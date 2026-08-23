import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The bridge is bundled to dist/bridge/index.js, so the repository root is two levels above this URL.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const RUNTIME_DIR = resolve(ROOT, ".runtime");
const USER_STATE_DIR = process.platform === "win32"
  ? resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "codex-canvas")
  : resolve(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "codex-canvas");
export const CODEX_HOME_DIR = resolve(USER_STATE_DIR, "codex-home");
export const TOKEN_FILE = resolve(RUNTIME_DIR, "token");
export const WORKSPACE_CONFIG_FILE = resolve(RUNTIME_DIR, "workspace.json");
export const THREAD_REGISTRY_FILE = resolve(RUNTIME_DIR, "threads.json");
export const PORT = Number(process.env.CODEX_CANVAS_PORT ?? 3845);
export const THREAD_SOURCE = "codex-canvas-figma";
