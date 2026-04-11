# Hanako `pi-sdk` -> `claude-agent-sdk` 全面替换方案

## 1. 目标

本次改造不是“把包名换掉”的最小迁移，而是把 Hanako 当前依赖 `@mariozechner/pi-coding-agent` 的运行时能力整体切换到 `@anthropic-ai/claude-agent-sdk`，并让 Hanako 的会话、工具、沙箱、提示词、模型接入都以 Claude Agent SDK 为准。

本方案同时满足下面这些约束：

1. `systemPrompt` 不再使用 Hanako 自拼的完整 system prompt 字符串直传，而是统一改为 Claude SDK 官方推荐的 `claude_code` preset。
2. Hanako 的身份、意识、记忆、用户档案、技能、工作区提示、工具提示，统一通过 `systemPrompt.append` 注入。
3. 文件/命令/Web 等内置工具改用 Claude SDK 内置工具，不再使用 Pi SDK 的 `createReadTool/createWriteTool/createEditTool/createBashTool/...`。
4. 沙箱改用 Claude SDK 的 `sandbox`、`permissionMode`、`allowedTools`、`disallowedTools`、`canUseTool`，不再走 Hanako 自己包的 `wrapPathTool/wrapBashTool` 执行链作为主执行面。
5. 会话改用 Claude SDK 的 session/transcript 体系，不再把 Pi SDK JSONL transcript 当作主数据源。
6. 模型接入改为 Claude SDK 支持的 Anthropic Messages 兼容模式，允许第三方提供 `Anthropic-compatible` base URL。

## 2. 官方接口依据

主要依据以下官方文档：

- TypeScript SDK reference: <https://platform.claude.com/docs/en/agent-sdk/typescript>
- Migration guide: <https://platform.claude.com/docs/en/agent-sdk/migration-guide>
- Work with sessions: <https://code.claude.com/docs/en/agent-sdk/sessions>
- Configure permissions: <https://code.claude.com/docs/en/agent-sdk/permissions>
- Stream responses in real-time: <https://platform.claude.com/docs/en/agent-sdk/streaming-output>

关键结论：

1. `@anthropic-ai/claude-code` 已迁移为 `@anthropic-ai/claude-agent-sdk`。
2. SDK 默认不再自动加载 Claude Code system prompt，必须显式传 `systemPrompt: { type: "preset", preset: "claude_code" }`。
3. SDK 默认不再自动加载 `CLAUDE.md/settings.json` 等文件系统配置；若要加载，必须显式设置 `settingSources`。
4. TypeScript `query()` 支持：
   - 单轮 prompt
   - `AsyncIterable<SDKUserMessage>` 流式输入
   - `includePartialMessages`
   - `resume`
   - `continue`
   - `allowedTools` / `disallowedTools`
   - `permissionMode`
   - `canUseTool`
   - `sandbox`
5. SDK 提供 transcript/session API：
   - `listSessions()`
   - `getSessionMessages()`
   - `getSessionInfo()`
   - `renameSession()`
   - `tagSession()`
   - `forkSession()`

## 3. 现有 `pi-sdk` 耦合点

当前仓库对 `@mariozechner/pi-coding-agent` 的直接耦合主要分成 7 类：

### 3.1 会话创建与持久化

- [core/session-coordinator.js](/Users/tc/PythonProject/openhanako/core/session-coordinator.js)
- [core/bridge-session-manager.js](/Users/tc/PythonProject/openhanako/core/bridge-session-manager.js)
- [hub/agent-executor.js](/Users/tc/PythonProject/openhanako/hub/agent-executor.js)
- [server/routes/sessions.js](/Users/tc/PythonProject/openhanako/server/routes/sessions.js)
- [server/routes/desk.js](/Users/tc/PythonProject/openhanako/server/routes/desk.js)

依赖点：

- `createAgentSession`
- `SessionManager.create/open/list`
- `SettingsManager.inMemory`

### 3.2 事件流模型

- [server/routes/chat.js](/Users/tc/PythonProject/openhanako/server/routes/chat.js)
- [index.js](/Users/tc/PythonProject/openhanako/index.js)

当前代码假设 Pi SDK 事件格式：

- `message_update`
- `assistantMessageEvent.text_delta`
- `assistantMessageEvent.toolcall_start`
- `tool_execution_start`
- `tool_execution_end`

### 3.3 内置工具工厂

- [lib/sandbox/index.js](/Users/tc/PythonProject/openhanako/lib/sandbox/index.js)

依赖点：

- `createReadTool`
- `createWriteTool`
- `createEditTool`
- `createBashTool`
- `createGrepTool`
- `createFindTool`
- `createLsTool`

### 3.4 ResourceLoader / Skills

- [core/engine.js](/Users/tc/PythonProject/openhanako/core/engine.js)
- [core/skill-manager.js](/Users/tc/PythonProject/openhanako/core/skill-manager.js)
- [core/agent.js](/Users/tc/PythonProject/openhanako/core/agent.js)

依赖点：

- `DefaultResourceLoader`
- `loadSkills`
- `formatSkillsForPrompt`

### 3.5 模型注册与认证

- [core/model-manager.js](/Users/tc/PythonProject/openhanako/core/model-manager.js)

依赖点：

- `AuthStorage`
- `ModelRegistry`
- `@mariozechner/pi-ai/oauth`

### 3.6 ToolDefinition 类型生态

- [lib/tools](/Users/tc/PythonProject/openhanako/lib/tools)
- [lib/memory/memory-search.js](/Users/tc/PythonProject/openhanako/lib/memory/memory-search.js)

当前所有自定义工具都返回 Pi 风格对象：

- `name`
- `description`
- `parameters`（TypeBox）
- `execute(toolCallId, params, signal, onUpdate, ctx)`

### 3.7 Session JSONL 直接读取

- [core/llm-utils.js](/Users/tc/PythonProject/openhanako/core/llm-utils.js)
- [server/routes/sessions.js](/Users/tc/PythonProject/openhanako/server/routes/sessions.js)

当前大量逻辑默认“sessionPath 就是 Pi transcript 文件路径”，并直接逐行解析 JSONL。

## 4. 目标架构

## 4.1 运行时入口

统一改为 Claude SDK 的：

- `query()`
- `createSdkMcpServer()`
- `tool()`
- `listSessions()`
- `getSessionMessages()`
- `getSessionInfo()`
- `renameSession()`
- `tagSession()`

## 4.2 Hanako 内部新增抽象

需要新增 4 个适配层：

1. `ClaudeSessionRuntime`
   - 包装 Claude SDK `query({ prompt: AsyncIterable<SDKUserMessage> })`
   - 向外暴露当前 Hanako 需要的 `prompt()/abort()/steer()/subscribe()`
2. `ClaudeSessionStore`
   - Hanako 自己维护每个 agent 的本地 session metadata
   - metadata 中保存 `sessionId/cwd/agentId/title/archiveState/...`
3. `ClaudeToolAdapter`
   - 把 Hanako 现有 custom tool 从 TypeBox + `execute()` 适配成 Claude SDK MCP server tool
4. `ClaudePermissionAdapter`
   - 把 Hanako 当前 `sandbox.mode/path_rules/tools.builtin_enabled/tools.custom_enabled`
   - 映射成 Claude SDK 的 `tools/allowedTools/disallowedTools/canUseTool/sandbox`

## 4.3 为什么不直接用“一次 query 一轮”的最小方案

因为 Hanako 现有架构依赖这些能力：

- 会话对象长驻
- 可中途中断
- 可插话 `steer`
- 多 session 并发
- Bridge session 与桌面 session 共存
- 运行时切权限/切工具/切模型

所以内部实现应基于 Claude SDK 的“流式输入 session”，而不是每一轮重新拉起一个 one-shot `query()`。

## 5. 旧接口 -> 新接口映射

| 旧能力 | 旧接口 | 新接口/实现 |
| --- | --- | --- |
| 创建会话 | `createAgentSession()` | `query({ prompt: AsyncIterable<SDKUserMessage>, options })` + `ClaudeSessionRuntime` |
| 打开/恢复会话 | `SessionManager.open()` | 本地 metadata 读出 `sessionId`，再用 `resume` 恢复 |
| 列出会话 | `SessionManager.list()` | `ClaudeSessionStore.list()` + Claude `getSessionInfo()` |
| 读取历史消息 | 直接读 Pi JSONL | `getSessionMessages(sessionId, { dir: cwd })` |
| 自定义工具 | `ToolDefinition` | `tool()` + `createSdkMcpServer()` |
| Skills 扫描 | `DefaultResourceLoader/loadSkills` | Hanako 自己扫描 skills 目录并注入 `append` |
| system prompt | 纯字符串 `agent.systemPrompt` | `systemPrompt: { type: "preset", preset: "claude_code", append }` |
| 内置 bash/read/edit | Pi builtin tool factories | Claude SDK `tools` builtin set |
| 沙箱 | `createSandboxedTools()` + wrapper | `sandbox` + `permissionMode` + `canUseTool` |
| 工具白名单 | `builtin_enabled/custom_enabled` | `tools` + `disallowedTools` + custom MCP server 名称控制 |

## 6. Claude Agent SDK 里要用的类/函数/参数

## 6.1 `query()`

用途：创建 Hanako 的主运行 session。

签名重点：

```ts
query({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: Options,
}): Query
```

Hanako 将使用：

- `prompt: AsyncIterable<SDKUserMessage>`
  - 让同一个 Claude 进程长期存活，支持多轮输入
- 返回值 `Query`
  - 既是 `AsyncGenerator<SDKMessage>`，也是控制句柄

需要用到的 `Query` 方法：

- `interrupt()`
  - 用于 Hanako 的 `abort()`
- `streamInput()`
  - 作为会话内追加消息的底层能力
- `setPermissionMode()`
  - 支持运行时切权限
- `setModel()`
  - 支持运行时切模型
- `close()`
  - 关闭 session

## 6.2 `Options`

Hanako 迁移时会重点使用这些字段：

### `cwd?: string`

- 含义：Claude session 的工作目录
- Hanako 用途：替代 Pi `SessionManager.getCwd()`

### `model?: string`

- 含义：当前 session 使用的模型 ID
- Hanako 用途：由现有 `ExecutionRouter/AuthStore/ProviderRegistry` 解析后写入

### `systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string; excludeDynamicSections?: boolean }`

- Hanako 统一改为：

```ts
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: buildHanakoAppendPrompt(...)
}
```

- 不再把 Hanako 的整份 system prompt 直接作为裸字符串塞进去
- `append` 用于注入：
  - Hanako 身份
  - public/private ishiki
  - 用户档案
  - memory / pinned memory
  - skills
  - 工作区提示
  - 当前时间提示
  - Hanako 特有工具约定

### `tools?: string[] | { type: "preset"; preset: "claude_code" }`

- 含义：本 session 可见的 Claude 内置工具集合
- Hanako 用途：作为 builtin tool surface
- 建议：
  - 默认使用 Claude builtin 全集，再配合 `disallowedTools`
  - 不再自己构造 Pi builtin tool 实例

### `allowedTools?: string[]`

- 含义：自动批准的工具
- Hanako 用途：
  - 对安全的读工具、受控目录内编辑工具进行自动放行
  - 替代当前“标准模式里有些工具不询问”的一部分逻辑

### `disallowedTools?: string[]`

- 含义：彻底禁止的工具
- Hanako 用途：
  - 根据当前 agent 配置关闭不该出现的 builtin/custom tool
  - 对 bridge 场景禁用不适合的工具

### `canUseTool?: CanUseTool`

- 含义：运行时权限回调
- Hanako 用途：
  - 实现 per-agent 路径权限
  - 实现“沙箱外命令是否允许”
  - 实现当前 UI/设置页的权限确认逻辑

### `permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"`

- Hanako 默认：
  - 主聊天：`default` 或 `acceptEdits`
  - 自动巡检/后台任务：`dontAsk` + 明确 allow list
  - 绝不默认用 `bypassPermissions`

### `sandbox?: SandboxSettings`

- 含义：Claude SDK 的命令执行沙箱
- Hanako 用途：替代 `lib/sandbox/*`
- 重点字段：
  - `enabled`
  - `failIfUnavailable`
  - `autoAllowBashIfSandboxed`
  - `allowUnsandboxedCommands`
  - `network`
  - `filesystem`
  - `excludedCommands`

### `includePartialMessages?: boolean`

- 含义：返回 `stream_event`
- Hanako 用途：把 SDK 原始 stream 事件重新映射成当前 WS/CLI 所需的增量事件

### `resume?: string`

- 含义：按 `sessionId` 恢复历史会话
- Hanako 用途：替代 `SessionManager.open()`

### `continue?: boolean`

- 含义：在同目录继续最近一次对话
- Hanako 用途：只作为 CLI/恢复兜底；主逻辑仍以显式 `resume: sessionId` 为准

### `persistSession?: boolean`

- 含义：是否持久化 Claude transcript
- Hanako 默认应为 `true`

### `settingSources?: ("user" | "project" | "local")[]`

- Hanako 默认建议为空数组 `[]`
- 原因：保持 SDK 隔离，不让外部 `CLAUDE.md/.claude/settings.json` 污染 Hanako 行为

### `env?: Record<string, string | undefined>`

- Hanako 用途：
  - 注入第三方 Anthropic-compatible provider 的认证和 base URL
  - 注入 `CLAUDE_AGENT_SDK_CLIENT_APP`

关键环境变量：

- `ANTHROPIC_BASE_URL`
  - 指向第三方兼容 Anthropic Messages API 的 base URL
- `ANTHROPIC_API_KEY`
  - 标准 API key 模式
- `ANTHROPIC_AUTH_TOKEN`
  - 如 provider 用 auth token 而不是 x-api-key，可走这个

## 6.3 `createSdkMcpServer()` 与 `tool()`

Hanako 的 custom tools 统一改为进程内 MCP server。

推荐结构：

```ts
const server = createSdkMcpServer({
  name: "hanako-tools",
  version: "1.0.0",
  tools: [
    tool(...),
    tool(...),
  ],
});
```

参数含义：

- `name`
  - MCP server 名称，建议按 Hanako 自定义工具域拆分
- `version`
  - 版本号
- `tools`
  - 由 `tool()` 定义的工具数组

`tool(name, description, inputSchema, handler, extras?)` 参数含义：

- `name`
  - 工具名
- `description`
  - 给模型看的工具描述
- `inputSchema`
  - Zod schema
- `handler`
  - 真正执行逻辑
- `extras.annotations`
  - `readOnlyHint/destructiveHint/idempotentHint/openWorldHint`

## 6.4 Session API

Hanako 将使用：

- `listSessions()`
- `getSessionInfo()`
- `getSessionMessages()`
- `renameSession()`
- `tagSession()`

用法：

1. Claude transcript 负责“真实会话历史”
2. Hanako 本地 metadata 负责“agent 归属、前端 path、记忆开关、归档状态”

## 6.5 `SDKMessage` 与关键消息类型

Hanako 事件桥接必须识别这些类型：

- `SDKSystemMessage`
  - 读取 `session_id/model/tools/permissionMode`
- `SDKPartialAssistantMessage`
  - 实时增量 text/tool call streaming
- `SDKAssistantMessage`
  - 一轮完整 assistant message
- `SDKToolProgressMessage`
  - 工具执行中的进度消息
- `SDKToolUseSummaryMessage`
  - 工具使用摘要
- `SDKResultMessage`
  - 一轮结束、usage/cost/stop reason
- `SDKSessionStateChangedMessage`
  - `idle/running/requires_action`

## 7. Hanako 内部配置映射

## 7.1 模型与 provider

保留现有：

- `ProviderRegistry`
- `ModelCatalog`
- `AuthStore`
- `ExecutionRouter`

移除：

- `AuthStorage`
- `ModelRegistry`
- `@mariozechner/pi-ai/oauth` 对 Claude runtime 的依赖

最终运行时映射：

```ts
const resolved = executionRouter.resolve("chat", agentConfig, sharedModels, utilOverride);

const options = {
  model: resolved.modelId,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: resolved.baseUrl,
    ANTHROPIC_API_KEY: resolved.apiKey || undefined,
  },
};
```

前提：

- 第三方 provider 必须兼容 Anthropic Messages API 输出格式
- Hanako 的 provider 页面要明确标注“Claude Agent SDK 运行时只支持 Anthropic-compatible provider”

## 7.2 system prompt

新策略：

- 基底：Claude Code preset
- 附加：Hanako append prompt

append 的来源：

1. 平台说明
2. Hanako 身份/人格/ishiki
3. 用户档案
4. pinned memory
5. memory
6. skills
7. 可用工具说明
8. 工作区说明
9. 当前时间说明

要删除的旧思路：

- 把完整大 prompt 当成自定义 `systemPrompt: string`

## 7.3 内置工具映射

旧 Hanako builtin 名称保留在配置层，运行时映射到 Claude 工具名：

| Hanako 配置名 | Claude SDK builtin |
| --- | --- |
| `read` | `Read` |
| `grep` | `Grep` |
| `find` | `Glob` |
| `ls` | `Glob` 或 `Read` 目录能力补位 |
| `write` | `Write` |
| `edit` | `Edit` |
| `bash` | `Bash` |

说明：

- Claude SDK 没有与 Pi `find/ls` 完全一一对应的旧名字，Hanako 运行时要做“配置名 -> Claude 工具名”的兼容翻译。

## 7.4 自定义工具

保留为 Hanako MCP custom tools：

- `search_memory`
- `pin_memory`
- `unpin_memory`
- `recall_experience`
- `record_experience`
- `cron`
- `notify`
- `present_files`
- `create_artifact`
- `channel`
- `ask_agent`
- `dm`
- `browser`
- `update_settings`
- `delegate`
- `claude_core`
- `describe_images`
- `generate_images`

其中要特别注意：

- `todo`
  - 优先切换为 Claude builtin `TodoWrite`
  - 如为了兼容前端短期保留旧名，则只做兼容壳，不再依赖 Pi session branch

## 7.5 沙箱与权限

旧 Hanako 配置：

```yaml
sandbox:
  mode: standard | balanced | full-access
  path_rules:
    - path: /abs/path
      access: read_only | read_write
```

迁移后映射：

### `standard`

- `sandbox.enabled = true`
- `sandbox.failIfUnavailable = true`
- `permissionMode = default`
- `canUseTool` 强限制 path rule

### `balanced`

- `sandbox.enabled = true`
- `sandbox.allowUnsandboxedCommands = true`
- 对指定命令通过 `canUseTool` 允许 `dangerouslyDisableSandbox`

### `full-access`

- `sandbox.enabled = false`
- `permissionMode = acceptEdits` 或按场景更高

路径规则实现原则：

1. Claude SDK `sandbox.filesystem` 只做静态基础限制
2. Hanako 的 `path_rules` 最终以 `canUseTool()` 为准
3. 所有自定义工具也必须复用同一套路径判定，不允许绕过

## 8. 事件桥接方案

当前前端/CLI 依赖 Pi 风格事件，因此迁移时要做一层 Claude -> Hanako 事件转换。

输入：

- `SDKPartialAssistantMessage.event.type === "content_block_start"`
- `SDKPartialAssistantMessage.event.type === "content_block_delta"`
- `SDKPartialAssistantMessage.event.type === "content_block_stop"`
- `SDKToolProgressMessage`
- `SDKResultMessage`

输出仍保持当前 Hanako WS 事件协议：

- `text_delta`
- `thinking_start/thinking_delta/thinking_end`
- `tool_start`
- `tool_end`
- `turn_end`
- `context_usage`

解析规则：

1. `content_block_delta` + `text_delta`
   - 转成 `text_delta`
2. `content_block_start` + `tool_use`
   - 转成 `tool_start`
3. `content_block_delta` + `input_json_delta`
   - 累积 tool input
4. `content_block_stop`
   - 转成 tool call 完成
5. `SDKToolProgressMessage`
   - 转成工具执行中的状态更新
6. `SDKResultMessage`
   - 作为本轮结束信号

## 9. 需要替换或重写的模块

## 9.1 必须重写

- [core/session-coordinator.js](/Users/tc/PythonProject/openhanako/core/session-coordinator.js)
- [core/bridge-session-manager.js](/Users/tc/PythonProject/openhanako/core/bridge-session-manager.js)
- [hub/agent-executor.js](/Users/tc/PythonProject/openhanako/hub/agent-executor.js)
- [server/routes/chat.js](/Users/tc/PythonProject/openhanako/server/routes/chat.js)
- [server/routes/sessions.js](/Users/tc/PythonProject/openhanako/server/routes/sessions.js)
- [server/routes/desk.js](/Users/tc/PythonProject/openhanako/server/routes/desk.js)
- [core/model-manager.js](/Users/tc/PythonProject/openhanako/core/model-manager.js)
- [lib/sandbox/index.js](/Users/tc/PythonProject/openhanako/lib/sandbox/index.js)

## 9.2 必须适配

- [core/engine.js](/Users/tc/PythonProject/openhanako/core/engine.js)
- [core/agent.js](/Users/tc/PythonProject/openhanako/core/agent.js)
- [core/skill-manager.js](/Users/tc/PythonProject/openhanako/core/skill-manager.js)
- [core/llm-utils.js](/Users/tc/PythonProject/openhanako/core/llm-utils.js)
- [index.js](/Users/tc/PythonProject/openhanako/index.js)

## 9.3 依赖层

- [package.json](/Users/tc/PythonProject/openhanako/package.json)
- [package-lock.json](/Users/tc/PythonProject/openhanako/package-lock.json)

## 10. 实施顺序

### Phase 1. 依赖与基础设施

1. 安装 `@anthropic-ai/claude-agent-sdk`
2. 安装 `zod`
3. 移除 `@mariozechner/pi-coding-agent`
4. 新增 Claude session/runtime/store/adapter 模块

### Phase 2. 会话层

1. 建立 `ClaudeSessionRuntime`
2. 建立 `ClaudeSessionStore`
3. 改写 `SessionCoordinator`
4. 改写 `BridgeSessionManager`
5. 改写 `AgentExecutor`

### Phase 3. 工具与沙箱

1. 建立 `ClaudeToolAdapter`
2. 自定义工具 MCP 化
3. 建立 `ClaudePermissionAdapter`
4. 替换 builtin tool/sandbox 执行链

### Phase 4. Prompt 与 Skills

1. `buildHanakoAppendPrompt()`
2. 移除 `DefaultResourceLoader`
3. 改为 Hanako 自己扫描 skills 并注入 append

### Phase 5. API 与前端兼容

1. 改写 WS 事件桥接
2. 改写 session list/history API
3. 改写 desk 对 sessionPath 的解析
4. 保持前端 sessionPath 协议不变

### Phase 6. 清理

1. 删除 Pi SDK imports
2. 删除不再使用的 sandbox wrapper
3. 删除不再使用的 ModelRegistry/AuthStorage 逻辑
4. 更新测试

## 11. 本次实施的明确边界

本次代码实施必须达到：

1. 运行时不再依赖 `@mariozechner/pi-coding-agent`
2. 主聊天 session、bridge session、isolated execution 都跑在 Claude Agent SDK 上
3. Claude Code preset 成为唯一 system prompt 基底
4. Hanako 身份/意识/记忆全部走 `append`
5. 内置工具与沙箱主链路改为 Claude SDK
6. 第三方模型通过 Anthropic-compatible base URL 驱动

不接受以下“最小替换”：

1. 只把 import 改名但仍沿用 Pi 的运行时假设
2. 保留 Pi builtin tools 作为真实执行面
3. 继续把 Hanako 完整 prompt 当自定义裸字符串塞给 SDK
4. 继续把 Pi transcript JSONL 当唯一历史来源
