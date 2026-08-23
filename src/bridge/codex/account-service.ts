import type { JsonObject } from "../types.js";
import type { AppServerClient } from "./app-server-client.js";

type AccountState = {
  authenticated: boolean;
  requiresOpenaiAuth: boolean;
  accountType: string | null;
  email: string | null;
  planType: string | null;
};

type LoginChallenge = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

const SIGNED_OUT_STATE: AccountState = {
  authenticated: false,
  requiresOpenaiAuth: true,
  accountType: null,
  email: null,
  planType: null
};

export class AccountService {
  private state: AccountState = { ...SIGNED_OUT_STATE };
  private pendingLogin: LoginChallenge | null = null;
  private loginStart: Promise<JsonObject> | null = null;

  constructor(private readonly app: AppServerClient) {}

  get canUseCodex(): boolean {
    return this.state.authenticated || !this.state.requiresOpenaiAuth;
  }

  message(): JsonObject {
    return { type: "account.state", ...this.state };
  }

  pendingLoginMessage(): JsonObject | null {
    return this.pendingLogin ? loginChallengeMessage(this.pendingLogin) : null;
  }

  async refresh(): Promise<JsonObject> {
    try {
      const response = (await this.app.request("account/read", { refreshToken: false })) as JsonObject;
      this.state = parseAccountState(response);
    } catch (error) {
      console.error("Unable to read Codex account state:", error);
    }
    return this.message();
  }

  async startLogin(): Promise<JsonObject> {
    if (this.pendingLogin) return loginChallengeMessage(this.pendingLogin);

    this.loginStart ??= this.createLogin();
    try {
      return await this.loginStart;
    } finally {
      this.loginStart = null;
    }
  }

  private async createLogin(): Promise<JsonObject> {
    const response = (await this.app.request("account/login/start", {
      type: "chatgptDeviceCode"
    })) as JsonObject;
    const loginId = stringValue(response.loginId);
    const verificationUrl = stringValue(response.verificationUrl);
    const userCode = stringValue(response.userCode);
    if (response.type !== "chatgptDeviceCode" || !loginId || !verificationUrl || !userCode) {
      throw new Error("Codex did not return a valid device sign-in challenge.");
    }

    this.pendingLogin = { loginId, verificationUrl, userCode };
    return loginChallengeMessage(this.pendingLogin);
  }

  async cancelLogin(): Promise<void> {
    const loginId = this.pendingLogin?.loginId;
    if (!loginId) return;
    await this.app.request("account/login/cancel", { loginId });
    this.pendingLogin = null;
  }

  async logout(): Promise<void> {
    await this.app.request("account/logout", {});
    this.pendingLogin = null;
    this.state = { ...SIGNED_OUT_STATE };
  }

  loginCompletedMessage(params: JsonObject): JsonObject {
    const loginId = nullableStringValue(params.loginId);
    if (loginId === null || loginId === this.pendingLogin?.loginId) this.pendingLogin = null;
    return {
      type: "account.login.completed",
      success: params.success === true,
      error: nullableSafeMessage(params.error)
    };
  }
}

function loginChallengeMessage(challenge: LoginChallenge): JsonObject {
  return { type: "account.login.challenge", ...challenge };
}

function parseAccountState(response: JsonObject): AccountState {
  const account = isJsonObject(response.account) ? response.account : null;
  return {
    authenticated: account !== null,
    requiresOpenaiAuth: response.requiresOpenaiAuth === true,
    accountType: account ? nullableStringValue(account.type) : null,
    email: account ? nullableStringValue(account.email) : null,
    planType: account ? nullableStringValue(account.planType) : null
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStringValue(value: unknown): string | null {
  const valueString = stringValue(value);
  return valueString || null;
}

function nullableSafeMessage(value: unknown): string | null {
  const message = stringValue(value).replace(/\s+/g, " ");
  return message ? message.slice(0, 300) : null;
}
