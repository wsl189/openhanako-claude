/**
 * LLM Utilities — 轻量 LLM 调用（标题摘要、翻译、ID 生成等）
 *
 * 纯函数模块，不持有状态。调用方传入 utilConfig（model/api_key/base_url）。
 * 从 Engine 提取，消除 5 处重复的 fetch 模式。
 */
import fs from "fs";
import path from "path";
import { callProviderText } from "../lib/llm/provider-client.js";
import { getLocale } from "../server/i18n.js";

/** Pi SDK content block 是否为工具调用（兼容 tool_use / toolCall 两种格式） */
export const isToolCallBlock = (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name;

/** 取工具调用参数（兼容 input / arguments） */
export const getToolArgs = (b) => b.input || b.arguments;

/**
 * 统一的 utility LLM 调用
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.api_key
 * @param {string} opts.base_url
 * @param {Array} opts.messages
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.max_tokens=100]
 * @returns {Promise<string|null>} 回复文本
 */
async function callLlm({ model, api, api_key, base_url, messages, temperature = 0.3, max_tokens = 100 }) {
  return callProviderText({
    api,
    model,
    api_key,
    base_url,
    messages,
    temperature,
    max_tokens,
  });
}

const TITLE_PREFIX_RE = /^(?:建议)?(?:最终)?(?:标题|title|topic|subject|主题|任务|需求|规则要求|要求|问题|目标)\s*[:：-]\s*/i;
const TITLE_LABEL_LINE_RE = /^(?:#+\s*)?(?:>\s*)?(?:[-*]\s*)?(?:\d+\s*[.)、-]\s*)?(?:建议)?(?:最终)?(?:标题|title|topic|subject|主题|任务|需求|规则要求|要求|问题|目标)\s*[:：-]/i;
const WEAK_TITLE_RE = /^(?:规则要求|规则|要求|主题|任务|需求|问题|目标|标题|title|topic|subject|task|request|requirements?|question|chat|conversation|对话|聊天)$/i;
const FINAL_PREFIX_RE = /^(?:最终(?:输出|答案|标题)|final(?:\s*(?:output|answer|title))?|result|结论)\s*[:：-]\s*/i;
const FINAL_LABEL_LINE_RE = /^(?:#+\s*)?(?:>\s*)?(?:[-*]\s*)?(?:\d+\s*[.)、-]\s*)?(?:最终(?:输出|答案|标题)|final(?:\s*(?:output|answer|title))?|result|结论)\s*[:：-]/i;

function stripTitleReasoning(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/```(?:think|analysis|reasoning|commentary|summary)?[\s\S]*?```/gi, "\n")
    .replace(/<think>[\s\S]*?<\/think>/gi, "\n")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "\n")
    .replace(/<commentary>[\s\S]*?<\/commentary>/gi, "\n")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, "\n")
    .replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>/gi, "\n")
    .replace(/<xing\s+title=["\u201C\u201D][^"\u201C\u201D]*["\u201C\u201D]>[\s\S]*?<\/xing>/gi, "\n")
    .replace(/<\/?(?:think|analysis|commentary|summary|mood|pulse|reflect|xing)\b[^>]*>/gi, " ");
}

function cleanTitleLine(line) {
  return String(line || "")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\s*[.)、-]\s+/, "")
    .replace(FINAL_PREFIX_RE, "")
    .replace(TITLE_PREFIX_RE, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[。！？.!?：:…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakTitle(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  return WEAK_TITLE_RE.test(s);
}

function looksLikeMetaTitleLine(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  const metaStartPatterns = [
    /^(?:思考|分析|推理)(?:过程|如下)?[:：]?/i,
    /^(?:让我|我先|我会|根据).*(?:对话|上下文|用户|助手)/i,
    /^(?:好的|当然|下面|接下来)[,， ]*/i,
    /^(?:let me|i(?:'m| am) (?:going to|going|analy[sz]e)|based on (?:the )?(?:dialog|conversation|context))/i,
    /^(?:analysis|reasoning)\b/i,
    /^(?:user|assistant)\s*[:：]/i,
    /^(?:对话|会话)(?:的)?(?:内容|主题)(?:是|为|如下)?/i,
    /^(?:这(?:段|次)?对话|本次对话).*(?:关于|内容|主题)/i,
    /^(?:the|this)\s+(?:conversation|chat)\s+(?:is|about|content|topic)/i,
    /^(?:user|the user|assistant|the assistant)\s+(?:asks?|asked|replies?|said)/i,
    /^(?:according|based on)\b/i,
    /^(?:用户|助手)\s*[:：]/i,
  ];
  return metaStartPatterns.some((re) => re.test(s));
}

function isCompactTitleCandidate(text, isZh) {
  const clean = String(text || "").trim();
  if (!clean) return false;
  if (/[`{}\[\]]/.test(clean)) return false;
  if (isZh) return Array.from(clean).length <= 20;
  const words = clean.split(/\s+/).filter(Boolean);
  return words.length <= 8 && clean.length <= 60;
}

function extractTaggedFinalTitle(text) {
  const s = String(text || "");
  const patterns = [
    /<final_title>([\s\S]*?)<\/final_title>/i,
    /<final>([\s\S]*?)<\/final>/i,
    /<title>([\s\S]*?)<\/title>/i,
    /<answer>([\s\S]*?)<\/answer>/i,
    /<output>([\s\S]*?)<\/output>/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m?.[1]) {
      const c = cleanTitleLine(m[1]);
      if (c) return c;
    }
  }
  return "";
}

function looksLikeRuleEchoTitle(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return true;
  const patterns = [
    /^(?:不要|必须|需要|请|应当|应该)/i,
    /^(?:根据规则|按照规则|规则[:：]?)/i,
    /^(?:只输出|直接输出|输出标题)/i,
    /^(?:语言和用户|标题长度|不加引号|不加标点)/i,
    /^(?:i need to|must|should|according to the rules|output only|title length)/i,
    /(?:规则|标题长度|用户第一句话|输出标题|不加引号|不加标点)/,
    /(?:title length|user(?:'s)? first message|output the title|no quotes|no punctuation)/i,
  ];
  return patterns.some((re) => re.test(s));
}

function isBadGeneratedTitle(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  if (isWeakTitle(s)) return true;
  if (looksLikeMetaTitleLine(s)) return true;
  if (looksLikeRuleEchoTitle(s)) return true;
  return false;
}

export function normalizeTitle(title, isZh) {
  const tagged = extractTaggedFinalTitle(title);
  if (tagged && !isBadGeneratedTitle(tagged)) {
    if (isZh) return Array.from(tagged).slice(0, 10).join("");
    return tagged.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  }

  const stripped = stripTitleReasoning(title);
  const rawLines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rawLines.length) return "";

  const labeled = [];
  const finalLabeled = [];
  const general = [];
  for (const rawLine of rawLines) {
    const isLabeled = TITLE_LABEL_LINE_RE.test(rawLine);
    const isFinalLabeled = FINAL_LABEL_LINE_RE.test(rawLine);
    const clean = cleanTitleLine(rawLine);
    if (!clean) continue;
    if (isBadGeneratedTitle(clean)) continue;
    if (isLabeled) labeled.push(clean);
    else if (isFinalLabeled) finalLabeled.push(clean);
    else general.push(clean);
  }

  const compact = general.filter((line) => isCompactTitleCandidate(line, isZh));
  const candidate = labeled.at(-1)
    || finalLabeled.at(-1)
    || compact.at(-1)
    || general.at(-1)
    || "";

  if (!candidate || isBadGeneratedTitle(candidate)) return "";
  if (isZh) return Array.from(candidate).slice(0, 10).join("");
  return candidate.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
}

/**
 * 从 .jsonl session 文件提取 user/assistant 文本和工具调用
 */
function parseSessionContent(sessionPath, { userLimit = 1000, assistantLimit = 1000 } = {}) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  let userText = "";
  let assistantText = "";
  const toolCalls = [];
  for (const line of lines) {
    if (line.type !== "message" || !line.message) continue;
    const msg = line.message;
    if (msg.role === "user" && !userText) {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      userText = textParts.map(c => c.text).join("\n").slice(0, userLimit);
    }
    if (msg.role === "assistant") {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      assistantText = textParts.map(c => c.text).join("\n").slice(0, assistantLimit);
      const toolParts = (msg.content || []).filter(isToolCallBlock);
      for (const t of toolParts) toolCalls.push(t.name || "unknown_tool");
    }
  }
  return { userText, assistantText, toolCalls };
}

function stripMoodAndMeta(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/<mood>[\s\S]*?<\/mood>/gi, " ")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\n+/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(vibe|sparks|reflections|will)\s*:/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllClearText(text) {
  const t = String(text || "").toLowerCase();
  return /一切正常|无异常|没有异常|未发现异常|无需(处理|操作)|继续待命|系统运行正常|all clear|no (issues?|anomal(?:y|ies)|abnormalit(?:y|ies))|no action needed|nothing (to do|requires action)|everything (looks )?(normal|fine)/i.test(t);
}

function looksLikeMetaAnalysis(text, isZh) {
  const s = String(text || "");
  const compact = s.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  // 摘要应是单句短文本；多段/列表通常是“分析过程”泄露
  if (s.split("\n").filter(Boolean).length >= 3) return true;
  if (compact.length > (isZh ? 90 : 220)) return true;

  const patterns = [
    /巡检上下文|patrol context/i,
    /agent\s*回复|agent\s*reply/i,
    /根据规则|rules?:/i,
    /用户要求我|the user is asking/i,
    /让我分析|let me analy[sz]e/i,
    /从上下文看|based on (the )?context/i,
    /^\s*[-*]\s+/m,
    /^\s*\d+\s*[.)、]/m,
  ];
  return patterns.some(re => re.test(s));
}

function limitSummaryLength(text, isZh) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (isZh) {
    const chars = Array.from(clean);
    return chars.length > 50 ? chars.slice(0, 50).join("").trim() : clean;
  }
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 30) return words.slice(0, 30).join(" ");
  return clean.length > 180 ? clean.slice(0, 180).trim() : clean;
}

function normalizeSummaryText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<\/?mood>/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 从 session 内容生成本地兜底摘要（不依赖外部 API）
 */
export function buildLocalSummary(assistantText, toolCalls) {
  const isZh = getLocale().startsWith("zh");
  const uniqueTools = [...new Set(toolCalls)];
  const cleanAssistant = stripMoodAndMeta(assistantText);
  if (uniqueTools.length > 0) {
    if (isZh) {
      return `执行了 ${uniqueTools.slice(0, 3).join("、")}${uniqueTools.length > 3 ? " 等" : ""}`;
    }
    return `Ran ${uniqueTools.slice(0, 3).join(", ")}${uniqueTools.length > 3 ? ", etc." : ""}`;
  }
  if (cleanAssistant) {
    if (isAllClearText(cleanAssistant)) {
      return isZh ? "巡检完毕，一切正常" : "Patrol complete, all clear";
    }
    const clean = cleanAssistant.replace(/[#*_`>\-[\]()]/g, "").trim();
    if (clean.length <= 50) return clean;
    return clean.slice(0, 47) + "...";
  }
  return null;
}

export function normalizeActivitySummary(rawSummary, { assistantText = "", toolCalls = [], isZh = true } = {}) {
  const canonicalAllClear = isZh ? "巡检完毕，一切正常" : "Patrol complete, all clear";
  const cleanAssistant = stripMoodAndMeta(assistantText);
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
  const fallback = buildLocalSummary(cleanAssistant, toolCalls) || (hasTools
    ? (isZh ? "已执行后台任务" : "Background task executed")
    : canonicalAllClear);

  const normalized = normalizeSummaryText(rawSummary);
  if (!normalized || looksLikeMetaAnalysis(normalized, isZh)) {
    return fallback;
  }

  const singleLine = normalized
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!singleLine) return fallback;
  if (!hasTools && (isAllClearText(singleLine) || isAllClearText(cleanAssistant))) {
    return canonicalAllClear;
  }
  if (looksLikeMetaAnalysis(singleLine, isZh)) return fallback;

  const limited = limitSummaryLength(singleLine, isZh);
  if (!limited) return fallback;
  return limited;
}

/**
 * 生成对话标题
 */
export async function summarizeTitle(utilConfig, userText, assistantText) {
  const isZh = getLocale().startsWith("zh");
  try {
    const { utility: model, api_key, base_url, api } = utilConfig || {};
    if (!api_key || !base_url || !api) return null;

    const systemContent = isZh
      ? `你是一个对话标题生成器。根据用户和助手的第一轮对话，用一句极短的话概括对话主题。

规则：
1. 标题长度严格控制在 10 个字以内（中文）或 5 个单词以内（英文）
2. 语言必须和用户说的第一句话一致：用户说中文就用中文，用户说英文就用英文
3. 不要加引号、句号或其他标点
4. 不要输出“规则要求、主题、任务、需求、问题”等空泛标签词
5. 只输出最终标题，不要过程；如果需要多行，最后一行必须是最终标题
6. 直接输出标题，不要解释`
      : `You are a conversation title generator. Based on the first exchange between user and assistant, summarize the topic in a very short phrase.

Rules:
1. Keep the title under 5 words (English) or 10 characters (Chinese)
2. The title language must match the user's first message
3. No quotes, periods, or other punctuation
4. Avoid generic label words like "requirements", "topic", "task", "question"
5. Output only the final title; if multiple lines appear, the last line must be the final title
6. Output the title directly, no explanation`;

    const userLabel = isZh ? "用户" : "User";
    const assistantLabel = isZh ? "助手" : "Assistant";

    const raw = await callLlm({
      model, api, api_key, base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${userLabel}：${(userText || "").slice(0, 500)}\n${assistantLabel}：${(assistantText || "").slice(0, 500)}`,
        },
      ],
      temperature: 0,
      max_tokens: 50,
    });
    const normalized = normalizeTitle(raw, isZh);
    if (normalized && !isBadGeneratedTitle(normalized)) return normalized;
    return null;
  } catch (err) {
    console.error("[llm-utils] summarizeTitle failed:", err.message);
    return null;
  }
}

/**
 * 批量翻译技能名称
 */
export async function translateSkillNames(utilConfig, names, lang) {
  if (!names.length) return {};
  const LANG_LABEL = { zh: "中文", en: "English" };
  const label = LANG_LABEL[lang] || lang;
  try {
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return {};
    const isZh = getLocale().startsWith("zh");
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `将下列 kebab-case 英文技能名翻译成简短的${label}名称（2-4 个字）。直接输出 JSON 对象，key 为原名，value 为翻译。不解释。`
            : `Translate the following kebab-case English skill names into short ${label} names (2-4 characters). Output a JSON object directly, key = original name, value = translation. No explanation.`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    if (!text) return {};
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    console.error("[llm-utils] translateSkillNames 失败:", err.message);
    return {};
  }
}

/**
 * 为活动 session 生成摘要（用 utility_large 模型）
 * @param {object} utilConfig - resolveUtilityConfig() 结果
 * @param {string} sessionPath
 * @param {(text: string, level?: string) => void} [emitDevLog]
 */
export async function summarizeActivity(utilConfig, sessionPath, emitDevLog) {
  const log = emitDevLog || (() => {});
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText, toolCalls } = parseSessionContent(sessionPath);
    if (!userText && !assistantText) {
      log("[summarize] session empty, skipping");
      return null;
    }

    const toolInfo = toolCalls.length > 0
      ? (isZh
          ? `\n\n调用的工具：${[...new Set(toolCalls)].join("、")}`
          : `\n\nTools used: ${[...new Set(toolCalls)].join(", ")}`)
      : "";
    const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilConfig;
    if (!api_key || !base_url || !api) {
      log("[summarize] utility_large config incomplete, skipping");
      return null;
    }

    const systemContent = isZh
      ? `你是一个执行摘要生成器。根据 Agent 的巡检上下文、执行结果和使用的工具，概括它做了什么。

规则：
1. 用中文，50 字以内
2. 直接输出摘要，不要前缀、不要解释
3. 说清楚做了什么具体动作（拆解待办、搜索信息、标记完成、读取文件等）
4. 如果调用了工具，提一下工具名称和做了什么
5. 如果 Agent 回复了「一切正常」或没有执行动作，就说「巡检完毕，一切正常」
6. 不要复述「巡检上下文 / Agent 回复 / 规则」原文
7. 禁止输出「让我分析」「根据规则」这类推理过程`
      : `You are an execution summary generator. Based on the Agent's patrol context, execution results, and tools used, summarize what it did.

Rules:
1. In English, under 30 words
2. Output the summary directly, no prefix or explanation
3. Be specific about what actions were taken (broke down tasks, searched info, marked complete, read files, etc.)
4. If tools were called, mention the tool names and what they did
5. If the Agent reported "all clear" or took no action, say "Patrol complete, all clear"
6. Do not restate "Patrol context / Agent reply / Rules"
7. Do not output analysis narration like "let me analyze"`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const text = await callProviderText({
      api,
      model,
      api_key,
      base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 600)}\n\n${replyLabel}：\n${assistantText.slice(0, 600)}${toolInfo}`,
        },
      ],
      temperature: 0,
      max_tokens: 150,
    });

    return normalizeActivitySummary(text, { assistantText, toolCalls, isZh });
  } catch (err) {
    log(`[summarize] error: ${err.message}`);
    console.error("[llm-utils] summarizeActivity failed:", err.message);
    return null;
  }
}

/**
 * 快速摘要（用 utility 小模型）
 * @param {object} utilConfig
 * @param {string} sessionPath - activity session 文件绝对路径
 */
export async function summarizeActivityQuick(utilConfig, sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText, toolCalls } = parseSessionContent(sessionPath, {
      userLimit: 800, assistantLimit: 800,
    });
    if (!userText && !assistantText) return null;

    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!api_key || !base_url || !api) return null;

    const systemContent = isZh
      ? `根据 Agent 的巡检上下文和执行结果，用一两句话概括它做了什么。30 字以内，中文，直接输出。不要输出分析过程，不要复述上下文。`
      : `Based on the Agent's patrol context and execution results, summarize what it did in one or two sentences. Under 15 words, English, output directly. Do not output analysis process or restate context.`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const text = await callProviderText({
      api,
      model,
      api_key,
      base_url,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 400)}\n\n${replyLabel}：\n${assistantText.slice(0, 400)}`,
        },
      ],
      temperature: 0,
      max_tokens: 80,
    });
    return normalizeActivitySummary(text, { assistantText, toolCalls, isZh });
  } catch (err) {
    console.error("[llm-utils] summarizeActivityQuick failed:", err.message);
    return null;
  }
}

/**
 * 用 LLM 根据显示名生成 agent ID
 * @param {object} utilConfig
 * @param {string} name - 显示名
 * @param {string} agentsDir - agents 根目录（检查冲突）
 */
export async function generateAgentId(utilConfig, name, agentsDir) {
  const raw = String(name || "").trim();
  const localMap = {
    "花子": "hanako",
    "ミク": "miku",
    "明": "ming",
  };

  const normalizeBase = (input) =>
    String(input || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/['"`’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-")
      .slice(0, 12)
      .replace(/-+$/g, "");

  const pickUniqueId = (base) => {
    const cleanBase = normalizeBase(base);
    if (cleanBase.length >= 2 && !fs.existsSync(path.join(agentsDir, cleanBase))) {
      return cleanBase;
    }
    for (let i = 2; i < 1000; i++) {
      const suffix = `-${i}`;
      const maxBase = 12 - suffix.length;
      if (maxBase < 2) break;
      const head = cleanBase.slice(0, maxBase).replace(/-+$/g, "");
      if (head.length < 2) continue;
      const cand = `${head}${suffix}`;
      if (!fs.existsSync(path.join(agentsDir, cand))) return cand;
    }
    return null;
  };

  // 先走本地快速路径（无网络调用）
  const mapped = localMap[raw];
  const localBase = mapped || normalizeBase(raw);
  const localId = localBase ? pickUniqueId(localBase) : null;
  if (localId) return localId;

  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api } = utilConfig;
    if (!model || !api_key || !base_url || !api) {
      return `agent-${Date.now().toString(36)}`;
    }
    const text = await callLlm({
      model, api, api_key, base_url,
      messages: [
        {
          role: "system",
          content: isZh
            ? `根据给定的助手名字，生成一个简短的英文小写 ID（用于文件夹名）。
规则：
1. 纯小写英文字母，可以用连字符
2. 2~12 个字符
3. 尽量是名字的英文音译或缩写
4. 直接输出 ID，不要解释

示例：
- "花子" → "hanako"
- "ミク" → "miku"
- "小助手" → "helper"
- "Alice" → "alice"`
            : `Given an assistant's display name, generate a short lowercase English ID (for use as a folder name).
Rules:
1. Lowercase English letters only, hyphens allowed
2. 2–12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, no explanation

Examples:
- "花子" → "hanako"
- "ミク" → "miku"
- "Helper" → "helper"
- "Alice" → "alice"`,
        },
        { role: "user", content: name },
      ],
      max_tokens: 20,
    });

    if (text) {
      const llmId = pickUniqueId(text);
      if (llmId) return llmId;
    }
  } catch (err) {
    console.error("[llm-utils] generateAgentId LLM failed:", err.message);
  }
  return `agent-${Date.now().toString(36)}`;
}
