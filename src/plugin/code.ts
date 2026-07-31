figma.showUI(__html__, {
  width: 420,
  height: 680,
  themeColors: true,
  title: "Codex Canvas"
});

figma.skipInvisibleInstanceChildren = true;

type PlainValue =
  | null
  | boolean
  | number
  | string
  | PlainValue[]
  | { [key: string]: PlainValue };

type ToolRequest = {
  type: "tool.run";
  requestId: string | number;
  tool: string;
  arguments: Record<string, unknown>;
};

const NODE_PROPERTIES = [
  "visible",
  "locked",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "blendMode",
  "layoutMode",
  "layoutWrap",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "clipsContent",
  "cornerRadius",
  "strokesIncludedInLayout",
  "characters",
  "fontName",
  "fontSize",
  "textAlignHorizontal",
  "textAlignVertical",
  "textAutoResize",
  "lineHeight",
  "letterSpacing",
  "fills",
  "strokes",
  "strokeWeight",
  "effects",
  "constraints",
  "componentPropertyDefinitions"
] as const;

function toPlain(value: unknown, depth = 0): PlainValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "function") return "[function]";
  if (depth > 8) return "[max-depth]";

  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPlain(item, depth + 1));
  }

  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id === "string" && typeof candidate.type === "string") {
      return serializeNode(value as BaseNode, 0);
    }

    const result: Record<string, PlainValue> = {};
    for (const key of Object.keys(candidate)) {
      try {
        result[key] = toPlain(candidate[key], depth + 1);
      } catch {
        result[key] = "[unavailable]";
      }
    }
    return result;
  }

  return String(value);
}

function serializeNode(node: BaseNode, childDepth = 1): Record<string, PlainValue> {
  const source = node as unknown as Record<string, unknown>;
  const output: Record<string, PlainValue> = {
    id: node.id,
    type: node.type,
    name: node.name
  };

  for (const property of NODE_PROPERTIES) {
    if (!(property in source)) continue;
    try {
      output[property] = toPlain(source[property], 1);
    } catch {
      output[property] = "[unavailable]";
    }
  }

  if (childDepth > 0 && "children" in node) {
    output.children = node.children.map((child) => serializeNode(child, childDepth - 1));
  }

  return output;
}

function currentSelectionSummary(): Record<string, PlainValue> {
  return {
    editorType: figma.editorType,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.map((node) => serializeNode(node, 0))
  };
}

async function getContext(args: Record<string, unknown>): Promise<PlainValue> {
  const scope = typeof args.scope === "string" ? args.scope : "selection";
  const requestedDepth = typeof args.depth === "number" ? args.depth : 1;
  const depth = Math.max(0, Math.min(4, Math.floor(requestedDepth)));

  if (scope === "node") {
    if (typeof args.nodeId !== "string") throw new Error("nodeId is required for scope=node");
    const node = await figma.getNodeByIdAsync(args.nodeId);
    if (!node) throw new Error(`Node ${args.nodeId} was not found`);
    return serializeNode(node, depth);
  }

  if (scope === "current_page") {
    return serializeNode(figma.currentPage, depth);
  }

  return {
    editorType: figma.editorType,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.map((node) => serializeNode(node, depth))
  };
}

async function loadFontsForTextNode(node: TextNode): Promise<void> {
  if (node.characters.length === 0) {
    await figma.loadFontAsync(node.fontName as FontName);
    return;
  }

  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  const unique = new Map(fonts.map((font) => [`${font.family}:${font.style}`, font]));
  await Promise.all(Array.from(unique.values(), (font) => figma.loadFontAsync(font)));
}

async function executeScript(args: Record<string, unknown>): Promise<PlainValue> {
  if (typeof args.script !== "string" || args.script.trim().length === 0) {
    throw new Error("script must be a non-empty JavaScript async function body");
  }

  figma.commitUndo();
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...parameters: string[]
    ) => (figmaApi: PluginAPI, helpers: Record<string, unknown>) => Promise<unknown>;

    const runner = new AsyncFunction("figma", "helpers", `"use strict";\n${args.script}`);
    const value = await runner(figma, {
      serializeNode,
      toPlain,
      loadFontsForTextNode,
      findByName: (name: string) => figma.currentPage.findAll((node) => node.name === name)
    });
    figma.commitUndo();

    return {
      result: toPlain(value),
      context: currentSelectionSummary()
    };
  } catch (error) {
    try {
      figma.triggerUndo();
    } catch {
      // The original error is more useful than a rollback error.
    }
    throw error;
  }
}

function resolveOperationValue(value: unknown, references: Map<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOperationValue(entry, references));
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string" && Object.keys(object).length === 1) {
      if (!references.has(object.$ref)) throw new Error(`Unknown reference: ${object.$ref}`);
      return references.get(object.$ref);
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      resolved[key] = resolveOperationValue(entry, references);
    }
    return resolved;
  }

  return value;
}

function resolveOperationTarget(path: string, references: Map<string, unknown>): unknown {
  if (references.has(path)) return references.get(path);
  const parts = path.split(".");
  if (parts[0] !== "figma") throw new Error(`Unknown operation target: ${path}`);

  let target: unknown = figma;
  for (const part of parts.slice(1)) {
    if (!target || typeof target !== "object" || !(part in target)) {
      throw new Error(`Target path does not exist: ${path}`);
    }
    target = (target as Record<string, unknown>)[part];
  }
  return target;
}

async function executeOperations(args: Record<string, unknown>): Promise<PlainValue> {
  if (!Array.isArray(args.operations) || args.operations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  if (args.operations.length > 250) throw new Error("A batch can contain at most 250 operations");

  const references = new Map<string, unknown>([
    ["figma", figma],
    ["currentPage", figma.currentPage],
    ["selection", Array.from(figma.currentPage.selection)]
  ]);
  let lastResult: unknown = null;

  figma.commitUndo();
  try {
    for (const rawOperation of args.operations) {
      if (!rawOperation || typeof rawOperation !== "object") throw new Error("Invalid operation");
      const operation = rawOperation as Record<string, unknown>;
      const op = String(operation.op ?? "");
      const alias = typeof operation.as === "string" ? operation.as : null;

      if (op === "getNode") {
        if (typeof operation.id !== "string") throw new Error("getNode requires id");
        lastResult = await figma.getNodeByIdAsync(operation.id);
        if (!lastResult) throw new Error(`Node ${operation.id} was not found`);
      } else if (op === "get") {
        if (typeof operation.target !== "string" || typeof operation.property !== "string") {
          throw new Error("get requires target and property");
        }
        const target = resolveOperationTarget(operation.target, references);
        if (!target || (typeof target !== "object" && typeof target !== "function")) {
          throw new Error(`Cannot read from target ${operation.target}`);
        }
        lastResult = (target as Record<string, unknown>)[operation.property];
      } else if (op === "set") {
        if (typeof operation.target !== "string" || typeof operation.property !== "string") {
          throw new Error("set requires target and property");
        }
        const target = resolveOperationTarget(operation.target, references);
        if (!target || (typeof target !== "object" && typeof target !== "function")) {
          throw new Error(`Cannot write to target ${operation.target}`);
        }
        const value = resolveOperationValue(operation.value, references);
        (target as Record<string, unknown>)[operation.property] = value;
        lastResult = target;
      } else if (op === "call") {
        if (typeof operation.target !== "string" || typeof operation.method !== "string") {
          throw new Error("call requires target and method");
        }
        const target = resolveOperationTarget(operation.target, references);
        if (!target || (typeof target !== "object" && typeof target !== "function")) {
          throw new Error(`Cannot call method on target ${operation.target}`);
        }
        const method = (target as Record<string, unknown>)[operation.method];
        if (typeof method !== "function") {
          throw new Error(`${operation.target}.${operation.method} is not a function`);
        }
        const callArguments = Array.isArray(operation.args)
          ? operation.args.map((entry) => resolveOperationValue(entry, references))
          : [];
        lastResult = await Promise.resolve(method.apply(target, callArguments));
      } else {
        throw new Error(`Unsupported operation: ${op}`);
      }

      if (alias) references.set(alias, lastResult);
    }

    figma.commitUndo();
    const requestedRefs = Array.isArray(args.returnRefs)
      ? args.returnRefs.filter((entry): entry is string => typeof entry === "string")
      : [];
    const returned: Record<string, PlainValue> = {};
    for (const name of requestedRefs) {
      if (references.has(name)) returned[name] = toPlain(references.get(name));
    }

    return {
      result: requestedRefs.length ? returned : toPlain(lastResult),
      context: currentSelectionSummary()
    };
  } catch (error) {
    try {
      figma.triggerUndo();
    } catch {
      // Keep the original operation error.
    }
    throw error;
  }
}

async function renderNode(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let node: BaseNode | null = null;
  if (typeof args.nodeId === "string") {
    node = await figma.getNodeByIdAsync(args.nodeId);
  } else {
    node = figma.currentPage.selection[0] ?? null;
  }

  if (!node || !("exportAsync" in node)) {
    throw new Error("Select an exportable node or pass its nodeId");
  }

  const scale = Math.max(0.25, Math.min(3, typeof args.scale === "number" ? args.scale : 1));
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale }
  });

  return {
    kind: "image",
    mimeType: "image/png",
    bytes,
    node: serializeNode(node, 0)
  };
}

async function runTool(request: ToolRequest): Promise<void> {
  try {
    let result: unknown;
    switch (request.tool) {
      case "get_context":
        result = await getContext(request.arguments);
        break;
      case "execute":
        result = await executeScript(request.arguments);
        break;
      case "execute_ops":
        result = await executeOperations(request.arguments);
        break;
      case "render":
        result = await renderNode(request.arguments);
        break;
      case "undo":
        figma.triggerUndo();
        result = { ok: true, context: currentSelectionSummary() };
        break;
      default:
        throw new Error(`Unsupported tool: ${request.tool}`);
    }

    figma.ui.postMessage({
      type: "tool.result",
      requestId: request.requestId,
      ok: true,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "tool.result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

figma.ui.onmessage = async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const typed = message as Record<string, unknown>;

  if (typed.type === "ui.ready") {
    const [token, modelSettings] = await Promise.all([
      figma.clientStorage.getAsync("codex-canvas-token"),
      figma.clientStorage.getAsync("codex-canvas-model-settings")
    ]);
    const savedModelSettings =
      modelSettings && typeof modelSettings === "object"
        ? (modelSettings as Record<string, unknown>)
        : {};
    figma.ui.postMessage({
      type: "settings",
      token: typeof token === "string" ? token : "",
      model: typeof savedModelSettings.model === "string" ? savedModelSettings.model : "",
      effort: typeof savedModelSettings.effort === "string" ? savedModelSettings.effort : ""
    });
    figma.ui.postMessage({ type: "context.selection", context: currentSelectionSummary() });
    return;
  }

  if (typed.type === "settings.save-token" && typeof typed.token === "string") {
    await figma.clientStorage.setAsync("codex-canvas-token", typed.token);
    return;
  }

  if (
    typed.type === "settings.save-model" &&
    typeof typed.model === "string" &&
    typeof typed.effort === "string"
  ) {
    await figma.clientStorage.setAsync("codex-canvas-model-settings", {
      model: typed.model,
      effort: typed.effort
    });
    return;
  }

  if (typed.type === "tool.run") {
    await runTool(typed as unknown as ToolRequest);
  }
};

figma.on("selectionchange", () => {
  figma.ui.postMessage({ type: "context.selection", context: currentSelectionSummary() });
});

figma.on("currentpagechange", () => {
  figma.ui.postMessage({ type: "context.selection", context: currentSelectionSummary() });
});
