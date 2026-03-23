/**
 * GuestHandler — Guest 留言机处理
 *
 * 所有非主人的消息都经过这里。
 * A: 消息前缀标注发送者身份
 */

import { getLocale } from "../server/i18n.js";

export class GuestHandler {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
  }

  /**
   * 处理 guest 消息
   * @param {string} text
   * @param {string} sessionKey
   * @param {object} [meta]  { name, avatarUrl, userId }
   * @param {object} [opts]  { isGroup }
   * @returns {Promise<string|null>}
   */
  async handle(text, sessionKey, meta, opts = {}) {
    const isZh = getLocale().startsWith("zh");
    const senderName = meta?.name || (isZh ? "访客" : "Guest");

    // A: 消息前缀
    const prefixed = isZh
      ? `[来自 ${senderName}] ${text}`
      : `[From ${senderName}] ${text}`;

    return this._hub.engine.executeExternalMessage(prefixed, sessionKey, meta, {
      guest: false,
      agentId: opts.agentId,
      onDelta: opts.onDelta,
      images: opts.images,
    });
  }
}
