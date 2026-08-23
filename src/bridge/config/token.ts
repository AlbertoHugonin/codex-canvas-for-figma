import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RUNTIME_DIR, TOKEN_FILE } from "./paths.js";

export function loadOrCreateToken(): string {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();

  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}
