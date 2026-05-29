# Hanako Agent Memory 开源项目调研与升级审查

时间：2026-05-26  
范围：`/Users/tc/PythonProject/openhanako/.research/agent-memory/`

本次调研覆盖 11 个项目：

1. `A-mem`
2. `TencentDB-Agent-Memory`
3. `agentmemory`
4. `claude-mem`
5. `cortex-mem`
6. `graphiti`
7. `hindsight`
8. `langmem`
9. `letta`
10. `mem0`
11. `memU`

## Hanako 当前基线

结合 `lib/memory/`、`server/routes/memory.js`、`docs/hanako-memory-v3.md`，Hanako 已经具备一套相对完整的 v3 记忆骨架：

- 以 `facts.db` 为中心，`facts / evidence / episodes / playbooks / marks / profiles / memory_jobs / retrieval_logs` 已落库。
- 事实抽取链已经是 `evidence -> episode -> facts/playbooks`，不是纯 summary 驱动。
- 检索侧已经有 `BM25 + tag + entity token + recency + confidence + importance + intent/scope prior + freshness guard`。
- 兼容文件 `user.md / pinned.md / experience.md / memory.md` 已基本降级为投影视图。
- 已有 `memory-doctor`、`retrieval_logs`、`channel/profile` 写入约束、归档/恢复语义。

结论：Hanako 的短板不在“没有记忆库”，而在“记忆之间的连通性不够可见”和“检索过程虽然有审计数据，但没有正式对外暴露和消费路径”。

## 各项目优点与 Hanako 适配判断

### 1. A-mem

优点：

- 强调 agentic memory，自组织笔记、标签、上下文和记忆连接。
- 适合把离散记忆组织成网络，而不是单条召回。

对 Hanako 的启发：

- Hanako 已有 `source_refs` 和 `fact_links`，但没有把“记忆网络”真正暴露给用户或调试链路。

### 2. TencentDB-Agent-Memory

优点：

- 分层非常清晰：短期符号化压缩、长期 L0-L3 金字塔、可回钻。
- 强调“上层结构 + 下层证据”的可恢复链路。

对 Hanako 的启发：

- Hanako 已有 evidence-first 和 projection，但“详情页继续钻取相关记忆”的体验不足。

### 3. agentmemory

优点：

- 面向 coding agent 的跨会话共享记忆。
- 强调 viewer、hooks、MCP、审计可见性，工程完成度高。

对 Hanako 的启发：

- Hanako 已有 `retrieval_logs`，但缺少正式可读接口与前端消费。

### 4. claude-mem

优点：

- 强调 progressive disclosure、搜索工具、viewer、引用和上下文压缩。
- 用户能看到“记忆为什么被放进来”。

对 Hanako 的启发：

- Hanako 应补齐“检索轨迹可视化入口”和“关联引用跳转”。

### 5. cortex-mem

优点：

- 三层上下文加载、虚拟文件系统命名、仪表盘、缓存和增量更新。
- 把不同维度记忆组织成稳定路径。

对 Hanako 的启发：

- Hanako 不需要照搬 VFS，但可以借鉴“稳定路径 + 分层浏览 + observability”。

### 6. graphiti

优点：

- 时序图谱强，实体/关系/episodes/provenance 一体化。
- 强调事实失效而不是删除，适合处理“曾经为真”和“现在为真”。

对 Hanako 的启发：

- Hanako 已有 `valid_from / valid_to / invalidated_by`，但关联关系的消费层还弱。

### 7. hindsight

优点：

- 区分 world / experiences / mental models。
- `retain / recall / reflect` 三段式语义明确。

对 Hanako 的启发：

- Hanako 当前更强在 retain/recall，reflect 暴露不足，后续可做“反思结果层”。

### 8. langmem

优点：

- 热路径 memory tools 与后台 memory manager 分离。
- 适合把“当场记”和“后台整理”解耦。

对 Hanako 的启发：

- Hanako 已有工具和后台 ticker，但缺少更清晰的“热路径管理入口”的外显能力。

### 9. letta

优点：

- 把 agent memory blocks 做成一等概念，适合长期 persona 和自我改进。

对 Hanako 的启发：

- Hanako 的 `profile projection` 已接近这一路线，但还可以继续做 block 化展示。

### 10. mem0

优点：

- 新版算法明确强调 add-only、entity linking、multi-signal retrieval、temporal reasoning。
- 很适合作为现代检索设计对照组。

对 Hanako 的启发：

- Hanako 已有多信号排序和 freshness guard，但 entity linking 只停留在 token 级，不够结构化。

### 11. memU

优点：

- 把记忆作为 24/7 主动 agent 的底座。
- 强调意图捕捉、长期在线、主动触发。

对 Hanako 的启发：

- Hanako 的 `desk / heartbeat / cron` 已有主动运行机制，未来可与记忆更紧耦合。

## 初版升级计划 v1

候选工作流分 4 组：

1. 关联记忆图谱消费层
2. 检索审计外显层
3. 反思结果层
4. 主动记忆调度层

### 1. 关联记忆图谱消费层

- 目标：把 `source_refs / fact_links / state_key / decision_key / subject_id` 真正用于详情钻取。
- 结果：事实、证据、事件锚点、经验、置顶可以互相跳转。

### 2. 检索审计外显层

- 目标：正式暴露 `retrieval_logs`。
- 结果：能看到 query、路由、排序权重、最终结果、每项 component score。

### 3. 反思结果层

- 目标：把 hindsight 的 reflect 思路引入 Hanako。
- 风险：会新增一层存储语义与新抽取任务，改动较大。

### 4. 主动记忆调度层

- 目标：把 memU 的 proactive memory 与 Hanako `heartbeat / cron` 融合。
- 风险：需要定义主动触发边界，避免过度动作。

## 第一次全面审查：可实施性

### 结论

v1 过大，不能在当前仓库里“严格实施并完整验证”。

### 原因

- `反思结果层` 需要新增 schema、任务调度、评估集，不适合在本轮与现有 deep-memory 并行大改。
- `主动记忆调度层` 会牵动 desk/automation 语义，不是纯 memory 子系统改造。
- 真正高收益且低侵入的缺口，是“现有结构没有被好好消费”。

### 审查后收缩

把本轮实施聚焦为一个完整里程碑：

`M1: Connected + Auditable Memory`

包含两件事：

1. 关联记忆钻取
2. 检索轨迹外显

## 第二次全面审查：完整性

### 检查项

- 是否有明确的用户可见收益
- 是否能复用现有 schema，而不是引入第二套真相源
- 是否能覆盖服务层、接口层、前端消费层、测试层
- 是否符合 v3 的 evidence-first / projection-only / 非兜底原则

### 结论

`M1: Connected + Auditable Memory` 完整且可闭环。

### 理由

- 用户可见：记忆详情页可以继续打开相关证据、锚点、同状态事实、同来源经验。
- 服务层可验证：完全复用 `source_refs / fact_links / retrieval_logs`，不新增旁路写入。
- 接口层可验证：新增 retrieval logs 读取接口。
- 前端可验证：MemoryViewer 展示关联记忆。
- 测试可验证：可为 service 和 route 写单测，不依赖外部模型。

## 最终实施方案

本轮严格实施 `M1: Connected + Auditable Memory`。

### 方案内容

1. `MemoryService.getDetails()` 增加 `relatedItems`
2. 关联来源覆盖：
   - 直接来源 `evidence / episode`
   - 共享 `evidence / episode`
   - 同 `state_key`
   - 同 `decision_key`
   - 同 `subject_id`
   - 共享 `source_refs` 的 `playbook / mark`
3. 新增 `MemoryService.listRetrievalLogs()`
4. 新增 `/api/memory/retrievals`
5. 前端 MemoryViewer 详情弹窗展示“关联记忆”
6. 新增对应单元测试

### 明确不在本轮实施

- 图数据库替换
- 新的 reflect 存储层
- proactive memory 调度策略
- 全量 persona block 重构

这些作为后续路线图，不混入本轮最终方案。

## 实施状态

已落地：

- `lib/memory/memory-service.js`
  - 新增 `relatedItems`
  - 新增 `listRetrievalLogs()`
- `server/routes/memory.js`
  - 新增 `/api/memory/retrievals`
- `desktop/src/react/settings/overlays/MemoryViewer.tsx`
  - 新增关联记忆展示与点击跳转
- `desktop/src/locales/en.json`
- `desktop/src/locales/zh.json`
- `lib/memory/memory-service.test.js`
- `server/routes/memory.test.js`

待验证：

- 运行相关测试并检查是否有回归。
