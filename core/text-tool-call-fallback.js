function stripCodeFence(text = "") {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeSmartPunctuation(text = "") {
  return String(text || "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/，/g, ",")
    .replace(/：/g, ":");
}

function decodeXmlEntities(text = "") {
  return String(text || "")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function findBalancedJsonFragment(text = "") {
  const source = String(text || "");
  const start = source.search(/[\[{]/);
  if (start < 0) return null;

  const stack = [];
  let inString = false;
  let quoteChar = "";
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quoteChar) {
        inString = false;
        quoteChar = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack[stack.length - 1] !== expected) return null;
      stack.pop();
      if (stack.length === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseToolArgs(rawBody = "") {
  const body = normalizeSmartPunctuation(stripCodeFence(rawBody));
  if (!body) return null;

  const candidates = [body, findBalancedJsonFragment(body)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse failures and try the next candidate
    }
  }

  return null;
}

function stripQuotedString(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseLooseValue(raw = "") {
  const text = normalizeSmartPunctuation(raw).trim();
  if (!text) return "";

  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);

  const quoted = stripQuotedString(text);
  if (quoted !== text) return quoted;

  if (text.startsWith("[") && text.endsWith("]")) {
    const candidate = text.replace(/'/g, "\"");
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore and fallback
    }
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(/\s*,\s*/)
      .map((part) => stripQuotedString(part))
      .filter(Boolean);
  }

  if (text.startsWith("{") && text.endsWith("}")) {
    const candidate = text.replace(/'/g, "\"");
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // ignore and fallback
    }
  }

  return text;
}

function parseBulletArgs(rawBody = "") {
  const body = normalizeSmartPunctuation(String(rawBody || ""));
  const lines = body
    .replace(/[{}]/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const out = {};
  for (const line of lines) {
    const payload = line.replace(/^[-–—*]\s*/, "").trim();
    if (!payload) continue;
    const match = payload.match(/^([A-Za-z_][\w-]*)\s*(?::|=>)?\s*(.+)$/);
    if (!match) continue;
    const key = match[1];
    const value = parseLooseValue(match[2]);
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function parseStructuredObjectValue(rawValue = "") {
  const text = normalizeSmartPunctuation(String(rawValue || ""));
  const jsonObj = parseToolArgs(text);
  if (jsonObj && typeof jsonObj === "object" && !Array.isArray(jsonObj)) {
    return jsonObj;
  }

  const looksBulletObject = (
    /(?:^|\n)\s*[-–—*]\s*[A-Za-z_][\w-]*\s*(?::|=>|\s+)/.test(text)
    || (/\n/.test(text) && /[A-Za-z_][\w-]*\s*(?::|=>)/.test(text))
  );
  if (!looksBulletObject) return null;

  const bulletObj = parseBulletArgs(text);
  if (bulletObj && typeof bulletObj === "object" && !Array.isArray(bulletObj)) {
    return bulletObj;
  }
  return null;
}

function parseXmlParameters(rawBody = "") {
  const args = {};
  const body = normalizeSmartPunctuation(String(rawBody || ""));
  if (!body) return args;

  const paramRe = /<parameter\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)(?=<\/parameter\b|<parameter\b|<\/?invoke\b|<\/?function_calls\b|<\/?minimax:tool_call\b|<\/?workspace\b|$)/gi;
  let paramMatch = null;
  while ((paramMatch = paramRe.exec(body)) !== null) {
    const key = (paramMatch[1] || paramMatch[2] || paramMatch[3] || "").trim();
    if (!key) continue;
    const rawValue = decodeXmlEntities(paramMatch[4] || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .trim();
    if (!rawValue) {
      args[key] = "";
      continue;
    }
    const parsedObj = parseStructuredObjectValue(rawValue);
    if (parsedObj && typeof parsedObj === "object" && !Array.isArray(parsedObj)) {
      args[key] = parsedObj;
      continue;
    }
    args[key] = parseLooseValue(rawValue);
  }
  return args;
}

function parseBracketToolCallBody(rawBody = "") {
  const body = normalizeSmartPunctuation(String(rawBody || ""));
  if (!body) return null;

  const toolMatch = body.match(/(?:^|[\s{,])tool\s*=>\s*["']?([A-Za-z_][\w-]*)["']?/i);
  if (!toolMatch?.[1]) return null;

  const argsStart = body.search(/\bargs\s*=>/i);
  const argsRaw = argsStart >= 0
    ? body.slice(argsStart).replace(/\bargs\s*=>/i, "").trim()
    : "";
  const args = parseToolArgs(argsRaw) || parseBulletArgs(argsRaw);
  if (!args || typeof args !== "object") return null;

  return {
    rawName: toolMatch[1],
    args: normalizeLegacyToolArgs(toolMatch[1], args),
  };
}

function normalizeLegacyToolArgs(rawName = "", args = {}) {
  const toolName = String(rawName || "").trim().toLowerCase();
  const next = { ...(args || {}) };

  // 兼容旧格式: { patterns: ["*"], baseDir: "...", recursive: false }
  if (toolName === "glob" || toolName === "find" || toolName === "list_files" || toolName === "ls") {
    if (!next.pattern && Array.isArray(next.patterns) && next.patterns.length > 0) {
      next.pattern = String(next.patterns[0] || "").trim();
    }
    if (!next.path && typeof next.baseDir === "string") {
      next.path = next.baseDir;
    }
    // 兼容 minimax XML 格式里把绝对 glob 路径直接塞到 pattern 的情况。
    // 例如 "/Users/tc/Desktop/*" -> { path: "/Users/tc/Desktop", pattern: "*" }。
    if (!next.path && typeof next.pattern === "string") {
      const pattern = String(next.pattern || "").trim();
      const hasWildcard = /[*?[\]{}]/.test(pattern);
      const looksAbsolute = pattern.startsWith("/") || pattern.startsWith("~") || /^[A-Za-z]:[\\/]/.test(pattern);
      if (looksAbsolute) {
        const wildcardPos = pattern.search(/[*?[\]{}]/);
        let sep = Math.max(pattern.lastIndexOf("/"), pattern.lastIndexOf("\\"));
        if (wildcardPos >= 0) {
          const slashBeforeWildcard = Math.max(
            pattern.lastIndexOf("/", wildcardPos),
            pattern.lastIndexOf("\\", wildcardPos),
          );
          if (slashBeforeWildcard > 0) {
            sep = slashBeforeWildcard;
          }
        }
        if (sep > 0) {
          const base = pattern.slice(0, sep).trim();
          const tail = pattern.slice(sep + 1).trim();
          if (base && tail && (hasWildcard || tail.includes("."))) {
            next.path = base;
            next.pattern = tail;
          }
        }
      }
    }
    delete next.patterns;
    delete next.baseDir;
    delete next.recursive;
  }

  return next;
}

const TOOL_ALIASES = {
  read: ["Read"],
  read_file: ["Read"],
  readfile: ["Read"],
  file_read: ["Read"],
  glob: ["Glob"],
  find: ["Glob"],
  find_files: ["Glob"],
  ls: ["Glob"],
  list_files: ["Glob"],
  grep: ["Grep"],
  search_in_files: ["Grep"],
  write: ["Write"],
  write_file: ["Write"],
  edit: ["Edit"],
  edit_file: ["Edit"],
  bash: ["Bash"],
  shell: ["Bash"],
  exec: ["Bash"],
  exec_command: ["Bash"],
  command: ["Bash"],
};

function normalizeToolName(rawName, availableToolNames = []) {
  const trimmed = String(rawName || "").trim();
  if (!trimmed) return null;

  const direct = availableToolNames.find((name) => name.toLowerCase() === trimmed.toLowerCase());
  if (direct) return direct;

  const aliasTargets = TOOL_ALIASES[trimmed.toLowerCase()] || [];
  for (const target of aliasTargets) {
    const match = availableToolNames.find((name) => name.toLowerCase() === target.toLowerCase());
    if (match) return match;
  }

  return null;
}

function parseMinimaxToolCallBody(rawBody = "") {
  const body = normalizeSmartPunctuation(String(rawBody || ""));
  if (!body) return null;

  let rawName = "";
  const invokeRe = /<invoke\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let invokeMatch = null;
  while ((invokeMatch = invokeRe.exec(body)) !== null) {
    rawName = (invokeMatch[1] || invokeMatch[2] || invokeMatch[3] || "").trim() || rawName;
  }
  if (!rawName) return null;

  const args = parseXmlParameters(body);

  if (!Object.keys(args).length) {
    const parsedObj = parseToolArgs(body) || parseBulletArgs(body);
    if (parsedObj && typeof parsedObj === "object" && !Array.isArray(parsedObj)) {
      Object.assign(args, parsedObj);
    }
  }
  if (!Object.keys(args).length) return null;

  return {
    rawName,
    args: normalizeLegacyToolArgs(rawName, args),
  };
}

function parseMinimaxToolCalls(rawBody = "") {
  const body = normalizeSmartPunctuation(String(rawBody || ""));
  if (!body) return [];

  const invokeRe = /<\/?invoke\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const invokes = [];
  let invokeMatch = null;
  while ((invokeMatch = invokeRe.exec(body)) !== null) {
    const rawName = (invokeMatch[1] || invokeMatch[2] || invokeMatch[3] || "").trim();
    if (!rawName) continue;
    invokes.push({
      rawName,
      start: invokeMatch.index,
      end: invokeRe.lastIndex,
    });
  }

  if (!invokes.length) {
    const single = parseMinimaxToolCallBody(body);
    return single ? [single] : [];
  }

  const parseInvokeArgs = (segment = "") => {
    const args = parseXmlParameters(segment);

    if (!Object.keys(args).length) {
      const parsedObj = parseToolArgs(segment) || parseBulletArgs(segment);
      if (parsedObj && typeof parsedObj === "object" && !Array.isArray(parsedObj)) {
        Object.assign(args, parsedObj);
      }
    }
    return args;
  };

  const calls = [];
  for (let i = 0; i < invokes.length; i += 1) {
    const curr = invokes[i];
    const next = invokes[i + 1];
    const segment = body.slice(curr.end, next ? next.start : body.length);
    const args = parseInvokeArgs(segment);
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    if (!Object.keys(args).length) continue;
    calls.push({
      rawName: curr.rawName,
      args: normalizeLegacyToolArgs(curr.rawName, args),
    });
  }

  if (calls.length > 0) return calls;
  const single = parseMinimaxToolCallBody(body);
  return single ? [single] : [];
}

function collectMarkupMatches(text = "") {
  const patterns = [
    {
      kind: "xml",
      re: /<assistant\b[^>]*\bto\s*=\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|([^\s>]+))[^>]*>([\s\S]*?)<\/assistant>/gi,
    },
    {
      kind: "xml",
      re: /<tool_use\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|([^\s>]+))[^>]*>([\s\S]*?)<\/tool_use>/gi,
    },
    {
      kind: "minimax_xml",
      re: /<minimax:tool_call\b[^>]*>([\s\S]*?)<\/minimax:tool_call>/gi,
    },
    {
      kind: "function_calls_xml",
      re: /<function_calls\b[^>]*>([\s\S]*?)<\/function_calls>/gi,
    },
    {
      kind: "bracket",
      re: /\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/gi,
    },
  ];

  const matches = [];
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.re.exec(text)) !== null) {
      matches.push({
        kind: pattern.kind,
        start: match.index,
        end: match.index + match[0].length,
        rawName: pattern.kind === "xml"
          ? (match[1] || match[2] || match[3] || match[4] || match[5] || "")
          : "",
        body: pattern.kind === "xml"
          ? (match[6] || "")
          : (match[1] || ""),
      });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

function stripMatchedRanges(text = "", ranges = []) {
  if (!ranges.length) return String(text || "");
  let cursor = 0;
  let out = "";
  for (const range of ranges) {
    if (range.start > cursor) out += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

function looksLikeMinimaxToolMarkup(text = "") {
  const source = String(text || "");
  if (!source) return false;
  const hasInvoke = /<\/?invoke\b/i.test(source);
  const hasParam = /<parameter\b/i.test(source);
  const hasMinimaxTag = /<\/?minimax:tool_call\b/i.test(source);
  const hasFunctionCallsTag = /<\/?function_calls\b/i.test(source);
  return (hasInvoke && hasParam) || hasMinimaxTag || hasFunctionCallsTag;
}

function stripLooseMinimaxToolMarkup(text = "") {
  return String(text || "")
    .replace(/<\/?function_calls\b[^>]*>\s*/gi, " ")
    .replace(/<\/?workspace\b[^>]*>\s*/gi, " ")
    .replace(/<\/?minimax:tool_call\b[^>]*>\s*/gi, " ")
    .replace(/<\/?invoke\b[^>]*>\s*/gi, " ")
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>\s*/gi, " ")
    .replace(/<\/?parameter\b[^>]*>\s*/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTextToolCalls(text = "", availableToolNames = []) {
  const source = String(text || "");
  const matches = collectMarkupMatches(source);
  if (!matches.length) {
    if (looksLikeMinimaxToolMarkup(source)) {
      const looseCalls = parseMinimaxToolCalls(source);
      const toolCalls = looseCalls
        .map((parsed, index) => {
          const name = normalizeToolName(parsed.rawName, availableToolNames);
          if (!name || !parsed.args) return null;
          return {
            id: `text_tc_loose_${index}`,
            name,
            arguments: parsed.args,
          };
        })
        .filter(Boolean);
      if (toolCalls.length > 0) {
        return { toolCalls, cleanedText: stripLooseMinimaxToolMarkup(source) };
      }
    }
    return { toolCalls: [], cleanedText: source };
  }

  const ranges = [];
  const toolCalls = [];

  for (const match of matches) {
    if (match.kind === "bracket" || match.kind === "minimax_xml" || match.kind === "function_calls_xml") {
      ranges.push({ start: match.start, end: match.end });
    }
    let rawName = match.rawName;
    let args = null;
    if (match.kind === "bracket") {
      const parsed = parseBracketToolCallBody(match.body);
      if (!parsed) continue;
      rawName = parsed.rawName;
      args = parsed.args;
    } else if (match.kind === "minimax_xml" || match.kind === "function_calls_xml") {
      const parsedCalls = parseMinimaxToolCalls(match.body);
      if (!parsedCalls.length) continue;
      for (let i = 0; i < parsedCalls.length; i += 1) {
        const parsed = parsedCalls[i];
        const name = normalizeToolName(parsed.rawName, availableToolNames);
        if (!name || !parsed.args) continue;
        toolCalls.push({
          id: `text_tc_${match.start}_${i}`,
          name,
          arguments: parsed.args,
        });
      }
      continue;
    } else {
      args = parseToolArgs(match.body);
    }
    const name = normalizeToolName(rawName, availableToolNames);
    if (!name || !args) continue;
    if (match.kind !== "bracket" && match.kind !== "minimax_xml" && match.kind !== "function_calls_xml") {
      ranges.push({ start: match.start, end: match.end });
    }
    toolCalls.push({
      id: `text_tc_${match.start}`,
      name,
      arguments: args,
    });
  }

  const fallbackCleanedText = stripMatchedRanges(source, matches.map((m) => ({ start: m.start, end: m.end })))
    .replace(/\bto\s*=\s*[A-Za-z_][\w-]*\b/gi, " ")
    .replace(/\bcode omitted\b/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!toolCalls.length) {
    return { toolCalls: [], cleanedText: fallbackCleanedText || source };
  }

  const cleanedText = stripMatchedRanges(source, ranges)
    .replace(/\bto\s*=\s*[A-Za-z_][\w-]*\b/gi, " ")
    .replace(/\bcode omitted\b/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { toolCalls, cleanedText };
}
