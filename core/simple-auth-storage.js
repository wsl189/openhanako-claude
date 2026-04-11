import fs from "fs";
import path from "path";
import { minimaxOAuthProvider } from "../lib/oauth/minimax-portal.js";

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) || {};
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function extractApiKey(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry.apiKey === "string") return entry.apiKey;
  if (typeof entry.access === "string") return entry.access;
  if (typeof entry.token === "string") return entry.token;
  return "";
}

function dedupeById(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

export class SimpleAuthStorage {
  constructor({ authJsonPath, providerRegistry }) {
    this._authJsonPath = authJsonPath;
    this._registry = providerRegistry;
    this._providers = new Map([
      ["minimax", minimaxOAuthProvider],
    ]);
  }

  _read() {
    return readJson(this._authJsonPath);
  }

  _write(data) {
    writeJson(this._authJsonPath, data);
  }

  _resolveAuthKey(provider) {
    return this._registry?.getAuthJsonKey?.(provider) || provider;
  }

  get(provider) {
    const auth = this._read();
    const key = this._resolveAuthKey(provider);
    return auth[key] || auth[provider] || null;
  }

  async getApiKey(provider) {
    const entry = this.get(provider);
    if (!entry) return "";

    const key = this._resolveAuthKey(provider);
    if (
      key === "minimax"
      && entry?.type === "oauth"
      && entry?.refresh
      && Number(entry?.expires || 0) > 0
      && Number(entry.expires) <= Date.now() + 60_000
    ) {
      try {
        const refreshed = await minimaxOAuthProvider.refreshToken(entry);
        const auth = this._read();
        auth[key] = {
          ...entry,
          ...refreshed,
          type: "oauth",
        };
        this._write(auth);
        return extractApiKey(auth[key]);
      } catch {
        return extractApiKey(entry);
      }
    }

    return extractApiKey(entry);
  }

  getOAuthProviders() {
    const providers = [];
    for (const entry of this._registry?.getAll?.().values?.() || []) {
      if (entry?.authType !== "oauth") continue;
      const authKey = this._registry.getAuthJsonKey(entry.id);
      providers.push({
        id: authKey,
        name: entry.displayName || authKey,
        usesCallbackServer: authKey === "openai-codex",
      });
    }
    return dedupeById(providers);
  }

  async login(provider, callbacks = {}) {
    const authKey = this._resolveAuthKey(provider);
    const handler = this._providers.get(authKey);
    if (!handler?.login) {
      throw new Error(`OAuth login is not supported for provider "${provider}" yet`);
    }

    const credentials = await handler.login(callbacks);
    const auth = this._read();
    auth[authKey] = {
      ...credentials,
      type: "oauth",
    };
    this._write(auth);
    return auth[authKey];
  }

  logout(provider) {
    const authKey = this._resolveAuthKey(provider);
    const auth = this._read();
    delete auth[authKey];
    this._write(auth);
  }
}
