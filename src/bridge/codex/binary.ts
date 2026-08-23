import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

type CodexTarget = {
  packageName: string;
  targetTriple: string;
};

const LOCAL_TARGETS: Record<string, CodexTarget> = {
  "darwin-arm64": {
    packageName: "@openai/codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin"
  },
  "darwin-x64": {
    packageName: "@openai/codex-darwin-x64",
    targetTriple: "x86_64-apple-darwin"
  },
  "linux-arm64": {
    packageName: "@openai/codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl"
  },
  "linux-x64": {
    packageName: "@openai/codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl"
  },
  "win32-arm64": {
    packageName: "@openai/codex-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc"
  },
  "win32-x64": {
    packageName: "@openai/codex-win32-x64",
    targetTriple: "x86_64-pc-windows-msvc"
  }
};

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command: string): string | null {
  const commandNames =
    process.platform === "win32" && !command.includes(".")
      ? [`${command}.exe`, `${command}.com`, `${command}.cmd`, `${command}.bat`, command]
      : [command];

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const commandName of commandNames) {
      const candidate = join(directory, commandName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveConfiguredBinary(configured: string): string {
  const candidate =
    isAbsolute(configured) || configured.includes("/") || configured.includes("\\")
      ? resolve(configured)
      : findOnPath(configured);

  if (candidate && isExecutableFile(candidate)) return candidate;
  throw new Error(
    `CODEX_BIN points to an unavailable executable: ${configured}\n` +
      "Set it to the absolute path of a Codex native executable."
  );
}

function resolveLocalBinary(): string {
  const target = LOCAL_TARGETS[`${process.platform}-${process.arch}`];
  if (!target) {
    throw new Error(`Codex Canvas does not support ${process.platform} (${process.arch}).`);
  }

  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve(`${target.packageName}/package.json`));
  } catch {
    throw new Error(
      `The project-local Codex runtime for ${process.platform} (${process.arch}) is missing. ` +
        "Run npm ci in the Codex Canvas project directory."
    );
  }

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const candidate = join(packageRoot, "vendor", target.targetTriple, "bin", executableName);
  if (isExecutableFile(candidate)) return candidate;

  throw new Error(
    `The project-local Codex runtime is incomplete: ${candidate}\n` +
      "Run npm ci in the Codex Canvas project directory."
  );
}

export function resolveCodexBinary(): string {
  const configured = process.env.CODEX_BIN?.trim();
  return configured ? resolveConfiguredBinary(configured) : resolveLocalBinary();
}
