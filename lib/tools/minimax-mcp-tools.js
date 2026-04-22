import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

export const MINIMAX_MCP_WEB_SEARCH_SWITCH = "minimax_mcp_web_search";
export const MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH = "minimax_mcp_understand_image";

/**
 * MiniMax MCP 开关型工具定义
 *
 * 这两个条目仅用于 custom tool catalog / custom_enabled 白名单控制。
 * 真正能力由外部 MCP server `MiniMax` 暴露：
 * - mcp__MiniMax__web_search
 * - mcp__MiniMax__understand_image
 */
export function createMiniMaxMcpSwitchTools() {
  return [
    {
      name: MINIMAX_MCP_WEB_SEARCH_SWITCH,
      label: t("toolDef.minimaxMcpWebSearch.label"),
      description: t("toolDef.minimaxMcpWebSearch.description"),
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{
          type: "text",
          text: "MiniMax MCP web_search is provided via mcp__MiniMax__web_search.",
        }],
        details: { mode: "mcp_server", tool: "web_search" },
      }),
    },
    {
      name: MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH,
      label: t("toolDef.minimaxMcpUnderstandImage.label"),
      description: t("toolDef.minimaxMcpUnderstandImage.description"),
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{
          type: "text",
          text: "MiniMax MCP understand_image is provided via mcp__MiniMax__understand_image.",
        }],
        details: { mode: "mcp_server", tool: "understand_image" },
      }),
    },
  ];
}
