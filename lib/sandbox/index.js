import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { spawnAndStream } from "./exec-helper.js";
import { PathGuard } from "./path-guard.js";
import { deriveSandboxPolicy } from "./policy.js";
import { createEnhancedReadFile } from "./read-enhanced.js";
import { createSeatbeltExec } from "./seatbelt.js";
import { createBwrapExec } from "./bwrap.js";
import { createWin32Exec } from "./win32-exec.js";
import { checkAvailability, detectPlatform } from "./platform.js";
import { wrapBashTool } from "./tool-wrapper.js";

const PROVIDER_BUILTIN_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "Write", "Edit", "Bash"]);
const DEFAULT_GREP_MAX_RESULTS = 200;
const DEFAULT_GLOB_MAX_RESULTS = 500;
const DEFAULT_READ_MAX_LINES = 400;
const DEFAULT_BASH_TIMEOUT_SEC = 60;

function normalizePathParam(params = {}) {
  return params.file_path || params.path || "";
}

function normalizeBaseDirParam(params = {}, cwd) {
  const raw = params.path || params.cwd || cwd;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function safeErrorText(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function ensureAbsolute(filePath, cwd) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function globToRegExp(pattern = "") {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      source += ".";
      continue;
    }
    if ("\\.[]{}()+-^$|".includes(ch)) {
      source += `\\${ch}`;
      continue;
    }
    source += ch;
  }
  source += "$";
  return new RegExp(source);
}

function listFilesRecursive(baseDir, limit = DEFAULT_GLOB_MAX_RESULTS) {
  const out = [];
  const stack = [baseDir];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) out.push(fullPath);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function runRg(args, cwd) {
  const result = spawnSync("rg", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status > 1) {
    throw new Error(result.stderr || `rg exited with code ${result.status}`);
  }
  return result.stdout || "";
}

function createReadTool(cwd, readFile) {
  return {
    name: "Read",
    description: "Read a file from the local workspace.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or relative file path." },
        offset: { type: "integer", description: "Optional starting line offset.", default: 0 },
        limit: { type: "integer", description: "Optional max number of lines to return.", default: DEFAULT_READ_MAX_LINES },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const filePath = ensureAbsolute(normalizePathParam(params), cwd);
      if (!filePath) return textResult("Read requires file_path.", { error: "missing_file_path" });
      const buffer = await readFile(filePath);
      if (isBinaryBuffer(buffer)) {
        return textResult(`[Binary file: ${filePath}]`, { filePath });
      }
      const text = buffer.toString("utf-8");
      const offset = Math.max(0, Number(params.offset) || 0);
      const limit = Math.max(1, Math.min(Number(params.limit) || DEFAULT_READ_MAX_LINES, 2000));
      const lines = text.split(/\r?\n/);
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, idx) => `${offset + idx + 1}\t${line}`).join("\n");
      return textResult(numbered || "", {
        filePath,
        offset,
        limit,
        totalLines: lines.length,
      });
    },
  };
}

function createGlobTool(cwd) {
  return {
    name: "Glob",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, for example **/*.js" },
        path: { type: "string", description: "Base directory to search from." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const baseDir = normalizeBaseDirParam(params, cwd);
      const pattern = String(params.pattern || "").trim();
      if (!pattern) return textResult("Glob requires pattern.", { error: "missing_pattern" });
      try {
        const output = runRg(["--files", "-g", pattern, baseDir], cwd).trim();
        const matches = output ? output.split(/\r?\n/).filter(Boolean).slice(0, DEFAULT_GLOB_MAX_RESULTS) : [];
        return textResult(matches.join("\n"), { path: baseDir, pattern, count: matches.length });
      } catch {
        const regex = globToRegExp(pattern.replace(/\\/g, "/"));
        const files = listFilesRecursive(baseDir, DEFAULT_GLOB_MAX_RESULTS * 3);
        const matches = files
          .map((filePath) => path.relative(baseDir, filePath).replace(/\\/g, "/"))
          .filter((relativePath) => regex.test(relativePath))
          .slice(0, DEFAULT_GLOB_MAX_RESULTS)
          .map((relativePath) => path.join(baseDir, relativePath));
        return textResult(matches.join("\n"), { path: baseDir, pattern, count: matches.length });
      }
    },
  };
}

function createGrepTool(cwd, readFile) {
  return {
    name: "Grep",
    description: "Search file contents with ripgrep-compatible pattern matching.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern." },
        path: { type: "string", description: "Base directory or file path." },
        glob: { type: "string", description: "Optional file glob filter." },
        max_results: { type: "integer", description: "Maximum number of matches to return.", default: DEFAULT_GREP_MAX_RESULTS },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const targetPath = ensureAbsolute(params.path || cwd, cwd);
      const pattern = String(params.pattern || "").trim();
      const glob = String(params.glob || "").trim();
      const maxResults = Math.max(1, Math.min(Number(params.max_results) || DEFAULT_GREP_MAX_RESULTS, 1000));
      if (!pattern) return textResult("Grep requires pattern.", { error: "missing_pattern" });
      try {
        const args = ["-n", "--no-heading", "--color", "never", "--max-count", String(maxResults)];
        if (glob) args.push("-g", glob);
        args.push(pattern, targetPath);
        const output = runRg(args, cwd).trim();
        const lines = output ? output.split(/\r?\n/).filter(Boolean).slice(0, maxResults) : [];
        return textResult(lines.join("\n"), { path: targetPath, pattern, count: lines.length });
      } catch {
        const flags = pattern.startsWith("/") && pattern.lastIndexOf("/") > 0 ? "" : "i";
        const matcher = new RegExp(pattern, flags);
        const regex = glob ? globToRegExp(glob.replace(/\\/g, "/")) : null;
        const files = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()
          ? [targetPath]
          : listFilesRecursive(targetPath, DEFAULT_GLOB_MAX_RESULTS * 3);
        const lines = [];
        for (const filePath of files) {
          const relativePath = path.relative(targetPath, filePath).replace(/\\/g, "/");
          if (regex && !regex.test(relativePath)) continue;
          let content = "";
          try {
            content = (await readFile(filePath)).toString("utf-8");
          } catch {
            continue;
          }
          const fileLines = content.split(/\r?\n/);
          for (let i = 0; i < fileLines.length; i += 1) {
            if (!matcher.test(fileLines[i])) continue;
            lines.push(`${filePath}:${i + 1}:${fileLines[i]}`);
            if (lines.length >= maxResults) break;
          }
          if (lines.length >= maxResults) break;
        }
        return textResult(lines.join("\n"), { path: targetPath, pattern, count: lines.length });
      }
    },
  };
}

function createWriteTool(cwd) {
  return {
    name: "Write",
    description: "Write full file contents to disk, creating parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or relative file path." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const filePath = ensureAbsolute(normalizePathParam(params), cwd);
      if (!filePath) return textResult("Write requires file_path.", { error: "missing_file_path" });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, String(params.content || ""), "utf-8");
      return textResult(`Wrote ${filePath}`, { filePath, bytes: Buffer.byteLength(String(params.content || ""), "utf-8") });
    },
  };
}

function createEditTool(cwd) {
  return {
    name: "Edit",
    description: "Edit a file by replacing an existing string with a new string.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or relative file path." },
        old_string: { type: "string", description: "Existing text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace all occurrences instead of exactly one.", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const filePath = ensureAbsolute(normalizePathParam(params), cwd);
      if (!filePath) return textResult("Edit requires file_path.", { error: "missing_file_path" });
      const oldString = String(params.old_string ?? "");
      const newString = String(params.new_string ?? "");
      const replaceAll = params.replace_all === true;
      const content = fs.readFileSync(filePath, "utf-8");
      const occurrences = oldString ? content.split(oldString).length - 1 : 0;
      if (!occurrences) {
        return textResult(`Could not find the target text in ${filePath}.`, { error: "old_string_not_found", filePath });
      }
      if (!replaceAll && occurrences !== 1) {
        return textResult(`Found ${occurrences} matches in ${filePath}; use replace_all=true or provide a more specific old_string.`, {
          error: "old_string_ambiguous",
          filePath,
          occurrences,
        });
      }
      const next = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      fs.writeFileSync(filePath, next, "utf-8");
      return textResult(`Edited ${filePath}`, { filePath, occurrences: replaceAll ? occurrences : 1 });
    },
  };
}

function createDirectBashExec() {
  if (process.platform === "win32") {
    return createWin32Exec();
  }
  return async (command, cwd, { onData, signal, timeout, env }) => {
    return spawnAndStream("/bin/bash", ["-lc", command], {
      cwd,
      env: env ?? process.env,
      onData,
      signal,
      timeout,
    });
  };
}

function createBashTool(cwd, execBash) {
  return {
    name: "Bash",
    description: "Run a shell command in the current workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeout_sec: { type: "integer", description: "Optional timeout in seconds.", default: DEFAULT_BASH_TIMEOUT_SEC },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, signal) => {
      const command = String(params.command || "").trim();
      if (!command) return textResult("Bash requires command.", { error: "missing_command" });
      let output = "";
      const timeout = Math.max(1, Math.min(Number(params.timeout_sec) || DEFAULT_BASH_TIMEOUT_SEC, 600));
      try {
        const result = await execBash(command, cwd, {
          signal,
          timeout,
          env: process.env,
          onData: (chunk) => {
            output += chunk.toString("utf-8");
          },
        });
        const finalText = output.trim();
        if (result.exitCode && result.exitCode !== 0) {
          return textResult(finalText || `Command exited with code ${result.exitCode}`, {
            error: `exit_code_${result.exitCode}`,
            exitCode: result.exitCode,
            command,
          });
        }
        return textResult(finalText || "(no output)", { exitCode: result.exitCode ?? 0, command });
      } catch (error) {
        return textResult(output.trim() || safeErrorText(error), {
          error: safeErrorText(error),
          command,
        });
      }
    },
  };
}

function buildBuiltinTools(cwd, { policy, builtinEnabled = [] } = {}) {
  const enabled = (Array.isArray(builtinEnabled) ? builtinEnabled : [])
    .filter((name) => PROVIDER_BUILTIN_TOOL_NAMES.has(name));
  if (enabled.length === 0) return [];

  const guard = new PathGuard(policy);
  const readFile = createEnhancedReadFile();
  const execBash = (() => {
    if (policy.mode === "full-access") return createDirectBashExec();
    if (process.platform === "win32") return createWin32Exec();
    const platform = detectPlatform();
    if (platform === "seatbelt" && checkAvailability(platform)) return createSeatbeltExec(policy);
    if (platform === "bwrap" && checkAvailability(platform)) return createBwrapExec(policy);
    return null;
  })();

  const toolMap = {
    Read: createReadTool(cwd, readFile),
    Glob: createGlobTool(cwd),
    Grep: createGrepTool(cwd, readFile),
    Write: createWriteTool(cwd),
    Edit: createEditTool(cwd),
    Bash: execBash
      ? createBashTool(cwd, execBash)
      : {
        name: "Bash",
        description: "Run a shell command in the current workspace.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout_sec: { type: "integer" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async () => textResult("Bash is unavailable because no supported local shell sandbox is available.", {
          error: "bash_unavailable",
        }),
      },
  };

  return enabled.map((name) => {
    const tool = toolMap[name];
    if (!tool) return null;
    if (name === "Read" || name === "Glob" || name === "Grep") {
      return {
        ...tool,
        execute: async (toolCallId, params, ...rest) => {
          const targetPath = ensureAbsolute(
            name === "Glob" ? (params.path || cwd) : normalizePathParam(params) || params.path || cwd,
            cwd,
          );
          const result = guard.check(targetPath || cwd, "read");
          if (!result.allowed) return textResult(result.reason, { error: "path_guard_denied" });
          return tool.execute(toolCallId, params, ...rest);
        },
      };
    }
    if (name === "Write" || name === "Edit") {
      return {
        ...tool,
        execute: async (toolCallId, params, ...rest) => {
          const targetPath = ensureAbsolute(normalizePathParam(params), cwd);
          const result = guard.check(targetPath || cwd, "write");
          if (!result.allowed) return textResult(result.reason, { error: "path_guard_denied" });
          return tool.execute(toolCallId, params, ...rest);
        },
      };
    }
    if (name === "Bash") {
      return wrapBashTool(tool, guard, cwd);
    }
    return tool;
  }).filter(Boolean);
}

export function createSandboxedTools(cwd, customTools = [], opts = {}) {
  const mode = "full-access";
  const policy = deriveSandboxPolicy({
    agentDir: opts.agentDir || process.cwd(),
    workspace: opts.workspace || cwd,
    hanakoHome: opts.hanakoHome || process.env.HANA_HOME || path.join(process.env.HOME || process.cwd(), ".hanako"),
    mode,
    pathRules: Array.isArray(opts.pathRules) ? opts.pathRules : [],
  });

  return {
    tools: buildBuiltinTools(cwd, {
      policy,
      builtinEnabled: opts.builtinEnabled || [],
    }),
    customTools: Array.isArray(customTools) ? customTools : [],
  };
}
