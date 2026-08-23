import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonObject } from "../types.js";
import { THREAD_REGISTRY_FILE } from "./paths.js";

type RegisteredThread = {
  id: string;
  cwd: string;
};

export class ThreadRegistry {
  private entries: RegisteredThread[];

  constructor() {
    this.entries = this.load();
  }

  has(threadId: string, cwd: string): boolean {
    return this.entries.some((entry) => entry.id === threadId && samePath(entry.cwd, cwd));
  }

  register(threadId: string, cwd: string): void {
    const id = threadId.trim();
    const normalizedCwd = resolve(cwd);
    if (!id || this.has(id, normalizedCwd)) return;

    const nextEntries = [...this.entries, { id, cwd: normalizedCwd }];
    this.persist(nextEntries);
    this.entries = nextEntries;
  }

  private load(): RegisteredThread[] {
    if (!existsSync(THREAD_REGISTRY_FILE)) return [];
    try {
      const saved = JSON.parse(readFileSync(THREAD_REGISTRY_FILE, "utf8")) as JsonObject;
      const rawEntries = Array.isArray(saved.threads) ? saved.threads : [];
      return rawEntries.flatMap((raw): RegisteredThread[] => {
        if (!raw || typeof raw !== "object") return [];
        const entry = raw as JsonObject;
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
        return id && cwd ? [{ id, cwd: resolve(cwd) }] : [];
      });
    } catch (error) {
      console.warn(`Ignoring invalid thread registry: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private persist(entries: RegisteredThread[]): void {
    mkdirSync(dirname(THREAD_REGISTRY_FILE), { recursive: true });
    const temporary = `${THREAD_REGISTRY_FILE}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, threads: entries }, null, 2)}\n`,
      "utf8"
    );
    if (existsSync(THREAD_REGISTRY_FILE)) unlinkSync(THREAD_REGISTRY_FILE);
    renameSync(temporary, THREAD_REGISTRY_FILE);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
