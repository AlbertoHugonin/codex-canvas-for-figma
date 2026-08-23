import { AccountService } from "./codex/account-service.js";
import { AppServerClient } from "./codex/app-server-client.js";
import { resolveCodexBinary } from "./codex/binary.js";
import { ModelService } from "./codex/model-service.js";
import { ThreadService } from "./codex/thread-service.js";
import { PORT, ROOT } from "./config/paths.js";
import { ThreadRegistry } from "./config/thread-registry.js";
import { loadOrCreateToken } from "./config/token.js";
import { WorkspaceStore } from "./config/workspace-store.js";
import { BridgeController } from "./server/bridge-controller.js";
import { PluginWebSocketServer } from "./server/plugin-websocket-server.js";

const codexBinary = resolveCodexBinary();
const token = loadOrCreateToken();
const workspace = new WorkspaceStore();
const threadRegistry = new ThreadRegistry();
const app = new AppServerClient(codexBinary, ROOT);
const accounts = new AccountService(app);
const models = new ModelService(app, ROOT);
const threads = new ThreadService(app, workspace, threadRegistry);
const pluginServer = new PluginWebSocketServer(PORT, token);
const controller = new BridgeController(app, accounts, workspace, models, threads, pluginServer);

await controller.initialize();
pluginServer.start(controller);

console.log("\nCodex Canvas bridge is ready.");
console.log(`Codex binary: ${codexBinary}`);
console.log(`WebSocket: ws://127.0.0.1:${PORT}`);
console.log(`Connection token: ${token}`);
console.log(`Workspace: ${workspace.configuredRoot ?? "not configured (Figma-only mode)"}`);
console.log("Open Codex Canvas from Figma > Plugins > Development and paste the token once.\n");

function shutdown(): void {
  pluginServer.close();
  controller.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
