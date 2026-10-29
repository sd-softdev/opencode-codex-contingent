# Codex Contingent

See your **Codex subscription quota and reset times** in the VS Code status bar.
Hover for all quota windows; click for details.

## Requirements

- VS Code 1.96 or newer (desktop).
- The [Codex CLI](https://developers.openai.com/codex/cli), installed locally and
  signed into ChatGPT with `codex login`. API-key-only authentication does not
  provide subscription quotas.

## Install

Install [Codex Contingent](https://marketplace.visualstudio.com/items?itemName=SD-SoftDev.codex-contingent)
from the VS Code Marketplace, or run:

```sh
code --install-extension SD-SoftDev.codex-contingent
```

You can also download the `.vsix` from the
[GitHub releases](https://github.com/sd-softdev/opencode-codex-contingent/releases).
In VS Code, run **Extensions: Install from VSIX…** and select the file.

## Usage

- **Codex Contingent: Refresh Quotas** requests an update.
- **Codex Contingent: Show Quotas** opens a plain-text detail view.
- Automatic updates run every five minutes; manual requests at most once per
  30 seconds. Last-known data is marked stale if a request fails.
- If Codex is not on VS Code's `PATH`, set **Codex Contingent: Codex Binary**
  (`codexContingent.codexBinary`) to its absolute executable path in User Settings.

The extension runs locally, including in remote workspaces. It shows the account
signed into the **local Codex CLI**, not necessarily the account in another IDE
extension. It does not show API billing or an app-specific allowance, start model
requests, or read credential files. Authentication stays with Codex.

Community extension, not affiliated with OpenAI, OpenCode, or Microsoft.
[Source and OpenCode plugin](https://github.com/sd-softdev/opencode-codex-contingent).
