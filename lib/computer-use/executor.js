import {
  API_RESIZE_PARAMS,
  targetImageSize,
} from "./vendor/index.js";
import {
  CLI_HOST_BUNDLE_ID,
  getCliComputerUseCapabilities,
  isComputerUseSupportedPlatform,
} from "./common.js";
import { callPythonHelper } from "./python-bridge.js";

const SCREENSHOT_JPEG_QUALITY = 0.75;
const MOVE_SETTLE_MS = 50;
const hostBundleId =
  process.env.HANAKO_COMPUTER_USE_HOST_BUNDLE_ID || CLI_HOST_BUNDLE_ID;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeTargetDims(logicalW, logicalH, scaleFactor) {
  const physW = Math.round(logicalW * scaleFactor);
  const physH = Math.round(logicalH * scaleFactor);
  return targetImageSize(physW, physH, API_RESIZE_PARAMS);
}

function normalizeDisplayGeometry(display) {
  return {
    ...display,
    displayId: display.displayId ?? display.id,
    label: display.label ?? display.name,
  };
}

async function readClipboardViaPbpaste() {
  return callPythonHelper("read_clipboard", {});
}

async function writeClipboardViaPbcopy(text) {
  await callPythonHelper("write_clipboard", { text });
}

async function readClipboard() {
  if (process.platform === "win32") {
    return callPythonHelper("read_clipboard", {});
  }
  return readClipboardViaPbpaste();
}

async function writeClipboard(text) {
  if (process.platform === "win32") {
    await callPythonHelper("write_clipboard", { text });
    return;
  }
  await writeClipboardViaPbcopy(text);
}

async function typeViaClipboard(text) {
  let saved;
  try {
    saved = await readClipboard();
  } catch {
    saved = undefined;
  }

  try {
    await writeClipboard(text);
    if (process.platform === "darwin") {
      await sleep(40);
      await callPythonHelper("paste_clipboard", {});
      await sleep(180);
    } else {
      await callPythonHelper("key", {
        keySequence: "ctrl+v",
        repeat: 1,
      });
      await sleep(100);
    }
  } finally {
    if (typeof saved === "string") {
      try {
        await writeClipboard(saved);
      } catch {
        // ignore restore failures
      }
    }
  }
}

export function createCliExecutor() {
  if (!isComputerUseSupportedPlatform()) {
    throw new Error(
      `createCliExecutor called on ${process.platform}. Computer control is only supported on macOS and Windows.`,
    );
  }

  return {
    capabilities: {
      ...getCliComputerUseCapabilities(),
      hostBundleId,
    },

    async prepareForAction(_allowlistBundleIds, _displayId) {
      return callPythonHelper("prepare_for_action", {});
    },

    async previewHideSet(_allowlistBundleIds, _displayId) {
      return callPythonHelper("preview_hide_set", {});
    },

    async getDisplaySize(displayId) {
      return normalizeDisplayGeometry(
        await callPythonHelper("get_display_size", { displayId }),
      );
    },

    async listDisplays() {
      const displays = await callPythonHelper("list_displays", {});
      return displays.map((display) => normalizeDisplayGeometry(display));
    },

    async findWindowDisplays(bundleIds) {
      return callPythonHelper("find_window_displays", { bundleIds });
    },

    async resolvePrepareCapture(opts) {
      const display = await this.getDisplaySize(opts.preferredDisplayId);
      const [targetW, targetH] = computeTargetDims(
        display.width,
        display.height,
        display.scaleFactor,
      );
      const result = await callPythonHelper("resolve_prepare_capture", {
        preferredDisplayId: opts.preferredDisplayId,
        targetWidth: targetW,
        targetHeight: targetH,
        jpegQuality: SCREENSHOT_JPEG_QUALITY,
      });
      return {
        ...result,
        display: normalizeDisplayGeometry(result.display),
        resolvedDisplayId: result.resolvedDisplayId ?? result.displayId,
      };
    },

    async screenshot(opts) {
      const display = await this.getDisplaySize(opts.displayId);
      const [targetW, targetH] = computeTargetDims(
        display.width,
        display.height,
        display.scaleFactor,
      );
      return callPythonHelper("screenshot", {
        displayId: opts.displayId,
        targetWidth: targetW,
        targetHeight: targetH,
        jpegQuality: SCREENSHOT_JPEG_QUALITY,
      });
    },

    async zoom(regionLogical, _allowedBundleIds, displayId) {
      const display = await this.getDisplaySize(displayId);
      const [outW, outH] = computeTargetDims(
        regionLogical.w,
        regionLogical.h,
        display.scaleFactor,
      );
      return callPythonHelper("zoom", {
        x: regionLogical.x,
        y: regionLogical.y,
        width: regionLogical.w,
        height: regionLogical.h,
        targetWidth: outW,
        targetHeight: outH,
      });
    },

    async analyzePatch(opts) {
      return callPythonHelper("analyze_patch", {
        beforeBase64: opts.beforeBase64,
        afterBase64: opts.afterBase64,
        beforePath: opts.beforePath,
        afterPath: opts.afterPath,
        x: opts.x,
        y: opts.y,
        patchSize: opts.patchSize,
        searchRadius: opts.searchRadius,
      });
    },

    async key(keySequence, repeat) {
      await callPythonHelper("key", { keySequence, repeat: repeat ?? 1 });
    },

    async holdKey(keyNames, durationMs) {
      await callPythonHelper("hold_key", { keyNames, durationMs });
    },

    async type(text, opts) {
      if (opts?.viaClipboard) {
        await typeViaClipboard(text);
        return;
      }
      await callPythonHelper("type", { text });
    },

    readClipboard,
    writeClipboard,

    async click(x, y, button, count, modifiers) {
      await callPythonHelper("click", { x, y, button, count, modifiers });
      await sleep(MOVE_SETTLE_MS);
    },

    async mouseDown() {
      await callPythonHelper("mouse_down", {});
    },

    async mouseUp() {
      await callPythonHelper("mouse_up", {});
    },

    async getCursorPosition() {
      return callPythonHelper("cursor_position", {});
    },

    async drag(from, to) {
      await callPythonHelper("drag", { from, to });
      await sleep(MOVE_SETTLE_MS);
    },

    async moveMouse(x, y) {
      await callPythonHelper("move_mouse", { x, y });
      await sleep(MOVE_SETTLE_MS);
    },

    async scroll(x, y, dx, dy) {
      await callPythonHelper("scroll", { x, y, deltaX: dx, deltaY: dy });
    },

    async getFrontmostApp() {
      return callPythonHelper("frontmost_app", {});
    },

    async appUnderPoint(x, y) {
      return callPythonHelper("app_under_point", { x, y });
    },

    async listInstalledApps() {
      return callPythonHelper("list_installed_apps", {});
    },

    async listRunningApps() {
      return callPythonHelper("list_running_apps", {});
    },

    async openApp(bundleId) {
      await callPythonHelper("open_app", { bundleId });
    },
  };
}

export async function unhideComputerUseApps(_bundleIds) {
  return;
}
