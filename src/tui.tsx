import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { QuotaError, readCodexLimits, resetText } from "./quota.mjs";

export default Plugin.define({
  id: "sd-softdev.codex-contingent",
  setup(context) {
    const binary = typeof context.options.codexBinary === "string" ? context.options.codexBinary : "codex";
    const [quota, setQuota] = createSignal<Awaited<ReturnType<typeof readCodexLimits>>>();
    const [error, setError] = createSignal("");
    const [now, setNow] = createSignal(Date.now());
    const controller = new AbortController();
    let pending: Promise<void> | undefined;
    let lastAttempt = 0;
    let disposed = false;

    function refresh() {
      if (pending) return pending;
      if (disposed || Date.now() - lastAttempt < 30000) return Promise.resolve();
      lastAttempt = Date.now();
      pending = readCodexLimits({ binary, signal: controller.signal })
        .then((result) => {
          if (!disposed) {
            setQuota(result);
            setError("");
            setNow(Date.now());
          }
        })
        .catch((cause) => {
          if (!disposed) setError(cause instanceof QuotaError ? cause.message : "Codex quota request failed.");
        })
        .finally(() => { pending = undefined; });
      return pending;
    }

    const selectedWindow = () => {
      const buckets = quota()?.buckets ?? [];
      const main = buckets.find((bucket) => bucket.id === "codex") ?? buckets[0];
      return main?.windows.find((window) => window.weekly) ?? main?.windows[0];
    };
    const footer = () => {
      const window = selectedWindow();
      if (!window) return error() ? "Codex: check /codex-limits" : "Codex: loading…";
      return `Codex ${window.label}: ${Math.round(window.remaining)}% left${error() ? " (stale)" : ""}`;
    };
    const unregister = [
      context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <box flexDirection="column" width="100%">
            <text fg={context.theme.text.base}>Codex quota</text>
            <Show when={quota()} fallback={<text fg={context.theme.text.muted}>{error() || "Loading…"}</text>}>
              <For each={quota()?.buckets}>{(bucket) => (
                <box flexDirection="column">
                  <Show when={bucket.id !== "codex"}><text fg={context.theme.text.muted}>{bucket.label}</text></Show>
                  <For each={bucket.windows}>{(window) => (
                    <box flexDirection="column">
                      <text fg={window.remaining <= 10 ? context.theme.text.feedback.warning.base : context.theme.text.base}>
                        {window.label}: {Math.round(window.remaining)}% left
                      </text>
                      <text fg={context.theme.text.muted}>{resetText(window.resetsAt, now())}</text>
                    </box>
                  )}</For>
                </box>
              )}</For>
              <Show when={error()}><text fg={context.theme.text.muted}>Stale data · /codex-limits</text></Show>
            </Show>
          </box>
        ),
      }),
      ...(["prompt.footer.status", "home.footer.status"] as const).map((append) => context.ui.slot({
        append,
        render: () => <text fg={context.theme.text.muted}>{footer()}</text>,
      })),
    ];
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "sd-softdev.codex-contingent.show",
        title: "Show Codex quotas",
        group: "Codex",
        palette: true,
        slash: { name: "codex-limits" },
        run: async () => {
          await refresh();
          if (disposed) return;
          const result = quota();
          const lines = result?.buckets.flatMap((bucket) => [bucket.label, ...bucket.windows.map((window) =>
            `${window.label}: ${Math.round(window.remaining)}% left · ${resetText(window.resetsAt)}`)]) ?? [];
          if (result) lines.push(`Updated: ${new Date(result.fetchedAt).toLocaleString()}`);
          if (error()) lines.push(error());
          lines.push("Codex subscription quota, not an OpenCode app-specific limit.", "Refreshes every 5 minutes; manual refreshes are limited to once per 30 seconds.");
          await context.ui.dialog.alert({ title: "Codex quotas", message: lines.join("\n") });
        },
      }],
    }));
    const poll = setInterval(() => void refresh(), 300000);
    const clock = setInterval(() => setNow(Date.now()), 60000);
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(poll);
      clearInterval(clock);
      for (const remove of unregister) remove();
    };
  },
});
