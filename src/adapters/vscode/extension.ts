import * as vscode from "vscode";
import { createVSCodeAdapter } from "./adapter.mjs";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(createVSCodeAdapter(vscode));
}
