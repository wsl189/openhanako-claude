import { buildProviderAuthHeaders } from "../../lib/llm/provider-client.js";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 45_000;
const TEST_AUDIO_DURATION_SEC = 0.45;
const TEST_AUDIO_SAMPLE_RATE = 16_000;

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(url || ""));
}

function isOpenAICompatibleApi(api) {
  return api === "openai-completions"
    || api === "openai-responses"
    || api === "openai-codex-responses";
}

function normalizeLanguage(language) {
  const raw = String(language || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.split(/[-_]/)[0] || raw;
}

function listProviderCandidates(engine, preferredProvider) {
  const order = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };

  push(preferredProvider);
  push(engine.currentModel?.provider);
  try {
    const utility = engine.resolveUtilityConfig?.()?.utility;
    push(utility?.provider);
  } catch {
    // ignore utility resolve errors
  }
  try {
    const all = engine.providerRegistry?.getAll?.();
    if (all?.values) {
      for (const entry of all.values()) {
        push(entry?.id);
      }
    }
  } catch {
    // ignore provider registry read errors
  }
  return order;
}

function resolveTranscribeTarget(engine, preferredProvider) {
  for (const provider of listProviderCandidates(engine, preferredProvider)) {
    const creds = engine.resolveProviderCredentials(provider);
    if (!creds?.base_url || !creds?.api) continue;
    if (!isOpenAICompatibleApi(creds.api)) continue;
    if (!creds.api_key && !isLocalBaseUrl(creds.base_url)) continue;
    return {
      provider,
      api: creds.api,
      api_key: creds.api_key || "",
      base_url: creds.base_url,
    };
  }
  return null;
}

function resolveSharedTranscribeTarget(engine, sharedModels = {}, providerHint) {
  const sharedModelRef = String(sharedModels?.voice_transcribe || "").trim();
  if (!sharedModelRef) return null;

  let resolved = null;
  try {
    resolved = engine.resolveModelWithCredentials(sharedModelRef);
  } catch {
    return null;
  }
  if (!resolved?.provider || !resolved?.api || !resolved?.base_url) return null;
  if (providerHint && resolved.provider !== providerHint) return null;
  if (!isOpenAICompatibleApi(resolved.api)) return null;
  if (!resolved.api_key && !isLocalBaseUrl(resolved.base_url)) return null;

  return {
    provider: resolved.provider,
    api: resolved.api,
    api_key: resolved.api_key || "",
    base_url: resolved.base_url,
    shared_voice_model: String(resolved.model || resolved.id || "").trim(),
  };
}

function parseErrorMessage(data, fallback) {
  return String(
    data?.error?.message
      || data?.error
      || data?.message
      || fallback,
  ).trim();
}

function buildTranscriptionEndpointCandidates(baseUrl) {
  const trimmed = stripTrailingSlash(baseUrl);
  if (!trimmed) return [];

  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const endpoint = stripTrailingSlash(value);
    if (!endpoint || seen.has(endpoint)) return;
    seen.add(endpoint);
    candidates.push(endpoint);
  };

  push(`${trimmed}/audio/transcriptions`);

  try {
    const parsed = new URL(trimmed);
    const pathname = String(parsed.pathname || "").replace(/\/+$/, "");
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (pathname.endsWith("/v1")) {
      push(`${origin}/audio/transcriptions`);
    } else {
      push(`${trimmed}/v1/audio/transcriptions`);
    }
  } catch {
    // ignore invalid url parsing
  }

  return candidates;
}

function createSilentWavBuffer({
  sampleRate = TEST_AUDIO_SAMPLE_RATE,
  durationSec = TEST_AUDIO_DURATION_SEC,
  channels = 1,
  bitsPerSample = 16,
} = {}) {
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSec));
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = sampleCount * blockAlign;
  const totalSize = 44 + dataSize;
  const buffer = Buffer.alloc(totalSize, 0);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function transcribeViaProvider({
  target,
  audioBuffer,
  mimeType,
  language,
  modelHints = [],
}) {
  const modelCandidates = [...new Set(modelHints.filter(Boolean).map((m) => String(m).trim()).filter(Boolean))];
  const endpointCandidates = buildTranscriptionEndpointCandidates(target.base_url);
  if (!endpointCandidates.length) {
    throw new Error("Voice transcription endpoint is empty");
  }

  const authHeaders = buildProviderAuthHeaders(target.api, target.api_key, {
    allowMissingApiKey: isLocalBaseUrl(target.base_url),
  });
  delete authHeaders["Content-Type"];
  delete authHeaders["content-type"];

  let lastError = "Voice transcription failed";
  let lastStatus = 0;
  let lastEndpoint = "";

  for (const endpoint of endpointCandidates) {
    for (const model of modelCandidates) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([audioBuffer], { type: mimeType || "audio/webm" }),
        "voice-input.webm",
      );
      form.append("model", model);
      if (language) form.append("language", language);
      form.append("response_format", "json");

      const res = await fetch(endpoint, {
        method: "POST",
        headers: authHeaders,
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });

      const rawText = await res.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = { message: rawText || "" };
      }

      if (!res.ok) {
        const message = parseErrorMessage(
          data,
          `Transcription API error (${res.status})`,
        );
        lastError = message;
        lastStatus = Number(res.status || 0);
        lastEndpoint = endpoint;
        // 模型不支持或端点找不到时，尝试下一个候选。
        if (res.status === 400 || res.status === 404) continue;
        throw new Error(message);
      }

      const text = String(data?.text || data?.transcript || "").trim();
      return {
        text,
        provider: target.provider,
        model,
        endpoint,
      };
    }
  }

  const notFoundSuffix = lastStatus === 404 && lastEndpoint
    ? ` (endpoint: ${lastEndpoint})`
    : "";
  throw new Error(`${lastError}${notFoundSuffix}`);
}

export default async function voiceRoute(app, { engine }) {
  app.post("/api/voice/transcribe", { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    try {
      const body = req.body || {};
      const audioBase64 = String(body.audioBase64 || "").trim();
      const mimeType = String(body.mimeType || "audio/webm").trim() || "audio/webm";
      const providerHint = String(body.provider || "").trim();
      const language = normalizeLanguage(body.language);

      if (!audioBase64) {
        return reply.code(400).send({ error: "audioBase64 is required" });
      }

      let audioBuffer;
      try {
        audioBuffer = Buffer.from(audioBase64, "base64");
      } catch {
        return reply.code(400).send({ error: "invalid audio base64 payload" });
      }
      if (!audioBuffer?.length) {
        return reply.code(400).send({ error: "empty audio payload" });
      }
      if (audioBuffer.length > MAX_AUDIO_BYTES) {
        return reply.code(413).send({ error: "audio payload too large" });
      }

      const sharedModels = engine.getSharedModels?.() || {};
      const sharedTarget = resolveSharedTranscribeTarget(
        engine,
        sharedModels,
        providerHint,
      );
      const target = sharedTarget || resolveTranscribeTarget(
        engine,
        providerHint || sharedTarget?.provider,
      );
      if (!target) {
        return reply.code(400).send({
          error: "No OpenAI-compatible provider credentials found for voice transcription.",
        });
      }

      const sharedModelHint = sharedTarget && sharedTarget.provider === target.provider
        ? String(sharedTarget.shared_voice_model || "").trim()
        : "";
      const modelHints = [
        String(body.model || "").trim(),
        sharedModelHint,
        String(process.env.HANA_VOICE_TRANSCRIBE_MODEL || "").trim(),
        "gpt-4o-mini-transcribe",
        "whisper-1",
      ].filter(Boolean);
      const result = await transcribeViaProvider({
        target,
        audioBuffer,
        mimeType,
        language,
        modelHints,
      });

      if (!result.text) {
        return reply.code(200).send({ text: "" });
      }

      return reply.send({
        text: result.text,
        provider: result.provider,
        model: result.model,
      });
    } catch (err) {
      const message = String(err?.message || err || "Voice transcription failed");
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/voice/test", async (req, reply) => {
    try {
      const body = req.body || {};
      const providerHint = String(body.provider || "").trim();
      const sharedModels = engine.getSharedModels?.() || {};
      const sharedTarget = resolveSharedTranscribeTarget(
        engine,
        sharedModels,
        providerHint,
      );
      const target = sharedTarget || resolveTranscribeTarget(
        engine,
        providerHint || sharedTarget?.provider,
      );
      if (!target) {
        return reply.send({
          ok: false,
          error: "No OpenAI-compatible provider credentials found for voice transcription.",
        });
      }

      const sharedModelHint = sharedTarget && sharedTarget.provider === target.provider
        ? String(sharedTarget.shared_voice_model || "").trim()
        : "";
      const requestedModel = String(body.model || "").trim();
      const modelHints = [
        requestedModel,
        sharedModelHint,
        String(process.env.HANA_VOICE_TRANSCRIBE_MODEL || "").trim(),
        "gpt-4o-mini-transcribe",
        "whisper-1",
      ];

      const result = await transcribeViaProvider({
        target,
        audioBuffer: createSilentWavBuffer(),
        mimeType: "audio/wav",
        language: normalizeLanguage(body.language || "en"),
        modelHints,
      });

      return reply.send({
        ok: true,
        provider: result.provider,
        model: result.model,
        endpoint: result.endpoint,
        text: result.text || "",
      });
    } catch (err) {
      return reply.send({
        ok: false,
        error: String(err?.message || err || "Voice transcription test failed"),
      });
    }
  });
}
