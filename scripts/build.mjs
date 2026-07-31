import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/plugin", { recursive: true });
await mkdir("dist/bridge", { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/plugin/code.ts"],
    outfile: "dist/plugin/code.js",
    bundle: true,
    format: "iife",
    target: "es2020",
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/bridge/index.ts"],
    outfile: "dist/bridge/index.js",
    bundle: true,
    external: ["ws"],
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "info"
  }),
  copyFile("src/plugin/ui.html", "dist/plugin/ui.html")
]);
