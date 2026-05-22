import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import sessionsRoute from "./sessions.js";

function createEngine(overrides = {}) {
  return {
    userDir: "/tmp/hanako-test-user",
    agentsDir: "/tmp/hanako-test-agents",
    currentSessionPath: null,
    currentAgentId: "hanako",
    messages: [],
    getSessionByPath: () => null,
    ...overrides,
  };
}

describe("/api/sessions/messages", () => {
  /** @type {import('fastify').FastifyInstance[]} */
  const apps = [];

  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      await app.close();
    }
  });

  it("keeps setup_settings nested args in assistant tool calls", async () => {
    const engine = createEngine({
      messages: [
        { role: "user", content: "请创建一个新助手" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "我来处理设置。" },
            {
              type: "tool_use",
              id: "toolu_setup_1",
              name: "mcp__hanako__setup_settings",
              input: {
                tutorial: "{\"agent\":{\"action\":\"create\",\"name\":\"wsl\"}}",
                agent: { action: "create", name: "wsl" },
                mcp: { name: "playwright", type: "stdio", command: "npx" },
                memory: { action: "clear", agent_id: "hanako" },
                dry_run: false,
              },
            },
          ],
        },
      ],
    });

    const app = Fastify();
    apps.push(app);
    await app.register(sessionsRoute, { engine });

    const res = await app.inject({ method: "GET", url: "/api/sessions/messages" });
    expect(res.statusCode).toBe(200);

    const data = res.json();
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages).toHaveLength(2);

    const assistant = data.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0]).toMatchObject({
      name: "mcp__hanako__setup_settings",
      toolUseId: "toolu_setup_1",
      args: {
        tutorial: "{\"agent\":{\"action\":\"create\",\"name\":\"wsl\"}}",
        agent: { action: "create", name: "wsl" },
        mcp: { name: "playwright", type: "stdio", command: "npx" },
        memory: { action: "clear", agent_id: "hanako" },
        dry_run: false,
      },
    });
  });
});
