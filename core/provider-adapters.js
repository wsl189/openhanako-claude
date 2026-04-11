function stripTrailingSlash(url = "") {
  return String(url || "").replace(/\/+$/, "");
}

function normalizeOpenAIBaseUrl(url = "") {
  return stripTrailingSlash(String(url || "").replace(/\/chat\/completions$/i, ""));
}

function normalizeAnthropicBaseUrl(url = "") {
  return stripTrailingSlash(String(url || "").replace(/\/(v1\/)?messages$/i, ""));
}

function buildOpenAIMessageContent(text = "", images = []) {
  if (!Array.isArray(images) || images.length === 0) return text;
  const content = images.map((img) => ({
    type: "image_url",
    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
  }));
  if (text) content.push({ type: "text", text });
  return content;
}

function buildAnthropicMessageContent(text = "", images = []) {
  if (!Array.isArray(images) || images.length === 0) return text;
  const content = images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mimeType,
      data: img.data,
    },
  }));
  if (text) content.push({ type: "text", text });
  return content;
}

function anthropicContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function normalizeOpenAIHistoryContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block?.type === "image" && block?.source?.data && block?.source?.media_type) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
  return parts;
}

function normalizeAnthropicUserHistoryContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type === "image" && block?.source?.data && block?.source?.media_type) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.source.media_type,
          data: block.source.data,
        },
      });
    }
  }
  return blocks.length ? blocks : "";
}

function normalizeAnthropicAssistantHistoryContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    }
  }
  return blocks.length ? blocks : "";
}

function normalizeToolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAITools(tools = []) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toAnthropicTools(tools = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function appendOpenAIContinuationMessages(messages, continuationMessages = []) {
  for (const message of continuationMessages) {
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: (message.toolCalls || []).map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments || {}),
          },
        })),
      });
      continue;
    }
    if (message.role === "tool") {
      for (const result of message.results || []) {
        messages.push({
          role: "tool",
          content: result.content || "",
          tool_call_id: result.toolCallId,
        });
      }
    }
  }
}

function appendOpenAIHistoryMessages(messages, history = []) {
  for (const message of history) {
    if (message?.role === "user") {
      messages.push({
        role: "user",
        content: normalizeOpenAIHistoryContent(message.content),
      });
      continue;
    }
    if (message?.role === "assistant") {
      messages.push({
        role: "assistant",
        content: anthropicContentToText(message.content) || null,
      });
    }
  }
}

function appendAnthropicContinuationMessages(messages, continuationMessages = []) {
  for (const message of continuationMessages) {
    if (message.role === "assistant") {
      const content = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.toolCalls || []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments || {},
        });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: (message.results || []).map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content || "",
          is_error: result.isError === true,
        })),
      });
    }
  }
}

function appendAnthropicHistoryMessages(messages, history = []) {
  for (const message of history) {
    if (message?.role === "user") {
      messages.push({
        role: "user",
        content: normalizeAnthropicUserHistoryContent(message.content),
      });
      continue;
    }
    if (message?.role === "assistant") {
      messages.push({
        role: "assistant",
        content: normalizeAnthropicAssistantHistoryContent(message.content),
      });
    }
  }
}

export class OpenAIAdapter {
  constructor() {
    this.providerType = "openai";
  }

  buildStreamRequest(input) {
    const messages = [];
    if (input.systemMessage) {
      messages.push({ role: "system", content: input.systemMessage });
    }
    appendOpenAIHistoryMessages(messages, input.history || []);

    messages.push({
      role: "user",
      content: buildOpenAIMessageContent(input.userMessage || "", input.currentImages || []),
    });

    if (input.continuationMessages?.length) {
      appendOpenAIContinuationMessages(messages, input.continuationMessages);
    }

    const body = {
      model: input.modelId,
      messages,
      stream: true,
      ...(input.tools?.length ? { tools: toOpenAITools(input.tools) } : {}),
    };

    return {
      url: `${normalizeOpenAIBaseUrl(input.baseUrl)}/chat/completions`,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    };
  }

  parseSSELine(jsonLine) {
    try {
      const chunk = JSON.parse(jsonLine);
      const delta = chunk?.choices?.[0]?.delta;
      const events = [];

      if (typeof delta?.content === "string" && delta.content) {
        events.push({ type: "chunk", delta: delta.content });
      }
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        events.push({ type: "reasoning", delta: delta.reasoning_content });
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const hasIndex = Number.isInteger(toolCall?.index);
          const toolCallId = hasIndex ? `tc_${toolCall.index}` : (toolCall.id || "");
          if (toolCall?.function?.name) {
            events.push({
              type: "tool_call_start",
              toolCallId,
              toolName: toolCall.function.name,
            });
          }
          if (toolCall?.function?.arguments) {
            events.push({
              type: "tool_call_delta",
              toolCallId,
              argumentsDelta: toolCall.function.arguments,
            });
          }
        }
      }

      // 兼容旧式 OpenAI function_call 流式字段（部分 OpenAI-compatible provider 仍在使用）
      if (delta?.function_call) {
        const legacyToolCallId = "fc_0";
        if (typeof delta.function_call.name === "string" && delta.function_call.name) {
          events.push({
            type: "tool_call_start",
            toolCallId: legacyToolCallId,
            toolName: delta.function_call.name,
          });
        }
        if (typeof delta.function_call.arguments === "string" && delta.function_call.arguments) {
          events.push({
            type: "tool_call_delta",
            toolCallId: legacyToolCallId,
            argumentsDelta: delta.function_call.arguments,
          });
        }
      }

      const finishReason = chunk?.choices?.[0]?.finish_reason;
      if (finishReason === "tool_calls" || finishReason === "function_call" || finishReason === "tool_call") {
        events.push({ type: "done", stopReason: "tool_use" });
      }
      return events;
    } catch {
      return [];
    }
  }
}

export class AnthropicAdapter {
  constructor() {
    this.providerType = "anthropic";
  }

  buildStreamRequest(input) {
    const messages = [];
    appendAnthropicHistoryMessages(messages, input.history || []);

    messages.push({
      role: "user",
      content: buildAnthropicMessageContent(input.userMessage || "", input.currentImages || []),
    });

    if (input.continuationMessages?.length) {
      appendAnthropicContinuationMessages(messages, input.continuationMessages);
    }

    const body = {
      model: input.modelId,
      max_tokens: input.thinkingEnabled ? 32768 : 8192,
      messages,
      stream: true,
      ...(input.systemMessage ? { system: input.systemMessage } : {}),
      ...(input.tools?.length ? { tools: toAnthropicTools(input.tools) } : {}),
      ...(input.thinkingEnabled
        ? { thinking: { type: "enabled", budget_tokens: 16384 } }
        : {}),
    };

    const baseUrl = normalizeAnthropicBaseUrl(input.baseUrl);
    return {
      url: /\/anthropic$/i.test(baseUrl)
        ? `${baseUrl}/v1/messages`
        : `${baseUrl}/messages`,
      headers: {
        "x-api-key": input.apiKey,
        Authorization: `Bearer ${input.apiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    };
  }

  parseSSELine(jsonLine) {
    try {
      const event = JSON.parse(jsonLine);
      const events = [];

      if (event?.type === "content_block_start" && event?.content_block?.type === "tool_use") {
        events.push({
          type: "tool_call_start",
          toolCallId: event.content_block.id || "",
          toolName: event.content_block.name || "",
        });
      }

      if (event?.type === "content_block_delta") {
        if (event?.delta?.type === "thinking_delta" && event?.delta?.thinking) {
          events.push({ type: "reasoning", delta: event.delta.thinking });
        } else if (event?.delta?.type === "input_json_delta" && event?.delta?.partial_json) {
          events.push({
            type: "tool_call_delta",
            toolCallId: "",
            argumentsDelta: event.delta.partial_json,
          });
        } else if (typeof event?.delta?.text === "string" && event.delta.text) {
          events.push({ type: "chunk", delta: event.delta.text });
        }
      }

      if (event?.type === "message_delta" && event?.delta?.stop_reason) {
        events.push({ type: "done", stopReason: event.delta.stop_reason });
      }
      return events;
    } catch {
      return [];
    }
  }
}

export function createProviderAdapter(api) {
  if (api === "anthropic-messages") return new AnthropicAdapter();
  if (api === "openai-completions") return new OpenAIAdapter();
  throw new Error(`Unsupported provider runtime api: ${api}`);
}

export async function streamSSE({
  request,
  adapter,
  onEvent,
  signal,
  fetchFn = fetch,
} = {}) {
  const response = await fetchFn(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`${adapter.providerType} API error (${response.status}): ${text.slice(0, 500)}`);
    error.status = response.status;
    error.statusCode = response.status;
    error.response = { status: response.status };
    throw error;
  }
  if (!response.body) {
    throw new Error("response body is empty");
  }

  let content = "";
  let reasoning = "";
  let stopReason;
  const pendingToolCalls = new Map();
  let currentToolCallId;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        let data = "";
        if (line.startsWith("data: ")) data = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
        else continue;
        if (!data || data === "[DONE]") continue;

        const events = adapter.parseSSELine(data);
        for (const event of events) {
          if (event.type === "chunk") {
            content += event.delta || "";
          } else if (event.type === "reasoning") {
            reasoning += event.delta || "";
          } else if (event.type === "tool_call_start") {
            const toolCallId = event.toolCallId || currentToolCallId || `tc_auto_${pendingToolCalls.size}`;
            currentToolCallId = toolCallId;
            const pending = pendingToolCalls.get(toolCallId);
            if (pending) {
              if (event.toolName) pending.name = event.toolName;
            } else {
              pendingToolCalls.set(toolCallId, {
                id: toolCallId,
                name: event.toolName || "",
                args: "",
              });
            }
          } else if (event.type === "tool_call_delta") {
            let toolCallId = event.toolCallId || currentToolCallId;
            if (!toolCallId && pendingToolCalls.size === 1) {
              toolCallId = pendingToolCalls.keys().next().value;
            }
            if (!toolCallId) {
              toolCallId = `tc_auto_${pendingToolCalls.size}`;
            }
            currentToolCallId = toolCallId;
            let pending = pendingToolCalls.get(toolCallId);
            if (!pending) {
              pending = { id: toolCallId, name: "", args: "" };
              pendingToolCalls.set(toolCallId, pending);
            }
            pending.args += event.argumentsDelta || "";
          } else if (event.type === "done" && event.stopReason) {
            stopReason = event.stopReason;
          }
          onEvent?.(event);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [];
  for (const [, pending] of pendingToolCalls) {
    let args = {};
    try {
      args = pending.args ? JSON.parse(pending.args) : {};
    } catch {
      args = {};
    }
    toolCalls.push({
      id: pending.id,
      name: pending.name,
      arguments: args,
    });
  }
  if (toolCalls.length > 0 && !stopReason) {
    stopReason = "tool_use";
  }
  onEvent?.({ type: "done", stopReason });
  return { content, reasoning, toolCalls, stopReason };
}
