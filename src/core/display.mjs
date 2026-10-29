// @ts-check
import { DEFAULT_CONFIG } from "./poller.mjs";
import { resetText } from "./quota.mjs";

/** @param {import("./quota.mjs").QuotaSnapshot | undefined} quota */
export function selectedWindow(quota) {
  const buckets = quota?.buckets ?? [];
  const main = buckets.find((bucket) => bucket.id === "codex") ?? buckets[0];
  return main?.windows.find((window) => window.weekly) ?? main?.windows[0];
}

/** @param {import("./poller.mjs").QuotaState} state */
export function quotaSummary(state) {
  const window = selectedWindow(state.quota);
  if (!window) return state.error ? "Codex: unavailable" : "Codex: loading…";
  return `Codex ${window.label}: ${Math.round(window.remaining)}% left${state.error ? " (stale)" : ""}`;
}

/** @param {import("./poller.mjs").QuotaState} state */
export function quotaDetails(state, config = DEFAULT_CONFIG) {
  const lines = state.quota?.buckets.flatMap((bucket) => [bucket.label, ...bucket.windows.map((window) =>
    `${window.label}: ${Math.round(window.remaining)}% left · ${resetText(window.resetsAt, state.now)}`)]) ?? [];
  if (state.quota) lines.push(`Updated: ${new Date(state.quota.fetchedAt).toLocaleString()}`);
  if (state.error) lines.push(`Stale or unavailable: ${state.error}`);
  if (!state.quota && !state.error) lines.push("Loading…");
  lines.push("Quota for the account signed into the local Codex CLI.",
    "Not API billing or an app-specific allowance.",
    `Refreshes every ${config.pollIntervalMs / 60000} minutes; manual refreshes are limited to once per ${config.manualRefreshIntervalMs / 1000} seconds.`);
  return lines;
}
