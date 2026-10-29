import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaPoller, DEFAULT_CONFIG, quotaConfig } from "../src/core/poller.mjs";
import { QuotaError, normalizeLimits } from "../src/core/quota.mjs";
import { quotaDetails, quotaSummary, selectedWindow } from "../src/core/display.mjs";

const snapshot = () => normalizeLimits({ rateLimits: {
  primary: { usedPercent: 40, windowDurationMins: 300 },
  secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 2000000000 },
} });

function harness(read = async () => snapshot(), config = {}) {
  let time = 0;
  const tasks = new Map();
  const requests = [];
  const poller = createQuotaPoller(config, {
    now: () => time,
    read: (options) => { requests.push(options); return read(options); },
    schedule: (callback, delay) => { const id = {}; tasks.set(id, { callback, delay }); return id; },
    cancel: (id) => tasks.delete(id),
  });
  return { poller, tasks, requests, advance: (ms) => { time += ms; },
    tick: (delay) => { for (const task of tasks.values()) if (task.delay === delay) task.callback(); } };
}

test("shared configuration preserves defaults and validates injected intervals", () => {
  assert.deepEqual(quotaConfig(), DEFAULT_CONFIG);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.equal(quotaConfig({ codexBinary: "/trusted/codex", pollIntervalMs: 60000 }).pollIntervalMs, 60000);
  for (const codexBinary of ["", "  ", null, 7, "bad\0path"]) assert.throws(() => quotaConfig({ codexBinary }));
  for (const key of ["pollIntervalMs", "manualRefreshIntervalMs", "timeoutMs", "clockIntervalMs"]) {
    for (const value of [0, -1, NaN, Infinity, "1000", 1.5, 2147483648]) {
      assert.throws(() => quotaConfig({ [key]: value }), RangeError);
    }
  }
});

test("startup reads immediately, deduplicates requests, and starts clocks only once", async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const states = [];
  const unsubscribe = h.poller.subscribe((state) => states.push(state));
  h.poller.start();
  h.poller.start();
  assert.equal(h.tasks.size, 2);
  assert.deepEqual([...h.tasks.values()].map((task) => task.delay), [300000, 60000]);
  const request = h.poller.refresh();
  assert.equal(request, h.poller.refresh());
  assert.equal(h.poller.getState().refreshing, true);
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  resolve(snapshot());
  await request;
  assert.equal(h.poller.getState().quota.buckets[0].windows[1].remaining, 83);
  assert.equal(h.poller.getState().refreshing, false);
  assert.equal(states[0].quota, undefined);
  unsubscribe();
  const count = states.length;
  h.advance(60000);
  h.tick(60000);
  assert.equal(states.length, count);
  assert.equal(h.requests.length, 1);
  assert.equal(h.poller.getState().now, 60000);
  h.poller.dispose();
  assert.equal(h.tasks.size, 0);
});

test("manual cooldown and automatic polling use the same cache and injected configuration", async () => {
  const h = harness(undefined, { codexBinary: "/trusted/codex", timeoutMs: 5000, pollIntervalMs: 90000 });
  await h.poller.refresh();
  assert.equal(h.requests[0].binary, "/trusted/codex");
  assert.equal(h.requests[0].timeoutMs, 5000);
  h.advance(29999);
  await h.poller.refresh();
  assert.equal(h.requests.length, 1);
  h.advance(1);
  await h.poller.refresh();
  assert.equal(h.requests.length, 2);
  h.poller.start();
  h.advance(90000);
  h.tick(90000);
  await h.poller.refresh();
  assert.equal(h.requests.length, 3);
  h.poller.dispose();
});

test("errors retain stale data, hide unexpected payloads, and clear after recovery", async () => {
  let failure;
  const h = harness(async () => { if (failure) throw failure; return snapshot(); });
  await h.poller.refresh();
  const cached = h.poller.getState().quota;
  failure = new QuotaError("Codex quota request timed out.");
  h.advance(30000);
  await h.poller.refresh();
  assert.equal(h.poller.getState().quota, cached);
  assert.match(quotaSummary(h.poller.getState()), /83% left \(stale\)/);
  assert.match(h.poller.getState().error, /timed out/);
  failure = new Error("secret provider payload");
  h.advance(30000);
  await h.poller.refresh();
  assert.equal(h.poller.getState().error, "Codex quota request failed.");
  failure = undefined;
  h.advance(30000);
  await h.poller.refresh();
  assert.equal(h.poller.getState().error, "");
  h.poller.dispose();
});

test("disposal aborts in-flight reads and suppresses all late state changes", async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  let emissions = 0;
  h.poller.subscribe(() => { emissions++; });
  h.poller.start();
  const pending = h.poller.refresh();
  await Promise.resolve();
  const state = h.poller.getState();
  const count = emissions;
  h.poller.dispose();
  h.poller.dispose();
  assert.ok(h.requests[0].signal.aborted);
  resolve(snapshot());
  await pending;
  h.advance(300000);
  h.poller.start();
  await h.poller.refresh();
  h.poller.subscribe(() => assert.fail("no emissions after disposal"));
  assert.equal(emissions, count);
  assert.equal(h.poller.getState(), state);
  assert.equal(h.tasks.size, 0);
  assert.equal(h.requests.length, 1);
});

test("disposal before deferred startup never launches a CLI", async () => {
  const h = harness();
  h.poller.start();
  h.poller.dispose();
  await h.poller.refresh();
  assert.equal(h.requests.length, 0);
});

test("shared presentation prefers Codex weekly quota and covers empty, error, and multi-bucket states", () => {
  const empty = { quota: undefined, error: "", now: 0, refreshing: false };
  assert.match(quotaSummary(empty), /loading/);
  assert.ok(quotaDetails(empty).includes("Loading…"));
  assert.match(quotaSummary({ ...empty, error: "unavailable" }), /unavailable/);
  const quota = snapshot();
  quota.buckets.unshift({ id: "other", label: "Other bucket", windows: [{ label: "5 hours", weekly: false, remaining: 1, resetsAt: null }] });
  assert.equal(selectedWindow(quota).remaining, 83);
  const details = quotaDetails({ ...empty, quota });
  assert.ok(details.includes("Other bucket"));
  assert.ok(details.some((line) => line.includes("Reset unknown")));
  assert.ok(details.some((line) => line.includes("Updated:")));
  assert.ok(details.some((line) => line.includes("local Codex CLI")));
  assert.match(quotaSummary({ ...empty, quota }), /Weekly: 83% left/);
  assert.equal(selectedWindow({ buckets: [quota.buckets[0]], fetchedAt: 0 }).remaining, 1);
});
