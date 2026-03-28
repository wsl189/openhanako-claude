/**
 * 统一的 compaction 参数计算。
 *
 * 目标：
 * - 大窗口模型保持原策略（约 100k 触发压缩）
 * - 小窗口模型采用比例参数，避免“几轮对话就压缩”
 */

const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_WINDOW_THRESHOLD = 128_000;

function normalizeContextWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONTEXT_WINDOW;
  return Math.floor(n);
}

export function buildCompactionSettings(contextWindow) {
  const windowSize = normalizeContextWindow(contextWindow);

  if (windowSize >= LARGE_WINDOW_THRESHOLD) {
    return {
      enabled: true,
      reserveTokens: Math.max(windowSize - 100_000, 16_384),
      keepRecentTokens: 20_000,
    };
  }

  // 小窗口模型（如 8k / 16k / 32k）使用比例阈值，防止频繁 compaction。
  const keepRecentTokens = Math.max(2_048, Math.floor(windowSize * 0.25));
  const reserveTokens = Math.max(1_024, Math.floor(windowSize * 0.20));

  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens,
  };
}

