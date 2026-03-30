/**
 * path-guard.js — 路径权限校验
 *
 * 定义四种访问级别：BLOCKED / READ_ONLY / READ_WRITE / FULL
 * 所有路径先经过 realpath 解析符号链接，再匹配区域。
 *
 * 常量从 policy.js 导入（单一来源）。
 */

import fs from "fs";
import path from "path";
import { t } from "../../server/i18n.js";
import {
  BLOCKED_FILES,
  BLOCKED_DIRS,
  READ_ONLY_AGENT_FILES,
  READ_ONLY_AGENT_DIRS,
  READ_ONLY_HOME_DIRS,
  READ_WRITE_AGENT_DIRS,
  READ_WRITE_AGENT_FILES,
  READ_WRITE_HOME_DIRS,
} from "./policy.js";

export const AccessLevel = {
  BLOCKED: "blocked",
  READ_ONLY: "read_only",
  READ_WRITE: "read_write",
  FULL: "full",
};

/** 操作 → 所需最低级别 */
const OP_REQUIREMENTS = {
  read: new Set([AccessLevel.READ_ONLY, AccessLevel.READ_WRITE, AccessLevel.FULL]),
  write: new Set([AccessLevel.READ_WRITE, AccessLevel.FULL]),
  delete: new Set([AccessLevel.FULL]),
};

export class PathGuard {
  /**
   * @param {object} policy  从 deriveSandboxPolicy() 得到，或兼容旧格式
   */
  constructor(policy) {
    if (policy.mode === "full-access") {
      this._fullAccess = true;
      return;
    }
    this._fullAccess = false;
    this.mode = policy.mode === "balanced" ? "balanced" : "standard";
    this.hanakoHome = path.resolve(policy.hanakoHome);
    this.agentDir = path.resolve(policy.agentDir);
    this.workspace = policy.workspace ? path.resolve(policy.workspace) : null;
    this.desktopPath = (() => {
      const rawPath = String(policy.desktopPath || "").trim();
      if (!rawPath || !path.isAbsolute(rawPath)) return null;
      try { return fs.realpathSync(rawPath); } catch { return path.resolve(rawPath); }
    })();
    this.pathRules = (Array.isArray(policy.pathRules) ? policy.pathRules : [])
      .map((rule) => {
        const rawPath = String(rule?.path || "").trim();
        const access = String(rule?.access || "").trim();
        if (!rawPath || !path.isAbsolute(rawPath)) return null;
        if (access !== "read_only" && access !== "read_write") return null;
        let resolvedPath = path.resolve(rawPath);
        try { resolvedPath = fs.realpathSync(rawPath); } catch {}
        return { path: resolvedPath, access };
      })
      .filter(Boolean)
      .sort((a, b) => b.path.length - a.path.length);
  }

  /**
   * 解析路径（跟踪符号链接）。
   * 文件不存在时 resolve 父目录 + basename。
   */
  _resolveReal(p) {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch (err) {
      if (err.code === "ENOENT") {
        const dir = path.dirname(abs);
        const base = path.basename(abs);
        try {
          return path.join(fs.realpathSync(dir), base);
        } catch {
          return null; // 文件和父目录都不存在 → fail-closed
        }
      }
      return null; // 其他错误 → fail-closed
    }
  }

  /** 判断 target 是否在 base 内部（含相等） */
  _isInside(target, base) {
    return target === base || target.startsWith(base + path.sep);
  }

  /**
   * 获取路径的访问级别
   * @param {string} rawPath 绝对路径
   * @returns {string} AccessLevel
   */
  getAccessLevel(rawPath) {
    const resolved = this._resolveReal(rawPath);
    if (!resolved) return AccessLevel.BLOCKED;

    // 1. BLOCKED 文件（hanakoHome 根）
    for (const f of BLOCKED_FILES) {
      if (resolved === path.join(this.hanakoHome, f)) return AccessLevel.BLOCKED;
    }

    // 2. BLOCKED 目录
    for (const d of BLOCKED_DIRS) {
      if (this._isInside(resolved, path.join(this.hanakoHome, d))) {
        return AccessLevel.BLOCKED;
      }
    }

    // 3. READ_ONLY agent 文件
    for (const f of READ_ONLY_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_ONLY;
    }

    // 4. READ_ONLY agent 目录（learned-skills 等）
    for (const d of READ_ONLY_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    // 5. READ_ONLY 全局目录
    for (const d of READ_ONLY_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.hanakoHome, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    // 6. READ_WRITE agent 目录
    for (const d of READ_WRITE_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    // balanced: 允许 agent 私有 skills 目录读写（便于技能脚本执行/自更新）
    if (this.mode === "balanced" && this._isInside(resolved, path.join(this.agentDir, "skills"))) {
      return AccessLevel.READ_WRITE;
    }

    // 6. READ_WRITE agent 文件
    for (const f of READ_WRITE_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_WRITE;
    }

    // 7. READ_WRITE 全局目录
    for (const d of READ_WRITE_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.hanakoHome, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    // 8. 系统桌面（默认读写白名单）
    if (this.desktopPath && this._isInside(resolved, this.desktopPath)) {
      return AccessLevel.READ_WRITE;
    }

    // 9. hanakoHome 内未匹配 → 安全兜底 BLOCKED
    if (this._isInside(resolved, this.hanakoHome)) return AccessLevel.BLOCKED;

    // 10. workspace 内 → FULL
    if (this.workspace && this._isInside(resolved, this.workspace)) {
      return AccessLevel.FULL;
    }

    // 11. 用户额外白名单路径
    for (const rule of this.pathRules) {
      if (!this._isInside(resolved, rule.path)) continue;
      return rule.access === "read_write" ? AccessLevel.READ_WRITE : AccessLevel.READ_ONLY;
    }

    // 12. 其他 → BLOCKED
    return AccessLevel.BLOCKED;
  }

  /**
   * 检查操作是否被允许
   * @param {string} absolutePath
   * @param {"read"|"write"|"delete"} operation
   * @returns {{ allowed: boolean, reason?: string }}
   */
  check(absolutePath, operation) {
    if (this._fullAccess) return { allowed: true };
    const level = this.getAccessLevel(absolutePath);
    const allowed = OP_REQUIREMENTS[operation]?.has(level) ?? false;

    if (allowed) return { allowed: true };

    const resolved = this._resolveReal(absolutePath) || absolutePath;
    const opLabel = { read: t("sandbox.opRead"), write: t("sandbox.opWrite"), delete: t("sandbox.opDelete") }[operation] || operation;
    return {
      allowed: false,
      reason: t("sandbox.denied", { op: opLabel, path: resolved, level }),
    };
  }

}
