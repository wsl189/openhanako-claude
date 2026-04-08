/**
 * claude-core-tool.js — 将复杂任务委派给本地 claude-core CLI
 *
 * 场景：复杂编程、多步调试、重构等高复杂度任务。
 * 实现方式：调用本地 bun + claude-core dist/cli.js（print 模式）并回传结果。
 */

import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { spawnAndStream } from "../sandbox/exec-helper.js";
import { t } from "../../server/i18n.js";

const DEFAULT_TIMEOUT_SEC = 600;
const MIN_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 1800;
const MAX_CAPTURE_CHARS = 80_000;
const DEFAULT_PERMISSION_MODE = "acceptEdits";
const AUTO_CONTINUE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function clampTimeoutSec(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC;
  return Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.floor(n)));
}

function truncateHead(text, max = 1200) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

function normalizeOutput(text) {
  return stripAnsi(String(text || ""))
    .replace(/\r/g, "")
    .trim();
}

function normalizeTask(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toTaskTokens(text) {
  const raw = normalizeTask(text);
  if (!raw) return new Set();

  const out = new Set();
  const normalizeWord = (word) => {
    const w = String(word || "").toLowerCase();
    if (w.length <= 4) return w;
    return w.replace(/(ing|ed|es|s)$/i, "");
  };
  const wordMatches = raw.match(/[a-z0-9_]+/g) || [];
  for (const w of wordMatches) {
    if (w.length >= 2) out.add(`w:${normalizeWord(w)}`);
  }
  const cjkMatches = raw.match(/[\u4e00-\u9fff]/g) || [];
  for (const ch of cjkMatches) {
    out.add(`z:${ch}`);
  }
  return out;
}

function areTasksRelated(prevTask, nextTask) {
  const a = normalizeTask(prevTask);
  const b = normalizeTask(nextTask);
  if (!a || !b) return false;
  if (a === b) return true;

  const minLen = Math.min(a.length, b.length);
  if (minLen >= 20 && (a.includes(b) || b.includes(a))) return true;

  const ta = toTaskTokens(a);
  const tb = toTaskTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;

  let inter = 0;
  for (const token of ta) {
    if (tb.has(token)) inter++;
  }
  const minSetSize = Math.min(ta.size, tb.size);
  if (minSetSize <= 0) return false;
  const overlap = inter / minSetSize;
  return overlap >= 0.6 || (inter >= 2 && overlap >= 0.4);
}

function appendWithLimit(state, chunk) {
  if (!chunk) return;
  const remaining = MAX_CAPTURE_CHARS - state.output.length;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const text = String(chunk);
  if (text.length > remaining) {
    state.output += text.slice(0, remaining);
    state.truncated = true;
    return;
  }
  state.output += text;
}

function defaultResolveEntryPath() {
  const fromEnv = String(process.env.HANAKO_CLAUDE_CORE_ENTRY || "").trim();
  const candidates = [];
  if (fromEnv) candidates.push(fromEnv);

  const cwd = process.cwd();
  candidates.push(path.resolve(cwd, "..", "claude-core", "dist", "cli.js"));
  candidates.push(path.resolve(cwd, "claude-core", "dist", "cli.js"));

  const home = String(process.env.HOME || "").trim();
  if (home) {
    candidates.push(path.join(home, "PythonProject", "claude-core", "dist", "cli.js"));
  }

  for (const p of candidates) {
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
    } catch {
      // try next candidate
    }
  }
  return "";
}

async function defaultRunCommand({
  bunBin,
  entryPath,
  args,
  cwd,
  signal,
  timeoutSec,
}) {
  const capture = { output: "", truncated: false };
  const startedAt = Date.now();

  const result = await spawnAndStream(
    bunBin,
    [entryPath, ...args],
    {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      onData: (buf) => appendWithLimit(capture, buf?.toString?.("utf8") || String(buf || "")),
      signal,
      timeout: timeoutSec,
    },
  );

  return {
    exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
    output: capture.output,
    truncated: capture.truncated,
    durationMs: Date.now() - startedAt,
  };
}

function resolveTaskCwd(params, ctx) {
  const requested = String(params?.cwd || "").trim();
  if (requested) return requested;
  return ctx?.sessionManager?.getCwd?.() || process.cwd();
}

function decideContinueMode({
  params,
  task,
  cwd,
  ctx,
  recentTaskMap,
}) {
  if (typeof params?.continue === "boolean") {
    return { shouldContinue: params.continue, source: "explicit" };
  }

  const sessionId = String(ctx?.sessionManager?.getSessionId?.() || "__global__");
  const key = `${sessionId}::${cwd}`;
  const last = recentTaskMap.get(key);
  if (!last?.task || !last?.at) {
    return { shouldContinue: false, source: "auto-miss", key };
  }
  if ((Date.now() - last.at) > AUTO_CONTINUE_MAX_AGE_MS) {
    return { shouldContinue: false, source: "auto-expired", key };
  }
  const related = areTasksRelated(last.task, task);
  return { shouldContinue: related, source: related ? "auto-hit" : "auto-miss", key };
}

function buildCommandArgs(params, task, shouldContinue) {
  const args = ["-p", "--output-format", "text"];
  if (shouldContinue) args.push("-c");

  const permissionMode = String(params?.permission_mode || DEFAULT_PERMISSION_MODE).trim();
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }

  const model = String(params?.model || "").trim();
  if (model) args.push("--model", model);

  const thinking = String(params?.thinking || "").trim();
  if (thinking) args.push("--thinking", thinking);

  const maxTurns = Number(params?.max_turns);
  if (Number.isFinite(maxTurns) && maxTurns > 0) {
    args.push("--max-turns", String(Math.floor(maxTurns)));
  }

  if (params?.dangerously_skip_permissions === true) {
    args.push("--dangerously-skip-permissions");
  }

  args.push(task);
  return args;
}

function formatFailureText(exitCode, rawOutput) {
  const cleaned = normalizeOutput(rawOutput);
  const tail = truncateHead(cleaned || "unknown error", 1200);
  return t("error.claudeCoreFailed", { code: String(exitCode), msg: tail });
}

export function createClaudeCoreTool(deps = {}) {
  const resolveEntryPath = deps.resolveEntryPath || defaultResolveEntryPath;
  const runCommand = deps.runCommand || defaultRunCommand;
  const fsExistsSync = deps.existsSync || fs.existsSync;
  const fsStatSync = deps.statSync || fs.statSync;
  const bunBin = String(deps.bunBin || process.env.HANAKO_CLAUDE_CORE_BIN || "bun").trim() || "bun";
  const recentTaskMap = new Map();

  return {
    name: "claude_core",
    label: t("toolDef.claudeCore.label"),
    description: t("toolDef.claudeCore.description"),
    parameters: Type.Object({
      task: Type.String({ description: t("toolDef.claudeCore.taskDesc") }),
      cwd: Type.Optional(Type.String({ description: t("toolDef.claudeCore.cwdDesc") })),
      model: Type.Optional(Type.String({ description: t("toolDef.claudeCore.modelDesc") })),
      permission_mode: Type.Optional(Type.Union([
        Type.Literal("default"),
        Type.Literal("acceptEdits"),
        Type.Literal("bypassPermissions"),
        Type.Literal("dontAsk"),
        Type.Literal("plan"),
      ], { description: t("toolDef.claudeCore.permissionModeDesc") })),
      thinking: Type.Optional(Type.Union([
        Type.Literal("enabled"),
        Type.Literal("adaptive"),
        Type.Literal("disabled"),
      ], { description: t("toolDef.claudeCore.thinkingDesc") })),
      max_turns: Type.Optional(Type.Number({ description: t("toolDef.claudeCore.maxTurnsDesc") })),
      timeout_sec: Type.Optional(Type.Number({ description: t("toolDef.claudeCore.timeoutDesc") })),
      continue: Type.Optional(Type.Boolean({ description: t("toolDef.claudeCore.continueDesc") })),
      dangerously_skip_permissions: Type.Optional(
        Type.Boolean({ description: t("toolDef.claudeCore.dangerouslySkipDesc") }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const task = String(params?.task || "").trim();
      if (!task) {
        return {
          content: [{ type: "text", text: t("error.claudeCoreTaskRequired") }],
          details: { error: "task_required" },
        };
      }

      const taskCwd = resolveTaskCwd(params, ctx);
      if (!path.isAbsolute(taskCwd)) {
        return {
          content: [{ type: "text", text: t("error.claudeCoreCwdAbsolute") }],
          details: { error: "cwd_not_absolute", cwd: taskCwd },
        };
      }
      if (!fsExistsSync(taskCwd)) {
        return {
          content: [{ type: "text", text: t("error.claudeCoreCwdNotFound", { cwd: taskCwd }) }],
          details: { error: "cwd_not_found", cwd: taskCwd },
        };
      }
      try {
        if (!fsStatSync(taskCwd).isDirectory()) {
          return {
            content: [{ type: "text", text: t("error.claudeCoreCwdNotDir", { cwd: taskCwd }) }],
            details: { error: "cwd_not_dir", cwd: taskCwd },
          };
        }
      } catch {
        return {
          content: [{ type: "text", text: t("error.claudeCoreCwdNotFound", { cwd: taskCwd }) }],
          details: { error: "cwd_not_found", cwd: taskCwd },
        };
      }

      const entryPath = resolveEntryPath();
      if (!entryPath) {
        return {
          content: [{ type: "text", text: t("error.claudeCoreEntryNotFound") }],
          details: { error: "entry_not_found" },
        };
      }

      const timeoutSec = clampTimeoutSec(params?.timeout_sec);
      const continueMode = decideContinueMode({
        params,
        task,
        cwd: taskCwd,
        ctx,
        recentTaskMap,
      });
      const args = buildCommandArgs(params, task, continueMode.shouldContinue);
      const recentKey = continueMode.key || `${String(ctx?.sessionManager?.getSessionId?.() || "__global__")}::${taskCwd}`;

      try {
        const result = await runCommand({
          bunBin,
          entryPath,
          args,
          cwd: taskCwd,
          signal,
          timeoutSec,
        });

        const exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
        const output = normalizeOutput(result?.output || "");
        const truncated = !!result?.truncated;

        if (exitCode !== 0) {
          return {
            content: [{ type: "text", text: formatFailureText(exitCode ?? "?", result?.output || "") }],
            details: {
              error: "exit_non_zero",
              exitCode,
              cwd: taskCwd,
              entryPath,
              bunBin,
              truncated,
              continued: continueMode.shouldContinue,
              continueSource: continueMode.source,
            },
          };
        }

        let finalText = output || t("error.claudeCoreNoOutput");
        if (truncated) {
          finalText += "\n\n" + t("error.claudeCoreOutputTruncated");
        }

        return {
          content: [{ type: "text", text: finalText }],
          details: {
            action: "completed",
            exitCode,
            cwd: taskCwd,
            entryPath,
            bunBin,
            truncated,
            continued: continueMode.shouldContinue,
            continueSource: continueMode.source,
            durationMs: result?.durationMs ?? null,
          },
        };
      } catch (err) {
        const message = String(err?.message || "");
        if (message === "aborted") {
          return {
            content: [{ type: "text", text: t("error.claudeCoreAborted") }],
            details: { error: "aborted", cwd: taskCwd },
          };
        }
        if (message.startsWith("timeout:")) {
          return {
            content: [{ type: "text", text: t("error.claudeCoreTimeout", { sec: timeoutSec }) }],
            details: { error: "timeout", timeoutSec, cwd: taskCwd },
          };
        }
        return {
          content: [{ type: "text", text: t("error.claudeCoreRunError", { msg: truncateHead(message, 500) }) }],
          details: {
            error: "spawn_error",
            message,
            cwd: taskCwd,
            entryPath,
            bunBin,
            continued: continueMode.shouldContinue,
            continueSource: continueMode.source,
          },
        };
      } finally {
        // 无论是否 -c，都记录最近任务，让下一次 auto 判断更稳定。
        recentTaskMap.set(recentKey, { task, at: Date.now() });
      }
    },
  };
}
