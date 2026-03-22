/**
 * cron-schedule.js — cron 间隔 schedule 解析工具
 *
 * 将 every 类型的 schedule 统一转换为毫秒数：
 * - 纯数字 >= 1000 视为毫秒（向后兼容）
 * - 纯数字 < 1000 视为分钟数（更符合自然语言输入，如 "5"）
 * - 支持带单位：ms / s / m / h 及中英文常见写法
 * - 最小粒度钳制到 1 分钟（调度器本身是按分钟检查）
 */

const UNIT_MS = {
  ms: 1,
  msec: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  "秒": 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  "分": 60_000,
  "分钟": 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  "时": 3_600_000,
  "小时": 3_600_000,
};

/**
 * 解析 every 类型 schedule 为毫秒
 * @param {string|number} schedule
 * @returns {number|null}
 */
export function normalizeEverySchedule(schedule) {
  if (schedule === null || schedule === undefined) return null;

  // number
  if (typeof schedule === "number" && Number.isFinite(schedule)) {
    if (schedule <= 0) return null;
    // 纯小数字默认按“分钟数”解释（如 5）
    const ms = schedule < 1000 ? schedule * 60_000 : Math.trunc(schedule);
    return Math.max(60_000, ms);
  }

  const raw = String(schedule).trim();
  if (!raw) return null;

  // 纯数字字符串
  const plain = raw.match(/^\d+$/);
  if (plain) {
    const n = parseInt(plain[0], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1000 ? n * 60_000 : n;
    return Math.max(60_000, ms);
  }

  // 带单位
  const withUnit = raw.match(/^(\d+)\s*([a-zA-Z\u4e00-\u9fa5]+)$/);
  if (!withUnit) return null;

  const value = parseInt(withUnit[1], 10);
  const unit = withUnit[2].toLowerCase();
  const mul = UNIT_MS[unit];
  if (!Number.isFinite(value) || value <= 0 || !mul) return null;

  return Math.max(60_000, value * mul);
}
