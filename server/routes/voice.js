import { buildProviderAuthHeaders } from "../../lib/llm/provider-client.js";
import { normalizeModelRef } from "../../core/model-ref.js";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const TRANSCRIBE_ATTEMPT_TIMEOUT_MS = 12_000;
const TRANSCRIBE_TOTAL_TIMEOUT_MS = 55_000;
const TEST_AUDIO_DURATION_SEC = 0.45;
const TEST_AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_MIME_BY_EXT = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  opus: "audio/opus",
  amr: "audio/amr",
  silk: "audio/silk",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
  weba: "audio/webm",
};
const AUDIO_EXT_BY_MIME = {
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/opus": "opus",
  "audio/amr": "amr",
  "audio/3gpp": "amr",
  "audio/silk": "silk",
  "audio/flac": "flac",
  "audio/webm": "webm",
};

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
  const sharedModelRef = normalizeModelRef(sharedModels?.voice_transcribe);
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

function normalizeAudioExt(pathLike = "") {
  const raw = String(pathLike || "").trim();
  if (!raw) return "";
  const clean = raw.split(/[?#]/)[0];
  const name = clean.split("/").pop() || clean;
  const m = /\.([a-zA-Z0-9]{1,12})$/.exec(name);
  return m?.[1]?.toLowerCase() || "";
}

function inferAudioMimeFromPath(pathLike = "") {
  const ext = normalizeAudioExt(pathLike);
  return AUDIO_MIME_BY_EXT[ext] || "";
}

function inferAudioExtFromMime(mimeType = "") {
  const lower = String(mimeType || "").trim().toLowerCase().split(";")[0];
  return AUDIO_EXT_BY_MIME[lower] || "";
}

function normalizeAudioMime(mimeType = "", pathLike = "") {
  const raw = String(mimeType || "").trim().toLowerCase();
  if (!raw || raw === "voice" || raw === "audio" || raw === "application/octet-stream") {
    return inferAudioMimeFromPath(pathLike);
  }
  if (raw.startsWith("audio/")) {
    return raw.split(";")[0];
  }
  if (raw === "amr") return "audio/amr";
  if (raw === "silk") return "audio/silk";
  if (raw === "wav") return "audio/wav";
  if (raw === "mp3") return "audio/mpeg";
  if (raw === "ogg") return "audio/ogg";
  if (raw === "m4a") return "audio/mp4";
  if (raw === "weba" || raw === "webm") return "audio/webm";
  return inferAudioMimeFromPath(pathLike);
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

  try {
    const parsed = new URL(trimmed);
    const pathname = String(parsed.pathname || "").replace(/\/+$/, "");
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (pathname.endsWith("/v1")) {
      push(`${trimmed}/audio/transcriptions`);
      push(`${origin}/v1/audio/transcriptions`);
      push(`${origin}/audio/transcriptions`);
    } else {
      push(`${trimmed}/v1/audio/transcriptions`);
      push(`${trimmed}/audio/transcriptions`);
    }
  } catch {
    push(`${trimmed}/v1/audio/transcriptions`);
    push(`${trimmed}/audio/transcriptions`);
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
  fileName = "",
  modelHints = [],
}) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + TRANSCRIBE_TOTAL_TIMEOUT_MS;
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
  let preferredError = null;
  const uploadMimeType = normalizeAudioMime(mimeType, fileName) || "audio/webm";
  const uploadExt = normalizeAudioExt(fileName) || inferAudioExtFromMime(uploadMimeType) || "webm";
  const uploadName = `voice-input.${uploadExt}`;

  for (const endpoint of endpointCandidates) {
    for (const model of modelCandidates) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 500) {
        const timeoutMsg = `Voice transcription timed out after ${Math.round((Date.now() - startedAt) / 1000)}s`;
        const endpointSuffix = lastEndpoint ? ` (endpoint: ${lastEndpoint})` : "";
        throw new Error(`${timeoutMsg}${endpointSuffix}`);
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([audioBuffer], { type: uploadMimeType }),
        uploadName,
      );
      form.append("model", model);
      if (language) form.append("language", language);
      form.append("response_format", "json");

      let res;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: authHeaders,
          body: form,
          signal: AbortSignal.timeout(Math.min(TRANSCRIBE_ATTEMPT_TIMEOUT_MS, remainingMs)),
        });
      } catch (err) {
        const networkMessage = String(err?.message || err || "Network error while calling transcription API");
        lastError = networkMessage;
        lastEndpoint = endpoint;
        continue;
      }

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
        if (res.status !== 404 && !preferredError) {
          preferredError = { message, endpoint, status: Number(res.status || 0) };
        }
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

  const finalMessage = preferredError?.message || lastError;
  const finalEndpoint = preferredError?.endpoint || lastEndpoint;
  const endpointSuffix = finalEndpoint ? ` (endpoint: ${finalEndpoint})` : "";
  throw new Error(`${finalMessage}${endpointSuffix}`);
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
        normalizeModelRef(body.model),
        sharedModelHint,
        normalizeModelRef(process.env.HANA_VOICE_TRANSCRIBE_MODEL || ""),
        target.provider === "siliconflow" ? "TeleAI/TeleSpeechASR" : "",
        target.provider === "siliconflow" ? "FunAudioLLM/SenseVoiceSmall" : "",
        "gpt-4o-mini-transcribe",
        "whisper-1",
      ].filter(Boolean);
      const result = await transcribeViaProvider({
        target,
        audioBuffer,
        mimeType,
        language,
        fileName: String(body.fileName || ""),
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
      const requestedModel = normalizeModelRef(body.model);
      const modelHints = [
        requestedModel,
        sharedModelHint,
        normalizeModelRef(process.env.HANA_VOICE_TRANSCRIBE_MODEL || ""),
        target.provider === "siliconflow" ? "TeleAI/TeleSpeechASR" : "",
        target.provider === "siliconflow" ? "FunAudioLLM/SenseVoiceSmall" : "",
        "gpt-4o-mini-transcribe",
        "whisper-1",
      ];

      const result = await transcribeViaProvider({
        target,
        audioBuffer: createSilentWavBuffer(),
        mimeType: "audio/wav",
        fileName: "voice-test.wav",
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
