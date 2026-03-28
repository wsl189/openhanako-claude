import { t } from "../../server/i18n.js";

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  return String(content);
}

function normalizeMessages(messages = [], systemPrompt = "") {
  const combined = [];

  if (systemPrompt) {
    combined.push({ role: "system", content: systemPrompt });
  }

  for (const message of messages) {
    if (!message?.role) continue;
    const text = contentToText(message.content);
    if (!text) continue;
    combined.push({ role: message.role, content: text });
  }

  return combined;
}

function buildAnthropicPayload(messages) {
  let system = "";
  const anthropicMessages = [];

  for (const message of messages) {
    if (message.role === "system") {
      system = system ? `${system}\n\n${message.content}` : message.content;
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    anthropicMessages.push({
      role: message.role,
      content: message.content,
    });
  }

  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: "user", content: "" });
  }

  return { system, messages: anthropicMessages };
}

function extractOpenAIText(data) {
  const content = data?.choices?.[0]?.message?.content;
  const text = contentToText(content).trim();
  return text || "";
}

function isReasoningLikeType(type) {
  const normalized = String(type || "").toLowerCase();
  return /(reason|think|analysis)/.test(normalized);
}

function extractResponsesAssistantTexts(data) {
  const texts = [];
  for (const item of data?.output || []) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    const chunkTexts = [];
    for (const chunk of item.content || []) {
      if (isReasoningLikeType(chunk?.type)) continue;
      if (typeof chunk?.text === "string" && chunk.text.trim()) {
        chunkTexts.push(chunk.text.trim());
      } else if (typeof chunk?.content === "string" && chunk.content.trim()) {
        chunkTexts.push(chunk.content.trim());
      }
    }
    if (chunkTexts.length > 0) texts.push(chunkTexts.join("\n").trim());
  }
  return texts;
}

function extractResponsesText(data) {
  const assistantTexts = extractResponsesAssistantTexts(data);
  if (assistantTexts.length > 0) {
    // 标题/摘要等场景优先使用“最后一条 assistant 最终消息”
    return assistantTexts[assistantTexts.length - 1];
  }

  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  return "";
}

function extractAnthropicText(data) {
  return (data?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function isAnthropicThinkingOnly(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  if (!blocks.length) return false;
  const hasText = blocks.some((item) => item?.type === "text" && typeof item.text === "string" && item.text.trim());
  if (hasText) return false;
  return blocks.some((item) => item?.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim());
}

function isResponsesReasoningOnly(data) {
  if (extractResponsesAssistantTexts(data).length > 0) return false;
  const output = Array.isArray(data?.output) ? data.output : [];
  return output.some((item) => {
    if (isReasoningLikeType(item?.type)) return true;
    if (item?.type !== "message") return false;
    return (item.content || []).some((chunk) => isReasoningLikeType(chunk?.type));
  });
}

function isResponsesMaxTokenStop(data) {
  const reason = String(
    data?.incomplete_details?.reason
    || data?.finish_reason
    || data?.stop_reason
    || data?.status
    || "",
  ).toLowerCase();
  return reason.includes("max_output_tokens")
    || reason.includes("max_tokens")
    || reason === "incomplete";
}

export function buildProviderAuthHeaders(api, apiKey, opts = {}) {
  const allowMissingApiKey = opts.allowMissingApiKey === true;
  if (!api) {
    throw new Error(t("error.missingApiProtocol"));
  }
  if (!apiKey && !allowMissingApiKey) {
    throw new Error(t("error.missingApiKey"));
  }

  if (api === "anthropic-messages") {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  }

  if (api === "openai-completions" || api === "openai-codex-responses" || api === "openai-responses") {
    const headers = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }

  throw new Error(t("error.unsupportedApiProtocol", { api }));
}

export async function callProviderText({
  api,
  api_key,
  base_url,
  model,
  systemPrompt = "",
  messages = [],
  temperature = 0.3,
  max_tokens = 512,
  timeoutMs = 60_000,
  signal,
}) {
  if (!model) throw new Error(t("error.missingModelId"));
  if (!base_url) throw new Error(t("error.missingBaseUrl"));

  const combinedMessages = normalizeMessages(messages, systemPrompt);
  const baseUrl = stripTrailingSlash(base_url);
  const headers = buildProviderAuthHeaders(api, api_key, {
    allowMissingApiKey: isLocalBaseUrl(baseUrl),
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let endpoint = "";
  let body = null;
  let extractText = () => "";

  if (api === "openai-completions") {
    endpoint = `${baseUrl}/chat/completions`;
    body = {
      model,
      messages: combinedMessages,
      temperature,
      max_tokens,
      enable_thinking: false,
    };
    extractText = extractOpenAIText;
  } else if (api === "anthropic-messages") {
    const anthropic = buildAnthropicPayload(combinedMessages);
    // 兼容 MiniMax Anthropic 网关：
    // base_url 常见为 ".../anthropic"，真实接口为 ".../anthropic/v1/messages"。
    endpoint = /\/anthropic$/i.test(baseUrl)
      ? `${baseUrl}/v1/messages`
      : `${baseUrl}/messages`;
    body = {
      model,
      system: anthropic.system || undefined,
      messages: anthropic.messages,
      temperature,
      max_tokens,
    };
    extractText = extractAnthropicText;
  } else if (api === "openai-codex-responses" || api === "openai-responses") {
    const responseInput = combinedMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
    endpoint = `${baseUrl}/responses`;
    body = {
      model,
      instructions: systemPrompt || undefined,
      input: responseInput,
      temperature,
      max_output_tokens: max_tokens,
    };
    extractText = extractResponsesText;
  } else {
    throw new Error(t("error.unsupportedApiProtocol", { api }));
  }

  const requestOnce = async (tokenLimit) => {
    if (body && typeof body === "object") {
      if ("max_tokens" in body) body.max_tokens = tokenLimit;
      if ("max_output_tokens" in body) body.max_output_tokens = tokenLimit;
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal,
    });

    const rawText = await res.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      throw new Error(t("error.llmInvalidJson", { status: res.status }));
    }

    if (!res.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        rawText ||
        `HTTP ${res.status}`;
      throw new Error(message);
    }
    return data;
  };

  let data = await requestOnce(max_tokens);
  let text = extractText(data);
  if (!text && (api === "openai-codex-responses" || api === "openai-responses") && isResponsesMaxTokenStop(data) && isResponsesReasoningOnly(data)) {
    const retryTokenLimits = [Math.max(max_tokens * 4, 200), Math.max(max_tokens * 8, 512)];
    let currentLimit = max_tokens;
    for (const retryLimit of retryTokenLimits) {
      if (retryLimit <= currentLimit) continue;
      data = await requestOnce(retryLimit);
      text = extractText(data);
      if (text) break;
      currentLimit = retryLimit;
      if (!(isResponsesMaxTokenStop(data) && isResponsesReasoningOnly(data))) break;
    }
  }
  if (!text && api === "anthropic-messages" && data?.stop_reason === "max_tokens" && isAnthropicThinkingOnly(data)) {
    const retryTokenLimits = [Math.max(max_tokens * 4, 200), Math.max(max_tokens * 8, 512)];
    let currentLimit = max_tokens;
    for (const retryLimit of retryTokenLimits) {
      if (retryLimit <= currentLimit) continue;
      data = await requestOnce(retryLimit);
      text = extractText(data);
      if (text) break;
      currentLimit = retryLimit;
      if (!(data?.stop_reason === "max_tokens" && isAnthropicThinkingOnly(data))) break;
    }
  }
  if (!text) {
    throw new Error(t("error.llmEmptyResponse"));
  }
  return text;
}

function normalizeVisionImages(images = []) {
  return (Array.isArray(images) ? images : [])
    .map((img) => ({
      data: String(img?.data || "").trim(),
      mimeType: String(img?.mimeType || "image/png").trim() || "image/png",
    }))
    .filter((img) => img.data);
}

function buildVisionOpenAIMessages({ systemPrompt, prompt, images }) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  const userContent = [];
  if (prompt) {
    userContent.push({ type: "text", text: prompt });
  }
  for (const img of images) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    });
  }
  messages.push({
    role: "user",
    content: userContent.length ? userContent : [{ type: "text", text: t("error.viewImage") }],
  });
  return messages;
}

function buildVisionResponsesInput({ prompt, images }) {
  const content = [];
  if (prompt) {
    content.push({ type: "input_text", text: prompt });
  }
  for (const img of images) {
    content.push({
      type: "input_image",
      image_url: `data:${img.mimeType};base64,${img.data}`,
    });
  }
  return [{
    role: "user",
    content: content.length ? content : [{ type: "input_text", text: t("error.viewImage") }],
  }];
}

function buildVisionAnthropicPayload({ systemPrompt, prompt, images }) {
  const content = [];
  if (prompt) {
    content.push({ type: "text", text: prompt });
  }
  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mimeType,
        data: img.data,
      },
    });
  }
  return {
    system: systemPrompt || undefined,
    messages: [{
      role: "user",
      content: content.length ? content : [{ type: "text", text: t("error.viewImage") }],
    }],
  };
}

function normalizeImageBase64(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const match = text.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i);
  return (match?.[1] || text).trim();
}

export async function callProviderVision({
  api,
  api_key,
  base_url,
  model,
  systemPrompt = "",
  prompt = "",
  images = [],
  temperature = 0.2,
  max_tokens = 800,
  timeoutMs = 120_000,
  signal,
}) {
  if (!model) throw new Error(t("error.missingModelId"));
  if (!base_url) throw new Error(t("error.missingBaseUrl"));

  const normalizedImages = normalizeVisionImages(images);
  if (normalizedImages.length === 0) {
    throw new Error(t("error.imageToolNoImages"));
  }

  const baseUrl = stripTrailingSlash(base_url);
  const headers = buildProviderAuthHeaders(api, api_key, {
    allowMissingApiKey: isLocalBaseUrl(baseUrl),
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let endpoint = "";
  let body = null;
  let extractText = () => "";

  if (api === "openai-completions") {
    endpoint = `${baseUrl}/chat/completions`;
    body = {
      model,
      messages: buildVisionOpenAIMessages({
        systemPrompt: String(systemPrompt || ""),
        prompt: String(prompt || ""),
        images: normalizedImages,
      }),
      temperature,
      max_tokens,
      enable_thinking: false,
    };
    extractText = extractOpenAIText;
  } else if (api === "anthropic-messages") {
    const anthropic = buildVisionAnthropicPayload({
      systemPrompt: String(systemPrompt || ""),
      prompt: String(prompt || ""),
      images: normalizedImages,
    });
    endpoint = /\/anthropic$/i.test(baseUrl)
      ? `${baseUrl}/v1/messages`
      : `${baseUrl}/messages`;
    body = {
      model,
      system: anthropic.system,
      messages: anthropic.messages,
      temperature,
      max_tokens,
    };
    extractText = extractAnthropicText;
  } else if (api === "openai-codex-responses" || api === "openai-responses") {
    endpoint = `${baseUrl}/responses`;
    body = {
      model,
      instructions: systemPrompt || undefined,
      input: buildVisionResponsesInput({
        prompt: String(prompt || ""),
        images: normalizedImages,
      }),
      temperature,
      max_output_tokens: max_tokens,
    };
    extractText = extractResponsesText;
  } else {
    throw new Error(t("error.unsupportedApiProtocol", { api }));
  }

  const requestOnce = async (tokenLimit) => {
    if (body && typeof body === "object") {
      if ("max_tokens" in body) body.max_tokens = tokenLimit;
      if ("max_output_tokens" in body) body.max_output_tokens = tokenLimit;
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal,
    });

    const rawText = await res.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      throw new Error(t("error.llmInvalidJson", { status: res.status }));
    }

    if (!res.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        rawText ||
        `HTTP ${res.status}`;
      throw new Error(message);
    }
    return data;
  };

  const data = await requestOnce(max_tokens);
  const text = extractText(data);
  if (!text) {
    throw new Error(t("error.llmEmptyResponse"));
  }
  return text;
}

export async function callProviderImageGeneration({
  api,
  api_key,
  base_url,
  model,
  prompt,
  n = 1,
  width = 1024,
  height = 1024,
  response_format = "base64",
  subject_reference,
  timeoutMs = 120_000,
  signal,
}) {
  if (!model) throw new Error(t("error.missingModelId"));
  if (!base_url) throw new Error(t("error.missingBaseUrl"));
  if (!prompt || !String(prompt).trim()) throw new Error(t("error.imageGenPromptRequired"));

  const baseUrl = stripTrailingSlash(base_url);
  const headers = buildProviderAuthHeaders(api, api_key, {
    allowMissingApiKey: isLocalBaseUrl(baseUrl),
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const endpoint = `${baseUrl}/image_generation`;
  const body = {
    model,
    prompt: String(prompt).trim(),
    n,
    width,
    height,
    response_format,
    subject_reference: Array.isArray(subject_reference) && subject_reference.length > 0
      ? subject_reference
      : undefined,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: requestSignal,
  });

  const rawText = await res.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(t("error.llmInvalidJson", { status: res.status }));
  }

  if (!res.ok) {
    const message =
      data?.base_resp?.status_msg ||
      data?.error?.message ||
      data?.message ||
      rawText ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }

  const statusCode = Number(data?.base_resp?.status_code ?? 0);
  if (Number.isFinite(statusCode) && statusCode !== 0) {
    throw new Error(data?.base_resp?.status_msg || t("error.imageGenFailed"));
  }

  const list = Array.isArray(data?.data?.image_base64)
    ? data.data.image_base64
    : (typeof data?.data?.image_base64 === "string" ? [data.data.image_base64] : []);
  const imageBase64List = list
    .map(normalizeImageBase64)
    .filter(Boolean);
  if (!imageBase64List.length) {
    throw new Error(t("error.imageGenNoOutput"));
  }
  return imageBase64List;
}

function resolveModelscopeApiRoot(base_url = "") {
  const base = stripTrailingSlash(base_url);
  if (!base) return "";
  return /\/v1$/i.test(base) ? base.slice(0, -3) : base;
}

async function readJsonResponse(res) {
  const rawText = await res.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(t("error.llmInvalidJson", { status: res.status }));
  }
  if (!res.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      data?.error_msg ||
      rawText ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

export async function callModelscopeImageGeneration({
  api_key,
  base_url,
  model,
  prompt,
  n = 1,
  timeoutMs = 180_000,
  pollIntervalMs = 3_000,
  signal,
}) {
  if (!model) throw new Error(t("error.missingModelId"));
  if (!base_url) throw new Error(t("error.missingBaseUrl"));
  if (!prompt || !String(prompt).trim()) throw new Error(t("error.imageGenPromptRequired"));

  const apiRoot = resolveModelscopeApiRoot(base_url);
  if (!apiRoot) throw new Error(t("error.missingBaseUrl"));
  const headers = buildProviderAuthHeaders("openai-completions", api_key, {
    allowMissingApiKey: isLocalBaseUrl(apiRoot),
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const imageBase64List = [];
  const targetCount = Math.max(1, Math.min(4, Number(n) || 1));

  for (let idx = 0; idx < targetCount; idx += 1) {
    const taskRes = await fetch(`${apiRoot}/v1/images/generations`, {
      method: "POST",
      headers: {
        ...headers,
        "X-ModelScope-Async-Mode": "true",
      },
      body: JSON.stringify({
        model,
        prompt: String(prompt).trim(),
      }),
      signal: requestSignal,
    });
    const taskData = await readJsonResponse(taskRes);
    const taskId = String(taskData?.task_id || "").trim();
    if (!taskId) {
      throw new Error(taskData?.message || t("error.imageGenFailed"));
    }

    const pollStart = Date.now();
    while (true) {
      if (Date.now() - pollStart > timeoutMs) {
        throw new Error("ModelScope image generation timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const pollRes = await fetch(`${apiRoot}/v1/tasks/${taskId}`, {
        method: "GET",
        headers: {
          ...headers,
          "X-ModelScope-Task-Type": "image_generation",
        },
        signal: requestSignal,
      });
      const pollData = await readJsonResponse(pollRes);
      const status = String(pollData?.task_status || "").toUpperCase();
      if (status === "FAILED") {
        throw new Error(pollData?.message || pollData?.error_msg || t("error.imageGenFailed"));
      }
      if (status !== "SUCCEED") continue;

      const urls = Array.isArray(pollData?.output_images) ? pollData.output_images : [];
      if (!urls.length) throw new Error(t("error.imageGenNoOutput"));
      for (const u of urls) {
        if (imageBase64List.length >= targetCount) break;
        const imgRes = await fetch(String(u), { signal: requestSignal });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
        const cleaned = normalizeImageBase64(buf);
        if (cleaned) imageBase64List.push(cleaned);
      }
      break;
    }
  }

  if (!imageBase64List.length) throw new Error(t("error.imageGenNoOutput"));
  return imageBase64List;
}
