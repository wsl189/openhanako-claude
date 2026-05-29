# Hanako 证据自动清理实施计划 v1

时间：2026-05-26

目标：在不破坏 Hanako `evidence-first` 记忆链路的前提下，减少低价值证据堆积，建立可自动运行的证据归档与延迟硬删机制。

## 当前问题

当前仓库已经具备：

- `evidence -> episodes -> facts / playbooks` 的结构化链路
- `facts / playbooks / marks` 的失效、归档、恢复、硬删能力
- `evidence` 层的前端浏览入口

但当前还有三个明显缺口：

1. 工具结果会直接落成证据，成功空回执和低价值 stdout/stderr 会长期堆积
2. `evidence` 没有生命周期字段，无法区分“核心依据”和“短期噪声”
3. 缺少“无活跃引用才允许自动归档/自动硬删”的清理器

## v1 范围

本轮只做证据自动清理的第一版闭环，不做更大范围的记忆重写。

包含：

1. 工具噪声证据源头减量
2. 证据生命周期分级
3. 自动归档
4. 延迟硬删
5. 手动触发入口
6. 设置页状态可见性

不包含：

- 用户可配置的复杂保留策略编辑器
- 多维可视化仪表盘
- 证据内容向量压缩或摘要重写
- 跨 agent 的全局清理调度

## 设计原则

1. 活跃引用保护优先  
   仍被活跃 `facts / playbooks / marks / episodes / active evidence refs` 引用的证据，禁止自动归档或自动硬删。

2. 先归档，再硬删  
   自动清理必须分两步：
   - 第一步：从默认视图隐藏
   - 第二步：在宽限期后物理删除

3. 先治根因，再做清库  
   不能只加“定时删除”；要先减少低价值工具证据进入库。

4. 失败过程不默认等于垃圾  
   报错与失败过程对经验沉淀仍有价值，只做更长保留，不直接当噪声处理。

## v1 生命周期策略

### A. core

定义：

- 由手动事实导入、经验补证据等路径生成的核心依据
- 或后续已被活跃记忆链引用的证据

策略：

- 不设置自动归档时间
- 不设置自动硬删时间

### B. session

定义：

- 普通用户消息、助手消息形成的会话证据

策略：

- `archive_after = 45 天`
- `purge_after = 135 天`

### C. tool_noise

定义：

- 成功的工具结果证据
- 默认视为短期过程痕迹，而不是长期记忆资产

策略：

- `archive_after = 1 天`
- `purge_after = 7 天`

额外根因修复：

- 对“成功且无正文”的工具结果，直接不落证据

### D. tool_debug

定义：

- 失败的工具结果证据
- 有调试价值，但不适合长期无限保留

策略：

- `archive_after = 14 天`
- `purge_after = 45 天`

## 实施方案

### 1. schema 补充

为 `evidence` 增加：

- `retention_class`
- `archive_after`
- `purge_after`

用途：

- 让证据从写入时就带生命周期语义

### 2. 证据分类器

在 `MemoryService.recordEvidence()` 中统一决定生命周期：

- `tool_result + success=true + 仅回执头部` -> 直接跳过
- `tool_result + success=true` -> `tool_noise`
- `tool_result + success=false` -> `tool_debug`
- `assistant_message / user_message / session_message` -> `session`
- 内部补证据路径 -> `core`

### 3. 清理器

新增证据清理器，分两个阶段：

1. 自动归档：
   - 找出 `archive_after <= now`
   - 过滤掉仍被活跃引用的证据
   - 写入 `memory_archives`

2. 自动硬删：
   - 找出已经归档且 `purge_after <= now`
   - 再次过滤活跃引用
   - 删除 `evidence` 记录与对应 archive 记录

### 4. 保护规则

自动清理前必须检查这些引用：

- 活跃 `facts` 的 `fact_links.evidence_id`
- 活跃 `playbooks.source_refs`
- 活跃 `marks.source_refs`
- 未归档 `episodes.source_refs`
- 未归档 `evidence.source_refs`

### 5. 触发方式

v1 使用双触发：

1. 自动触发：
   - 每次写入证据时，按“天”粒度排一个 `cleanup_evidence` job

2. 手动触发：
   - 新增后端接口
   - 设置页提供“立即清理证据”按钮

### 6. 前端可见性

在设置页“记忆”区新增一块“证据清理”状态：

- 当前策略摘要
- 待自动归档数量
- 待自动删除数量
- “立即清理证据”按钮

## 第一次审查：合理性

### 结论

本方案合理，可直接落地。

### 原因

1. 不破坏 evidence-first  
   清理动作建立在“活跃引用保护”之上，不会把仍在支撑 `facts / playbooks` 的证据删掉。

2. 解决的是根因  
   先阻断低价值工具成功回执继续堆积，再做后续清理。

3. 能与现有结构兼容  
   当前仓库已有 `memory_archives`、`memory_jobs`、`settings memory library`，不需要引入新系统。

4. 风险可控  
   先归档再硬删，并保留手动触发与状态可见性，便于观察效果。

### 风险点

1. 如果把所有工具成功结果都当长期证据，会继续污染库  
   所以 v1 明确把成功工具证据默认降为 `tool_noise`。

2. 如果归档后仍被 `listEvidenceBySession()` 当作活跃输入，会形成“视图已隐藏但摘要仍引用”的错位  
   所以需要同步让按 session 读取证据的默认路径跳过已归档证据。

3. 如果只做自动硬删，不做手动触发入口，现有历史垃圾无法及时清  
   所以 v1 必须包含手动运行接口。

## 最终实施要求

严格按以下顺序实施：

1. 先补 plan 所需 schema 与服务层能力
2. 再接入 session tool evidence 的源头分类与跳过逻辑
3. 再补 route 与 settings 可见性
4. 最后补测试

## 测试要求

至少覆盖：

1. 成功无输出工具证据不会入库
2. 成功工具证据按 `tool_noise` 打生命周期
3. 失败工具证据按 `tool_debug` 打生命周期
4. 无活跃引用旧证据会被自动归档
5. 已归档且过期证据会被自动硬删
6. 被活跃事实/经验/置顶/事件引用的证据不会被自动清理
7. 手动触发接口可返回清理结果
8. renderer typecheck
