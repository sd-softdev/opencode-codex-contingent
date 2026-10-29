import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const template = JSON.parse(await readFile("vscode/package.json", "utf8"));
// A single version source; the template is not a separately published npm package.
await rm(".vscode-build", { recursive: true, force: true });
await mkdir(".vscode-build", { recursive: true });
await writeFile(".vscode-build/package.json", `${JSON.stringify({ ...template, version: pkg.version }, null, 2)}\n`);
await copyFile("vscode/README.md", ".vscode-build/README.md");
for (const file of ["LICENSE", "SECURITY.md"]) await copyFile(file, `.vscode-build/${file}`);
await build({
  entryPoints: ["src/adapters/vscode/extension.ts"],
  outfile: ".vscode-build/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  legalComments: "none",
  sourcemap: false,
  // Only package version is needed from the root manifest in the runtime bundle.
  plugins: [{ name: "package-version", setup(builder) {
    builder.onLoad({ filter: /[/\\]package\.json$/ }, () => ({ contents: JSON.stringify({ version: pkg.version }), loader: "json" }));
  } }],
});
