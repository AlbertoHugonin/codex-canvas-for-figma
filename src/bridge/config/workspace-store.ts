import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonObject } from "../types.js";
import { CODEX_HOME_DIR, ROOT, WORKSPACE_CONFIG_FILE } from "./paths.js";

export class WorkspaceStore {
  private configuredWorkspace: string | null;

  constructor() {
    this.configuredWorkspace = this.load();
  }

  get configuredRoot(): string | null {
    return this.configuredWorkspace;
  }

  get activeRoot(): string {
    return this.configuredWorkspace ?? ROOT;
  }

  get permissionProfile(): ":workspace" | ":read-only" {
    return this.configuredWorkspace ? ":workspace" : ":read-only";
  }

  stateMessage(): JsonObject {
    return {
      type: "workspace.state",
      workspaceRoot: this.configuredWorkspace,
      writable: Boolean(this.configuredWorkspace)
    };
  }

  update(value: string): boolean {
    const requested = value.trim();
    const nextWorkspace = requested ? this.validate(requested) : null;
    if (this.sameConfiguredWorkspace(nextWorkspace, this.configuredWorkspace)) return false;

    this.persist(nextWorkspace);
    this.configuredWorkspace = nextWorkspace;
    return true;
  }

  owns(candidate: unknown): boolean {
    if (typeof candidate !== "string" || !candidate) return false;
    return this.samePath(candidate, this.activeRoot);
  }

  private load(): string | null {
    const configured = process.env.CODEX_CANVAS_WORKSPACE?.trim();
    if (configured) {
      try {
        return this.validate(configured);
      } catch (error) {
        console.warn(
          `Ignoring invalid CODEX_CANVAS_WORKSPACE: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (!existsSync(WORKSPACE_CONFIG_FILE)) return null;
    try {
      const saved = JSON.parse(readFileSync(WORKSPACE_CONFIG_FILE, "utf8")) as JsonObject;
      return typeof saved.workspaceRoot === "string" ? this.validate(saved.workspaceRoot) : null;
    } catch (error) {
      console.warn(`Ignoring invalid workspace settings: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private validate(value: string): string {
    const candidate = value.trim();
    if (!candidate || !isAbsolute(candidate)) throw new Error("Workspace must be an absolute path.");
    const resolvedRoot = resolve(candidate);
    if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
      throw new Error(`Workspace does not exist or is not a directory: ${resolvedRoot}`);
    }
    mkdirSync(CODEX_HOME_DIR, { recursive: true, mode: 0o700 });
    if (pathsOverlap(realpathSync(resolvedRoot), realpathSync(CODEX_HOME_DIR))) {
      throw new Error("Workspace cannot contain the private Codex state directory.");
    }
    return resolvedRoot;
  }

  private persist(workspaceRoot: string | null): void {
    if (workspaceRoot === null) {
      if (existsSync(WORKSPACE_CONFIG_FILE)) unlinkSync(WORKSPACE_CONFIG_FILE);
      return;
    }

    mkdirSync(dirname(WORKSPACE_CONFIG_FILE), { recursive: true });
    const temporary = `${WORKSPACE_CONFIG_FILE}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ workspaceRoot }, null, 2)}\n`,
      "utf8"
    );
    if (existsSync(WORKSPACE_CONFIG_FILE)) unlinkSync(WORKSPACE_CONFIG_FILE);
    renameSync(temporary, WORKSPACE_CONFIG_FILE);
  }

  private sameConfiguredWorkspace(left: string | null, right: string | null): boolean {
    if (left === null || right === null) return left === right;
    return this.samePath(left, right);
  }

  private samePath(left: string, right: string): boolean {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === "" ||
    (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative))
  );
}
