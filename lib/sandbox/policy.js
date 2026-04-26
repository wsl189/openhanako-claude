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

/** agentDir 下只读的目录（install_skill 工具绕过 PathGuard 直接写入） */
export const READ_ONLY_AGENT_DIRS = ["learned-skills"];

/** agentDir 下可读写的文件 */
export const READ_WRITE_AGENT_FILES = ["pinned.md", "channels.md"];

/** hanakoHome 根级别可读写的目录 */
export const READ_WRITE_HOME_DIRS = ["channels", "logs"];

// ─── 策略推导 ──────────────────────────────────

/**
 * Sandbox is globally disabled. Keep a policy object for existing wrappers.
 */
export function deriveSandboxPolicy() {
  return { mode: "full-access" };
}
