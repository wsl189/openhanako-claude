import { describe, expect, it } from "vitest";
import { buildClaudeRuntimeConfig } from "./claude-runtime-config.js";

function createConfig(overrides = {}) {
  return buildClaudeRuntimeConfig({
    agent: {
      agentDir: "/tmp/agent",
      buildSystemAppendPrompt: () => "",
      ...overrides.agent,
    },
    cwd: "/tmp",
    workspace: "/tmp",
    ...overrides,
  });
}

describe("buildClaudeRuntimeConfig env", () => {
  it("inherits process env by default", () => {
    const config = createConfig();
    const inheritedKey = ["PATH", "HOME", "USERPROFILE"].find((key) => typeof process.env[key] === "string");
    expect(inheritedKey).toBeTruthy();
    expect(config.options.env[inheritedKey]).toBe(process.env[inheritedKey]);
  });

  it("allows explicit env overrides", () => {
    const config = createConfig({
      env: {
        PATH: "/custom/path",
        HANAKO_TEST_ENV: "ok",
      },
    });

    expect(config.options.env.PATH).toBe("/custom/path");
    expect(config.options.env.HANAKO_TEST_ENV).toBe("ok");
  });
});
