import { WebSocket } from "ws";
import type { WorkspaceStore } from "../config/workspace-store.js";
import type { AccountService } from "../codex/account-service.js";
import type { AppServerClient } from "../codex/app-server-client.js";
import type { ModelService } from "../codex/model-service.js";
import type { ThreadService } from "../codex/thread-service.js";
import type { JsonObject, RpcId } from "../types.js";
import type { PluginConnectionHandler } from "./plugin-websocket-server.js";
import type { PluginWebSocketServer } from "./plugin-websocket-server.js";

export class BridgeController implements PluginConnectionHandler {
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private latestContext: unknown = null;

  constructor(
    private readonly app: AppServerClient,
    private readonly accounts: AccountService,
    private readonly workspace: WorkspaceStore,
    private readonly models: ModelService,
    private readonly threads: ThreadService,
    private readonly plugin: PluginWebSocketServer
  ) {
    this.app.onNotification = (message) => this.handleNotification(message);
    this.app.onServerRequest = (message) => this.handleServerRequest(message);
  }

  async initialize(): Promise<void> {
    await this.app.initialize();
    await this.accounts.refresh();
    await this.models.load();
    this.plugin.send(this.models.message());
  }

  async onAuthenticated(socket: WebSocket): Promise<void> {
    this.plugin.sendTo(socket, {
      type: "auth.ok",
      threadId: this.threadId,
      turnId: this.activeTurnId
    });
    await this.sendAccountState(socket);
    this.plugin.sendTo(socket, this.models.message());
    this.plugin.sendTo(socket, this.workspace.stateMessage());
    await this.sendThreadList(socket);
    if (this.threadId) await this.sendThreadHistory(socket, this.threadId);
  }

  async onMessage(socket: WebSocket, message: JsonObject): Promise<void> {
    if (message.type === "account.get") {
      await this.sendAccountState(socket);
      return;
    }

    if (message.type === "account.login.start") {
      await this.startAccountLogin(socket);
      return;
    }

    if (message.type === "account.login.cancel") {
      await this.cancelAccountLogin(socket);
      return;
    }

    if (message.type === "account.logout") {
      await this.logoutAccount(socket);
      return;
    }

    if (message.type === "workspace.get") {
      this.plugin.sendTo(socket, this.workspace.stateMessage());
      return;
    }

    if (message.type === "workspace.set") {
      await this.changeWorkspace(socket, message.workspaceRoot);
      return;
    }

    if (message.type === "context.update") {
      this.latestContext = message.context ?? null;
      return;
    }

    if (message.type === "chat.prompt") {
      await this.startPrompt(socket, message);
      return;
    }

    if (message.type === "chat.interrupt" && this.threadId && this.activeTurnId) {
      await this.threads.interrupt(this.threadId, this.activeTurnId);
      return;
    }

    if (message.type === "thread.select") {
      await this.selectThread(socket, message);
      return;
    }

    if (message.type === "thread.new") {
      await this.startNewThread(socket);
      return;
    }

    if (message.type === "tool.result") this.handleToolResult(message);
  }

  onDisconnected(_socket: WebSocket): void {}

  close(): void {
    this.app.close();
  }

  private async changeWorkspace(socket: WebSocket, workspaceRoot: unknown): Promise<void> {
    if (this.activeTurnId) throw new Error("Wait for the current turn to finish before changing workspace.");
    const changed = this.workspace.update(String(workspaceRoot ?? ""));
    if (!changed) {
      this.plugin.sendTo(socket, this.workspace.stateMessage());
      return;
    }

    const previousThreadId = this.threadId;
    this.threadId = null;
    this.plugin.sendTo(socket, this.workspace.stateMessage());
    this.plugin.sendTo(socket, { type: "thread.reset", reason: "workspace.changed" });
    await this.sendThreadList(socket);
    if (previousThreadId) this.threads.unsubscribe(previousThreadId);
  }

  private async startPrompt(socket: WebSocket, message: JsonObject): Promise<void> {
    if (!this.accounts.canUseCodex) {
      this.plugin.sendTo(socket, {
        type: "error",
        message: "Connect ChatGPT in Settings before starting a conversation."
      });
      return;
    }
    if (this.activeTurnId) {
      this.plugin.sendTo(socket, { type: "error", message: "Codex is already working on a request." });
      return;
    }

    const settings = this.models.resolve(message.model, message.effort);
    const activeThread = await this.ensureThread(settings);
    const prompt = String(message.text ?? "").trim();
    if (!prompt) return;
    this.activeTurnId = await this.threads.startTurn(activeThread, settings, prompt, this.latestContext);
  }

  private async selectThread(socket: WebSocket, message: JsonObject): Promise<void> {
    if (this.activeTurnId) throw new Error("Wait for the current turn to finish before changing conversation.");
    const selectedThreadId = String(message.threadId ?? "").trim();
    if (!selectedThreadId) throw new Error("Missing conversation id.");
    if (selectedThreadId === this.threadId) {
      await this.sendThreadHistory(socket, selectedThreadId);
      return;
    }

    const settings = this.models.resolve(message.model, message.effort);
    const previousThreadId = this.threadId;
    const resumed = await this.threads.resume(selectedThreadId, settings);
    this.threadId = resumed.threadId;
    this.activeTurnId = null;
    this.plugin.sendTo(socket, {
      type: "thread.selected",
      threadId: this.threadId,
      messages: resumed.messages
    });
    await this.sendThreadList(socket);
    if (previousThreadId && previousThreadId !== this.threadId) this.threads.unsubscribe(previousThreadId);
  }

  private async startNewThread(socket: WebSocket): Promise<void> {
    if (this.activeTurnId) throw new Error("Wait for the current turn to finish before starting a new chat.");
    const previousThreadId = this.threadId;
    this.threadId = null;
    this.plugin.sendTo(socket, { type: "thread.reset" });
    await this.sendThreadList(socket);
    if (previousThreadId) this.threads.unsubscribe(previousThreadId);
  }

  private async ensureThread(settings: { model?: string; effort?: string }): Promise<string> {
    if (this.threadId) return this.threadId;
    this.threadId = await this.threads.start(settings);
    this.plugin.send({ type: "thread.ready", threadId: this.threadId });
    void this.refreshThreadList();
    return this.threadId;
  }

  private async sendThreadList(socket: WebSocket): Promise<void> {
    this.plugin.sendTo(socket, await this.threads.list(this.threadId));
  }

  private async refreshThreadList(): Promise<void> {
    try {
      this.plugin.send(await this.threads.list(this.threadId));
    } catch (error) {
      console.error("Unable to refresh Codex threads:", error);
    }
  }

  private async sendThreadHistory(socket: WebSocket, threadId: string): Promise<void> {
    this.plugin.sendTo(socket, await this.threads.historyMessage(threadId));
  }

  private handleNotification(message: JsonObject): void {
    const method = String(message.method);
    const params = (message.params ?? {}) as JsonObject;

    if (method === "account/login/completed") {
      const completed = this.accounts.loginCompletedMessage(params);
      this.plugin.send(completed);
      void this.refreshAccount(completed.success === true);
      return;
    }

    if (method === "account/updated") {
      void this.refreshAccount(false);
      return;
    }

    const notificationThreadId = typeof params.threadId === "string" ? params.threadId : null;
    if (notificationThreadId && this.threadId && notificationThreadId !== this.threadId) return;

    if (method === "item/agentMessage/delta") {
      this.plugin.send({ type: "agent.delta", delta: String(params.delta ?? "") });
      return;
    }

    if (method === "item/started") {
      const item = (params.item ?? {}) as JsonObject;
      if (item.type === "agentMessage") {
        this.plugin.send({ type: "agent.message.started", itemId: String(item.id ?? "") });
        return;
      }
      if (item.type === "dynamicToolCall") {
        this.plugin.send({ type: "agent.status", text: `Figma: ${String(item.tool ?? "operation")}` });
      }
      return;
    }

    if (method === "turn/started") {
      const turn = (params.turn ?? {}) as JsonObject;
      this.activeTurnId = typeof turn.id === "string" ? turn.id : this.activeTurnId;
      this.plugin.send({ type: "turn.started", turnId: this.activeTurnId ?? "" });
      return;
    }

    if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as JsonObject;
      this.activeTurnId = null;
      this.plugin.send({ type: "turn.completed", status: String(turn.status ?? "completed") });
      void this.refreshThreadList();
      return;
    }

    if (method === "error" || method === "warning") {
      this.plugin.send({ type: "agent.status", text: String(params.message ?? method), level: "error" });
    }
  }

  private handleServerRequest(message: JsonObject): void {
    const method = String(message.method);
    const id = message.id as RpcId;
    const params = (message.params ?? {}) as JsonObject;

    if (method === "item/tool/call") {
      if (!this.plugin.connected) {
        this.app.respond(id, {
          success: false,
          contentItems: [{ type: "inputText", text: "The local Figma plugin is not connected." }]
        });
        return;
      }
      this.plugin.send({
        type: "tool.request",
        requestId: id,
        namespace: params.namespace ?? null,
        tool: String(params.tool ?? ""),
        arguments: params.arguments ?? {}
      });
      return;
    }

    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.app.respond(id, { decision: "decline" });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      this.app.respond(id, { answers: {} });
      return;
    }

    this.app.respondError(id, -32601, `Unsupported client request: ${method}`);
  }

  private handleToolResult(message: JsonObject): void {
    const requestId = message.requestId as RpcId | undefined;
    if (requestId === undefined || (typeof requestId !== "string" && typeof requestId !== "number")) {
      throw new Error("Missing tool request id");
    }
    if (message.ok === false) {
      this.app.respond(requestId, {
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
    this.app.respond(requestId, { success: true, contentItems });
  }

  private async startAccountLogin(socket: WebSocket): Promise<void> {
    try {
      this.plugin.sendTo(socket, await this.accounts.startLogin());
    } catch (error) {
      console.error("Unable to start ChatGPT sign-in:", error);
      this.plugin.sendTo(socket, {
        type: "account.login.completed",
        success: false,
        error: "Unable to start ChatGPT sign-in."
      });
    }
  }

  private async sendAccountState(socket: WebSocket): Promise<void> {
    this.plugin.sendTo(socket, await this.accounts.refresh());
    const pendingLogin = this.accounts.pendingLoginMessage();
    if (pendingLogin) this.plugin.sendTo(socket, pendingLogin);
  }

  private async cancelAccountLogin(socket: WebSocket): Promise<void> {
    try {
      await this.accounts.cancelLogin();
      this.plugin.sendTo(socket, await this.accounts.refresh());
    } catch (error) {
      console.error("Unable to cancel ChatGPT sign-in:", error);
      this.plugin.sendTo(socket, {
        type: "error",
        message: "Unable to cancel ChatGPT sign-in."
      });
    }
  }

  private async logoutAccount(socket: WebSocket): Promise<void> {
    try {
      await this.accounts.logout();
      this.plugin.sendTo(socket, await this.accounts.refresh());
    } catch (error) {
      console.error("Unable to sign out from ChatGPT:", error);
      this.plugin.sendTo(socket, { type: "error", message: "Unable to sign out from ChatGPT." });
    }
  }

  private async refreshAccount(reloadModels: boolean): Promise<void> {
    this.plugin.send(await this.accounts.refresh());
    if (!reloadModels || !this.accounts.canUseCodex) return;
    await this.models.load();
    this.plugin.send(this.models.message());
  }
}
