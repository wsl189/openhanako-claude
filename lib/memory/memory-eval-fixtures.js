export const MEMORY_EVAL_FIXTURES = [
  {
    id: "profile_preference_capture",
    evidence: "用户明确表示以后都希望先给结论再展开分析。",
    bundle: {
      facts: [{
        fact: "用户长期偏好先给结论再展开分析",
        tags: ["偏好", "沟通"],
        memory_kind: "profile_preference",
        timeliness: "persistent",
      }],
      playbooks: [],
      episode_patch: {
        episode_kind: "conversation",
        tags: ["偏好", "沟通"],
        anchor_text: "用户明确了稳定沟通偏好。",
      },
    },
    checks: {
      profileContains: "用户长期偏好先给结论再展开分析",
      retrieval: {
        query: "偏好 结论",
        intent: "profile",
        scope: "profile",
        expectedItemType: "fact",
      },
    },
  },
  {
    id: "state_update_capture",
    evidence: "用户说现在已经不再持有中国核建。",
    bundle: {
      facts: [{
        fact: "当前不再持有中国核建",
        tags: ["中国核建", "持仓", "状态变更"],
        memory_kind: "state",
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
      }],
      playbooks: [],
      episode_patch: {
        episode_kind: "decision_process",
        tags: ["投资", "状态更新"],
        anchor_text: "用户更新了中国核建持仓状态。",
      },
    },
    checks: {
      retrieval: {
        query: "现在还持有中国核建吗",
        intent: "state",
        scope: "agent",
        expectedMemoryKind: "state",
      },
    },
  },
  {
    id: "decision_capture",
    evidence: "用户最终决定先做 SQLite 迁移，再改检索逻辑。",
    bundle: {
      facts: [{
        fact: "已决定先做 SQLite 迁移，再改检索逻辑",
        tags: ["SQLite", "迁移", "决策"],
        memory_kind: "decision",
        decision_key: "memory/sqlite-migration/priority",
      }],
      playbooks: [],
      episode_patch: {
        episode_kind: "decision_process",
        tags: ["技术方案", "迁移"],
        anchor_text: "用户确认了实现顺序。",
      },
    },
    checks: {
      retrieval: {
        query: "为什么先做 SQLite 迁移",
        intent: "decision",
        scope: "agent",
        expectedMemoryKind: "decision",
      },
    },
  },
  {
    id: "channel_scope_isolation",
    evidence: "频道里决定由 Alice 负责 API 重构，下周再评审。",
    bundle: {
      facts: [{
        fact: "频道决定由 Alice 负责 API 重构",
        tags: ["API", "分工"],
        memory_kind: "decision",
        decision_key: "channel/api-refactor/owner",
      }],
      playbooks: [],
      episode_patch: {
        episode_kind: "channel_coordination",
        tags: ["协作", "分工"],
        anchor_text: "频道确认了 API 重构 owner。",
      },
    },
    context: {
      origin: "channel",
      scope: "channel",
      sessionId: "channel-eval",
      channelName: "eval",
    },
    checks: {
      channelProjectionContains: "频道决定由 Alice 负责 API 重构",
    },
  },
  {
    id: "playbook_capture",
    evidence: "同类问题反复出现：只按相似度召回导致旧状态误用。需要增加 freshness guard。",
    bundle: {
      facts: [],
      playbooks: [{
        category: "Memory",
        trigger: "状态召回误用旧事实",
        wrong_path: "只按相似度排序",
        root_cause: "没有时效保护",
        fix_steps: "增加 freshness guard 和 intent 路由",
        validation: "state 查询优先返回最新状态",
      }],
      episode_patch: {
        episode_kind: "research_trace",
        tags: ["检索", "排障"],
        anchor_text: "识别了状态召回误用旧事实的根因。",
      },
    },
    checks: {
      retrieval: {
        query: "状态召回误用旧事实",
        intent: "playbook",
        layers: "playbooks",
        expectedItemType: "playbook",
      },
    },
  },
  {
    id: "stale_state_warning",
    evidence: "上个月用户说当前持有海螺水泥。",
    bundle: {
      facts: [{
        fact: "当前持有海螺水泥",
        tags: ["海螺水泥", "持仓"],
        memory_kind: "state",
        timeliness: "stateful",
        state_key: "投资组合/海螺水泥/持仓状态",
        time: "2026-04-01T08:00:00.000Z",
      }],
      playbooks: [],
      episode_patch: {
        episode_kind: "conversation",
        tags: ["投资", "状态"],
        anchor_text: "记录了一条较旧的持仓状态。",
      },
    },
    checks: {
      retrieval: {
        query: "现在还持有海螺水泥吗",
        intent: "state",
        scope: "agent",
        expectedMemoryKind: "state",
      },
      diagnosticEvent: "stale_state_suppressed",
    },
  },
];
