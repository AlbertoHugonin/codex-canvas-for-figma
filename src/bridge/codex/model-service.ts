import type { JsonObject, ModelChoice, ModelSettings } from "../types.js";
import type { AppServerClient } from "./app-server-client.js";

export class ModelService {
  private availableModels: ModelChoice[] = [];
  private configuredModel = "";
  private configuredEffort = "";

  constructor(
    private readonly app: AppServerClient,
    private readonly configCwd: string
  ) {}

  message(): JsonObject {
    return {
      type: "models.available",
      models: this.availableModels,
      selectedModel: this.configuredModel,
      selectedEffort: this.configuredEffort
    };
  }

  async load(): Promise<void> {
    try {
      const [modelResponse, configResponse] = await Promise.all([
        this.app.request("model/list", { limit: 100, includeHidden: false }),
        this.app.request("config/read", { cwd: this.configCwd, includeLayers: false })
      ]);

      const rawModels = Array.isArray(modelResponse?.data) ? modelResponse.data : [];
      this.availableModels = rawModels.flatMap((raw: unknown) => this.parseModel(raw));

      const config = (configResponse?.config ?? {}) as JsonObject;
      const catalogDefault = this.availableModels.find((model) => model.isDefault) ?? this.availableModels[0];
      this.configuredModel = String(config.model ?? catalogDefault?.id ?? "");
      const selectedModel =
        this.availableModels.find((model) => model.id === this.configuredModel) ?? catalogDefault;
      const requestedEffort = String(config.model_reasoning_effort ?? "");
      this.configuredEffort = selectedModel?.efforts.some((effort) => effort.value === requestedEffort)
        ? requestedEffort
        : (selectedModel?.defaultEffort ?? requestedEffort);
    } catch (error) {
      console.error("Unable to load Codex model catalog:", error);
    }
  }

  resolve(modelValue: unknown, effortValue: unknown): ModelSettings {
    const requestedModel = String(modelValue ?? "").trim();
    const selectedModel =
      this.availableModels.find((model) => model.id === requestedModel) ??
      this.availableModels.find((model) => model.id === this.configuredModel) ??
      this.availableModels.find((model) => model.isDefault) ??
      this.availableModels[0];
    if (!selectedModel) return {};

    const requestedEffort = String(effortValue ?? "").trim();
    const effort = selectedModel.efforts.some((option) => option.value === requestedEffort)
      ? requestedEffort
      : selectedModel.defaultEffort;
    return { model: selectedModel.id, effort };
  }

  private parseModel(raw: unknown): ModelChoice[] {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as JsonObject;
    const id = String(entry.model ?? entry.id ?? "").trim();
    if (!id) return [];

    const rawEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
      : [];
    const efforts = rawEfforts.flatMap((rawEffort: unknown) => {
      if (!rawEffort || typeof rawEffort !== "object") return [];
      const effort = rawEffort as JsonObject;
      const value = String(effort.reasoningEffort ?? "").trim();
      return value ? [{ value, description: String(effort.description ?? "") }] : [];
    });

    return [
      {
        id,
        displayName: String(entry.displayName ?? id),
        isDefault: entry.isDefault === true,
        defaultEffort: String(entry.defaultReasoningEffort ?? efforts[0]?.value ?? "medium"),
        efforts
      }
    ];
  }
}
