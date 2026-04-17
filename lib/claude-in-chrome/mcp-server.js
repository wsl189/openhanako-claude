import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_TOOLS } from "./browser-tools.js";
import { getAllSocketPaths } from "./common.js";
import { McpSocketClient, SocketConnectionError } from "./mcp-socket-client.js";

function defaultLogger() {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

function toCallToolResult(response) {
  if (!response || typeof response !== "object") {
    return {
      content: [{ type: "text", text: "Tool execution completed" }],
    };
  }

  const isError = !!response.error;
  const payload = response.error || response.result;

  if (!payload || typeof payload !== "object") {
    return {
      content: [{ type: "text", text: "Tool execution completed" }],
      ...(isError ? { isError: true } : {}),
    };
  }

  let content = payload.content;
  if (!Array.isArray(content)) {
    content = [{ type: "text", text: String(content ?? "") }];
  }

  const normalized = content.map((item) => {
    if (item && typeof item === "object" && item.type === "image" && item.source && typeof item.source === "object") {
      const data = item.source?.data;
      if (typeof data === "string" && data) {
        return {
          type: "image",
          data,
          mimeType: String(item.source?.media_type || "image/png"),
        };
      }
    }

    if (item && typeof item === "object" && typeof item.type === "string") {
      return item;
    }

    return { type: "text", text: String(item ?? "") };
  });

  return {
    content: normalized,
    ...(isError ? { isError: true } : {}),
  };
}

export function createClaudeInChromeMcpServer({ logger } = {}) {
  const log = logger || defaultLogger();

  const socketClient = new McpSocketClient({
    serverName: "claude-in-chrome",
    logger: log,
    getSocketPaths: () => getAllSocketPaths(),
  });

  const server = new Server(
    {
      name: "claude-in-chrome",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  socketClient.setNotificationHandler((notification) => {
    server.notification({
      method: notification.method,
      params: notification.params,
    }).catch(() => {});
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request?.params?.name || "").trim();
    const args = request?.params?.arguments && typeof request.params.arguments === "object"
      ? request.params.arguments
      : {};

    try {
      const raw = await socketClient.callTool(name, args);
      return toCallToolResult(raw);
    } catch (err) {
      if (err instanceof SocketConnectionError) {
        return {
          content: [
            {
              type: "text",
              text: "Chrome extension is not connected. Open Chrome with Hanako MCP extension and try again.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Browser tool call failed: ${err?.message || String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return {
    server,
    socketClient,
  };
}

export async function runClaudeInChromeMcpServer() {
  const { server, socketClient } = createClaudeInChromeMcpServer();
  const transport = new StdioServerTransport();

  const cleanup = () => {
    try { socketClient.disconnect(); } catch {}
    try { process.exit(0); } catch {}
  };

  process.stdin.on("end", cleanup);
  process.stdin.on("error", cleanup);

  await server.connect(transport);
}
