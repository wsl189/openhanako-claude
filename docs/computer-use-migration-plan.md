# Computer Use 完整迁移计划（cc-haha → Hanako）

## 目标
把 `cc-haha-main` 中的 `computer-use` 能力完整迁移到 Hanako，保留原有 `computer-use-mcp` 的工具集合、参数结构、调度逻辑与安全闸门语义，不做“阉割版”精简。

## 范围
- 完整保留 `vendor/computer-use-mcp` 核心逻辑。
- 在 Hanako 内实现可运行宿主层（Python bridge、执行器、权限/TCC 适配、会话状态绑定）。
- 作为 Hanako 自定义工具开关接入，并通过独立 MCP server 暴露 `mcp__computer_use__*` 工具族。
- 保持与 Hanako 现有 tool whitelist、事件流、runtime 配置模型兼容。

## 迁移阶段与执行状态
1. 盘点与映射（已完成）
- 识别 cc-haha `computer-use` 的核心边界：
  - `src/vendor/computer-use-mcp/*`
  - `src/utils/computerUse/{executor,pythonBridge,hostAdapter,gates,permissions,...}`
  - `runtime/{mac_helper.py,win_helper.py,requirements*.txt}`
- 识别 Hanako 接入点：
  - `core/agent.js` custom tool catalog
  - `core/claude-runtime-config.js` MCP server 注入与 `allowedTools`
  - `lib/claude/custom-tool-adapter.js` custom tool 适配链路

2. 内核迁入（已完成）
- 将 `computer-use-mcp` TS 源码迁入 `lib/computer-use/vendor-src/`。
- 编译产物输出到 `lib/computer-use/vendor/`（Node 可直接执行的 JS）。

3. 宿主层实现（已完成）
- 新增 `lib/computer-use/`：
  - `common.js`：server/switch 常量与平台能力
  - `gates.js`：环境变量驱动的总开关与子闸门
  - `permissions.js`：TCC 检测结果归一化
  - `python-bridge.js`：venv 自举、依赖安装、helper 调用
  - `executor.js`：对接 Python helper 的 `ComputerExecutor`
  - `host-adapter.js`：`ComputerUseHostAdapter` 绑定
  - `custom-mcp.js`：会话状态、锁、`bindSessionContext` 调度、工具定义生成
- 迁入 Python runtime：
  - `lib/computer-use/runtime/mac_helper.py`
  - `lib/computer-use/runtime/win_helper.py`
  - `lib/computer-use/runtime/requirements*.txt`

4. Hanako 自定义工具接入（已完成）
- 在 `core/agent.js` 注入 `computer_use` 开关型 custom tool。
- 在 `core/claude-runtime-config.js` 增加：
  - `computer_use` 独立 MCP server 挂载
  - `mcp__computer_use__*` allowlist 注入
  - 与现有 `claude_in_chrome`/`MiniMax` 并存

5. 验证与回归（已完成）
- 新增/更新测试：`core/claude-runtime-config.test.js`（computer_use 挂载与 noTools 行为）。
- 通过回归测试：
  - `core/claude-runtime-config.test.js`
  - `lib/claude/custom-tools-smoke.test.js`
  - `core/engine-permissions.test.js`

## 关键说明
- 工具族完整性：通过 `buildComputerUseTools(...)` 生成，保持与原实现一致。
- 会话状态：`allowedApps/grantFlags/lastScreenshotDims/display pin` 等通过 `bindSessionContext` 维持。
- 安全闸门：核心仍在迁入的 `computer-use-mcp` 内执行；Hanako 侧补齐平台权限检测与执行器。
- 当前审批模型：`request_access` 采用会话内自动批准路径（保持能力可用），其余安全闸门仍生效。
