import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const temporary = await mkdtemp(".release/package-smoke-");

// Exercise only packed code. Every process launch is intercepted; these tests
// cannot use the real CLI, credentials, network or a model turn.
function runtime(hosts) {
  const timers = new Set();
  const launches = [];
  const requests = [];
  const children = [];
  const timer = () => { const id = { unref() {} }; timers.add(id); return id; };
  function spawn(binary, args, options) {
    launches.push({ binary, args, options });
    const child = new EventEmitter();
    children.push(child);
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit("close")); return true; };
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString());
      requests.push(request);
      if (request.id) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id,
        result: request.id === 1 ? {} : { rateLimits: { primary: { usedPercent: 17, windowDurationMins: 10080 } } },
      })}\n`));
    });
    return child;
  }
  return {
    launches, requests, children, timers,
    load(source) {
      const module = { exports: {} };
      runInNewContext(source, {
        module, exports: module.exports, Buffer, AbortController, console,
        setTimeout: timer, setInterval: timer,
        clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
        require: (name) => {
          if (name === "node:child_process") return { spawn };
          if (Object.hasOwn(hosts, name)) return hosts[name];
          if (name === "node:os") return require(name);
          throw new Error(`Unexpected runtime dependency: ${name}`);
        },
      }, { timeout: 5000 });
      return module.exports;
    },
    verify() {
      assert.equal(launches.length, 1, "startup and manual refresh share the cooldown");
      assert.equal(launches[0].binary, "/mock/codex");
      assert.equal(JSON.stringify(launches[0].args), JSON.stringify(["app-server", "--listen", "stdio://"]));
      assert.equal(requests[0].params.clientInfo.version, pkg.version);
      assert.equal(JSON.stringify(requests.map((request) => request.method)),
        JSON.stringify(["initialize", "initialized", "account/rateLimits/read"]));
      assert.equal(children[0].signalCode, "SIGTERM");
      assert.equal(timers.size, 0, "all clocks and timeout handles are disposed");
    },
  };
}

try {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { encoding: "utf8" }));
  assert.ok(packed.files.every((file) => !/vscode|node_modules|src\//.test(file.path)));
  execFileSync("tar", ["-xzf", `${temporary}/${packed.filename}`, "-C", temporary]);
  const npmManifest = JSON.parse(await readFile(`${temporary}/package/package.json`, "utf8"));
  assert.equal(npmManifest.version, pkg.version);
  assert.equal(npmManifest.exports["./tui"], "./dist/tui.js");
  const bundled = await build({
    entryPoints: [resolve(temporary, "package", npmManifest.exports["./tui"])],
    write: false, bundle: true, format: "cjs", platform: "node",
    external: ["@opencode/plugin/tui", "@opentui/solid", "solid-js"],
  });
  const solid = {
    createSignal: (value) => [() => value, (next) => { value = next; }],
    For: (props) => props.each?.map(props.children),
    Show: (props) => props.when ? props.children : props.fallback,
  };
  const ui = {
    createElement: (type) => ({ type, children: [] }), createTextNode: (text) => text,
    insertNode: (node, child) => node.children.push(child),
    insert: (node, child) => node.children.push(typeof child === "function" ? child() : child),
    setProp: (node, name, value) => { node[name] = value; },
    createComponent: (component, props) => component(props),
    effect: (callback, initial) => callback(initial), memo: (callback) => callback,
  };
  const tui = runtime({ "@opencode/plugin/tui": { Plugin: { define: (plugin) => plugin } }, "solid-js": solid, "@opentui/solid": ui });
  const plugin = tui.load(bundled.outputFiles[0].text).default;
  assert.equal(plugin.id, "sd-softdev.codex-contingent");
  const slots = [];
  let command;
  let message;
  let removed = 0;
  const dispose = plugin.setup({
    options: { codexBinary: "/mock/codex" },
    theme: { text: { base: "white", muted: "gray", feedback: { warning: { base: "yellow" } } } },
    ui: { slot: (slot) => { slots.push(slot); return () => { removed++; }; },
      dialog: { alert: async (options) => { message = options.message; } } },
    keymap: { layer: (layer) => { command = layer().commands[0]; } },
  });
  assert.equal(command.slash.name, "codex-limits");
  await command.run();
  assert.match(message, /Weekly: 83% left/);
  for (const slot of slots) {
    const rendered = JSON.stringify(slot.render());
    assert.match(rendered, /83/);
  }
  dispose();
  assert.equal(removed, 3);
  tui.verify();

  const vsix = resolve(`.release/codex-contingent-${pkg.version}.vsix`);
  const files = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(files, ["[Content_Types].xml", "extension.vsixmanifest", "extension/LICENSE.txt", "extension/SECURITY.md",
    "extension/extension.cjs", "extension/package.json", "extension/readme.md"].sort());
  const extract = (name) => execFileSync("unzip", ["-p", vsix, `extension/${name}`], { encoding: "utf8" });
  const manifest = JSON.parse(extract("package.json"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.publisher, "SD-SoftDev");
  assert.equal(manifest.dependencies, undefined);
  const commands = new Map();
  let itemDisposed = false;
  const item = { show() {}, dispose() { itemDisposed = true; } };
  const vscode = runtime({ vscode: {
    StatusBarAlignment: { Right: 2 }, ThemeColor: class {},
    commands: { registerCommand: (id, run) => { commands.set(id, run); return { dispose: () => commands.delete(id) }; } },
    window: { createStatusBarItem: () => item },
    workspace: { getConfiguration: () => ({ get: () => "/mock/codex" }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  } });
  const extension = vscode.load(extract("extension.cjs"));
  const subscriptions = [];
  extension.activate({ subscriptions });
  await commands.get("codexContingent.refresh")();
  assert.match(item.text, /Weekly: 83% left/);
  assert.equal(typeof item.tooltip, "string");
  assert.ok(commands.has("codexContingent.showDetails"));
  for (const subscription of subscriptions) subscription.dispose();
  assert.ok(itemDisposed);
  assert.equal(commands.size, 0);
  vscode.verify();
  console.log("Packed npm plugin and VSIX load, display mocked quota, and dispose cleanly.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
