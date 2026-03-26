/**
 * tool-wrapper.js — 工具沙盒包装
 *
 * 在 Pi SDK 工具的 execute 外面套一层路径校验。
 * 被拦截时返回 LLM 可读的文本错误，不抛异常。
 *
 * macOS/Linux: bash 安全边界在 OS 沙盒（seatbelt/bwrap），preflight 只优化体验。
 * Windows: 无 OS 沙盒，bash 额外做路径提取 + PathGuard 校验作为安全层。
 */

import path from "path";
import { t } from "../../server/i18n.js";

/** 构造被拦截时返回给 LLM 的结果 */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

/** 解析工具参数中的路径为绝对路径 */
function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

/**
 * 轻量 preflight 模式匹配
 * macOS/Linux: 体验层（OS 沙盒兜底）
 * Windows: 安全层之一（无 OS 沙盒）
 */
const PREFLIGHT_UNIX = [
  [/\bsudo\s/, () => t("sandbox.noSudo")],
  [/\bsu\s+\w/, () => t("sandbox.noSu")],
  [/\bchmod\s/, () => t("sandbox.noChmod")],
  [/\bchown\s/, () => t("sandbox.noChown")],
];

const PREFLIGHT_WIN32 = [
  [/\bdel\s+\/s/i, () => t("sandbox.noDelRecursive")],
  [/\brmdir\s+\/s/i, () => t("sandbox.noRmdirRecursive")],
  [/\breg\s+(delete|add)\b/i, () => t("sandbox.noRegEdit")],
  [/\btakeown\b/i, () => t("sandbox.noTakeown")],
  [/\bicacls\b/i, () => t("sandbox.noIcacls")],
  [/\bnet\s+(user|localgroup)\b/i, () => t("sandbox.noNetUser")],
  [/\bschtasks\s+\/create\b/i, () => t("sandbox.noSchtasks")],
  [/\bsc\s+(create|delete)\b/i, () => t("sandbox.noScService")],
  [/powershell.*-e(xecutionpolicy)?\s*(bypass|unrestricted)/i, () => t("sandbox.noPsExecutionBypass")],
  [/\bformat\s+[a-z]:/i, () => t("sandbox.noFormat")],
  [/\bbcdedit\b/i, () => t("sandbox.noBcdedit")],
  [/\bwmic\b/i, () => t("sandbox.noWmic")],
];

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32]
  : PREFLIGHT_UNIX;

/**
 * 从 bash 命令中提取可能的文件路径（启发式）
 * 用于 Windows 无 OS 沙盒时的 PathGuard 校验
 */
const WIN_ABS_PATH = /[A-Za-z]:[\\\/][^\s"'|<>&;]+/g;
const UNIX_ABS_PATH = /(?:^|\s)(\/[^\s"'|<>&;]+)/g;
const QUOTED_PATH = /["']([A-Za-z]:[\\\/][^"']+)["']/g;

function extractPaths(command) {
  const paths = new Set();
  for (const re of [WIN_ABS_PATH, QUOTED_PATH]) {
    for (const m of command.matchAll(re)) {
      paths.add(m[1] || m[0]);
    }
  }
  if (process.platform !== "win32") {
    for (const m of command.matchAll(UNIX_ABS_PATH)) {
      paths.add(m[1] || m[0]);
    }
  }
  return [...paths];
}

const SEGMENT_BREAKS = new Set([";", "&&", "||", "|", "\n"]);
const COMMAND_WRAPPERS = new Set(["command", "builtin", "env", "nohup", "time"]);
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "del", "erase", "rd"]);

function tokenizeShell(command = "") {
  const tokens = [];
  let buf = "";
  let quote = null;
  let escaped = false;

  const pushBuf = () => {
    if (!buf.length) return;
    tokens.push(buf);
    buf = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else buf += ch;
      continue;
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
        continue;
      }
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === "\"" || next === "\\" || next === "$" || next === "`") {
          buf += next;
          i += 1;
          continue;
        }
      }
      buf += ch;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (ch === "&" && command[i + 1] === "&") {
      pushBuf();
      tokens.push("&&");
      i += 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      pushBuf();
      tokens.push("||");
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      pushBuf();
      tokens.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      pushBuf();
      continue;
    }

    buf += ch;
  }

  if (escaped) buf += "\\";
  pushBuf();
  return tokens;
}

function normalizeCommandName(token = "") {
  return path.basename(token);
}

function looksLikeAssignment(token = "") {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isRedirectionToken(token = "") {
  if (!token) return false;
  return token === ">" || token === ">>" || token === "<" || token === "<<" || token.startsWith("2>") || token.startsWith("1>");
}

function resolveCommandPath(token, cwd) {
  if (!token) return null;
  const home = process.env.HOME || "";
  let raw = token;
  if (raw === "~") raw = home || raw;
  else if (raw.startsWith("~/")) raw = home ? path.join(home, raw.slice(2)) : raw;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function collectDeleteTargetsFromFind(tokens, cwd) {
  const hasDelete = tokens.includes("-delete");
  if (!hasDelete) return [];

  const roots = [];
  for (const tok of tokens) {
    if (!tok || tok === "--") continue;
    if (tok === "(" || tok === ")" || tok === "!" || tok.startsWith("-")) break;
    if (isRedirectionToken(tok)) break;
    roots.push(tok);
  }

  const effectiveRoots = roots.length ? roots : ["."];
  return effectiveRoots
    .map((tok) => resolveCommandPath(tok, cwd))
    .filter(Boolean);
}

function collectDeleteTargetsFromCommand(tokens, cwd) {
  if (!tokens.length) return [];

  let idx = 0;
  while (idx < tokens.length && looksLikeAssignment(tokens[idx])) idx += 1;
  while (idx < tokens.length && COMMAND_WRAPPERS.has(normalizeCommandName(tokens[idx]))) idx += 1;
  if (idx >= tokens.length) return [];

  const cmd = normalizeCommandName(tokens[idx]);
  const args = tokens.slice(idx + 1);

  if (cmd === "find") {
    return collectDeleteTargetsFromFind(args, cwd);
  }

  if (!DELETE_COMMANDS.has(cmd)) return [];

  const out = [];
  let endOfOptions = false;
  for (const tok of args) {
    if (!tok) continue;
    if (!endOfOptions && tok === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && tok.startsWith("-")) continue;
    if (isRedirectionToken(tok)) continue;
    const abs = resolveCommandPath(tok, cwd);
    if (abs) out.push(abs);
  }
  return out;
}

function resolveCd(segmentTokens, cwd) {
  let idx = 0;
  while (idx < segmentTokens.length && looksLikeAssignment(segmentTokens[idx])) idx += 1;
  while (idx < segmentTokens.length && COMMAND_WRAPPERS.has(normalizeCommandName(segmentTokens[idx]))) idx += 1;
  if (idx >= segmentTokens.length) return cwd;
  if (normalizeCommandName(segmentTokens[idx]) !== "cd") return cwd;

  const target = segmentTokens[idx + 1];
  if (!target || target === "-") return cwd;
  return resolveCommandPath(target, cwd) || cwd;
}

export function extractDeleteTargets(command, cwd) {
  const baseCwd = path.resolve(cwd || process.cwd());
  const tokens = tokenizeShell(command || "");
  const targets = [];
  let segment = [];
  let effectiveCwd = baseCwd;

  const flush = (separator) => {
    if (!segment.length) return;
    targets.push(...collectDeleteTargetsFromCommand(segment, effectiveCwd));
    if (separator !== "|") {
      effectiveCwd = resolveCd(segment, effectiveCwd);
    }
    segment = [];
  };

  for (const tok of tokens) {
    if (SEGMENT_BREAKS.has(tok)) {
      flush(tok);
      continue;
    }
    segment.push(tok);
  }
  flush(null);

  return [...new Set(targets.map((p) => path.resolve(p)))];
}

/**
 * 包装路径类工具（read, write, edit, grep, find, ls）
 */
export function wrapPathTool(tool, guard, operation, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);

      if (!result.allowed) {
        return blockedResult(result.reason);
      }

      return tool.execute(toolCallId, params, ...rest);
    },
  };
}

/**
 * 包装 bash 工具
 *
 * 1. preflight：常见危险命令提前拦截
 * 2. 路径校验：提取命令中的绝对路径，用 PathGuard 检查（Windows 无 OS 沙盒时的安全层）
 * 3. 执行：OS 沙盒在 BashOperations.exec 里生效（macOS/Linux）
 * 4. 错误翻译：OS 沙盒拦截后 stderr 的 Operation not permitted
 *
 * @param {object} tool  原始 bash 工具
 * @param {object} [guard]  PathGuard 实例（Windows 必传，macOS/Linux 可选）
 * @param {string} [cwd]  工作目录
 */
export function wrapBashTool(tool, guard, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // preflight
      for (const [pattern, reasonFn] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          return blockedResult(reasonFn());
        }
      }

      // 路径校验：从命令中提取绝对路径，检查 PathGuard
      if (guard && cwd) {
        const deleteTargets = extractDeleteTargets(params.command, cwd);
        for (const p of deleteTargets) {
          const result = guard.check(p, "delete");
          if (!result.allowed) {
            return blockedResult(result.reason || t("sandbox.restrictedPath", { path: p }));
          }
        }

        // Windows 无 OS 沙盒，需要对命令中绝对路径做额外读取校验。
        // macOS/Linux 仍交给 OS 沙盒处理普通读写边界，这里主要补 delete 校验。
        if (process.platform === "win32") {
          const paths = extractPaths(params.command);
          for (const p of paths) {
            const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
            const result = guard.check(abs, "read");
            if (!result.allowed) {
              return blockedResult(t("sandbox.restrictedPath", { path: p }));
            }
          }
        }
      }

      try {
        const result = await tool.execute(toolCallId, params, ...rest);

        // 成功路径的错误翻译（exitCode 0 但 stderr 有 sandbox 拒绝）
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n" + t("sandbox.writeRestricted");
        }

        return result;
      } catch (err) {
        // Pi SDK 对非零退出 throw Error，错误消息里包含 stderr 输出。
        // 如果是沙盒拦截导致的，追加友好提示。
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        throw err;
      }
    },
  };
}
