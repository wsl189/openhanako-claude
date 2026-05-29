# Hanako Agent Memory vNext 一次性升级计划

时间：2026-05-26

目标：围绕已确认的前四项优化建议，做一次性升级、一次审查、一次严格实施与全面测试。

## 本轮目标范围

本轮只覆盖以下四项：

1. 结构化实体链接增强
2. reflect 层落地
3. 检索审计消费层完善
4. profile / persona block 化

不包含：

- 主动记忆调度
- 图数据库替换
- 第二套记忆真相源
- 大规模重写现有提取链

## 当前基线

当前仓库已经具备这些基础：

- `facts / evidence / episodes / playbooks / marks / profiles / retrieval_logs` 已落库
- `source_refs / fact_links / state_key / decision_key / subject_id` 已存在
- settings 已有 memory library、compiled memory、retrieval route、related items
- prompt 已固定注入 user profile / pinned / memory summary

当前主要缺口不是“没有能力”，而是：

- 结构化字段没有被充分消费
- reflect 结果还没有成为一等上下文
- retrieval audit 虽已存在，但用户不可读
- profile projection 还是“文本投影优先”，block 语义不足

## 一次性升级计划

### A. Structured Entity Memory

目标：

- 把 `subject_id / state_key / decision_key` 从“存储字段”提升为“检索与浏览都可见的结构化链接”

实施：

1. 为 memory detail 增加结构化实体链接视图
2. 为 evidence / episode / playbook / mark 通过 `source_refs + fact_links` 反推实体链接
3. 检索排序新增 structured entity score，而不是只做 token overlap
4. retrieval audit 输出每条结果命中的结构化实体链接

预期收益：

- “同一个人 / 同一个状态 / 同一个决策”的跨层联系更稳定
- query 命中结构化键时，排序更可解释

### B. Reflection Layer

目标：

- 在 retain / recall 之外，补一个 derived reflect 层

实施：

1. 新增 reflection blocks 生成逻辑
2. reflection 只从现有 facts / playbooks / profile facts 派生，不新增旁路真相源
3. prompt 注入新增 `Reflections` section
4. settings 提供 reflection 可视化入口

约束：

- reflection 是 derived layer，不允许绕过 evidence-first 直接写真相

预期收益：

- agent 能拿到“近期状态关注点 / 重复决策脉络 / 已验证经验”的浓缩结果

### C. Retrieval Audit Consumption

目标：

- 把已有 `retrieval_logs` 变成用户可读、可调试的界面

实施：

1. settings 新增 retrieval audit viewer
2. 展示 query、resolved intent/scope/layer、final order、component scores
3. 展示 structured entity match 与结果预览

预期收益：

- 能解释“为什么这条记忆进来了”
- 排序问题可直接定位

### D. Profile / Persona Blocks

目标：

- 把 profile 从“单段文本”升级为 block 化结构

实施：

1. 提供 profile blocks API
2. block 类型至少包含：identity / preferences / constraints / manual profile / pinned
3. prompt 注入改为按 blocks 组装，而不是仅依赖单段 projection
4. 去掉 prompt 中 pinned 的重复注入
5. memory master 开关关闭时，不再继续注入 memory / pinned / reflections

预期收益：

- profile 更稳定、更可解释
- prompt 更干净，语义更一致

## 第一轮审查

### 结论

本轮四项可以一起做，但必须遵守两个收缩原则：

1. reflect 层只能做 derived layer，不能引入第二套独立写入语义
2. profile block 化要复用现有 profile facts / marks / manual profile，不做 schema 大改

### 风险点

1. 如果把 reflect 做成新真相源，会和 v3 的 DB 单真相源冲突
2. 如果把 entity linking 做成全新图层，会过度扩张
3. 如果直接改现有 compiled viewer，容易和当前 worktree 中的未提交改动冲突

### 审查后收敛方案

采用下面的最终方案：

1. `MemoryService` 增加：
   - `getProfileBlocks()`
   - `getReflectionBlocks()`
   - `getReflectionProjection()`
   - 结构化实体链接派生与 structured retrieval scoring
2. `core/agent.js`：
   - prompt 改为 block-aware 注入
   - 去掉 profile 与 pinned 的重复注入
   - memory master 关闭时停止注入 memory / pinned / reflections
3. `server/routes/memory.js`：
   - 新增 profile blocks 与 reflection 读取接口
4. settings：
   - 新增独立 memory insights viewer
   - 内含 `Reflections / Profile Blocks / Retrieval Audit` 三个 tab
   - 不改现有 compiled memory viewer，避免和已有修改冲突

## 最终实施要求

严格按以下顺序实施：

1. 先落服务层与路由
2. 再落 prompt 组装
3. 再落 settings viewer
4. 最后补测试并做全量验证

## 测试要求

至少覆盖：

1. service：
   - structured entity link 派生
   - structured retrieval scoring / audit snapshot
   - reflection blocks / projection
   - profile blocks 与 pinned 去重
2. routes：
   - `/api/memory/reflection`
   - `/api/memory/profile/blocks`
   - `/api/memory/retrievals`
3. prompt：
   - memory master 关闭时不再注入 memory / pinned / reflections
   - profile 仍可注入
   - pinned 不重复
4. renderer：
   - typecheck
   - build

