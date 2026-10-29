import { createVSIX } from "@vscode/vsce";
import { mkdir, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir(".release", { recursive: true });
await createVSIX({
  cwd: ".vscode-build",
  packagePath: `.release/codex-contingent-${pkg.version}.vsix`,
  dependencies: false,
});
