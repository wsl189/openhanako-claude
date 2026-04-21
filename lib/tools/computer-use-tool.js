import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

/**
 * computer_use 开关型工具定义
 *
 * 该条目用于 Hanako 的 custom tool catalog / custom_enabled 白名单控制。
 * 真正可执行能力通过独立 MCP server `computer_use` 暴露（mcp__computer_use__*）。
 */
export function createComputerUseTool() {
  return {
    name: "computer_use",
    label: t("toolDef.computerUse.label"),
    description: t("toolDef.computerUse.description"),
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{
        type: "text",
        text: "computer_use is provided via MCP tools (mcp__computer_use__*).",
      }],
      details: { mode: "mcp_server" },
    }),
  };
}

