import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";

type JsonObject = Record<string, unknown>;
type RpcId = number | string;
type ModelChoice = {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort: string;
  efforts: Array<{ value: string; description: string }>;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_DIR = resolve(ROOT, ".runtime");
const TOKEN_FILE = resolve(RUNTIME_DIR, "token");
const PORT = Number(process.env.CODEX_CANVAS_PORT ?? 3845);

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function findBundledCodexCandidates(): string[] {
  const extensionRoots = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
    join(homedir(), ".cursor", "extensions"),
    join(homedir(), ".windsurf", "extensions")
  ];
  const candidates: string[] = [];

  for (const extensionRoot of extensionRoots) {
    if (!existsSync(extensionRoot)) continue;

    for (const extension of readdirSync(extensionRoot, { withFileTypes: true })) {
      if (!extension.isDirectory() || !extension.name.startsWith("openai.chatgpt-")) continue;
      const binRoot = join(extensionRoot, extension.name, "bin");
      if (!existsSync(binRoot)) continue;

      for (const platform of readdirSync(binRoot, { withFileTypes: true })) {
        if (!platform.isDirectory() || !platform.name.startsWith("macos-")) continue;
        const candidate = join(binRoot, platform.name, "codex");
        if (isExecutableFile(candidate)) candidates.push(candidate);
      }
    }
  }

  return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function resolveCodexBinary(): string {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) {
    const candidate = configured.includes("/") ? resolve(configured) : findOnPath(configured);
    if (candidate && isExecutableFile(candidate)) return candidate;
    throw new Error(
      `CODEX_BIN points to an unavailable executable: ${configured}\n` +
        "Set it to the absolute path of Codex, for example: CODEX_BIN=/path/to/codex npm start"
    );
  }

  const pathMatch = findOnPath("codex");
  if (pathMatch) return pathMatch;

  const commonCandidates = [
    join(homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ];
  const commonMatch = commonCandidates.find(isExecutableFile);
  if (commonMatch) return commonMatch;

  const bundledMatch = findBundledCodexCandidates()[0];
  if (bundledMatch) return bundledMatch;

  throw new Error(
    "Codex Canvas could not find the Codex executable. Install/authenticate Codex, or start with " +
      "CODEX_BIN=/absolute/path/to/codex npm start"
  );
}

const CODEX_BIN = resolveCodexBinary();

mkdirSync(RUNTIME_DIR, { recursive: true });
const token = existsSync(TOKEN_FILE)
  ? readFileSync(TOKEN_FILE, "utf8").trim()
  : randomBytes(24).toString("base64url");
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });

const FIGMA_TOOLS = [
  {
    type: "namespace",
    name: "figma_local",
    description:
      "Direct access to the currently open Figma document through the user's local Codex Canvas plugin. This is not the hosted Figma connector.",
    tools: [
      {
        type: "function",
        name: "get_context",
        description:
          "Inspect the current selection, current page, or a node. Read before modifying. Depth is capped at 4 to keep results manageable.",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["selection", "current_page", "node"] },
            nodeId: { type: "string" },
            depth: { type: "integer", minimum: 0, maximum: 4 }
          },
          required: ["scope"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "execute",
        description:
          "Execute an async JavaScript function body against the Figma Plugin API. The globals passed in are figma and helpers. Use modern async APIs, await figma.loadFontAsync before editing text, never call figma.closePlugin, and return only serializable data or Figma nodes. Batch a coherent visual change in one call. The plugin creates an undo checkpoint and rolls back a thrown error.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            script: {
              type: "string",
              description:
                "Async function body, for example: const r=figma.createRectangle(); r.resize(200,100); return r;"
            }
          },
          required: ["description", "script"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "execute_ops",
        description:
          "Eval-free fallback that executes a batch of reflective Figma Plugin API operations. Each operation is getNode, get, set, or call. Targets can be figma, figma.variables, figma.teamLibrary, currentPage, selection, or an alias created with 'as'. Use {$ref:'alias'} inside values and arguments. Example: getNode id as card; set target card property opacity value 0.8; call target card method resize args [320,200]. Use this if execute reports that dynamic code is unavailable.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 250,
              items: { type: "object", additionalProperties: true }
            },
            returnRefs: { type: "array", items: { type: "string" } }
          },
          required: ["description", "operations"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "render",
        description:
          "Render a Figma node to PNG for visual verification. Pass nodeId or omit it to render the first selected node.",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            scale: { type: "number", minimum: 0.25, maximum: 3 }
          },
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "undo",
        description: "Undo the last committed Figma change made by the plugin.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    ]
  }
];

const DEVELOPER_INSTRUCTIONS = `
You are Codex Canvas, an AI design agent embedded inside Figma.

Operate on the live Figma document only through the figma_local tools. Do not use hosted Figma connectors, shell commands, or filesystem edits to manipulate the design.

For design changes:
- Inspect the selection or relevant parent first.
- Make the requested change directly when it is reversible and in scope.
- Preserve existing components, variables, styles, constraints, and naming conventions when possible.
- Prefer Auto Layout and reusable components over fixed-position copies when they improve the design.
- Load every font before changing text.
- Keep each coherent mutation in one execute call so Undo stays useful.
- If dynamic JavaScript execution is unavailable in the current Figma runtime, continue with execute_ops instead of stopping.
- Render the edited node after meaningful visual changes and correct obvious layout problems before finishing.
- Never call figma.closePlugin.

Answer the user concisely in the language they use. Explain what changed and mention any real Figma API limitation.
`;

class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private failure: Error | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  onNotification?: (message: JsonObject) => void;
  onServerRequest?: (message: JsonObject) => void;

  constructor() {
    this.child = spawn(CODEX_BIN, ["app-server", "--stdio"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handle(JSON.parse(line) as JsonObject);
      } catch (error) {
        console.error("Invalid app-server message:", error, line);
      }
    });

    this.child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.error(`[codex] ${message}`);
    });

    this.child.on("error", (error) => {
      this.fail(new Error(`Unable to start Codex at ${CODEX_BIN}: ${error.message}`));
    });

    this.child.on("exit", (code, signal) => {
      this.fail(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "codex_canvas", title: "Codex Canvas for Figma", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  request(method: string, params: JsonObject): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      if (this.failure) {
        rejectPromise(this.failure);
        return;
      }
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  close(): void {
    this.child.kill("SIGTERM");
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private handle(message: JsonObject): void {
    if (message.id !== undefined && typeof message.method === "string") {
      this.onServerRequest?.(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id as RpcId);
      if (!pending) return;
      this.pending.delete(message.id as RpcId);
      if (message.error) {
        const error = message.error as JsonObject;
        pending.reject(new Error(String(error.message ?? "App server error")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") this.onNotification?.(message);
  }
}

const app = new AppServerClient();
let threadId: string | null = null;
let activeTurnId: string | null = null;
let activePlugin: WebSocket | null = null;
let latestContext: unknown = null;
let availableModels: ModelChoice[] = [];
let configuredModel = "";
let configuredEffort = "";

function modelSettingsMessage(): JsonObject {
  return {
    type: "models.available",
    models: availableModels,
    selectedModel: configuredModel,
    selectedEffort: configuredEffort
  };
}

async function loadModelSettings(): Promise<void> {
  try {
    const [modelResponse, configResponse] = await Promise.all([
      app.request("model/list", { limit: 100, includeHidden: false }),
      app.request("config/read", { cwd: ROOT, includeLayers: false })
    ]);

    const rawModels = Array.isArray(modelResponse?.data) ? modelResponse.data : [];
    availableModels = rawModels.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== "object") return [];
      const entry = raw as JsonObject;
      const id = String(entry.model ?? entry.id ?? "").trim();
      if (!id) return [];
      const rawEfforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts
        : [];
      const efforts = rawEfforts.flatMap((rawEffort: unknown) => {
        if (!rawEffort || typeof rawEffort !== "object") return [];
        const effort = rawEffort as JsonObject;
        const value = String(effort.reasoningEffort ?? "").trim();
        if (!value) return [];
        return [{ value, description: String(effort.description ?? "") }];
      });
      return [
        {
          id,
          displayName: String(entry.displayName ?? id),
          isDefault: entry.isDefault === true,
          defaultEffort: String(entry.defaultReasoningEffort ?? efforts[0]?.value ?? "medium"),
          efforts
        }
      ];
    });

    const config = (configResponse?.config ?? {}) as JsonObject;
    const catalogDefault = availableModels.find((model) => model.isDefault) ?? availableModels[0];
    configuredModel = String(config.model ?? catalogDefault?.id ?? "");
    const selectedModel = availableModels.find((model) => model.id === configuredModel) ?? catalogDefault;
    const requestedEffort = String(config.model_reasoning_effort ?? "");
    configuredEffort = selectedModel?.efforts.some((effort) => effort.value === requestedEffort)
      ? requestedEffort
      : (selectedModel?.defaultEffort ?? requestedEffort);
    sendToPlugin(modelSettingsMessage());
  } catch (error) {
    console.error("Unable to load Codex model catalog:", error);
  }
}

function resolveModelSettings(modelValue: unknown, effortValue: unknown): { model?: string; effort?: string } {
  const requestedModel = String(modelValue ?? "").trim();
  const selectedModel =
    availableModels.find((model) => model.id === requestedModel) ??
    availableModels.find((model) => model.id === configuredModel) ??
    availableModels.find((model) => model.isDefault) ??
    availableModels[0];
  if (!selectedModel) return {};

  const requestedEffort = String(effortValue ?? "").trim();
  const effort = selectedModel.efforts.some((option) => option.value === requestedEffort)
    ? requestedEffort
    : selectedModel.defaultEffort;
  return { model: selectedModel.id, effort };
}

function sendToPlugin(message: JsonObject): void {
  if (activePlugin?.readyState === WebSocket.OPEN) {
    activePlugin.send(JSON.stringify(message));
  }
}

async function ensureThread(settings: { model?: string; effort?: string }): Promise<string> {
  if (threadId) return threadId;
  const response = await app.request("thread/start", {
    model: settings.model,
    config: settings.effort ? { model_reasoning_effort: settings.effort } : undefined,
    cwd: ROOT,
    sandbox: "read-only",
    approvalPolicy: "never",
    serviceName: "codex_canvas_figma",
    personality: "friendly",
    developerInstructions: DEVELOPER_INSTRUCTIONS,
    dynamicTools: FIGMA_TOOLS
  });
  threadId = String(response.thread.id);
  sendToPlugin({ type: "thread.ready", threadId });
  return threadId;
}

app.onNotification = (message) => {
  const method = String(message.method);
  const params = (message.params ?? {}) as JsonObject;

  if (method === "item/agentMessage/delta") {
    sendToPlugin({ type: "agent.delta", delta: String(params.delta ?? "") });
    return;
  }

  if (method === "item/started") {
    const item = (params.item ?? {}) as JsonObject;
    if (item.type === "agentMessage") {
      sendToPlugin({ type: "agent.message.started", itemId: String(item.id ?? "") });
      return;
    }
    if (item.type === "dynamicToolCall") {
      sendToPlugin({ type: "agent.status", text: `Figma: ${String(item.tool ?? "operation")}` });
    }
    return;
  }

  if (method === "turn/started") {
    const turn = (params.turn ?? {}) as JsonObject;
    activeTurnId = typeof turn.id === "string" ? turn.id : activeTurnId;
    sendToPlugin({ type: "turn.started", turnId: activeTurnId ?? "" });
    return;
  }

  if (method === "turn/completed") {
    const turn = (params.turn ?? {}) as JsonObject;
    activeTurnId = null;
    sendToPlugin({ type: "turn.completed", status: String(turn.status ?? "completed") });
    return;
  }

  if (method === "error" || method === "warning") {
    sendToPlugin({ type: "agent.status", text: String(params.message ?? method), level: "error" });
  }
};

app.onServerRequest = (message) => {
  const method = String(message.method);
  const id = message.id as RpcId;
  const params = (message.params ?? {}) as JsonObject;

  if (method === "item/tool/call") {
    if (!activePlugin || activePlugin.readyState !== WebSocket.OPEN) {
      app.respond(id, {
        success: false,
        contentItems: [{ type: "inputText", text: "The local Figma plugin is not connected." }]
      });
      return;
    }
    sendToPlugin({
      type: "tool.request",
      requestId: id,
      namespace: params.namespace ?? null,
      tool: String(params.tool ?? ""),
      arguments: params.arguments ?? {}
    });
    return;
  }

  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    app.respond(id, { decision: "decline" });
    return;
  }

  if (method === "item/tool/requestUserInput") {
    app.respond(id, { answers: {} });
    return;
  }

  app.respondError(id, -32601, `Unsupported client request: ${method}`);
};

const socketServer = new WebSocketServer({ host: "127.0.0.1", port: PORT });

socketServer.on("connection", (socket) => {
  let authenticated = false;
  const authTimeout = setTimeout(() => socket.close(4001, "Authentication timeout"), 5000);

  socket.on("message", async (raw) => {
    let message: JsonObject;
    try {
      message = JSON.parse(String(raw)) as JsonObject;
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (!authenticated) {
      if (message.type !== "auth" || message.token !== token) {
        socket.close(4003, "Invalid bridge token");
        return;
      }
      authenticated = true;
      clearTimeout(authTimeout);
      if (activePlugin && activePlugin !== socket) activePlugin.close(4000, "Replaced by another Figma window");
      activePlugin = socket;
      socket.send(JSON.stringify({ type: "auth.ok", threadId }));
      socket.send(JSON.stringify(modelSettingsMessage()));
      return;
    }

    try {
      if (message.type === "context.update") {
        latestContext = message.context ?? null;
        return;
      }

      if (message.type === "chat.prompt") {
        if (activeTurnId) {
          socket.send(JSON.stringify({ type: "error", message: "Codex is already working on a request." }));
          return;
        }
        const settings = resolveModelSettings(message.model, message.effort);
        const activeThread = await ensureThread(settings);
        const prompt = String(message.text ?? "").trim();
        if (!prompt) return;
        const contextSuffix = latestContext
          ? `\n\n<active_figma_context>${JSON.stringify(latestContext)}</active_figma_context>`
          : "";
        const response = await app.request("turn/start", {
          threadId: activeThread,
          model: settings.model,
          effort: settings.effort,
          input: [{ type: "text", text: `${prompt}${contextSuffix}` }]
        });
        activeTurnId = String(response.turn.id);
        return;
      }

      if (message.type === "chat.interrupt" && threadId && activeTurnId) {
        await app.request("turn/interrupt", { threadId, turnId: activeTurnId });
        return;
      }

      if (message.type === "thread.new") {
        if (activeTurnId) throw new Error("Wait for the current turn to finish before starting a new chat.");
        threadId = null;
        socket.send(JSON.stringify({ type: "thread.reset" }));
        return;
      }

      if (message.type === "tool.result") {
        const requestId = message.requestId as RpcId | undefined;
        if (requestId === undefined || (typeof requestId !== "string" && typeof requestId !== "number")) {
          throw new Error("Missing tool request id");
        }
        if (message.ok === false) {
          app.respond(requestId, {
            success: false,
            contentItems: [{ type: "inputText", text: String(message.error ?? "Figma operation failed") }]
          });
          return;
        }

        const result = (message.result ?? null) as JsonObject | null;
        const contentItems: JsonObject[] = [];
        if (result?.kind === "image" && typeof result.imageDataUrl === "string") {
          contentItems.push({ type: "inputImage", imageUrl: result.imageDataUrl });
          contentItems.push({ type: "inputText", text: JSON.stringify(result.node ?? {}) });
        } else {
          contentItems.push({ type: "inputText", text: JSON.stringify(result) });
        }
        app.respond(requestId, { success: true, contentItems });
      }
    } catch (error) {
      socket.send(
        JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })
      );
    }
  });

  socket.on("close", () => {
    clearTimeout(authTimeout);
    if (activePlugin === socket) activePlugin = null;
  });
});

await app.initialize();
await loadModelSettings();

console.log("\nCodex Canvas bridge is ready.");
console.log(`Codex binary: ${CODEX_BIN}`);
console.log(`WebSocket: ws://127.0.0.1:${PORT}`);
console.log(`Connection token: ${token}`);
console.log("Open Codex Canvas from Figma > Plugins > Development and paste the token once.\n");

function shutdown(): void {
  socketServer.close();
  app.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
