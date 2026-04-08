import { describe, it, expect, vi } from "vitest";
import { withRetry, RetryError, sleep } from "./retry.js";

describe("retry", () => {
  it("成功时直接返回结果", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("失败时重试直到成功", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("达到最大重试次数后抛出 RetryError", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fail"));
    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 10 })).rejects.toThrow(
      "Failed after 3 attempts"
    );
    expect(fn).toHaveBeenCalledTimes(3); // 初始 + 2 次重试
  });

  it("不可重试错误直接抛出", async () => {
    const err = new Error("bad request");
    err.status = 400;
    const fn = vi.fn().mockRejectedValue(err);

    // 400 错误不应该重试
    await expect(withRetry(fn, { maxRetries: 3, baseDelay: 10 })).rejects.toThrow(
      "Failed after 1 attempts"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("5xx 错误应该重试", async () => {
    const serverErr = new Error("server error");
    serverErr.response = { status: 500 };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("429 Rate Limit 应该重试", async () => {
    const rateLimitErr = new Error("rate limited");
    rateLimitErr.response = { status: 429 };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("自定义 shouldRetry 判断", async () => {
    const err = new Error("custom retryable");
    err.code = "CUSTOM";
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelay: 10,
      shouldRetry: (e) => e.code === "CUSTOM",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("sleep 工具函数正常工作", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it("RetryError 包含正确的属性", async () => {
    const originalErr = new Error("original");
    const fn = vi.fn().mockRejectedValue(originalErr);

    try {
      await withRetry(fn, { maxRetries: 1, baseDelay: 10 });
    } catch (err) {
      expect(err).toBeInstanceOf(RetryError);
      expect(err.cause).toBe(originalErr);
      expect(err.attempts).toBe(2);
    }
  });
});
