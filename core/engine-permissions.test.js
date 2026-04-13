import { describe, expect, it } from "vitest";
import { HanaEngine } from "./engine.js";

function createEngineLikeForPermissions({
  toolsConfig = undefined,
  customCatalog = ["web_fetch", "todo_write", "ask_agent"],
} = {}) {
  const agent = {
    config: {
      tools: toolsConfig,
      sandbox: {},
    },
  };
  return {
    agent,
    getAgent: () => agent,
    _fallbackSandboxMode: () => "balanced",
    _normalizePathRules: () => [],
    getToolCatalog: () => ({
      builtin_required: ["Read", "Glob", "Grep"],
      builtin_optional: ["Write", "Edit", "Bash"],
      custom: customCatalog,
    }),
  };
}

describe("HanaEngine.getAgentPermissionConfig custom_enabled semantics", () => {
  it("allows all custom tools when custom_enabled is missing", () => {
    const engineLike = createEngineLikeForPermissions({
      toolsConfig: {
        builtin_enabled: ["write", "edit"],
      },
    });

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.tools.custom_enabled).toEqual(["web_fetch", "todo_write", "ask_agent"]);
  });

  it("disables all custom tools when custom_enabled is an empty array", () => {
    const engineLike = createEngineLikeForPermissions({
      toolsConfig: {
        builtin_enabled: ["write"],
        custom_enabled: [],
      },
    });

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.tools.custom_enabled).toEqual([]);
  });

  it("treats non-empty custom_enabled as whitelist", () => {
    const engineLike = createEngineLikeForPermissions({
      toolsConfig: {
        custom_enabled: ["todo_write", "unknown_tool"],
      },
    });

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.tools.custom_enabled).toEqual(["todo_write"]);
  });

  it("filters stale tool names out of whitelist without fallback", () => {
    const engineLike = createEngineLikeForPermissions({
      toolsConfig: {
        custom_enabled: ["old_tool_a", "old_tool_b"],
      },
    });

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.tools.custom_enabled).toEqual([]);
  });
});
