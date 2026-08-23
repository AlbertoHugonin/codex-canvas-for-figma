import { WebSocket, WebSocketServer } from "ws";
import type { JsonObject } from "../types.js";

export interface PluginConnectionHandler {
  onAuthenticated(socket: WebSocket): Promise<void>;
  onMessage(socket: WebSocket, message: JsonObject): Promise<void>;
  onDisconnected(socket: WebSocket): void;
}

export class PluginWebSocketServer {
  private server: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string
  ) {}

  get connected(): boolean {
    return this.activeSocket?.readyState === WebSocket.OPEN;
  }

  start(handler: PluginConnectionHandler): void {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: this.port });
    this.server.on("connection", (socket) => this.accept(socket, handler));
  }

  send(message: JsonObject): void {
    if (this.activeSocket) this.sendTo(this.activeSocket, message);
  }

  sendTo(socket: WebSocket, message: JsonObject): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  close(): void {
    for (const client of this.server?.clients ?? []) client.terminate();
    this.activeSocket = null;
    this.server?.close();
    this.server = null;
  }

  private accept(socket: WebSocket, handler: PluginConnectionHandler): void {
    let authenticated = false;
    const authTimeout = setTimeout(() => socket.close(4001, "Authentication timeout"), 5000);

    socket.on("message", (raw) => {
      void this.handleRaw(socket, raw, handler, () => authenticated, () => {
        authenticated = true;
        clearTimeout(authTimeout);
      }).catch((error) => {
        this.sendTo(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      if (this.activeSocket === socket) this.activeSocket = null;
      handler.onDisconnected(socket);
    });
  }

  private async handleRaw(
    socket: WebSocket,
    raw: unknown,
    handler: PluginConnectionHandler,
    isAuthenticated: () => boolean,
    markAuthenticated: () => void
  ): Promise<void> {
    let message: JsonObject;
    try {
      message = JSON.parse(String(raw)) as JsonObject;
    } catch {
      this.sendTo(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (!isAuthenticated()) {
      if (message.type !== "auth" || message.token !== this.token) {
        socket.close(4003, "Invalid bridge token");
        return;
      }

      markAuthenticated();
      if (this.activeSocket && this.activeSocket !== socket) {
        this.activeSocket.close(4000, "Replaced by another Figma window");
      }
      this.activeSocket = socket;
      await handler.onAuthenticated(socket);
      return;
    }

    if (this.activeSocket === socket) await handler.onMessage(socket, message);
  }
}
