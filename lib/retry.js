/**
 * 重试工具 - 指数退避策略
 *
 * 设计：
 *   - 默认指数退避（base=2），避免雪崩
 *   - 可配置最大重试次数和超时
 *   - 区分可重试错误（网络、5xx）和不可重试错误（4xx、业务）
 */

export class RetryError extends Error {
  /** @type {any} */
  cause
  /** @type {number} 已重试次数 */
  attempts

  constructor(message, cause, attempts) {
    super(message)
    this.name = "RetryError"
    this.cause = cause
    this.attempts = attempts
  }
}

/**
 * @typedef {Object} RetryOptions
 * @property {number} [maxRetries=3] 最大重试次数
 * @property {number} [baseDelay=1000] 基础延迟(ms)
 * @property {number} [maxDelay=30000] 最大延迟(ms)
 * @property {number} [timeout=30000] 单次操作超时(ms)
 * @property {(err: any) => boolean} [shouldRetry] 判断错误是否可重试
 */

/** 默认可重试判断：网络错误 + 5xx */
const defaultShouldRetry = (err) => {
  if (!err) return false
  const code = err?.response?.status || err?.status || err?.statusCode
  // 网络错误或 5xx 可重试
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") return true
  if (code >= 500 && code < 600) return true
  // 429 Rate Limit 可重试
  if (code === 429) return true
  return false
}

/**
 * 带重试的执行包装
 *
 * @param {() => Promise<T>} fn 异步操作
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    timeout = 30000,
    shouldRetry = defaultShouldRetry,
  } = options

  let lastError

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 带超时包装
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("Operation timeout"), { code: "ETIMEDOUT" })), timeout)
        ),
      ])
      return result
    } catch (err) {
      lastError = err

      // 最后一次尝试或不满足重试条件
      if (attempt === maxRetries || !shouldRetry(err)) {
        throw new RetryError(`Failed after ${attempt + 1} attempts: ${err.message}`, err, attempt + 1)
      }

      // 指数退避 + 抖动
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
      const jitter = delay * 0.1 * Math.random()
      await sleep(delay + jitter)
    }
  }

  throw lastError
}

/** 睡眠工具 */
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
