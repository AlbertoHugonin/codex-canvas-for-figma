export const DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "figma_local",
    description:
      "Direct access to the currently open Figma document through the user's local Codex Canvas plugin. This is not the hosted Figma connector.",
    tools: [
      {
        type: "function",
        name: "get_context",
        description:
          "Inspect the current selection, current page, or a node. Read before modifying. Depth is capped at 4 to keep results manageable.",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["selection", "current_page", "node"] },
            nodeId: { type: "string" },
            depth: { type: "integer", minimum: 0, maximum: 4 }
          },
          required: ["scope"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "execute",
        description:
          "Execute an async JavaScript function body against the Figma Plugin API. The globals passed in are figma and helpers. Use modern async APIs, await figma.loadFontAsync before editing text, never call figma.closePlugin, and return only serializable data or Figma nodes. Batch a coherent visual change in one call. The plugin creates an undo checkpoint and rolls back a thrown error.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            script: {
              type: "string",
              description:
                "Async function body, for example: const r=figma.createRectangle(); r.resize(200,100); return r;"
            }
          },
          required: ["description", "script"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "execute_ops",
        description:
          "Eval-free fallback that executes a batch of reflective Figma Plugin API operations. Each operation is getNode, get, set, or call. Targets can be figma, figma.variables, figma.teamLibrary, currentPage, selection, or an alias created with 'as'. Use {$ref:'alias'} inside values and arguments. Example: getNode id as card; set target card property opacity value 0.8; call target card method resize args [320,200]. Use this if execute reports that dynamic code is unavailable.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 250,
              items: { type: "object", additionalProperties: true }
            },
            returnRefs: { type: "array", items: { type: "string" } }
          },
          required: ["description", "operations"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "render",
        description:
          "Render a Figma node to PNG for visual verification. Pass nodeId or omit it to render the first selected node.",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            scale: { type: "number", minimum: 0.25, maximum: 3 }
          },
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "undo",
        description: "Undo the last committed Figma change made by the plugin.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    ]
  }
];

export const DEVELOPER_INSTRUCTIONS = `
You are Codex Canvas, an AI design agent embedded inside Figma.

Operate on the live Figma document only through the figma_local tools. Do not use hosted Figma connectors to manipulate the design.

The user can configure a local workspace directory. When it is configured, you may freely inspect and modify files inside that workspace with the normal Codex filesystem and command tools when doing so is relevant to the user's request. Stay inside the configured workspace and treat existing user changes carefully.

For design changes:
- Inspect the selection or relevant parent first.
- Make the requested change directly when it is reversible and in scope.
- Preserve existing components, variables, styles, constraints, and naming conventions when possible.
- Prefer Auto Layout and reusable components over fixed-position copies when they improve the design.
- Load every font before changing text.
- Keep each coherent mutation in one execute call so Undo stays useful.
- If dynamic JavaScript execution is unavailable in the current Figma runtime, continue with execute_ops instead of stopping.
- Render the edited node after meaningful visual changes and correct obvious layout problems before finishing.
- Never call figma.closePlugin.

Answer the user concisely in the language they use. Explain what changed and mention any real Figma API limitation.
`;
