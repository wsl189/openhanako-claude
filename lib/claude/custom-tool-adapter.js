import { createRequire } from "module";
import { typeBoxObjectToZodShape } from "./typebox-to-zod.js";

const require = createRequire(import.meta.url);
let _sdkToolFn = null;
let _sdkCreateMcpServerFn = null;

function getClaudeSdkTool() {
  if (typeof _sdkToolFn === "function") return _sdkToolFn;
  const sdk = require("@anthropic-ai/claude-agent-sdk");
  if (typeof sdk?.tool !== "function") {
    throw new Error("claude-agent-sdk tool() is unavailable");
  }
  _sdkToolFn = sdk.tool;
  return _sdkToolFn;
}

function getClaudeSdkMcpServerFactory() {
  if (typeof _sdkCreateMcpServerFn === "function") return _sdkCreateMcpServerFn;
  const sdk = require("@anthropic-ai/claude-agent-sdk");
  if (typeof sdk?.createSdkMcpServer !== "function") {
    throw new Error("claude-agent-sdk createSdkMcpServer() is unavailable");
  }
  _sdkCreateMcpServerFn = sdk.createSdkMcpServer;
  return _sdkCreateMcpServerFn;
}

function normalizeContentBlock(block) {
  if (typeof block === "string") return { type: "text", text: block };
  if (!block || typeof block !== "object") {
    return { type: "text", text: String(block || "") };
  }

  const type = String(block.type || "").trim().toLowerCase();

  if (type === "image") {
    const data = typeof block.data === "string"
      ? block.data
      : (typeof block.source?.data === "string" ? block.source.data : "");
    const mimeType = typeof block.mimeType === "string"
      ? block.mimeType
      : (typeof block.source?.media_type === "string" ? block.source.media_type : "image/png");
    if (data) return { type: "image", data, mimeType };
  }

  if (type === "text") {
    if (typeof block.text === "string") return { type: "text", text: block.text };
    if (typeof block.content === "string") return { type: "text", text: block.content };
    return { type: "text", text: String(block.text || block.content || "") };
  }

  if (typeof block.text === "string") return { type: "text", text: block.text };
  if (typeof block.content === "string") return { type: "text", text: block.content };
  return { type: "text", text: JSON.stringify(block) };
}

function normalizeContent(content) {
  if (Array.isArray(content)) {
    return content.map((block) => normalizeContentBlock(block));
  }
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [normalizeContentBlock(content)];
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
  includeStructuredContent = false,
} = {}) {
  const tool = getClaudeSdkTool();
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
        const normalizedContent = normalizeContent(result?.content || []);
        const details = result?.details;
        onToolEnd?.({
          type: "tool_end",
          name: toolDef.name,
          toolCallId,
          args,
          success: true,
          content: normalizedContent,
          details,
        });
        const response = {
          content: normalizedContent,
        };
        // NOTE:
        // In Claude MCP transcripts, structuredContent can dominate tool_result
        // payloads, causing text/image content to be omitted from model context.
        // Keep structuredContent opt-in so models reliably receive normalized content.
        if (includeStructuredContent && details) {
          response.structuredContent = { details };
        }
        return response;
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
        const response = {
          isError: true,
          content: [{ type: "text", text: message }],
        };
        if (includeStructuredContent) {
          response.structuredContent = { details: { error: message } };
        }
        return response;
      }
    },
    { annotations: inferAnnotations(toolDef) },
  );
}

export function createCustomToolsMcpServer(name, customTools, opts = {}) {
  const createSdkMcpServer = getClaudeSdkMcpServerFactory();
  return createSdkMcpServer({
    name,
    version: opts.version || "1.0.0",
    tools: (customTools || []).map((toolDef) => adaptCustomTool(toolDef, opts)),
  });
}
