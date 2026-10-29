import { transformFileAsync } from "@babel/core";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";

const result = await transformFileAsync("src/adapters/opencode/tui.tsx", {
  babelrc: false,
  configFile: false,
  sourceMaps: false,
  presets: [
    ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid", dev: false }],
    ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
  ],
});
if (!result?.code) throw new Error("TUI compilation produced no output.");
// Only generated output is cleaned; the public ./tui entry stays unchanged.
await rm("dist", { recursive: true, force: true });
await mkdir("dist/adapters/opencode", { recursive: true });
await mkdir("dist/core", { recursive: true });
await writeFile("dist/adapters/opencode/tui.js", `${result.code}\n`);
await writeFile("dist/tui.js", 'export { default } from "./adapters/opencode/tui.js";\n');
for (const file of await readdir("src/core")) {
  if (file.endsWith(".mjs")) await copyFile(`src/core/${file}`, `dist/core/${file}`);
}
