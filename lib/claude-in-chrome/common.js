import fs from "fs";
import os from "os";
import path from "path";

export const CLAUDE_IN_CHROME_MCP_SERVER_NAME = "claude-in-chrome";
export const DEFAULT_NATIVE_HOST_IDENTIFIER = "com.anthropic.claude_code_browser_extension";

const KNOWN_EXTENSION_IDS = [
  "ngcldcdhlkapibhbofllhlafkhmeehpb", // claude-core-mcp-chrome
  "fcoeoabgfenejglbffodgkkbkcdhcgfn", // official prod
  "dihbgbndebgnbjfmelmegjepbnkhlgni", // dev
  "dngcpimnedloihjnnfngkgjoidhnaolf", // ant
];

function uniq(list = []) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

export function parseExtraExtensionIds(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[a-p]{32}$/.test(item));
}

export function getAllowedExtensionOrigins(env = process.env) {
  const fromEnv = parseExtraExtensionIds(
    env?.HANAKO_CHROME_EXTENSION_IDS || env?.HANA_CHROME_EXTENSION_IDS,
  );
  const all = uniq([...KNOWN_EXTENSION_IDS, ...fromEnv]);
  return all.map((id) => `chrome-extension://${id}/`);
}

function safeUsername() {
  const user = String(os.userInfo?.().username || process.env.USER || "user")
    .trim()
    .toLowerCase();
  return user.replace(/[^a-z0-9_-]/g, "_") || "user";
}

export function getSocketName() {
  return `hanako-mcp-browser-bridge-${safeUsername()}`;
}

export function getSocketDir() {
  if (process.platform === "win32") return "";
  return path.join("/tmp", getSocketName());
}

export function getSecureSocketPath() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${getSocketName()}`;
  }
  return path.join(getSocketDir(), `${process.pid}.sock`);
}

export function getAllSocketPaths() {
  if (process.platform === "win32") {
    return [getSecureSocketPath()];
  }
  const out = [];
  const dir = getSocketDir();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".sock")) out.push(path.join(dir, file));
    }
  } catch {
    // ignore
  }

  // Backward compatible fallbacks.
  const legacyPrefix = `claude-mcp-browser-bridge-${safeUsername()}`;
  out.push(path.join(os.tmpdir(), legacyPrefix));
  out.push(path.join("/tmp", legacyPrefix));

  return uniq(out);
}

function home() {
  return os.homedir();
}

function browserDataPathCandidates() {
  const h = home();
  if (process.platform === "darwin") {
    return [
      path.join(h, "Library", "Application Support", "Google", "Chrome"),
      path.join(h, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
      path.join(h, "Library", "Application Support", "Arc", "User Data"),
      path.join(h, "Library", "Application Support", "Microsoft Edge"),
      path.join(h, "Library", "Application Support", "Chromium"),
      path.join(h, "Library", "Application Support", "Vivaldi"),
      path.join(h, "Library", "Application Support", "com.operasoftware.Opera"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(h, "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(h, "AppData", "Roaming");
    return [
      path.join(local, "Google", "Chrome", "User Data"),
      path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
      path.join(local, "Microsoft", "Edge", "User Data"),
      path.join(local, "Chromium", "User Data"),
      path.join(local, "Vivaldi", "User Data"),
      path.join(roaming, "Opera Software", "Opera Stable"),
      path.join(local, "Arc", "User Data"),
    ];
  }
  return [
    path.join(h, ".config", "google-chrome"),
    path.join(h, ".config", "BraveSoftware", "Brave-Browser"),
    path.join(h, ".config", "microsoft-edge"),
    path.join(h, ".config", "chromium"),
    path.join(h, ".config", "vivaldi"),
    path.join(h, ".config", "opera"),
  ];
}

function extensionProfileDirs(dataRoot) {
  // Chrome-style profiles.
  const roots = [
    "Default",
    "Profile 1",
    "Profile 2",
    "Profile 3",
  ].map((profile) => path.join(dataRoot, profile, "Extensions"));
  // Some builds place directly under Extensions.
  roots.push(path.join(dataRoot, "Extensions"));
  return roots;
}

export function detectInstalledExtensionIds(env = process.env) {
  const wantedIds = uniq([
    ...KNOWN_EXTENSION_IDS,
    ...parseExtraExtensionIds(env?.HANAKO_CHROME_EXTENSION_IDS || env?.HANA_CHROME_EXTENSION_IDS),
  ]);
  const found = new Set();

  for (const dataRoot of browserDataPathCandidates()) {
    for (const extensionsDir of extensionProfileDirs(dataRoot)) {
      for (const id of wantedIds) {
        const extPath = path.join(extensionsDir, id);
        if (fs.existsSync(extPath)) found.add(id);
      }
    }
  }

  return [...found];
}

export function isChromeExtensionInstalled(env = process.env) {
  const override = String(
    env?.HANAKO_CLAUDE_IN_CHROME_INSTALLED || env?.HANA_CLAUDE_IN_CHROME_INSTALLED || "",
  ).trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes" || override === "on") {
    return true;
  }
  if (override === "0" || override === "false" || override === "no" || override === "off") {
    return false;
  }
  return detectInstalledExtensionIds(env).length > 0;
}

export function getNativeMessagingManifestDirs() {
  const h = home();
  if (process.platform === "darwin") {
    return [
      path.join(h, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      path.join(h, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      path.join(h, "Library", "Application Support", "Arc", "User Data", "NativeMessagingHosts"),
      path.join(h, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
      path.join(h, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      path.join(h, "Library", "Application Support", "Vivaldi", "NativeMessagingHosts"),
      path.join(h, "Library", "Application Support", "com.operasoftware.Opera", "NativeMessagingHosts"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(h, "AppData", "Local");
    return [path.join(local, "Hanako", "ChromeNativeHost")];
  }
  return [
    path.join(h, ".config", "google-chrome", "NativeMessagingHosts"),
    path.join(h, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    path.join(h, ".config", "chromium", "NativeMessagingHosts"),
    path.join(h, ".config", "microsoft-edge", "NativeMessagingHosts"),
    path.join(h, ".config", "vivaldi", "NativeMessagingHosts"),
    path.join(h, ".config", "opera", "NativeMessagingHosts"),
  ];
}

export function getWindowsRegistryNativeHostKeys(hostIdentifier = DEFAULT_NATIVE_HOST_IDENTIFIER) {
  if (process.platform !== "win32") return [];
  return [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostIdentifier}`,
    `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${hostIdentifier}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostIdentifier}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${hostIdentifier}`,
    `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${hostIdentifier}`,
    `HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts\\${hostIdentifier}`,
  ];
}

export function getNativeHostIdentifier(env = process.env) {
  return String(
    env?.HANAKO_CHROME_NATIVE_HOST_IDENTIFIER
      || env?.HANA_CHROME_NATIVE_HOST_IDENTIFIER
      || DEFAULT_NATIVE_HOST_IDENTIFIER,
  ).trim() || DEFAULT_NATIVE_HOST_IDENTIFIER;
}

export function getNativeHostManifestName(env = process.env) {
  return `${getNativeHostIdentifier(env)}.json`;
}
