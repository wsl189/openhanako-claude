/**
 * OAuthFlowManager — OAuth 流程状态持久化管理
 *
 * 职责：
 *   - 管理 OAuth 登录流程状态（内存 + 文件持久化）
 *   - 解决服务重启后 pendingFlows 丢失问题
 *   - 提供统一的流程查询接口
 *
 * 持久化：flow-{sessionId}.json 保存在 hanakoHome 下
 * 流程结束（done/error/timeout）后清理文件
 */

import fs from "fs"
import path from "path"
import crypto from "crypto"

const FLOW_TTL = 5 * 60 * 1000 // 5 分钟超时

/**
 * @typedef {Object} OAuthFlow
 * @property {string} sessionId
 * @property {string} provider
 * @property {number} createdAt
 * @property {"pending"|"done"|"error"|"timeout"} status
 * @property {string|null} error
 */

export class OAuthFlowManager {
  /**
   * @param {string} hanakoHome
   */
  constructor(hanakoHome) {
    this._hanakoHome = hanakoHome
    /** @type {Map<string, { resolve: Function, reject: Function, promise: Promise<any> }>} */
    this._callbacks = new Map()
    /** @type {Map<string, OAuthFlow>} */
    this._flows = new Map()
    this._cleanupTimer = null
    this._startCleanup()
  }

  /** 持久化目录 */
  get _flowDir() {
    return path.join(this._hanakoHome, "oauth-flows")
  }

  /** 生成 sessionId */
  generateSessionId() {
    return crypto.randomUUID()
  }

  /**
   * 注册一个新流程
   * @param {string} provider
   * @returns {{ sessionId: string, flow: OAuthFlow }}
   */
  register(provider) {
    const sessionId = this.generateSessionId()
    /** @type {OAuthFlow} */
    const flow = {
      sessionId,
      provider,
      createdAt: Date.now(),
      status: "pending",
      error: null,
    }
    this._flows.set(sessionId, flow)
    this._persist(sessionId, flow)
    return { sessionId, flow }
  }

  /**
   * 存储流程的 resolve/reject 回调（供 callback/poll 使用）
   * @param {string} sessionId
   * @param {Function} resolve
   * @param {Function} reject
   * @returns {Promise<any>}
   */
  setCallbacks(sessionId, resolve, reject) {
    const existing = this._callbacks.get(sessionId)
    if (existing) return existing.promise

    const promise = new Promise((res, rej) => {
      // 外部已传入 resolve/reject，这里包装一下
      resolve._original = resolve
      reject._original = reject
    })
    this._callbacks.set(sessionId, { resolve, reject, promise })
    return promise
  }

  /**
   * 完成流程（授权码流程 callback）
   * @param {string} sessionId
   * @param {string|null} [error]
   */
  complete(sessionId, error = null) {
    const flow = this._flows.get(sessionId)
    const cb = this._callbacks.get(sessionId)

    if (error) {
      if (flow) {
        flow.status = "error"
        flow.error = error
        this._persist(sessionId, flow)
      }
      if (cb) cb.reject(new Error(error))
    } else {
      if (flow) {
        flow.status = "done"
        this._persist(sessionId, flow)
      }
      if (cb) cb.resolve()
    }

    this._callbacks.delete(sessionId)
    this._scheduleCleanup(sessionId)
  }

  /**
   * 获取流程状态
   * @param {string} sessionId
   * @returns {OAuthFlow|null}
   */
  getFlow(sessionId) {
    // 先查内存
    if (this._flows.has(sessionId)) {
      const flow = this._flows.get(sessionId)
      // 超时检查
      if (flow.status === "pending" && Date.now() - flow.createdAt > FLOW_TTL) {
        this.complete(sessionId, "OAuth flow timed out")
        return { ...flow, status: "timeout", error: "OAuth flow timed out" }
      }
      return flow
    }

    // 尝试从文件加载
    const loaded = this._load(sessionId)
    if (loaded) {
      // 超时检查
      if (loaded.status === "pending" && Date.now() - loaded.createdAt > FLOW_TTL) {
        loaded.status = "timeout"
        loaded.error = "OAuth flow timed out"
        this._persist(sessionId, loaded)
        return loaded
      }
      this._flows.set(sessionId, loaded)
      return loaded
    }

    return null
  }

  /**
   * 删除流程
   * @param {string} sessionId
   */
  remove(sessionId) {
    this._flows.delete(sessionId)
    this._callbacks.delete(sessionId)
    this._removeFile(sessionId)
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  _ensureDir() {
    try {
      fs.mkdirSync(this._flowDir, { recursive: true })
    } catch {}
  }

  _flowFile(sessionId) {
    return path.join(this._flowDir, `flow-${sessionId}.json`)
  }

  _persist(sessionId, flow) {
    this._ensureDir()
    try {
      fs.writeFileSync(this._flowFile(sessionId), JSON.stringify(flow, null, 2), "utf-8")
    } catch (err) {
      console.error(`[OAuthFlowManager] persist failed: ${err.message}`)
    }
  }

  _load(sessionId) {
    const filePath = this._flowFile(sessionId)
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"))
      }
    } catch {}
    return null
  }

  _removeFile(sessionId) {
    try {
      const filePath = this._flowFile(sessionId)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {}
  }

  _scheduleCleanup(sessionId) {
    // 流程结束后延迟删除（给 poll 端点留时间）
    setTimeout(() => this.remove(sessionId), 30_000).unref()
  }

  _startCleanup() {
    // 每分钟检查过期流程
    this._cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [sessionId, flow] of this._flows) {
        if (flow.status === "pending" && now - flow.createdAt > FLOW_TTL) {
          this.complete(sessionId, "OAuth flow timed out")
        }
      }
    }, 60_000)
    this._cleanupTimer.unref()
  }

  /** 关闭时清理 */
  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer)
  }
}
