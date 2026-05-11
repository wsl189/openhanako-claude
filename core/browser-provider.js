const PROVIDER_ALIAS = {
  "": "embedded",
  auto: "embedded",
  embedded: "embedded",
  builtin: "embedded",
  browser: "embedded",
  "claude-in-chrome": "embedded",
  claude_in_chrome: "embedded",
  claudeinchrome: "embedded",
  chrome_plugin: "embedded",
  "chrome-plugin": "embedded",
};

export function normalizeBrowserProvider(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  return PROVIDER_ALIAS[normalized] || "embedded";
}

export function resolveBrowserProvider(env = process.env) {
  const requestedProvider = normalizeBrowserProvider(
    env?.HANAKO_BROWSER_PROVIDER || env?.HANA_BROWSER_PROVIDER,
  );
  return {
    requestedProvider,
    activeProvider: "embedded",
    useClaudeInChrome: false,
    useEmbeddedBrowser: true,
    claudeInChromeDetected: false,
    claudeInChromeSource: "",
    claudeInChromeEntryPath: "",
    claudeInChromeCommandEnv: null,
    claudeInChromeServer: null,
    fallbackClaudeInChromeServer: null,
    chromeExtensionInstalled: false,
  };
}

export function resolveClaudeInChromeExternalServer() {
  return null;
}
