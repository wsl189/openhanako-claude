/**
 * cron-store.js — 定时任务存储
 *
 * 管理 cron job 的 CRUD 和运行历史。
 * 调度逻辑在 cron-scheduler.js，这里只负责持久化。
 *
 * 参考 OpenClaw：jobs.json + runs/<jobId>.jsonl
 *
 * Job 类型：
 * - "at"：一次性任务（schedule = ISO 时间字符串）
 * - "every"：间隔任务（schedule = 毫秒数，如 3600000 = 1小时）
 * - "cron"：标准 5 段 cron 表达式（schedule = "0 7 * * *"）
 */

import fs from "fs";
import path from "path";
import { Cron } from "croner";

const CRON_CACHE_MAX = 256;
const KNOWN_NOTIFY_PLATFORMS = new Set(["wechat", "telegram", "feishu", "qq"]);
const cronCache = new Map();

function normalizeNotifyTarget(value, fallback = "auto") {
  const v = String(value ?? fallback).toLowerCase();
  return (v === "local" || v === "platform" || v === "auto") ? v : fallback;
}

function normalizeNotifyPlatform(value) {
  const v = String(value || "").trim().toLowerCase();
  return KNOWN_NOTIFY_PLATFORMS.has(v) ? v : "";
}

function getCronParser(expr) {
  const key = String(expr || "").trim();
  if (!key) return null;

  const cached = cronCache.get(key);
  if (cached) return cached;

  if (cronCache.size >= CRON_CACHE_MAX) {
    const oldest = cronCache.keys().next().value;
    if (oldest) cronCache.delete(oldest);
  }

  const parser = new Cron(key, { catch: false });
  cronCache.set(key, parser);
  return parser;
}

export class CronStore {
  /**
   * @param {string} jobsPath - cron-jobs.json 路径
   * @param {string} runsDir  - cron-runs/ 目录路径
   */
  constructor(jobsPath, runsDir) {
    this._jobsPath = jobsPath;
    this._runsDir = runsDir;
    this._jobs = [];
    this._nextNum = 1;
    this._load();
  }

  // ════════════════════════════
  //  持久化
  // ════════════════════════════

  _load() {
    try {
      const raw = fs.readFileSync(this._jobsPath, "utf-8");
      const data = JSON.parse(raw);
      this._jobs = (Array.isArray(data.jobs) ? data.jobs : []).map((job) => {
        const notifyPlatform = normalizeNotifyPlatform(job?.notifyPlatform);
        const notifyTarget = normalizeNotifyTarget(job?.notifyTarget, "auto");
        return {
          ...job,
          notifyTarget: notifyPlatform ? "platform" : notifyTarget,
          notifyPlatform,
        };
      });
      this._nextNum = data.nextNum ?? (this._jobs.length + 1);
    } catch {
      this._jobs = [];
      this._nextNum = 1;
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._jobsPath), { recursive: true });
    const data = JSON.stringify({
      jobs: this._jobs,
      nextNum: this._nextNum,
    }, null, 2) + "\n";
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    const tmpPath = this._jobsPath + ".tmp";
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, this._jobsPath);
  }

  // ════════════════════════════
  //  Job CRUD
  // ════════════════════════════

  /**
   * 添加任务
   * @param {object} opts
   * @param {"at"|"every"|"cron"} opts.type - 调度类型
   * @param {string|number} opts.schedule - 调度参数
   * @param {string} opts.prompt - 执行时的 prompt
   * @param {string} [opts.mode="isolated"] - 执行模式
   * @param {string} [opts.label] - 显示标签
   * @param {string} [opts.model] - 指定模型（为空则用 agent 默认模型）
   * @param {"local"|"platform"|"auto"} [opts.notifyTarget="auto"] - 提醒通知目标
   * @param {"wechat"|"telegram"|"feishu"|"qq"|""} [opts.notifyPlatform=""] - 指定提醒平台
   * @returns {object} 新建的 job
   */
  addJob({ type, schedule, prompt, mode = "isolated", label = "", model = "", notifyTarget = "auto", notifyPlatform = "" }) {
    // 先重载，避免多实例并发写入时使用过期内存覆盖最新磁盘状态。
    this._load();
    const id = `job_${this._nextNum++}`;
    const now = new Date().toISOString();
    const normalizedNotifyPlatform = normalizeNotifyPlatform(notifyPlatform);
    const normalizedNotifyTarget = normalizedNotifyPlatform
      ? "platform"
      : normalizeNotifyTarget(notifyTarget, "auto");

    const job = {
      id,
      type,
      schedule,
      prompt,
      mode,
      label: label || prompt.slice(0, 30),
      model: model || "",
      notifyTarget: normalizedNotifyTarget,
      notifyPlatform: normalizedNotifyPlatform,
      enabled: true,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: this._calcNextRun(type, schedule, now),
    };

    this._jobs.push(job);
    this._save();
    return job;
  }

  /**
   * 删除任务
   * @param {string} id
   * @returns {boolean}
   */
  removeJob(id) {
    // 先重载，避免并发写入导致删除后又被旧内存写回。
    this._load();
    const idx = this._jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this._jobs.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * 获取单个任务
   * @param {string} id
   * @returns {object|null}
   */
  getJob(id) {
    return this._jobs.find(j => j.id === id) || null;
  }

  /**
   * 列出所有任务（每次从磁盘重读，确保跨实例的写入都能被感知）
   * @returns {object[]}
   */
  listJobs() {
    this._load();
    return [...this._jobs];
  }

  /**
   * 更新任务字段
   * @param {string} id
   * @param {object} partial
   * @returns {object|null}
   */
  updateJob(id, partial) {
    this._load();
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    const merged = { ...job, ...(partial || {}) };
    const normalizedNotifyPlatform = normalizeNotifyPlatform(merged.notifyPlatform);
    const normalizedNotifyTarget = normalizeNotifyTarget(merged.notifyTarget, "auto");
    merged.notifyPlatform = normalizedNotifyPlatform;
    merged.notifyTarget = normalizedNotifyPlatform ? "platform" : normalizedNotifyTarget;
    Object.assign(job, merged);
    this._save();
    return job;
  }

  /**
   * 切换任务启用/禁用
   * @param {string} id
   * @returns {object|null}
   */
  toggleJob(id) {
    this._load();
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) {
      // 重新计算下次执行时间
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }
    this._save();
    return job;
  }

  /**
   * 标记任务已执行，更新 lastRunAt + nextRunAt
   * @param {string} id
   */
  markRun(id) {
    // 运行结束前再次重载，避免任务被外部删除后“复活”。
    this._load();
    const job = this._jobs.find(j => j.id === id);
    if (!job) return;
    const now = new Date().toISOString();
    job.lastRunAt = now;
    job.nextRunAt = this._calcNextRun(job.type, job.schedule, now);

    // "at" 类型执行一次后自动禁用
    if (job.type === "at") {
      job.enabled = false;
    }

    this._save();
  }

  // ════════════════════════════
  //  运行历史
  // ════════════════════════════

  /**
   * 记录一次运行
   * @param {string} jobId
   * @param {object} run - { status, startedAt, finishedAt, error? }
   */
  logRun(jobId, run) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ ...run, timestamp: new Date().toISOString() }) + "\n";
    fs.mkdirSync(this._runsDir, { recursive: true });
    fs.appendFileSync(filePath, line, "utf-8");
  }

  /**
   * 读取运行历史
   * @param {string} jobId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  getRunHistory(jobId, limit = 20) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  调度计算
  // ════════════════════════════

  /**
   * 计算下次执行时间
   * @param {"at"|"every"|"cron"} type
   * @param {string|number} schedule
   * @param {string} fromISO - 基准时间（ISO string）
   * @returns {string|null} ISO string
   */
  _calcNextRun(type, schedule, fromISO) {
    const from = new Date(fromISO);

    switch (type) {
      case "at": {
        // 一次性：schedule 就是目标时间
        const target = new Date(schedule);
        return target > from ? target.toISOString() : null;
      }

      case "every": {
        // 间隔：从现在起 schedule 毫秒后
        const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(from.getTime() + ms).toISOString();
      }

      case "cron": {
        // 使用标准 cron 解析器，支持范围、步进、列表等复杂表达式。
        return this._parseSimpleCron(schedule, from);
      }

      default:
        return null;
    }
  }

  /**
   * cron 解析
   * @param {string} expr - cron 表达式
   * @param {Date} from - 基准时间
   * @returns {string|null}
   */
  _parseSimpleCron(expr, from) {
    try {
      const parser = getCronParser(expr);
      if (!parser) return null;

      const nowMs = from.getTime();
      let next = parser.nextRun(from);
      if (!next) return null;

      let nextMs = next.getTime();
      if (!Number.isFinite(nextMs)) return null;

      // 边界秒下有些表达式可能返回当前时刻，保证返回 future time。
      if (nextMs <= nowMs) {
        const nextSecond = new Date(Math.floor(nowMs / 1000) * 1000 + 1000);
        next = parser.nextRun(nextSecond);
        if (!next) return null;
        nextMs = next.getTime();
        if (!Number.isFinite(nextMs) || nextMs <= nowMs) return null;
      }

      return new Date(nextMs).toISOString();
    } catch {
      return null;
    }
  }

  /** 任务数量 */
  get size() {
    return this._jobs.length;
  }

  /** 启用的任务数量 */
  get enabledCount() {
    return this._jobs.filter(j => j.enabled).length;
  }
}
