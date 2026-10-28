import { transformFileAsync } from "@babel/core";
import { copyFile, mkdir, writeFile } from "node:fs/promises";

const result = await transformFileAsync("src/tui.tsx", {
  babelrc: false,
  configFile: false,
  sourceMaps: false,
  presets: [
    ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid", dev: false }],
    ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
  ],
});
if (!result?.code) throw new Error("TUI compilation produced no output.");
await mkdir("dist", { recursive: true });
await writeFile("dist/tui.js", `${result.code}\n`);
await copyFile("src/quota.mjs", "dist/quota.mjs");
