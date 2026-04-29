import {
  bindSessionContext,
  buildComputerUseTools,
  DEFAULT_GRANT_FLAGS,
} from "./vendor/index.js";
import {
  COMPUTER_USE_MCP_SERVER_NAME,
  COMPUTER_USE_SWITCH,
} from "./common.js";
import { getChicagoCoordinateMode } from "./gates.js";
import { getComputerUseHostAdapter } from "./host-adapter.js";

const LOCK_IDLE_MS = Number.parseInt(process.env.HANAKO_COMPUTER_USE_LOCK_IDLE_MS || "", 10) || 120000;

const sessionStates = new Map();
const sessionBindings = new Map();

const lockState = {
  holder: undefined,
  updatedAt: 0,
};

function now() {
  return Date.now();
}

function touchLockIfHeld(sessionKey) {
  if (lockState.holder === sessionKey) {
    lockState.updatedAt = now();
  }
}

function cleanupStaleLock() {
  if (!lockState.holder) return;
  if (now() - lockState.updatedAt > LOCK_IDLE_MS) {
    lockState.holder = undefined;
    lockState.updatedAt = 0;
  }
}

function resolveSessionKey(ctx = {}) {
  const sm = ctx?.sessionManager;
  const sessionFile = String(sm?.getSessionFile?.() || "").trim();
  if (sessionFile) return sessionFile;
  const sessionId = String(sm?.getSessionId?.() || "").trim();
  if (sessionId) return `session:${sessionId}`;
  return "session:default";
}

function getOrCreateSessionState(sessionKey) {
  const existing = sessionStates.get(sessionKey);
  if (existing) return existing;

  const created = {
    allowedApps: [],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    selectedDisplayId: undefined,
    displayPinnedByModel: false,
    displayResolvedForApps: undefined,
    lastScreenshotDims: undefined,
    clipboardStash: undefined,
    teachModeActive: false,
    currentSignal: undefined,
  };
  sessionStates.set(sessionKey, created);
  return created;
}

function autoApprovePermission(request, state) {
  const requestedFlags = request?.requestedFlags || {};
  const mergedFlags = {
    ...DEFAULT_GRANT_FLAGS,
    ...state.grantFlags,
    clipboardRead: state.grantFlags.clipboardRead || requestedFlags.clipboardRead === true,
    clipboardWrite: state.grantFlags.clipboardWrite || requestedFlags.clipboardWrite === true,
    systemKeyCombos: state.grantFlags.systemKeyCombos || requestedFlags.systemKeyCombos === true,
  };

  const apps = Array.isArray(request?.apps) ? request.apps : [];
  const granted = [];
  const denied = [];

  for (const item of apps) {
    if (!item?.resolved?.bundleId) {
      denied.push({
        bundleId: String(item?.requestedName || "unknown"),
        reason: "not_installed",
      });
      continue;
    }
    if (item.alreadyGranted) continue;
    granted.push({
      bundleId: item.resolved.bundleId,
      displayName: item.resolved.displayName,
      grantedAt: now(),
      tier: item.proposedTier,
    });
  }

  return {
    granted,
    denied,
    flags: mergedFlags,
    userConsented: true,
  };
}

function createSessionBinding(sessionKey) {
  const state = getOrCreateSessionState(sessionKey);
  const adapter = getComputerUseHostAdapter();

  const ctx = {
    getAllowedApps: () => state.allowedApps,
    getGrantFlags: () => state.grantFlags,
    getUserDeniedBundleIds: () => state.userDeniedBundleIds,
    getSelectedDisplayId: () => state.selectedDisplayId,
    getDisplayPinnedByModel: () => state.displayPinnedByModel,
    getDisplayResolvedForApps: () => state.displayResolvedForApps,
    getLastScreenshotDims: () => state.lastScreenshotDims,

    onPermissionRequest: async (request) => autoApprovePermission(request, state),
    onAllowedAppsChanged: (apps, flags) => {
      state.allowedApps = [...(apps || [])];
      state.grantFlags = {
        ...DEFAULT_GRANT_FLAGS,
        ...flags,
      };
    },
    getClipboardStash: () => state.clipboardStash,
    onClipboardStashChanged: (stash) => {
      state.clipboardStash = stash;
    },
    onResolvedDisplayUpdated: (displayId) => {
      state.selectedDisplayId = displayId;
      state.displayPinnedByModel = false;
      state.displayResolvedForApps = undefined;
    },
    onDisplayPinned: (displayId) => {
      state.selectedDisplayId = displayId;
      state.displayPinnedByModel = displayId !== undefined;
      if (displayId === undefined) {
        state.displayResolvedForApps = undefined;
      }
    },
    onDisplayResolvedForApps: (key) => {
      state.displayResolvedForApps = key;
    },
    onScreenshotCaptured: (dims) => {
      state.lastScreenshotDims = dims;
    },

    checkCuLock: async () => {
      cleanupStaleLock();
      return {
        holder: lockState.holder,
        isSelf: lockState.holder === sessionKey,
      };
    },
    acquireCuLock: async () => {
      cleanupStaleLock();
      if (lockState.holder && lockState.holder !== sessionKey) {
        throw new Error(
          `Computer use is currently held by another session (${lockState.holder}). Wait for it to become idle.`,
        );
      }
      lockState.holder = sessionKey;
      lockState.updatedAt = now();
    },
    formatLockHeldMessage: (holder) => (
      `Computer use is currently held by another session (${holder}). Wait for it to become idle.`
    ),

    isAborted: () => state.currentSignal?.aborted === true,
  };

  const dispatch = bindSessionContext(
    adapter,
    getChicagoCoordinateMode(),
    ctx,
  );

  return { dispatch, state };
}

function getBinding(sessionKey) {
  let binding = sessionBindings.get(sessionKey);
  if (!binding) {
    binding = createSessionBinding(sessionKey);
    sessionBindings.set(sessionKey, binding);
  }
  return binding;
}

export async function runComputerUseTool(toolName, args = {}, signal, ctx = {}) {
  const sessionKey = resolveSessionKey(ctx);
  const binding = getBinding(sessionKey);
  binding.state.currentSignal = signal;
  touchLockIfHeld(sessionKey);

  try {
    const result = await binding.dispatch(toolName, args);
    touchLockIfHeld(sessionKey);
    const textError = result?.isError
      ? String(result?.content?.find?.((item) => item?.type === "text")?.text || "Computer use action failed")
      : "";
    const details = {
      ...(result?.telemetry ? { telemetry: result.telemetry } : {}),
      ...(textError ? { error: textError } : {}),
    };
    return {
      content: Array.isArray(result?.content) ? result.content : [{ type: "text", text: "" }],
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  } finally {
    if (binding.state.currentSignal === signal) {
      binding.state.currentSignal = undefined;
    }
    touchLockIfHeld(sessionKey);
  }
}

let cachedTools;

export function createComputerUseCustomTools() {
  if (cachedTools) return cachedTools;

  const adapter = getComputerUseHostAdapter();
  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    getChicagoCoordinateMode(),
  );

  cachedTools = tools.map((toolDef) => ({
    name: toolDef.name,
    label: `[Computer Use] ${toolDef.name}`,
    description: toolDef.description,
    parameters: toolDef.inputSchema || { type: "object", properties: {} },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      return runComputerUseTool(toolDef.name, params, signal, ctx);
    },
  }));

  return cachedTools;
}

export function createComputerUseSwitchTool() {
  return {
    name: COMPUTER_USE_SWITCH,
    label: "Computer Use",
    description: "Enable full desktop control tools via MCP (screenshot, mouse, keyboard, app control, clipboard, batching).",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => ({
      content: [{
        type: "text",
        text: "Computer Use is provided via MCP tools (mcp__computer_use__*).",
      }],
      details: {
        mode: "mcp_server",
        server: COMPUTER_USE_MCP_SERVER_NAME,
      },
    }),
  };
}
