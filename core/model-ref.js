/**
 * Normalize legacy/structured model references into a stable string ref.
 *
 * Supported inputs:
 * - "provider/model"
 * - "model-id"
 * - { id, provider }
 * - { modelId, providerId }
 * - { model, vendor }
 */
export function normalizeModelRef(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";

  const rawId = value.id ?? value.modelId ?? value.model ?? value.name ?? "";
  const rawProvider = value.provider ?? value.providerId ?? value.vendor ?? "";
  const id = String(rawId || "").trim();
  const provider = String(rawProvider || "").trim();
  if (!id) return "";

  if (provider && !id.includes("/")) return `${provider}/${id}`;
  return id;
}

export function splitModelRef(ref, knownProviders = null) {
  const normalized = normalizeModelRef(ref);
  if (!normalized) return { normalized: "", provider: "", modelId: "" };
  if (!normalized.includes("/")) {
    return { normalized, provider: "", modelId: normalized };
  }

  const idx = normalized.indexOf("/");
  const maybeProvider = normalized.slice(0, idx);
  const rest = normalized.slice(idx + 1);
  if (!maybeProvider || !rest) {
    return { normalized, provider: "", modelId: normalized };
  }
  if (knownProviders && !knownProviders.has(maybeProvider)) {
    return { normalized, provider: "", modelId: normalized };
  }
  return { normalized, provider: maybeProvider, modelId: rest };
}

