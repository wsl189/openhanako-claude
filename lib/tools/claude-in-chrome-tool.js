import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

export const CLAUDE_IN_CHROME_SWITCH = "claude_in_chrome";

export function createClaudeInChromeTool() {
  return {
    name: CLAUDE_IN_CHROME_SWITCH,
    label: t("toolDef.claudeInChrome.label"),
    description: t("toolDef.claudeInChrome.description"),
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{
        type: "text",
        text: "claude-in-chrome is provided via MCP tools (mcp__claude_in_chrome__*).",
      }],
      details: { mode: "mcp_server" },
    }),
  };
}
