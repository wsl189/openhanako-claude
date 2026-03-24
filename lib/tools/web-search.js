/**
 * web-search.js — web_search 自定义工具
 *
 * 对外暴露一个统一的 web_search tool，只使用显式配置的 provider。
 *
 * 统一返回格式：[{ title, url, snippet }]
 */

import { Type } from "@sinclair/typebox";
import { loadConfig } from "../memory/config-loader.js";
import { t } from "../../server/i18n.js";

let _configPath = null;

export function initWebSearch(configPath) {
  _configPath = configPath;
}

// ════════════════════════════════════════
// Provider: Tavily
// ════════════════════════════════════════

async function searchTavily(query, maxResults, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
  });

  if (!res.ok) throw new Error(`Tavily API ${res.status}`);
  const data = await res.json();

  return (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
}

// ════════════════════════════════════════
// Provider: Serper (Google)
// ════════════════════════════════════════

async function searchSerper(query, maxResults, apiKey) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  if (!res.ok) throw new Error(`Serper API ${res.status}`);
  const data = await res.json();

  return (data.organic || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
  }));
}

// ════════════════════════════════════════
// Provider: Brave Search
// ════════════════════════════════════════

async function searchBrave(query, maxResults, apiKey) {
  const params = new URLSearchParams({ q: query, count: maxResults });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) throw new Error(`Brave API ${res.status}`);
  const data = await res.json();

  return (data.web?.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
}

const PROVIDERS = {
  tavily: searchTavily,
  serper: searchSerper,
  brave: searchBrave,
};

async function doSearch(query, maxResults) {
  const cfg = loadConfig(_configPath);
  const searchCfg = cfg.search || {};
  const provider = searchCfg.provider || "";
  const apiKey = searchCfg.api_key || "";

  if (!provider) {
    throw new Error(t("error.searchProviderNotConfigured"));
  }
  if (!apiKey) {
    throw new Error(t("error.searchProviderMissingKey", { provider }));
  }
  if (!PROVIDERS[provider]) {
    throw new Error(t("error.searchProviderUnknown", { provider }));
  }

  try {
    return {
      results: await PROVIDERS[provider](query, maxResults, apiKey),
      provider,
    };
  } catch (err) {
    throw new Error(t("error.searchFailed", { msg: err.message }));
  }
}

// ════════════════════════════════════════
// Tool 定义
// ════════════════════════════════════════

export function createWebSearchTool() {
  return {
    name: "web_search",
    label: t("toolDef.webSearch.label"),
    description: t("toolDef.webSearch.description"),
    parameters: Type.Object({
      query: Type.String({ description: t("toolDef.webSearch.queryDesc") }),
      maxResults: Type.Optional(
        Type.Number({ description: t("toolDef.webSearch.maxResultsDesc"), default: 5 })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: t("error.searchEmptyQuery") }],
          details: {},
        };
      }

      try {
        const { results, provider } = await doSearch(query, params.maxResults ?? 5);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.searchNoResults", { provider }) }],
            details: {},
          };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: t("error.searchResults", { provider, results: formatted }) }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.searchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
