// @ts-check
import { QuotaError, readCodexLimits } from "./quota.mjs";

/** @type {Readonly<QuotaConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  codexBinary: "codex",
  pollIntervalMs: 300000,
  manualRefreshIntervalMs: 30000,
  timeoutMs: 15000,
  clockIntervalMs: 60000,
});

/** @typedef {{codexBinary: string, pollIntervalMs: number, manualRefreshIntervalMs: number, timeoutMs: number, clockIntervalMs: number}} QuotaConfig */
/** @typedef {{quota: import("./quota.mjs").QuotaSnapshot | undefined, error: string, now: number, refreshing: boolean}} QuotaState */

/**
 * Configuration injection is shared by both hosts; no configuration file is read.
 * @param {Partial<QuotaConfig>} [overrides]
 */
export function quotaConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (typeof config.codexBinary !== "string" || !config.codexBinary.trim() || config.codexBinary.includes("\0")) {
    throw new TypeError("codexBinary must be an executable name or path.");
  }
  /** @type {(keyof Omit<QuotaConfig, "codexBinary">)[]} */
  const intervals = ["pollIntervalMs", "manualRefreshIntervalMs", "timeoutMs", "clockIntervalMs"];
  for (const name of intervals) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0 || config[name] > 2147483647) {
      throw new RangeError(`${name} must be a positive timer interval.`);
    }
  }
  return Object.freeze(config);
}

/**
 * Owns the cache, request deduplication, cooldown, clocks and cancellation.
 * Timers and transport are injectable so tests never need a real Codex login.
 * @param {Partial<QuotaConfig>} [overrides]
 * @param {{read?: typeof readCodexLimits, now?: () => number, schedule?: typeof setInterval, cancel?: typeof clearInterval}} [dependencies]
 */
export function createQuotaPoller(overrides = {}, {
  read = readCodexLimits, now = Date.now, schedule = setInterval, cancel = clearInterval,
} = {}) {
  const config = quotaConfig(overrides);
  /** @type {QuotaState} */
  let state = { quota: undefined, error: "", now: now(), refreshing: false };
  /** @type {Set<(state: QuotaState) => void>} */
  const listeners = new Set();
  const controller = new AbortController();
  /** @type {Promise<void> | undefined} */
  let pending;
  let lastAttempt = -Infinity;
  let started = false;
  let disposed = false;
  /** @type {ReturnType<typeof setInterval>[]} */
  const timers = [];

  /** @param {Partial<QuotaState>} patch */
  function update(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function refresh() {
    if (pending) return pending;
    if (disposed || now() - lastAttempt < config.manualRefreshIntervalMs) return Promise.resolve();
    lastAttempt = now();
    pending = Promise.resolve()
      .then(() => {
        if (!disposed) return read({ binary: config.codexBinary, timeoutMs: config.timeoutMs, signal: controller.signal });
      })
      .then((quota) => { if (quota) update({ quota, error: "", now: now() }); })
      .catch((cause) => update({ error: cause instanceof QuotaError ? cause.message : "Codex quota request failed." }))
      .finally(() => {
        pending = undefined;
        update({ refreshing: false });
      });
    update({ refreshing: true });
    return pending;
  }

  return {
    config,
    getState: () => state,
    /** @param {(state: QuotaState) => void} listener */
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    refresh,
    start() {
      if (started || disposed) return;
      started = true;
      timers.push(schedule(() => { void refresh(); }, config.pollIntervalMs));
      timers.push(schedule(() => update({ now: now() }), config.clockIntervalMs));
      void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) cancel(timer);
      listeners.clear();
      controller.abort();
    },
  };
}
