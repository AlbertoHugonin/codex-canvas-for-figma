import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/plugin", { recursive: true });
await mkdir("dist/bridge", { recursive: true });

const [, , uiBuild] = await Promise.all([
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
  build({
    entryPoints: ["src/plugin/ui.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "info"
  })
]);

const [uiTemplate, uiStyles] = await Promise.all([
  readFile("src/plugin/ui.html", "utf8"),
  readFile("src/plugin/ui.css", "utf8")
]);
const uiScript = uiBuild.outputFiles[0]?.text;
if (!uiScript) throw new Error("UI build did not produce JavaScript output");
if (!uiTemplate.includes("/*__CODEX_CANVAS_STYLES__*/") || !uiTemplate.includes("/*__CODEX_CANVAS_SCRIPT__*/")) {
  throw new Error("UI template is missing build placeholders");
}

await writeFile(
  "dist/plugin/ui.html",
  uiTemplate
    .replace("/*__CODEX_CANVAS_STYLES__*/", uiStyles)
    .replace("/*__CODEX_CANVAS_SCRIPT__*/", uiScript),
  "utf8"
);
