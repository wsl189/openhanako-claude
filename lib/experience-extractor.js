/**
 * experience-extractor.js — session 结束后台经验提取
 *
 * v4 起经验以结构化 playbook 存在 DB 中。
 */

import { callProviderText } from "./llm/provider-client.js";
import { getLocale } from "../server/i18n.js";

/**
 * 从 episode anchor + evidence 中提取经验教训
 *
 * @param {{
 *   episodeAnchor: string,
 *   evidenceRows: Array<{ id: string, content?: string, preview?: string }>,
 *   memoryService: import('./memory/memory-service.js').MemoryService|null,
 *   resolvedModel: { model: string, api: string, api_key: string, base_url: string },
 *   origin?: string,
 * }} input
 * @returns {Promise<{ extracted: number }>}
 */
export async function extractSessionExperiences(input = {}) {
  const {
    episodeAnchor = "",
    evidenceRows = [],
    memoryService = null,
    resolvedModel,
    origin = "session",
  } = input;
  if (!memoryService) return { extracted: 0 };
  const refs = Array.isArray(evidenceRows)
    ? evidenceRows
        .map((row) => ({ layer: "evidence", id: String(row?.id || "").trim() }))
        .filter((row) => row.id)
        .slice(0, 3)
    : [];
  if (refs.length === 0) {
    return { extracted: 0 };
  }
  if (!episodeAnchor.trim() && refs.length === 0) return { extracted: 0 };

  const { model: utilityModel, api, api_key, base_url } = resolvedModel;
  const evidenceText = evidenceRows
    .slice(0, 3)
    .map((row, index) => {
      const body = String(row?.content || row?.preview || "").trim();
      return `### Evidence ${index + 1}\nID: ${row?.id || "(unknown)"}\n${body}`;
    })
    .join("\n\n");
  const raw = await callProviderText({
    api,
    model: utilityModel,
    api_key,
    base_url,
    systemPrompt: buildExtractionPrompt(),
    messages: [{
      role: "user",
      content: `## Episode Anchor\n\n${episodeAnchor || "(empty)"}\n\n## Evidence\n\n${evidenceText}`,
    }],
    temperature: 0.3,
    max_tokens: 4096,
    timeoutMs: 60_000,
  });

  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const jsonStr = (fenceMatch ? fenceMatch[1] : raw).trim();

  let entries;
  try {
    entries = JSON.parse(jsonStr);
    if (!Array.isArray(entries)) return { extracted: 0 };
  } catch {
    console.error(`[experience] JSON parse failed: ${jsonStr.slice(0, 200)}`);
    return { extracted: 0 };
  }

  let extracted = 0;
  for (const entry of entries) {
    try {
      memoryService.addPlaybook({
        ...entry,
        origin,
        sourceRefs: refs,
      });
      extracted++;
    } catch {
      // skip invalid model output
    }
  }

  if (extracted > 0) {
    console.log(`\x1b[90m[experience] 提取了 ${extracted} 条经验\x1b[0m`);
  }

  return { extracted };
}

function buildExtractionPrompt() {
  const isZh = getLocale().startsWith("zh");

  if (isZh) {
    return `你是一个经验提取器。你只允许基于 episode anchor 和 evidence 提取可复用的结构化 playbook。

## 提取标准

只提取以下类型的内容：
1. 用户指出助手做错了，并解释了正确做法
2. 助手试错后找到了稳定可复用的方法
3. 用户明确提出“以后要/不要这样做”的长期操作约束
4. 如果 evidence 没有支撑，就不要提取

## 输出格式

严格 JSON 数组，不要 markdown 代码块：
[
  {
    "category": "工具使用",
    "trigger": "需要在代码库中定位文本或文件",
    "wrong_path": "直接用慢速全文扫描或凭感觉猜文件",
    "root_cause": "没有先缩小搜索范围",
    "fix_steps": "优先用 rg 或 rg --files 做快速定位，再按结果展开阅读",
    "validation": "能在最少文件读取下定位目标实现或文本"
  }
]

五个字段都必须非空；没有合格 playbook 时返回 []。`;
  }

  return `You are an experience extractor. You may only extract reusable structured playbooks from the episode anchor plus evidence.

## Extraction Criteria

Only extract content that describes a stable reusable method, correction, or durable "do/don't do this next time" instruction.
If evidence does not support a playbook, do not extract it.

## Output Format

Return strict JSON array, no markdown:
[
  {
    "category": "tool usage",
    "trigger": "Need to find text or files in a repo",
    "wrong_path": "Start with slow broad scans or guesses",
    "root_cause": "Search scope was not narrowed first",
    "fix_steps": "Use rg or rg --files first, then open the most relevant files",
    "validation": "Target implementation is found with minimal file reads"
  }
]

All five fields must be non-empty. Return [] when there is no qualifying playbook.`;
}
