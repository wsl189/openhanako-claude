import { describe, expect, it } from "vitest";
import { HanaEngine } from "./engine.js";

function createEngineLikeForPermissions({
  toolsConfig = undefined,
  customCatalog = ["web_fetch", "todo_write", "ask_agent"],
  builtinOptional = ["Write", "Edit", "Bash", "Skill"],
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
      builtin_optional: builtinOptional,
      custom: customCatalog,
    }),
  };
}

describe("HanaEngine.getAgentPermissionConfig custom_enabled semantics", () => {
  it("forces full-access sandbox mode regardless of legacy preferences or agent config", () => {
    const engineLike = createEngineLikeForPermissions();
    engineLike.agent.config.sandbox = {
      mode: "standard",
      path_rules: [{ path: "/tmp/extra", access: "read_write" }],
    };
    engineLike._readPreferences = () => ({
      sandbox: {
        mode: "balanced",
      },
    });
    engineLike._fallbackSandboxMode = HanaEngine.prototype._fallbackSandboxMode;

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.sandbox.mode).toBe("full-access");
    expect(permission.sandbox.path_rules).toEqual([]);
  });

  it("treats legacy builtin default config as unrestricted builtin set", () => {
    const engineLike = createEngineLikeForPermissions({
      toolsConfig: {
        builtin_enabled: ["write", "edit", "bash"],
      },
    });

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.tools.builtin_enabled).toContain("Read");
    expect(permission.tools.builtin_enabled).toContain("Glob");
    expect(permission.tools.builtin_enabled).toContain("Grep");
    expect(permission.tools.builtin_enabled).toContain("Write");
    expect(permission.tools.builtin_enabled).toContain("Edit");
    expect(permission.tools.builtin_enabled).toContain("Bash");
    expect(permission.tools.builtin_enabled).toContain("Skill");
    expect(permission.tools.builtin_enabled).toContain("Task");
    expect(permission.tools.builtin_enabled).toContain("WebFetch");
  });

  it("accepts lowercase skill alias in builtin_enabled", () => {
    const engineLike = createEngineLikeForPermissions({
      toolsConfig: {
        builtin_enabled: ["skill"],
      },
    });

    const permission = HanaEngine.prototype.getAgentPermissionConfig.call(engineLike);
    expect(permission.tools.builtin_enabled).toEqual(["Skill", "Read", "Glob", "Grep"]);
  });

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
