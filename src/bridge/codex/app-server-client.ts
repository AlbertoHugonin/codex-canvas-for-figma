import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { CODEX_HOME_DIR } from "../config/paths.js";
import type { JsonObject, RpcId } from "../types.js";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private failure: Error | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();

  onNotification?: (message: JsonObject) => void;
  onServerRequest?: (message: JsonObject) => void;

  constructor(binary: string, cwd: string) {
    mkdirSync(CODEX_HOME_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(CODEX_HOME_DIR, 0o700);

    this.child = spawn(binary, appServerArguments(), {
      cwd,
      env: appServerEnvironment(CODEX_HOME_DIR),
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
      this.fail(new Error(`Unable to start Codex at ${binary}: ${error.message}`));
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

function appServerArguments(): string[] {
  const args = ["app-server"];
  if (process.platform === "win32") {
    args.push("-c", 'windows.sandbox="unelevated"');
  }
  args.push("--stdio");
  return args;
}

function appServerEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CODEX_THREAD_ID",
    "CODEX_PERMISSION_PROFILE",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY"
  ]) {
    delete env[key];
  }
  env.CODEX_HOME = codexHome;
  return env;
}
