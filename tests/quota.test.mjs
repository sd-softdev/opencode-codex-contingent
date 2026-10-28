import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { normalizeLimits, readCodexLimits, resetText, QuotaError } from "../src/quota.mjs";

const weekly = { usedPercent: 17, windowDurationMins: 10080, resetsAt: 2000000000 };
const rolling = { usedPercent: 5, windowDurationMins: 300, resetsAt: 1900000000 };
const result = { rateLimits: { primary: weekly } };

function fakeServer(reply) {
  const requests = [];
  const launches = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    requests.push(request);
    queueMicrotask(() => reply?.(request, child));
  });
  return {
    child, requests, launches,
    spawnProcess: (...args) => { launches.push(args); return child; },
  };
}

function answer(child, value) {
  child.stdout.write(JSON.stringify(value) + "\n");
}

test("recognizes a weekly-only quota in the primary slot", () => {
  assert.deepEqual(normalizeLimits(result).buckets, [{ id: "codex", label: "Codex", windows: [{
    label: "Weekly", weekly: true, remaining: 83, resetsAt: 2000000000000,
  }] }]);
});

test("uses multi-bucket data without duplicating the legacy view", () => {
  const quota = normalizeLimits({
    ...result,
    rateLimitsByLimitId: {
      codex: { primary: rolling, secondary: weekly },
      extra: { limitName: "Extra\n\x1b", primary: weekly },
    },
  });
  assert.equal(quota.buckets.length, 2);
  assert.deepEqual(quota.buckets[0].windows.map((w) => w.label), ["5 hours", "Weekly"]);
  assert.equal(quota.buckets[1].label, "Extra");
  assert.equal(quota.buckets[1].id, "extra");
});

test("falls back from an empty bucket map and preserves exhausted and unused quotas", () => {
  for (const usedPercent of [0, 100]) {
    const quota = normalizeLimits({ rateLimitsByLimitId: {}, rateLimits: {
      primary: { usedPercent, windowDurationMins: 10080 },
    } });
    assert.equal(quota.buckets[0].windows[0].remaining, 100 - usedPercent);
    assert.equal(quota.buckets[0].windows[0].resetsAt, null);
  }
});

test("does not call unfamiliar durations weekly or invent a reset", () => {
  const quota = normalizeLimits({ rateLimits: { primary: {
    usedPercent: 12, windowDurationMins: 60, resetsAt: Infinity,
  } } });
  assert.equal(quota.buckets[0].windows[0].label, "60 min");
  assert.equal(quota.buckets[0].windows[0].weekly, false);
  assert.equal(quota.buckets[0].windows[0].resetsAt, null);
});

test("rejects absent and invalid quotas instead of inventing a percentage", () => {
  for (const invalid of [undefined, {}, { rateLimits: {} },
    { rateLimits: { primary: { usedPercent: -1 } } },
    { rateLimits: { primary: { usedPercent: 101 } } },
    { rateLimits: { primary: { usedPercent: NaN } } },
    { rateLimits: { primary: { usedPercent: "17" } } },
  ]) assert.throws(() => normalizeLimits(invalid), QuotaError);
});

test("formats known, unknown, imminent, and expired resets", () => {
  const now = 1000000;
  assert.equal(resetText(null, now), "Reset unknown");
  assert.equal(resetText(now, now), "Reset due");
  assert.equal(resetText(now + 1000, now), "Resets in 1m");
  assert.equal(resetText(now + 65 * 60000, now), "Resets in 1h 5m");
  assert.equal(resetText(now + (2 * 1440 + 3 * 60) * 60000, now), "Resets in 2d 3h");
});

test("performs the handshake, handles split lines and notifications, and only reads limits", async () => {
  const server = fakeServer((request, child) => {
    if (request.id === 1) {
      child.stdout.write('{"id":1,');
      child.stdout.write('"result":{}}\n');
    }
    if (request.id === 2) {
      answer(child, { method: "account/rateLimits/updated", params: {} });
      answer(child, { id: 2, result });
    }
  });
  const quota = await readCodexLimits({ binary: "/example/codex", spawnProcess: server.spawnProcess });
  assert.equal(quota.buckets[0].windows[0].remaining, 83);
  assert.deepEqual(server.requests.map((r) => r.method), ["initialize", "initialized", "account/rateLimits/read"]);
  assert.deepEqual(server.launches, [["/example/codex", ["app-server", "--listen", "stdio://"], {
    cwd: homedir(), stdio: ["pipe", "pipe", "ignore"],
  }]]);
  assert.deepEqual(server.child.kills, ["SIGTERM"]);
});

test("does not expose provider errors", async () => {
  const server = fakeServer((request, child) => answer(child, { id: request.id, error: { message: "sensitive-placeholder" } }));
  await assert.rejects(readCodexLimits({ spawnProcess: server.spawnProcess }), (error) => {
    assert.ok(error instanceof QuotaError);
    assert.ok(!error.message.includes("sensitive-placeholder"));
    assert.match(error.message, /codex login/);
    return true;
  });
  assert.deepEqual(server.child.kills, ["SIGTERM"]);
});

test("times out a stalled server and terminates its process", async () => {
  const server = fakeServer();
  await assert.rejects(readCodexLimits({ spawnProcess: server.spawnProcess, timeoutMs: 20 }), /timed out/);
  assert.deepEqual(server.child.kills, ["SIGTERM"]);
});

test("cancels active reads on plugin disposal", async () => {
  const server = fakeServer();
  const controller = new AbortController();
  const pending = readCodexLimits({ spawnProcess: server.spawnProcess, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(server.child.kills, ["SIGTERM"]);
});

test("does not spawn for an already aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readCodexLimits({ signal: controller.signal, spawnProcess: () => assert.fail("must not spawn") }), /cancelled/);
});

test("handles a missing executable without leaking its raw error", async () => {
  const server = fakeServer();
  const pending = readCodexLimits({ spawnProcess: server.spawnProcess });
  server.child.emit("error", new Error("sensitive-placeholder"));
  await assert.rejects(pending, /CLI installation/);
});

test("handles synchronous spawn failure", async () => {
  await assert.rejects(readCodexLimits({ spawnProcess: () => { throw new Error("sensitive-placeholder"); } }), /CLI installation/);
});

test("handles stdin and stdout failures without leaking raw errors", async () => {
  for (const stream of ["stdin", "stdout"]) {
    const server = fakeServer();
    const pending = readCodexLimits({ spawnProcess: server.spawnProcess });
    server.child[stream].emit("error", new Error("sensitive-placeholder"));
    await assert.rejects(pending, /interrupted/);
    assert.deepEqual(server.child.kills, ["SIGTERM"]);
  }
});

test("handles early process exit", async () => {
  const server = fakeServer();
  const pending = readCodexLimits({ spawnProcess: server.spawnProcess });
  server.child.emit("close", 1);
  await assert.rejects(pending, /without a quota response/);
});

test("rejects malformed and oversized output", async () => {
  for (const output of ["not-json\n", "x".repeat(1024 * 1024 + 1)]) {
    const server = fakeServer();
    const pending = readCodexLimits({ spawnProcess: server.spawnProcess });
    server.child.stdout.write(output);
    await assert.rejects(pending, QuotaError);
    assert.deepEqual(server.child.kills, ["SIGTERM"]);
  }
});
