import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createVSCodeAdapter, COMMANDS } from "../src/adapters/vscode/adapter.mjs";
import { DEFAULT_CONFIG } from "../src/core/poller.mjs";

function harness() {
  const commands = new Map();
  const services = [];
  const documents = [];
  const shown = [];
  const item = { show() { this.visible = true; }, dispose() { this.disposed = true; } };
  let change;
  let binary = "codex";
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    window: { createStatusBarItem: () => item, showTextDocument: async (document) => shown.push(document) },
    commands: { registerCommand: (id, run) => {
      commands.set(id, run); return { dispose: () => commands.delete(id) };
    } },
    workspace: {
      getConfiguration: () => ({ get: () => binary }),
      openTextDocument: async (options) => { documents.push(options); return options; },
      onDidChangeConfiguration: (callback) => { change = callback; return { dispose: () => { change = undefined; } }; },
    },
  };
  const adapter = createVSCodeAdapter(vscode, { createPoller: (config) => {
    let listener;
    const service = {
      config: { ...DEFAULT_CONFIG, ...config },
      state: { quota: undefined, error: "", now: 0, refreshing: false },
      refreshes: 0, disposed: false,
      start() { this.started = true; },
      subscribe(callback) { listener = callback; callback(this.state); return () => { listener = undefined; }; },
      emit(patch) { this.state = { ...this.state, ...patch }; listener?.(this.state); },
      getState() { return this.state; },
      async refresh() { this.refreshes++; await this.pending; },
      dispose() { this.disposed = true; },
    };
    services.push(service);
    return service;
  } });
  return { adapter, commands, services, item, documents, shown,
    change: (value, affected = true) => { binary = value; change?.({ affectsConfiguration: () => affected }); } };
}

const quota = { fetchedAt: 1000, buckets: [{ id: "codex", label: "[click](command:evil) $(zap)", windows: [
  { label: "Weekly", weekly: true, remaining: 8, resetsAt: 3600000 },
] }] };

test("VS Code adapter shows quota, plain-text tooltip, resets and stale warnings", () => {
  const h = harness();
  assert.ok(h.item.visible);
  assert.match(h.item.text, /loading/);
  assert.equal(h.item.command, COMMANDS.details);
  assert.ok(h.services[0].started);
  h.services[0].emit({ quota });
  assert.match(h.item.text, /8% left/);
  assert.equal(typeof h.item.tooltip, "string");
  assert.match(h.item.tooltip, /\[click\]\(command:evil\)/);
  assert.match(h.item.tooltip, /Resets in 1h/);
  assert.equal(h.item.backgroundColor.id, "statusBarItem.warningBackground");
  h.services[0].emit({ error: "Codex quota request timed out." });
  assert.match(h.item.text, /stale/);
  assert.match(h.item.tooltip, /timed out/);
  assert.equal(h.item.accessibilityInformation.label, h.item.text);
  h.services[0].emit({ error: "", quota: { ...quota, buckets: [{ ...quota.buckets[0], windows: [{ ...quota.buckets[0].windows[0], remaining: 90 }] }] } });
  assert.equal(h.item.backgroundColor, undefined);
  h.adapter.dispose();
});

test("VS Code commands refresh and open quota details without Markdown or model calls", async () => {
  const h = harness();
  h.services[0].emit({ quota });
  await h.commands.get(COMMANDS.refresh)();
  await h.commands.get(COMMANDS.details)();
  assert.equal(h.services[0].refreshes, 2);
  assert.equal(h.documents[0].language, "plaintext");
  assert.match(h.documents[0].content, /Weekly: 8% left/);
  assert.match(h.documents[0].content, /local Codex CLI/);
  assert.equal(h.shown.length, 1);
  h.adapter.dispose();
  h.adapter.dispose();
  assert.equal(h.commands.size, 0);
  assert.ok(h.services[0].disposed);
  assert.ok(h.item.disposed);
});

test("changing the executable disposes the old poller, ignores late data, and uses the new path", () => {
  const h = harness();
  h.change("ignored", false);
  assert.equal(h.services.length, 1);
  h.change("/trusted/codex");
  assert.equal(h.services.length, 2);
  assert.equal(h.services[1].config.codexBinary, "/trusted/codex");
  assert.ok(h.services[0].disposed);
  h.services[0].emit({ quota });
  assert.match(h.item.text, /loading/);
  h.services[1].emit({ quota });
  assert.match(h.item.text, /8% left/);
  h.adapter.dispose();
  h.change("after-disposal");
  assert.equal(h.services.length, 2);
});

test("late detail commands do not reopen editors after disposal or executable changes", async () => {
  for (const action of ["dispose", "change"]) {
    const h = harness();
    let resolve;
    h.services[0].pending = new Promise((done) => { resolve = done; });
    const pending = h.commands.get(COMMANDS.details)();
    if (action === "dispose") h.adapter.dispose();
    else h.change("/new/codex");
    resolve();
    await pending;
    assert.equal(h.documents.length, 0);
    assert.equal(h.shown.length, 0);
    h.adapter.dispose();
  }
});

test("VS Code manifest restricts executable configuration to the machine and runs locally", async () => {
  const manifest = JSON.parse(await readFile(new URL("../vscode/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.contributes.configuration.properties["codexContingent.codexBinary"].scope, "machine");
  assert.deepEqual(manifest.extensionKind, ["ui"]);
  assert.equal(manifest.browser, undefined);
  assert.equal(manifest.version, undefined, "the root manifest is the sole version source");
  assert.deepEqual(manifest.contributes.commands.map((command) => command.command), Object.values(COMMANDS));
});
