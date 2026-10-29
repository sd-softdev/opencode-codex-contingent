import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { resetText } from "../../core/quota.mjs";
import { createQuotaPoller } from "../../core/poller.mjs";
import { quotaDetails, quotaSummary } from "../../core/display.mjs";

export default Plugin.define({
  id: "sd-softdev.codex-contingent",
  setup(context) {
    const binary = typeof context.options.codexBinary === "string" ? context.options.codexBinary : "codex";
    const poller = createQuotaPoller({ codexBinary: binary });
    const [state, setState] = createSignal(poller.getState());
    const unsubscribe = poller.subscribe(setState);
    const quota = () => state().quota;
    const error = () => state().error;
    const now = () => state().now;
    let disposed = false;
    const footer = () => quotaSummary(state());
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
          await poller.refresh();
          if (disposed) return;
          await context.ui.dialog.alert({ title: "Codex quotas", message: quotaDetails(state(), poller.config).join("\n") });
        },
      }],
    }));
    poller.start();
    return () => {
      disposed = true;
      unsubscribe();
      poller.dispose();
      for (const remove of unregister) remove();
    };
  },
});
