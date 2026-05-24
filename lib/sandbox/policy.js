/**
 * policy.js — 沙盒策略单一来源
 *
 * 所有 ACL 常量在这里定义一份。
 * PathGuard 和 OS 沙盒（seatbelt/bwrap）都从这里导入。
 */

// ─── 常量 ─────────────────────────────────────

/** hanakoHome 根级别被屏蔽的文件 */
export const BLOCKED_FILES = ["auth.json", "models.json", "providers.yaml", "crash.log"];

/** hanakoHome 根级别被屏蔽的目录 */
export const BLOCKED_DIRS = ["browser-data", "playwright-browsers"];

/** compatibility projection files must never be mutated by normal runtime tools */
export const PROJECTION_ONLY_AGENT_FILES = ["pinned.md", "experience.md"];
export const PROJECTION_ONLY_AGENT_GLOBS = ["experience/*.md", "memory/memory.md"];
export const PROJECTION_ONLY_HOME_FILES = ["user/user.md"];

/** agentDir 下只读的文件 */
export const READ_ONLY_AGENT_FILES = [
  "ishiki.md",
  "config.yaml",
  "identity.md",
  "yuan.md",
];

/** hanakoHome 根级别只读的目录 */
export const READ_ONLY_HOME_DIRS = ["user", "skills"];

/** agentDir 下可读写的目录 */
export const READ_WRITE_AGENT_DIRS = [
  "memory",
  "sessions",
  "desk",
  "heartbeat",
  "book",
  "activity",
  "avatars",
];

/** agentDir 下只读的目录 */
export const READ_ONLY_AGENT_DIRS = ["learned-skills"];

/** agentDir 下可读写的文件 */
export const READ_WRITE_AGENT_FILES = ["channels.md"];

/** hanakoHome 根级别可读写的目录 */
export const READ_WRITE_HOME_DIRS = ["channels", "logs"];

// ─── 策略推导 ──────────────────────────────────

/**
 * Sandbox is globally disabled. Keep resolved path context on the policy object
 * so PathGuard can still enforce projection-file write restrictions.
 */
export function deriveSandboxPolicy(opts = {}) {
  return {
    ...opts,
    mode: "full-access",
  };
}
