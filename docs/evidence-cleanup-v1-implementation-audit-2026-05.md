# Hanako 证据自动清理实施后审查 v1

时间：2026-05-26

对应计划：[docs/evidence-cleanup-v1-2026-05.md](/Users/tc/PythonProject/openhanako/docs/evidence-cleanup-v1-2026-05.md)

## 审查结论

本轮已按计划完成 `Hanako 证据自动清理实施计划 v1` 的实现与补齐，未发现剩余必做项。

## 计划项对照

### 1. schema 补充

已完成。

证据：

- `evidence` 表新增 `retention_class / archive_after / purge_after`
- 老库补列与索引迁移已补上

对应文件：

- [lib/memory/fact-store.js](/Users/tc/PythonProject/openhanako/lib/memory/fact-store.js)

### 2. 证据分类器

已完成。

证据：

- `tool_result + success=true + 空正文` 直接跳过，不入库
- `tool_result + success=true` -> `tool_noise`
- `tool_result + success=false` -> `tool_debug`
- 普通会话证据默认 `session`
- 手动导入 / 经验沉淀路径归为 `core`

对应文件：

- [lib/memory/memory-service.js](/Users/tc/PythonProject/openhanako/lib/memory/memory-service.js)

### 3. 清理器

已完成。

证据：

- 已实现自动归档扫描
- 已实现延迟硬删扫描
- 已实现 archive 写入 `memory_archives`
- 已实现 purge 时删除 `evidence` 与关联 `fact_links`

对应文件：

- [lib/memory/memory-service.js](/Users/tc/PythonProject/openhanako/lib/memory/memory-service.js)

### 4. 保护规则

已完成。

证据：

- 自动清理前会收集并保护：
  - 活跃 facts 的 `fact_links.evidence_id`
  - 活跃 playbooks 的 `source_refs`
  - 活跃 marks 的 `source_refs`
  - 未归档 episodes 的 `source_refs`
  - 未归档 evidence 的 `source_refs`

对应文件：

- [lib/memory/memory-service.js](/Users/tc/PythonProject/openhanako/lib/memory/memory-service.js)

### 5. 触发方式

已完成。

证据：

- 写证据时会按天去重排入 `cleanup_evidence` job
- 已提供手动执行接口 `POST /api/memory/evidence-cleanup/run`

对应文件：

- [lib/memory/memory-service.js](/Users/tc/PythonProject/openhanako/lib/memory/memory-service.js)
- [server/routes/memory.js](/Users/tc/PythonProject/openhanako/server/routes/memory.js)

### 6. 前端可见性

已完成。

证据：

- 设置页“记忆”区已新增“证据清理”状态块
- 已展示策略摘要、待归档数量、待删除数量、保护跳过数量
- 已提供“立即清理证据”按钮

对应文件：

- [desktop/src/react/settings/tabs/AgentTab.tsx](/Users/tc/PythonProject/openhanako/desktop/src/react/settings/tabs/AgentTab.tsx)
- [desktop/src/react/settings/store.ts](/Users/tc/PythonProject/openhanako/desktop/src/react/settings/store.ts)
- [desktop/src/locales/zh.json](/Users/tc/PythonProject/openhanako/desktop/src/locales/zh.json)
- [desktop/src/locales/en.json](/Users/tc/PythonProject/openhanako/desktop/src/locales/en.json)

## 审查中发现并补齐的缺口

本次实施后审查发现两项测试证据不够完整，已补齐：

1. 原计划要求验证失败工具证据归类为 `tool_debug`，原测试未单独覆盖，现已新增。
2. 原计划要求验证被活跃事实 / 经验 / 置顶 / 事件 / 活跃证据引用保护的证据不会被自动清理，原测试只明确覆盖 facts，现已补成多引用类型保护回归用例。

补齐对应文件：

- [lib/memory/memory-service.test.js](/Users/tc/PythonProject/openhanako/lib/memory/memory-service.test.js)

## 全面测试结果

### 类型检查

通过。

- `npm run typecheck`

### 前端构建

通过。

- `npm run build:renderer`

备注：

- 构建过程中存在既有的 Vite 提示：
  - 非 module script 标签提示
  - 大 chunk warning
- 这两项未阻断构建，且不是本次证据清理改动引入的问题。

### 全量测试

通过。

- `npm test`
- 结果：`87` 个测试文件、`587` 条测试全部通过

备注：

- 当前运行环境中，少数依赖 `better-sqlite3` 的既有测试会按仓库现状自跳过并打印 ABI mismatch 提示；本次新增相关测试所在文件整体通过，未出现本次改动导致的失败。

## 最终判断

以当前代码、测试与构建证据看，`Hanako 证据自动清理实施计划 v1` 已按计划执行完整，且审查中发现的测试缺口已补齐。
