import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { typeBoxObjectToZodShape } from "./typebox-to-zod.js";

function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [{ type: "text", text: String(content || "") }];
}

function inferAnnotations(toolDef) {
  const name = String(toolDef?.name || "").toLowerCase();
  const readOnly = name.includes("read")
    || name.includes("search")
    || name.includes("describe")
    || name.includes("recall")
    || name === "browser";
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    openWorldHint: name.includes("web") || name.includes("browser"),
  };
}

export function adaptCustomTool(toolDef, {
  createContext,
  onToolStart,
  onToolEnd,
} = {}) {
  const description = toolDef?.description || toolDef?.label || toolDef?.name || "Hanako tool";
  const inputSchema = typeBoxObjectToZodShape(toolDef?.parameters || { type: "object", properties: {} });

  return tool(
    toolDef.name,
    description,
    inputSchema,
    async (args, extra) => {
      const toolCallId = `${toolDef.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const ctx = createContext?.(extra) || {};
      onToolStart?.({
        type: "tool_start",
        name: toolDef.name,
        toolCallId,
        args,
      });
      try {
        const result = await toolDef.execute?.(toolCallId, args, extra?.signal, undefined, ctx);
        const details = result?.details;
        onToolEnd?.({
          type: "tool_end",
          name: toolDef.name,
          toolCallId,
          args,
          success: true,
          content: result?.content || [],
          details,
        });
        return {
          content: normalizeContent(result?.content || []),
          structuredContent: details ? { details } : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onToolEnd?.({
          type: "tool_end",
          name: toolDef.name,
          toolCallId,
          args,
          success: false,
          content: [{ type: "text", text: message }],
          details: { error: message },
        });
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { details: { error: message } },
        };
      }
    },
    { annotations: inferAnnotations(toolDef) },
  );
}

export function createCustomToolsMcpServer(name, customTools, opts = {}) {
  return createSdkMcpServer({
    name,
    version: opts.version || "1.0.0",
    tools: (customTools || []).map((toolDef) => adaptCustomTool(toolDef, opts)),
  });
}
