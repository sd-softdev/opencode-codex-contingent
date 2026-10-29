// @ts-check
import { createQuotaPoller } from "../../core/poller.mjs";
import { quotaDetails, quotaSummary, selectedWindow } from "../../core/display.mjs";

export const COMMANDS = Object.freeze({
  refresh: "codexContingent.refresh",
  details: "codexContingent.showDetails",
});

/**
 * All host interaction lives here. Plain-text tooltips and detail documents
 * deliberately do not interpret provider labels as Markdown, HTML or commands.
 * @param {typeof import("vscode")} vscode
 */
export function createVSCodeAdapter(vscode, { createPoller = createQuotaPoller } = {}) {
  const item = vscode.window.createStatusBarItem("codexContingent.quota", vscode.StatusBarAlignment.Right, 100);
  item.name = "Codex quota";
  item.command = COMMANDS.details;
  let disposed = false;
  /** @type {ReturnType<typeof createQuotaPoller>} */
  let poller;
  /** @type {(() => void) | undefined} */
  let unsubscribe;

  function connect() {
    unsubscribe?.();
    poller?.dispose();
    const binary = vscode.workspace.getConfiguration("codexContingent").get("codexBinary", "codex");
    poller = createPoller({ codexBinary: typeof binary === "string" && binary.trim() ? binary : "codex" });
    unsubscribe = poller.subscribe((state) => {
      item.text = quotaSummary(state);
      item.tooltip = ["Codex quotas", ...quotaDetails(state, poller.config), "Click for details."].join("\n");
      item.accessibilityInformation = { label: item.text };
      item.backgroundColor = state.error || (selectedWindow(state.quota)?.remaining ?? 100) <= 10
        ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      item.show();
    });
    poller.start();
  }

  connect();
  const resources = [
    vscode.commands.registerCommand(COMMANDS.refresh, () => poller.refresh()),
    vscode.commands.registerCommand(COMMANDS.details, async () => {
      const active = poller;
      await active.refresh();
      if (disposed || active !== poller) return;
      const document = await vscode.workspace.openTextDocument({
        language: "plaintext", content: ["Codex quotas", "", ...quotaDetails(active.getState(), active.config)].join("\n"),
      });
      if (!disposed && active === poller) await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!disposed && event.affectsConfiguration("codexContingent.codexBinary")) connect();
    }),
  ];

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      poller.dispose();
      for (const resource of resources) resource.dispose();
      item.dispose();
    },
  };
}
