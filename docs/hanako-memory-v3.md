# Hanako 统一记忆系统落地计划 v3

本版以“先切断双真相源，再做模型升级”为硬原则推进。本文档是实施约束，不是讨论稿。

## 核心原则

- DB 是唯一真相源；`user.md`、`pinned.md`、`experience*.md`、`memory.md` 全部降级为投影视图
- 所有写入必须经过统一 `MemoryService` 校验；禁止 API、工具、ticker、频道链路直接写文件或直写 `FactStore`
- 事实抽取只以 `evidence` 为事实源；`summary` 不再参与结构化事实抽取
- `facts` 同名替换迁移必须强事务回滚；失败不得推进 schema version
- 删除语义改为 `invalidate/cancel`；物理删除只保留运维入口

## P0 硬门槛

### 1. Prompt 全面禁止读文件

禁止范围不止 `core/agent.js`，还包括所有会把记忆内容直接拼进 prompt 或模型输入的路径。

- 必须切断的现有文件真相源：
  - `core/agent.js`
  - `hub/channel-router.js`
  - `core/engine.js` 中 diary 写入路径
- Phase 1 完成条件：
  - prompt 构建只允许调用统一存储渲染接口
  - `user.md`、`pinned.md`、`memory.md` 只供 UI、导出、兼容查看
  - 任何 prompt 相关代码不得再以“文件内容会变化，所以从磁盘读取”为理由旁路 DB

### 2. 兼容入口必须全部先切服务层

兼容期允许保留旧 API 和旧工具名，但不允许保留旧写入方式。

- 必须改造的入口：
  - `/api/user-profile`
  - `/api/pinned`
  - `/api/agents/:id/pinned`
  - `/api/agents/:id/experience`
  - `pin_memory` / `unpin_memory`
  - `record_experience` / `recall_experience`
- `setup_settings` 也必须纳入约束：
  - 不允许直接 `clearAll`
  - 不允许直接删除 `facts.db`
  - 不允许直接清空 `pinned.md`
  - 清理记忆必须调用 `MemoryService` 的失效/归档/重建接口
- Phase 1 完成条件：
  - 上述入口全部只调用服务层
  - 文件写入仅由投影器执行
  - 不再存在路由或工具直接 `new FactStore(...)`、`fs.writeFileSync(pinned.md)`、`fs.writeFileSync(user.md)`、`experience/*.md` 直写

### 3. Evidence-first 必须封口，旧抽取入口下线

旧链路 `summary diff -> factStore.addBatch` 必须视为待下线路径，而不是“暂时共存”。

- 禁止继续作为事实源的路径：
  - `memory-ticker -> processDirtySessions`
  - `deep-memory -> extractFactsFromDiff`
  - `deep-memory -> factStore.addBatch`
- 新链路固定为：
  1. turn/channel/tool 输出先写 `evidence`
  2. `episodes` 从 `evidence` 聚合
  3. 反思器只从 `evidence + episode anchor` 提取 `facts/playbooks`
- 允许保留的旧能力：
  - `summary` 可继续用于滚动概览、today/week/longterm 投影、兼容展示
  - transcript 尾读只可用于兼容恢复，不可作为结构化事实源
- Phase 2 完成条件：
  - `deep-memory` 不再接受 `summary diff` 作为事实输入
  - `summary` 不再进入结构化事实抽取路径

### 4. 频道禁写 profile 必须是存储层硬约束

不能只靠 prompt 提示词限制模型。

- 所有 memory 写路径都必须经过 `MemoryService`
- 服务层必须校验：
  - `origin=channel` 时禁止写 `scope=profile`
  - 任意模型偏航产出的 profile 写入一律拒绝
  - 拒绝事件要进入诊断日志，便于 doctor 和回放评估检查
- 频道链路改造要求：
  - `hub/channel-router` 先落 `evidence`
  - 频道 summary/episode/fact 生成都通过服务层
  - 禁止频道链路绕过服务层直写 `summaryManager` 之外的结构化记忆
- Phase 2 完成条件：
  - 所有 memory 写入都有 `origin/scope` 校验
  - 不存在绕过校验直写库的旁路

### 5. facts 同名替换迁移必须失败回滚

当前迁移实现里的吞错逻辑与 v3 原则冲突，不能沿用。

- 迁移实现要求：
  - 禁止 `safeExec` 吞错
  - 任一步失败都要回滚整个迁移事务
  - 只有迁移成功后才能推进 `user_version`
  - 迁移完成后再安装新 FTS/索引，并做记录数校验
- 初始化顺序要求：
  - 先迁移，再初始化运行时语句和触发器
  - 不允许继续使用“先 initSchema，再局部 migrate”的宽松模式来做同名替换
- Phase 1 完成条件：
  - 旧 `facts` 成功改名为 `facts_legacy_v2`
  - 新同名 `facts` 可承载旧字段和新字段
  - 迁移失败时数据库结构与版本号保持旧状态

### 6. 删除语义必须改为失效，不允许普通入口物理清库

- 默认删除接口改造为：
  - `memory_invalidate(ids|state_key)`
  - `cancel_mark(mark_id)`
  - “清空记忆”改为批量失效/归档
- 必须同步替换的现有调用点：
  - `FactStore.delete`
  - `FactStore.clearAll`
  - `/api/memories` 删除路径
  - 所有通过配置或设置页触发的“清空记忆”动作
- 物理删除只允许：
  - 独立运维工具
  - 明确脱离普通 UI / 普通 API / 普通工具
- Phase 1 完成条件：
  - 普通用户路径不再触发物理删
  - 审计链在删除后仍可追溯到 `evidence`

## P1 补强项

### 1. 继续封堵服务层旁路

- 路由层不应再直接 `new FactStore(...)`
- 远程 agent 或非当前 agent 的记忆访问，也必须走 `MemoryService` 或对应 reader facade

### 2. memory_doctor 升级为 v3 规则集

现有 `memory-doctor` 仍是旧检查面，必须补充：

- 双真相源违规
- summary 误入事实链
- channel/profile 违规写入
- 过期仍 active
- ranking 配置漂移
- 兼容文件与 DB 投影不一致

### 3. sandbox 写白名单与“文件只投影”对齐

- `pinned.md` 不应继续出现在普通可写白名单中
- 若保留写权限，也只能给投影器或运维工具，不应对普通运行时开放

## 存储与迁移

### 本地与全局库

- agent 本地统一库继续使用 `memory/facts.db`
- 全局用户画像单独使用 `userDir/user-memory.db`

### facts 同名替换

- 旧 `facts` -> `facts_legacy_v2`
- 新建同名 `facts`
- 运行时只查新 `facts`
- 新表至少保留旧运行时代码所需字段：
  - `fact`
  - `tags`
  - `time`
  - `timeliness`
  - `state_key`
  - `valid_from`
  - `valid_to`
  - `is_active`
  - `session_id`
  - `created_at`
- 新增字段：
  - `scope`
  - `origin`
  - `source_refs`
  - `truth_time`
  - `confidence`
  - `importance`
  - `subject_id`
  - `hash`
  - `updated_at`
  - `invalidated_by`

### 新增表

- agent 本地：
  - `evidence`
  - `episodes`
  - `playbooks`
  - `fact_links`
  - `retrieval_logs`
  - `memory_marks`
  - `memory_jobs`
- 全局：
  - `profiles`

## 服务层与写入约束

### MemoryService

- 负责新增、更新、失效、导入导出、投影、审计
- 所有入口只能调服务层
- `FactStore` 降级为底层适配器，不允许上层直接调用写方法

### 固定校验

- `stateful` 必须有 `state_key`
- `ephemeral` 必须有 TTL
- `origin=channel` 禁止 `scope=profile`
- `playbook` 必须具备：
  - `trigger`
  - `wrong_path`
  - `root_cause`
  - `fix_steps`
  - `validation`
- `source_refs` 必填且可追到 `evidence`

## 跨库一致性

- 禁止单次跨库写
- 单 API / 工具一次只提交一个库
- 跨库流程拆分为：
  1. 主库提交
  2. 如需更新 `profiles`，写 `memory_jobs`
  3. worker 按幂等键异步消费
- 不做跨库补偿回滚

### memory_jobs 最低要求

- 幂等键
- 租约字段
- 指数退避
- 最大重试次数
- 死信状态
- 恢复操作不允许覆盖较新的 profile 版本

## 兼容投影与 Prompt

- `user.md`
- `pinned.md`
- `experience/*.md`
- `experience.md`
- `memory.md`

这些文件全部只由投影器生成。

### 明确禁止

- 文件自动反写 DB
- prompt 直接读兼容文件
- 兼容文件被用户手工修改后自动回灌 DB

### 唯一允许的回灌方式

- 显式 `memory_import`

## 检索、日志与导入导出

### 检索接口

- `search_memory_index`
- `get_memory_timeline`
- `get_memory_details`
- `memory_upsert_profile`
- `memory_add_playbook`
- `memory_invalidate`
- `memory_audit_trace`
- `memory_export`
- `memory_import`

### search_memory 兼容约束

- 输入不变
- 输出仍是单段文本列表
- 内部可走 `index + details`
- 旧格式必须稳定，不允许提示词消费侧因形状变化而抖动

### retrieval_logs 最低要求

- `ranking_version`
- 组件分数
- 最终排序
- 配置快照（权重、阈值、过滤条件）
- 采样率
- 保留期

### 导出导入协议

联合导出协议必须覆盖：

- agent 本地库
- 全局 `profiles`

禁止只导出 `facts` 而遗漏全局画像。

## 安全与脱敏

- `evidence` 入库前统一执行 PII/密钥脱敏
- 不能只对 `facts` 或 `summary` 做脱敏
- 审计链允许追溯事实，但不允许把敏感原始工具输出明文永久暴露给普通路径

## Rollout

1. Phase 0：测试基线
   - 排除 `dist/**`、`*.app/**`、`*-unpacked/**`
   - 确认主源码测试结果干净
2. Phase 1：单一真相源切断
   - `facts` 强事务同名替换迁移
   - `MemoryService`
   - prompt 改为 DB 渲染
   - `/api/user-profile`、`/api/pinned`、`/api/agents/:id/pinned`、`/api/agents/:id/experience`、`pin/unpin_memory`、`record/recall_experience` 全改服务层
   - 文件投影器上线
3. Phase 2：Evidence-first 与频道约束
   - turn/channel/tool 全量写 `evidence`
   - `deep-memory` 下线旧 summary diff 抽取入口
   - 频道写入经过 `origin/scope` 校验
   - `memory_jobs` worker、重试、死信上线
4. Phase 3：三段检索与联合导入导出
   - 新检索接口上线
   - `search_memory` 兼容包装完成
   - 联合导出导入协议完成
   - `retrieval_logs` 版本化与采样上线
5. Phase 4：Prompt 默认切换与治理
   - 主 prompt 切到“Profile 摘要常驻 + 按需检索”
   - `memory.md` 仅保留投影视图
   - 回放评估、审计链、doctor 指标齐套

## 验收标准

### Phase 1 验收

- `core/agent.js`、`hub/channel-router.js`、`core/engine.js` 不再把兼容文件当 prompt 真相源
- `/api/user-profile`、`/api/pinned`、`/api/agents/:id/pinned`、`/api/agents/:id/experience`、`pin/unpin_memory`、`record/recall_experience` 全部改为服务层写 DB
- `setup_settings` 不再物理清库/删库/清空 pinned 文件
- `facts` 迁移失败时数据库回滚，`user_version` 不前进
- 普通删除路径不再物理删

### Phase 2 验收

- `deep-memory` 不再从 `summary` 直接抽事实
- transcript tail 不再是结构化事实源
- 所有 memory 写入都有 `origin/scope` 校验
- channel origin 写 profile 会被拒绝

### 全局验收

- prompt 构建不发生任何 `user.md/pinned.md/memory.md` 直读
- 修改兼容文件不会自动影响 DB
- `search_memory` 输出文本与旧格式一致
- doctor 能检出 v3 新规则违规

