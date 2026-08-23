export type JsonObject = Record<string, unknown>;

export type RpcId = number | string;

export type ModelChoice = {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort: string;
  efforts: Array<{ value: string; description: string }>;
};

export type ModelSettings = {
  model?: string;
  effort?: string;
};

export type ChatHistoryMessage = {
  role: "user" | "agent";
  text: string;
};
