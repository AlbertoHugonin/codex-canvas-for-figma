import { THREAD_SOURCE } from "../config/paths.js";
import type { ThreadRegistry } from "../config/thread-registry.js";
import type { WorkspaceStore } from "../config/workspace-store.js";
import { DEVELOPER_INSTRUCTIONS, DYNAMIC_TOOLS } from "../figma/agent-config.js";
import type { ChatHistoryMessage, JsonObject, ModelSettings } from "../types.js";
import type { AppServerClient } from "./app-server-client.js";

type ResumedThread = {
  threadId: string;
  messages: ChatHistoryMessage[];
};

export class ThreadService {
  constructor(
    private readonly app: AppServerClient,
    private readonly workspace: WorkspaceStore,
    private readonly registry: ThreadRegistry
  ) {}

  async list(activeThreadId: string | null): Promise<JsonObject> {
    const response = await this.app.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["appServer", "vscode"],
      cwd: this.workspace.activeRoot
    });
    const threads = (Array.isArray(response?.data) ? response.data : [])
      .filter((raw: unknown) => this.isVisibleCanvasThread(raw))
      .map(threadChoice)
      .filter((entry: JsonObject | null): entry is JsonObject => entry !== null);
    return { type: "threads.available", threads, threadId: activeThreadId };
  }

  async historyMessage(threadId: string): Promise<JsonObject> {
    const response = await this.read(threadId);
    return {
      type: "thread.selected",
      threadId,
      messages: historyMessages(response?.thread)
    };
  }

  async start(settings: ModelSettings): Promise<string> {
    const response = await this.app.request("thread/start", {
      model: settings.model,
      config: settings.effort ? { model_reasoning_effort: settings.effort } : undefined,
      cwd: this.workspace.activeRoot,
      permissions: this.workspace.permissionProfile,
      runtimeWorkspaceRoots: [this.workspace.activeRoot],
      approvalPolicy: "never",
      serviceName: "codex_canvas_figma",
      threadSource: THREAD_SOURCE,
      personality: "friendly",
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      dynamicTools: DYNAMIC_TOOLS
    });
    const threadId = String(response.thread.id);
    this.registry.register(threadId, this.workspace.activeRoot);
    return threadId;
  }

  async resume(threadId: string, settings: ModelSettings): Promise<ResumedThread> {
    const historyResponse = await this.read(threadId);
    if (!this.workspace.owns(historyResponse?.thread?.cwd)) {
      throw new Error("This conversation belongs to a different workspace.");
    }

    const response = await this.app.request("thread/resume", {
      threadId,
      model: settings.model,
      config: settings.effort ? { model_reasoning_effort: settings.effort } : undefined,
      cwd: this.workspace.activeRoot,
      permissions: this.workspace.permissionProfile,
      runtimeWorkspaceRoots: [this.workspace.activeRoot],
      approvalPolicy: "never",
      personality: "friendly",
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      dynamicTools: DYNAMIC_TOOLS
    });

    return {
      threadId: String(response.thread.id),
      messages: historyMessages(historyResponse?.thread)
    };
  }

  async startTurn(
    threadId: string,
    settings: ModelSettings,
    prompt: string,
    figmaContext: unknown
  ): Promise<string> {
    const contextSuffix = figmaContext
      ? `\n\n<active_figma_context>${JSON.stringify(figmaContext)}</active_figma_context>`
      : "";
    const response = await this.app.request("turn/start", {
      threadId,
      model: settings.model,
      effort: settings.effort,
      cwd: this.workspace.activeRoot,
      approvalPolicy: "never",
      permissions: this.workspace.permissionProfile,
      runtimeWorkspaceRoots: [this.workspace.activeRoot],
      input: [{ type: "text", text: `${prompt}${contextSuffix}` }]
    });
    return String(response.turn.id);
  }

  interrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.app.request("turn/interrupt", { threadId, turnId });
  }

  unsubscribe(threadId: string): void {
    void this.app
      .request("thread/unsubscribe", { threadId })
      .catch((error) => console.error("Unable to unsubscribe from the previous thread:", error));
  }

  private read(threadId: string): Promise<any> {
    return this.app.request("thread/read", { threadId, includeTurns: true });
  }

  private isVisibleCanvasThread(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const thread = raw as JsonObject;
    const id = String(thread.id ?? "").trim();
    return (
      Boolean(id) &&
      (thread.threadSource === THREAD_SOURCE || this.registry.has(id, this.workspace.activeRoot))
    );
  }
}

function cleanUserMessage(text: string): string {
  return text.replace(/\n\n<active_figma_context>[\s\S]*<\/active_figma_context>\s*$/, "").trim();
}

function historyMessages(rawThread: unknown): ChatHistoryMessage[] {
  if (!rawThread || typeof rawThread !== "object") return [];
  const thread = rawThread as JsonObject;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages: ChatHistoryMessage[] = [];

  for (const rawTurn of turns) {
    if (!rawTurn || typeof rawTurn !== "object") continue;
    const turn = rawTurn as JsonObject;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as JsonObject;
      if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = cleanUserMessage(
          content
            .flatMap((rawContent: unknown) => {
              if (!rawContent || typeof rawContent !== "object") return [];
              const contentItem = rawContent as JsonObject;
              return contentItem.type === "text" && typeof contentItem.text === "string"
                ? [contentItem.text]
                : [];
            })
            .join("\n")
        );
        if (text) messages.push({ role: "user", text });
      }
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push({ role: "agent", text: item.text });
      }
    }
  }

  return messages;
}

function threadChoice(raw: unknown): JsonObject | null {
  if (!raw || typeof raw !== "object") return null;
  const thread = raw as JsonObject;
  const id = String(thread.id ?? "").trim();
  if (!id) return null;
  const preview = cleanUserMessage(String(thread.preview ?? "")).replace(/\s+/g, " ").trim();
  const name = String(thread.name ?? "").replace(/\s+/g, " ").trim();
  return {
    id,
    title: name || preview || "Untitled conversation",
    createdAt: Number(thread.createdAt ?? 0),
    updatedAt: Number(thread.updatedAt ?? thread.createdAt ?? 0)
  };
}
