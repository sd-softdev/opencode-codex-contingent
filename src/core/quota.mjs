import { spawn } from "node:child_process";
import { homedir } from "node:os";
import metadata from "../../package.json" with { type: "json" };

/**
 * @typedef {{label: string, weekly: boolean, remaining: number, resetsAt: number | null}} QuotaWindow
 * @typedef {{id: string, label: string, windows: QuotaWindow[]}} QuotaBucket
 * @typedef {{buckets: QuotaBucket[], fetchedAt: number}} QuotaSnapshot
 */

/** Only fixed messages are exposed; never include provider errors or stderr. */
export class QuotaError extends Error {}

/** @returns {QuotaSnapshot} */
export function normalizeLimits(result) {
  const source = result?.rateLimitsByLimitId;
  const entries = source && typeof source === "object" && Object.keys(source).length
    ? Object.entries(source)
    : [["codex", result?.rateLimits]];
  const buckets = [];
  for (const [id, bucket] of entries) {
    if (!bucket || typeof bucket !== "object") continue;
    const windows = [];
    for (const key of ["primary", "secondary"]) {
      const value = bucket[key];
      if (!value || !Number.isFinite(value.usedPercent)
        || value.usedPercent < 0 || value.usedPercent > 100) continue;
      const minutes = value.windowDurationMins;
      // Weekly-only plans may put the weekly quota in the primary slot.
      const label = minutes === 10080 ? "Weekly"
        : minutes === 300 ? "5 hours"
        : Number.isFinite(minutes) && minutes > 0 ? `${minutes} min` : "Window";
      windows.push({
        label,
        weekly: minutes === 10080,
        remaining: 100 - value.usedPercent,
        resetsAt: Number.isFinite(value.resetsAt) && value.resetsAt > 0
          && Number.isFinite(value.resetsAt * 1000) ? value.resetsAt * 1000 : null,
      });
    }
    if (windows.length) {
      const label = String(bucket.limitName || id).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80);
      buckets.push({ id, label: id === "codex" ? "Codex" : label, windows });
    }
  }
  if (!buckets.length) throw new QuotaError("No Codex quotas available. Check your ChatGPT sign-in with codex login.");
  return { buckets, fetchedAt: Date.now() };
}

export function resetText(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return "Reset unknown";
  const minutes = Math.ceil((resetsAt - now) / 60000);
  if (minutes <= 0) return "Reset due";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `Resets in ${days}d ${hours}h`;
  if (hours) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets in ${minutes}m`;
}

/**
 * Only initialize and read account quotas; never start a thread or a model turn.
 * Codex owns authentication. No tokens, database access, shell, or HTTP fallback.
 * @param {{binary?: string, timeoutMs?: number, signal?: AbortSignal, spawnProcess?: typeof spawn}} [options]
 * @returns {Promise<QuotaSnapshot>}
 */
export function readCodexLimits({
  binary = "codex", timeoutMs = 15000, signal, spawnProcess = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new QuotaError("Request cancelled."));
    let child;
    try {
      child = spawnProcess(binary, ["app-server", "--listen", "stdio://"], {
        cwd: homedir(),
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return reject(new QuotaError("Could not start Codex. Check the CLI installation and codexBinary option."));
    }
    let settled = false;
    let initialized = false;
    let received = 0;
    let buffer = "";
    const abort = () => finish(new QuotaError("Request cancelled."));
    const timer = setTimeout(() => finish(new QuotaError("Codex quota request timed out.")), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout.removeAllListeners("data");
      child.stdin.end();
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
        child.once("close", () => clearTimeout(killTimer));
      }
      if (error) reject(error);
      else resolve(value);
    }
    function send(message) {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.on("error", () => finish(new QuotaError("Could not start Codex. Check the CLI installation and codexBinary option.")));
    child.stdin.on("error", () => finish(new QuotaError("Connection to the Codex app server interrupted.")));
    child.stdout.on("error", () => finish(new QuotaError("Connection to the Codex app server interrupted.")));
    child.once("close", () => finish(new QuotaError("Codex exited without a quota response. Check codex login.")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      received += Buffer.byteLength(chunk);
      if (received > 1024 * 1024) return finish(new QuotaError("Codex response exceeded the size limit."));
      buffer += chunk;
      let index;
      while (!settled && (index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { return finish(new QuotaError("Invalid Codex response.")); }
        if (!message || typeof message !== "object") continue;
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) return finish(new QuotaError("Codex quota request rejected. Check your sign-in with codex login."));
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2 && initialized) {
          try { finish(null, normalizeLimits(message.result)); }
          catch { finish(new QuotaError("No Codex quotas available. Check your ChatGPT sign-in with codex login.")); }
        }
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex_contingent", title: "Codex Contingent", version: metadata.version } },
    });
  });
}
