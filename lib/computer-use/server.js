import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

const IS_DARWIN = process.platform === "darwin";
const SESSION_STATES = new Map();

const KEY_CODE_MAP = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
};

const MODIFIER_MAP = {
  command: "command down",
  cmd: "command down",
  meta: "command down",
  super: "command down",
  shift: "shift down",
  option: "option down",
  alt: "option down",
  control: "control down",
  ctrl: "control down",
};

const MODIFIER_FLAG_MASK = {
  command: 1 << 20,
  cmd: 1 << 20,
  meta: 1 << 20,
  super: 1 << 20,
  shift: 1 << 17,
  option: 1 << 19,
  alt: 1 << 19,
  control: 1 << 18,
  ctrl: 1 << 18,
};

const actionItemSchema = z.object({
  action: z.enum([
    "key",
    "type",
    "mouse_move",
    "click_text",
    "left_click",
    "left_click_drag",
    "right_click",
    "middle_click",
    "double_click",
    "triple_click",
    "scroll",
    "hold_key",
    "screenshot",
    "cursor_position",
    "left_mouse_down",
    "left_mouse_up",
    "wait",
  ]),
  coordinate: z.array(z.number()).length(2).optional(),
  start_coordinate: z.array(z.number()).length(2).optional(),
  text: z.string().optional(),
  partial: z.boolean().optional(),
  occurrence: z.number().int().min(1).max(100).optional(),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().int().min(0).max(100).optional(),
  duration: z.number().min(0).max(100).optional(),
  repeat: z.number().int().min(1).max(100).optional(),
});

function escapeAppleScriptString(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getSessionState(sessionKey) {
  const key = String(sessionKey || "default");
  const existing = SESSION_STATES.get(key);
  if (existing) return existing;
  const next = {
    allowedApps: [],
    grantFlags: {
      clipboardRead: false,
      clipboardWrite: false,
      systemKeyCombos: false,
    },
    selectedDisplayId: undefined,
    lastScreenshot: null,
    leftMouseDown: false,
  };
  SESSION_STATES.set(key, next);
  return next;
}

function resolveSessionKey(createContext, extra) {
  const ctx = typeof createContext === "function" ? (createContext(extra) || {}) : {};
  const manager = ctx?.sessionManager || {};
  const byMethod = typeof manager.getSessionId === "function"
    ? String(manager.getSessionId() || "")
    : "";
  const byPath = typeof manager.getSessionPath === "function"
    ? String(manager.getSessionPath() || "")
    : "";
  return byMethod || byPath || "default";
}

async function runExecFile(command, args = []) {
  const { stdout } = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
  return String(stdout || "").trim();
}

async function runSpawnWithInput(command, args = [], input = "") {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (buf) => { stdout += String(buf || ""); });
    proc.stderr.on("data", (buf) => { stderr += String(buf || ""); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(String(stdout || "").trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    if (input) proc.stdin.write(input);
    proc.stdin.end();
  });
}

async function runAppleScript(script) {
  return runExecFile("osascript", ["-e", String(script || "")]);
}

async function runJxa(script) {
  return runExecFile("osascript", ["-l", "JavaScript", "-e", String(script || "")]);
}

function requireMac() {
  if (!IS_DARWIN) {
    throw new Error(`computer_use is currently only available on macOS (current: ${process.platform})`);
  }
}

async function readClipboard() {
  requireMac();
  return runExecFile("pbpaste", []);
}

async function writeClipboard(text) {
  requireMac();
  await runSpawnWithInput("pbcopy", [], String(text || ""));
}

async function getFrontmostApp() {
  requireMac();
  const raw = await runAppleScript(`
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set appName to name of frontApp
      set bundleId to bundle identifier of frontApp
      return bundleId & "|" & appName
    end tell
  `);
  const [bundleId = "", appName = ""] = String(raw || "").split("|");
  return { bundleId: bundleId.trim(), appName: appName.trim() };
}

async function listRunningApps() {
  requireMac();
  const raw = await runJxa(`
    ObjC.import("AppKit");
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    var result = [];
    for (var i = 0; i < apps.count; i++) {
      var app = apps.objectAtIndex(i);
      var bundle = app.bundleIdentifier;
      var name = app.localizedName;
      if (bundle && name) {
        result.push({ bundleId: ObjC.unwrap(bundle), displayName: ObjC.unwrap(name) });
      }
    }
    JSON.stringify(result);
  `);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listDisplays() {
  requireMac();
  const raw = await runJxa(`
    ObjC.import("Foundation");
    ObjC.import("AppKit");
    ObjC.import("CoreGraphics");
    var key = $.NSString.stringWithString("NSScreenNumber");
    var screens = $.NSScreen.screens;
    var main = $.NSScreen.mainScreen;
    var result = [];
    for (var i = 0; i < screens.count; i++) {
      var screen = screens.objectAtIndex(i);
      var desc = screen.deviceDescription;
      var displayObj = desc.objectForKey(key);
      if (!displayObj) continue;
      var did = Number(ObjC.unwrap(displayObj));
      var bounds = $.CGDisplayBounds(did);
      var w = Number($.CGDisplayPixelsWide(did));
      var h = Number($.CGDisplayPixelsHigh(did));
      var pointWidth = Number(bounds.size.width);
      var pointHeight = Number(bounds.size.height);
      result.push({
        displayId: did,
        width: w,
        height: h,
        pointWidth: pointWidth,
        pointHeight: pointHeight,
        originX: Number(bounds.origin.x),
        originY: Number(bounds.origin.y),
        scaleX: pointWidth > 0 ? w / pointWidth : 1,
        scaleY: pointHeight > 0 ? h / pointHeight : 1,
        isMain: Boolean(screen.isEqual(main)),
        name: "Display " + (i + 1) + " (#" + did + ")"
      });
    }
    JSON.stringify(result);
  `);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return { width: 0, height: 0 };
  }
  const pngSig = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSig) {
    return { width: 0, height: 0 };
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function getCaptureOutputDir() {
  const home = process.env.HANA_HOME
    ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".hanako");
  return path.join(home, "user", "computer-use-captures");
}

function makeCaptureFileName(prefix = "capture", ext = "png") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${ts}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
}

async function captureScreenshot({ displayId, region, saveToDisk = false, savePrefix = "capture" } = {}) {
  requireMac();
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, makeCaptureFileName("hanako-cu-temp", "png"));
  const args = ["-x"];
  if (Number.isFinite(displayId)) args.push("-D", String(displayId));
  if (region) {
    const { x, y, width, height } = region;
    args.push("-R", `${x},${y},${width},${height}`);
  }
  args.push(tmpPath);
  await runExecFile("screencapture", args);
  const buf = fs.readFileSync(tmpPath);
  const dims = parsePngDimensions(buf);

  let savedPath = null;
  if (saveToDisk) {
    const outDir = getCaptureOutputDir();
    fs.mkdirSync(outDir, { recursive: true });
    savedPath = path.join(outDir, makeCaptureFileName(savePrefix, "png"));
    fs.copyFileSync(tmpPath, savedPath);
  }

  try { fs.unlinkSync(tmpPath); } catch {}

  return {
    base64: buf.toString("base64"),
    mimeType: "image/png",
    width: dims.width,
    height: dims.height,
    savedPath,
    displayId: Number.isFinite(displayId) ? Number(displayId) : undefined,
  };
}

function parseModifierTokens(text = "") {
  const raw = String(text || "")
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const modifiers = [];
  for (const token of raw) {
    if (MODIFIER_MAP[token]) modifiers.push(token);
  }
  return [...new Set(modifiers)];
}

function parseKeyChord(text = "") {
  const tokens = String(text || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers = [];
  let key = "";
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (MODIFIER_MAP[lower]) modifiers.push(lower);
    else key = token;
  }
  return { modifiers: [...new Set(modifiers)], key: key.trim() };
}

function buildModifierUsingClause(modifiers = []) {
  const using = modifiers
    .map((item) => MODIFIER_MAP[item])
    .filter(Boolean);
  if (!using.length) return "";
  return ` using {${using.join(", ")}}`;
}

function buildCgEventFlags(modifiers = []) {
  let flags = 0;
  for (const mod of modifiers) {
    flags |= MODIFIER_FLAG_MASK[mod] || 0;
  }
  return flags;
}

function normalizeCoord(tuple) {
  if (!Array.isArray(tuple) || tuple.length !== 2) {
    throw new Error("coordinate must be [x, y]");
  }
  const x = Number(tuple[0]);
  const y = Number(tuple[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("coordinate must contain finite numbers");
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function findDisplayById(displays = [], displayId) {
  if (!Number.isFinite(displayId)) return null;
  return displays.find((item) => Number(item?.displayId) === Number(displayId)) || null;
}

function findDisplayForPoint(displays = [], point = null) {
  if (!Array.isArray(displays) || !displays.length) return null;
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const hit = displays.find((display) => {
      const ox = Number(display?.originX || 0);
      const oy = Number(display?.originY || 0);
      const pw = Number(display?.pointWidth || 0);
      const ph = Number(display?.pointHeight || 0);
      return x >= ox && x < ox + pw && y >= oy && y < oy + ph;
    });
    if (hit) return hit;
  }
  return displays.find((item) => item?.isMain) || displays[0] || null;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveCoordinateInGlobalSpace(state, tuple) {
  const input = normalizeCoord(tuple);
  const shot = state?.lastScreenshot;
  if (!shot) {
    return {
      x: input.x,
      y: input.y,
      inputX: input.x,
      inputY: input.y,
      mapped: false,
    };
  }

  const shotWidth = toNumber(shot.width, 0);
  const shotHeight = toNumber(shot.height, 0);
  const inCapture = input.x >= 0 && input.y >= 0 && input.x <= shotWidth && input.y <= shotHeight;
  if (!inCapture) {
    return {
      x: input.x,
      y: input.y,
      inputX: input.x,
      inputY: input.y,
      mapped: false,
    };
  }

  const originX = toNumber(shot.originX, 0);
  const originY = toNumber(shot.originY, 0);
  const pointWidth = toNumber(shot.pointWidth, 0);
  const pointHeight = toNumber(shot.pointHeight, 0);
  const pixelWidth = toNumber(shot.pixelWidth, shotWidth);
  const pixelHeight = toNumber(shot.pixelHeight, shotHeight);
  const regionX = toNumber(shot.regionX, 0);
  const regionY = toNumber(shot.regionY, 0);

  const localX = regionX + input.x;
  const localY = regionY + input.y;
  const scaleX = pointWidth > 0 && pixelWidth > 0 ? pointWidth / pixelWidth : 1;
  const scaleY = pointHeight > 0 && pixelHeight > 0 ? pointHeight / pixelHeight : 1;

  return {
    x: Math.round(originX + localX * scaleX),
    y: Math.round(originY + localY * scaleY),
    inputX: input.x,
    inputY: input.y,
    mapped: true,
    displayId: Number.isFinite(shot.displayId) ? Number(shot.displayId) : undefined,
  };
}

function mapGlobalToLastScreenshot(state, point) {
  const shot = state?.lastScreenshot;
  if (!shot || !point) return null;

  const originX = toNumber(shot.originX, 0);
  const originY = toNumber(shot.originY, 0);
  const pointWidth = toNumber(shot.pointWidth, 0);
  const pointHeight = toNumber(shot.pointHeight, 0);
  const pixelWidth = toNumber(shot.pixelWidth, toNumber(shot.width, 0));
  const pixelHeight = toNumber(shot.pixelHeight, toNumber(shot.height, 0));
  const regionX = toNumber(shot.regionX, 0);
  const regionY = toNumber(shot.regionY, 0);
  const shotWidth = toNumber(shot.width, 0);
  const shotHeight = toNumber(shot.height, 0);
  if (pointWidth <= 0 || pointHeight <= 0 || pixelWidth <= 0 || pixelHeight <= 0 || shotWidth <= 0 || shotHeight <= 0) {
    return null;
  }

  const gx = toNumber(point.x, NaN);
  const gy = toNumber(point.y, NaN);
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;

  const localX = ((gx - originX) * (pixelWidth / pointWidth)) - regionX;
  const localY = ((gy - originY) * (pixelHeight / pointHeight)) - regionY;
  const x = Math.round(localX);
  const y = Math.round(localY);
  if (x < 0 || y < 0 || x > shotWidth || y > shotHeight) return null;
  return { x, y };
}

function normalizeSearchText(input = "") {
  return String(input || "")
    .toLowerCase()
    .replace(/[\s\u200b-\u200d\ufeff]+/g, "")
    .replace(/[.,，。:：;；'"“”‘’!?！？()（）[\]【】{}<>《》、\-_/\\|~@#$%^&*+=]+/g, "");
}

async function clickFrontmostElementByText({ text, partial = true, occurrence = 1 }) {
  requireMac();
  const query = String(text || "").trim();
  if (!query) throw new Error("text is required.");
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) throw new Error("text must contain at least one searchable character.");
  const preferPartial = partial !== false;
  const nth = Math.max(1, Math.round(Number(occurrence) || 1));
  const queryLiteral = JSON.stringify(normalizedQuery);
  const raw = await runJxa(`
    function safe(fn, fallback) {
      try {
        var out = fn();
        return out === undefined || out === null ? fallback : out;
      } catch (_) {
        return fallback;
      }
    }
    function simplify(input) {
      return String(input || "")
        .toLowerCase()
        .replace(/[\\s\\u200b-\\u200d\\ufeff]+/g, "")
        .replace(/[.,，。:：;；'"“”‘’!?！？()（）[\\]【】{}<>《》、\\-_\\/\\\\|~@#$%^&*+=]+/g, "");
    }
    function toPair(value) {
      try {
        if (!value) return null;
        var x = Number(value[0]);
        var y = Number(value[1]);
        if (isFinite(x) && isFinite(y)) return [x, y];
      } catch (_) {}
      return null;
    }
    var normalizedQuery = ${queryLiteral};
    var partial = ${preferPartial ? "true" : "false"};
    var targetOccurrence = ${nth};
    var se = Application("System Events");
    var processes = safe(function () { return se.processes.whose({ frontmost: true }); }, []);
    if (!processes || !processes.length) {
      JSON.stringify({ ok: false, error: "No frontmost process found." });
    } else {
      var process = processes[0];
      var processName = safe(function () { return String(process.name() || ""); }, "");
      var windows = safe(function () { return process.windows(); }, []);
      var elements = [];
      for (var w = 0; w < windows.length; w++) {
        var winElems = safe(function () { return windows[w].entireContents(); }, []);
        for (var i = 0; i < winElems.length; i++) elements.push(winElems[i]);
      }
      if (!elements.length) {
        var procElems = safe(function () { return process.entireContents(); }, []);
        for (var p = 0; p < procElems.length; p++) elements.push(procElems[p]);
      }
      var maxScan = Math.min(elements.length, 8000);
      var candidates = [];
      for (var idx = 0; idx < maxScan; idx++) {
        var el = elements[idx];
        var role = safe(function () { return String(el.role() || ""); }, "");
        var fields = [
          ["name", safe(function () { return String(el.name() || ""); }, "")],
          ["title", safe(function () { return String(el.title() || ""); }, "")],
          ["description", safe(function () { return String(el.description() || ""); }, "")],
          ["value", safe(function () { return String(el.value() || ""); }, "")],
          ["help", safe(function () { return String(el.help() || ""); }, "")],
        ];
        var best = null;
        for (var f = 0; f < fields.length; f++) {
          var rawText = fields[f][1];
          if (!rawText) continue;
          var normalized = simplify(rawText);
          if (!normalized) continue;
          var matched = partial ? normalized.indexOf(normalizedQuery) >= 0 : normalized === normalizedQuery;
          if (!matched) continue;
          var score = normalized === normalizedQuery ? 300 : normalized.indexOf(normalizedQuery) === 0 ? 240 : 180;
          if (/button|menu item|link|checkbox|radio/i.test(role)) score += 40;
          if (!best || score > best.score) {
            best = { field: fields[f][0], raw: rawText, score: score };
          }
        }
        if (!best) continue;
        var pos = toPair(safe(function () { return el.position(); }, null));
        var size = toPair(safe(function () { return el.size(); }, null));
        var center = null;
        if (pos && size) center = [pos[0] + size[0] / 2, pos[1] + size[1] / 2];
        candidates.push({
          element: el,
          index: idx,
          score: best.score,
          field: best.field,
          matched: best.raw,
          role: role,
          pos: pos,
          size: size,
          center: center,
          enabled: safe(function () { return Boolean(el.enabled()); }, true),
        });
      }
      candidates.sort(function (a, b) { return b.score - a.score; });
      if (!candidates.length) {
        JSON.stringify({
          ok: false,
          error: "No matching UI element found.",
          query: normalizedQuery,
          process: processName,
          scanned: maxScan,
        });
      } else {
        var selected = candidates[Math.min(candidates.length, targetOccurrence) - 1];
        var clicked = false;
        var method = "";
        try {
          selected.element.actions.byName("AXPress").perform();
          clicked = true;
          method = "AXPress";
        } catch (_) {}
        if (!clicked) {
          try {
            selected.element.click();
            clicked = true;
            method = "click";
          } catch (_) {}
        }
        JSON.stringify({
          ok: clicked,
          method: method || "none",
          query: normalizedQuery,
          process: processName,
          matched: selected.matched,
          matchField: selected.field,
          role: selected.role,
          center: selected.center,
          pos: selected.pos,
          size: selected.size,
          enabled: selected.enabled,
          scanned: maxScan,
          totalMatches: candidates.length,
          occurrence: targetOccurrence,
          error: clicked ? "" : "Element found but direct AX click failed.",
        });
      }
    }
  `);
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  throw new Error(`Failed to parse click_text result: ${String(raw || "").slice(0, 300)}`);
}

async function moveMouseTo(x, y) {
  requireMac();
  await runJxa(`
    ObjC.import("CoreGraphics");
    var p = $.CGPointMake(${Math.round(x)}, ${Math.round(y)});
    var e = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, 0);
    $.CGEventPost($.kCGHIDEventTap, e);
  `);
}

async function clickMouseAt({ x, y, button = "left", count = 1, modifiers = [] }) {
  requireMac();
  const btnCode = button === "right" ? 1 : button === "middle" ? 2 : 0;
  const downType = btnCode === 0
    ? "kCGEventLeftMouseDown"
    : btnCode === 1
      ? "kCGEventRightMouseDown"
      : "kCGEventOtherMouseDown";
  const upType = btnCode === 0
    ? "kCGEventLeftMouseUp"
    : btnCode === 1
      ? "kCGEventRightMouseUp"
      : "kCGEventOtherMouseUp";
  const flags = buildCgEventFlags(modifiers);
  await runJxa(`
    ObjC.import("CoreGraphics");
    var p = $.CGPointMake(${Math.round(x)}, ${Math.round(y)});
    var flags = ${flags};
    for (var i = 0; i < ${Math.max(1, Math.round(count))}; i++) {
      var d = $.CGEventCreateMouseEvent(null, $.${downType}, p, ${btnCode});
      var u = $.CGEventCreateMouseEvent(null, $.${upType}, p, ${btnCode});
      if (flags) { $.CGEventSetFlags(d, flags); $.CGEventSetFlags(u, flags); }
      $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, i + 1);
      $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, i + 1);
      $.CGEventPost($.kCGHIDEventTap, d);
      $.CGEventPost($.kCGHIDEventTap, u);
    }
  `);
}

async function mouseButtonEvent(action) {
  requireMac();
  await runJxa(`
    ObjC.import("CoreGraphics");
    var eLoc = $.CGEventCreate(null);
    var p = $.CGEventGetLocation(eLoc);
    var eventType = $.${action === "down" ? "kCGEventLeftMouseDown" : "kCGEventLeftMouseUp"};
    var e = $.CGEventCreateMouseEvent(null, eventType, p, 0);
    $.CGEventPost($.kCGHIDEventTap, e);
  `);
}

async function dragMouse({ start, end }) {
  requireMac();
  if (start) {
    await moveMouseTo(start.x, start.y);
  }
  await mouseButtonEvent("down");
  await sleep(60);
  await moveMouseTo(end.x, end.y);
  await sleep(60);
  await mouseButtonEvent("up");
}

async function scrollAt({ x, y, direction, amount }) {
  requireMac();
  const amt = Math.max(0, Math.min(100, Number(amount) || 0));
  await moveMouseTo(x, y);
  let axisCount = 1;
  let vertical = 0;
  let horizontal = 0;
  if (direction === "up") vertical = -amt;
  if (direction === "down") vertical = amt;
  if (direction === "left") {
    axisCount = 2;
    horizontal = -amt;
  }
  if (direction === "right") {
    axisCount = 2;
    horizontal = amt;
  }
  const script = axisCount === 1
    ? `
      ObjC.import("CoreGraphics");
      var e = $.CGEventCreateScrollWheelEvent(null, 0, 1, ${vertical});
      $.CGEventPost($.kCGHIDEventTap, e);
    `
    : `
      ObjC.import("CoreGraphics");
      var e = $.CGEventCreateScrollWheelEvent(null, 0, 2, 0, ${horizontal});
      $.CGEventPost($.kCGHIDEventTap, e);
    `;
  await runJxa(script);
}

function looksLikeSystemCombo(raw = "") {
  const text = String(raw || "").toLowerCase().replace(/\s+/g, "");
  return (
    text.includes("cmd+tab")
    || text.includes("command+tab")
    || text.includes("cmd+q")
    || text.includes("command+q")
    || text.includes("cmd+space")
    || text.includes("command+space")
    || text.includes("ctrl+cmd+q")
    || text.includes("control+command+q")
  );
}

async function sendKeyChord(chordText, repeat = 1) {
  requireMac();
  const { modifiers, key } = parseKeyChord(chordText);
  const lowerKey = String(key || "").toLowerCase();
  const keyCode = KEY_CODE_MAP[lowerKey];
  const usingClause = buildModifierUsingClause(modifiers);

  for (let i = 0; i < Math.max(1, Math.round(repeat)); i++) {
    if (keyCode !== undefined) {
      await runAppleScript(`tell application "System Events" to key code ${keyCode}${usingClause}`);
    } else if (key) {
      const escaped = escapeAppleScriptString(key.length === 1 ? key : lowerKey);
      await runAppleScript(`tell application "System Events" to keystroke "${escaped}"${usingClause}`);
    } else if (modifiers.length > 0) {
      await sleep(10);
    }
  }
}

async function typeText(text, grantFlags) {
  requireMac();
  const raw = String(text || "");
  const hasNewLine = raw.includes("\n");
  if (hasNewLine && grantFlags?.clipboardWrite) {
    let oldClipboard = "";
    let restore = false;
    try {
      oldClipboard = await readClipboard();
      restore = true;
    } catch {
      restore = false;
    }
    await writeClipboard(raw);
    await sendKeyChord("cmd+v", 1);
    await sleep(100);
    if (restore) {
      try { await writeClipboard(oldClipboard); } catch {}
    }
    return;
  }
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || "";
    if (line.length > 0) {
      const escaped = escapeAppleScriptString(line);
      await runAppleScript(`tell application "System Events" to keystroke "${escaped}"`);
    }
    if (i < lines.length - 1) {
      await runAppleScript(`tell application "System Events" to key code 36`);
    }
  }
}

async function getMousePosition() {
  requireMac();
  const raw = await runJxa(`
    ObjC.import("CoreGraphics");
    var e = $.CGEventCreate(null);
    var p = $.CGEventGetLocation(e);
    p.x + "," + p.y;
  `);
  const [xRaw, yRaw] = String(raw || "").split(",");
  const x = Math.round(Number(xRaw || 0));
  const y = Math.round(Number(yRaw || 0));
  return { x, y };
}

async function checkMacAccessibility() {
  requireMac();
  try {
    const out = await runAppleScript('tell application "System Events" to return UI elements enabled');
    return /true/i.test(String(out || ""));
  } catch {
    return false;
  }
}

function ensureHasAccess(state) {
  if (!Array.isArray(state.allowedApps) || state.allowedApps.length === 0) {
    throw new Error("No applications granted yet. Call request_access first.");
  }
}

async function ensureFrontmostAllowed(state) {
  ensureHasAccess(state);
  const front = await getFrontmostApp();
  const frontBundle = String(front.bundleId || "").toLowerCase();
  const frontName = String(front.appName || "").toLowerCase();

  const ok = state.allowedApps.some((app) => {
    const bundle = String(app.bundleId || "").toLowerCase();
    const name = String(app.displayName || "").toLowerCase();
    if (bundle.startsWith("name:")) {
      return frontName === bundle.slice("name:".length);
    }
    if (bundle && frontBundle && bundle === frontBundle) return true;
    if (name && frontName && name === frontName) return true;
    return false;
  });
  if (!ok) {
    const list = state.allowedApps
      .map((app) => app.displayName || app.bundleId)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Frontmost app is "${front.appName || front.bundleId || "Unknown"}", not in granted allowlist (${list || "empty"}).`,
    );
  }
}

async function resolveRequestedApps(appNames = []) {
  const running = await listRunningApps();
  const byBundle = new Map();
  const byName = new Map();
  for (const item of running) {
    const bundle = String(item?.bundleId || "").trim();
    const name = String(item?.displayName || "").trim();
    if (bundle) byBundle.set(bundle.toLowerCase(), { bundleId: bundle, displayName: name || bundle });
    if (name) byName.set(name.toLowerCase(), { bundleId: bundle || `name:${name.toLowerCase()}`, displayName: name });
  }

  const out = [];
  const seen = new Set();
  for (const raw of appNames) {
    const req = String(raw || "").trim();
    if (!req) continue;
    let resolved = null;
    if (req.includes(".") && !req.includes(" ")) {
      resolved = byBundle.get(req.toLowerCase()) || {
        bundleId: req,
        displayName: req.split(".").slice(-1)[0] || req,
      };
    } else {
      resolved = byName.get(req.toLowerCase()) || {
        bundleId: `name:${req.toLowerCase()}`,
        displayName: req,
      };
    }
    const key = String(resolved.bundleId || resolved.displayName || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      bundleId: String(resolved.bundleId || ""),
      displayName: String(resolved.displayName || resolved.bundleId || req),
    });
  }
  return out;
}

function mergeAllowedApps(prev = [], next = []) {
  const map = new Map();
  for (const item of [...prev, ...next]) {
    const bundle = String(item?.bundleId || "").trim();
    const name = String(item?.displayName || "").trim();
    const key = (bundle || `name:${name.toLowerCase()}`).toLowerCase();
    if (!key) continue;
    map.set(key, {
      bundleId: bundle || `name:${name.toLowerCase()}`,
      displayName: name || bundle,
    });
  }
  return [...map.values()];
}

function normalizeContent(content) {
  if (!Array.isArray(content)) return [{ type: "text", text: String(content || "") }];
  return content.map((block) => {
    if (block?.type === "image" && typeof block?.data === "string") {
      return {
        type: "image",
        data: block.data,
        mimeType: String(block.mimeType || "image/png"),
      };
    }
    return { type: "text", text: String(block?.text || "") };
  });
}

function makeTextResult(text, details = undefined) {
  return {
    content: [{ type: "text", text: String(text || "") }],
    details,
  };
}

function requireClipboardGrant(state, field) {
  if (!state?.grantFlags?.[field]) {
    throw new Error(`Clipboard permission "${field}" is not granted. Re-run request_access with ${field}=true.`);
  }
}

async function runAction(toolName, args, state) {
  const params = args || {};

  if (toolName === "request_access") {
    requireMac();
    const appsInput = Array.isArray(params.apps) ? params.apps : [];
    if (!appsInput.length) throw new Error("apps is required and cannot be empty.");
    const resolvedApps = await resolveRequestedApps(appsInput);
    state.allowedApps = mergeAllowedApps(state.allowedApps, resolvedApps);
    state.grantFlags = {
      ...state.grantFlags,
      clipboardRead: state.grantFlags.clipboardRead || params.clipboardRead === true,
      clipboardWrite: state.grantFlags.clipboardWrite || params.clipboardWrite === true,
      systemKeyCombos: state.grantFlags.systemKeyCombos || params.systemKeyCombos === true,
    };
    const accessibility = await checkMacAccessibility();
    const grantedNames = resolvedApps.map((app) => app.displayName || app.bundleId).join(", ");
    return makeTextResult(
      `Access granted for ${resolvedApps.length} app(s): ${grantedNames || "none"}.\n`
      + `Coordinate mode: screenshot-local pixels (auto-mapped to global cursor space)\n`
      + `Screenshot filtering: none\n`
      + `Accessibility permission: ${accessibility ? "granted" : "missing (please enable in System Settings if actions fail)"}`,
      {
        granted: resolvedApps,
        denied: [],
        flags: state.grantFlags,
        screenshotFiltering: "none",
        coordinateMode: "screenshot_local_pixels_with_auto_mapping",
      },
    );
  }

  if (toolName === "list_granted_applications") {
    return makeTextResult(
      JSON.stringify({
        apps: state.allowedApps,
        flags: state.grantFlags,
        coordinateMode: "screenshot_local_pixels_with_auto_mapping",
        selectedDisplayId: state.selectedDisplayId,
        lastScreenshot: state.lastScreenshot,
      }, null, 2),
    );
  }

  if (toolName === "switch_display") {
    const display = String(params.display || "").trim();
    if (!display) throw new Error("display is required.");
    if (display.toLowerCase() === "auto") {
      state.selectedDisplayId = undefined;
      return makeTextResult("Display mode switched to auto.");
    }
    const displays = await listDisplays();
    const byId = Number(display);
    let found = Number.isFinite(byId)
      ? displays.find((d) => Number(d.displayId) === Number(byId))
      : null;
    if (!found) {
      const lower = display.toLowerCase();
      found = displays.find((d) =>
        String(d.name || "").toLowerCase().includes(lower)
        || String(d.displayId || "").toLowerCase() === lower,
      );
    }
    if (!found) {
      throw new Error(`Display "${display}" not found. Available displays: ${displays.map((d) => d.name).join(", ") || "none"}`);
    }
    state.selectedDisplayId = Number(found.displayId);
    return makeTextResult(`Display switched to ${found.name}.`);
  }

  if (toolName === "open_application") {
    await ensureFrontmostAllowed(state).catch(() => {});
    ensureHasAccess(state);
    const app = String(params.app || "").trim();
    if (!app) throw new Error("app is required.");
    const target = state.allowedApps.find((item) =>
      String(item.bundleId || "").toLowerCase() === app.toLowerCase()
      || String(item.displayName || "").toLowerCase() === app.toLowerCase(),
    );
    if (!target) {
      throw new Error(`App "${app}" is not in granted allowlist. Call request_access first.`);
    }
    if (String(target.bundleId || "").includes(".")) {
      await runExecFile("open", ["-b", String(target.bundleId)]);
    } else {
      await runExecFile("open", ["-a", String(target.displayName || app)]);
    }
    await sleep(700);
    return makeTextResult(`Opened application: ${target.displayName || target.bundleId}`);
  }

  if (toolName === "screenshot") {
    ensureHasAccess(state);
    const displays = await listDisplays();
    let selected = Number.isFinite(state.selectedDisplayId)
      ? findDisplayById(displays, Number(state.selectedDisplayId))
      : null;
    if (!selected) {
      const cursor = await getMousePosition().catch(() => null);
      selected = findDisplayForPoint(displays, cursor);
    }
    const captureDisplayId = Number.isFinite(selected?.displayId) ? Number(selected.displayId) : undefined;
    const shot = await captureScreenshot({
      displayId: captureDisplayId,
      saveToDisk: params.save_to_disk === true,
      savePrefix: "screenshot",
    });
    state.lastScreenshot = {
      width: shot.width,
      height: shot.height,
      displayId: shot.displayId,
      originX: toNumber(selected?.originX, 0),
      originY: toNumber(selected?.originY, 0),
      pointWidth: toNumber(selected?.pointWidth, shot.width),
      pointHeight: toNumber(selected?.pointHeight, shot.height),
      pixelWidth: toNumber(selected?.width, shot.width),
      pixelHeight: toNumber(selected?.height, shot.height),
      regionX: 0,
      regionY: 0,
      capturedAt: Date.now(),
    };
    const note = selected
      ? `Captured ${selected.name} (${shot.width}x${shot.height}).`
      : `Captured current display (${shot.width}x${shot.height}).`;
    const saveNote = shot.savedPath ? `\nSaved to: ${shot.savedPath}` : "";
    return {
      content: normalizeContent([
        { type: "image", data: shot.base64, mimeType: shot.mimeType },
        { type: "text", text: `${note}${saveNote}` },
      ]),
      details: {
        action: "screenshot",
        width: shot.width,
        height: shot.height,
        displayId: shot.displayId,
        pointWidth: toNumber(selected?.pointWidth, 0),
        pointHeight: toNumber(selected?.pointHeight, 0),
        originX: toNumber(selected?.originX, 0),
        originY: toNumber(selected?.originY, 0),
        savedPath: shot.savedPath,
      },
    };
  }

  if (toolName === "zoom") {
    ensureHasAccess(state);
    const region = Array.isArray(params.region) ? params.region : null;
    if (!region || region.length !== 4) throw new Error("region must be [x0, y0, x1, y1]");
    const [x0, y0, x1, y1] = region.map((v) => Math.round(Number(v)));
    if (![x0, y0, x1, y1].every(Number.isFinite)) throw new Error("region values must be finite numbers");
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    const displays = await listDisplays();
    let selected = Number.isFinite(state.selectedDisplayId)
      ? findDisplayById(displays, Number(state.selectedDisplayId))
      : null;
    if (!selected) {
      const cursor = await getMousePosition().catch(() => null);
      selected = findDisplayForPoint(displays, cursor);
    }
    const captureDisplayId = Number.isFinite(selected?.displayId) ? Number(selected.displayId) : undefined;
    const shot = await captureScreenshot({
      displayId: captureDisplayId,
      region: { x: x0, y: y0, width, height },
      saveToDisk: params.save_to_disk === true,
      savePrefix: "zoom",
    });
    state.lastScreenshot = {
      width: shot.width,
      height: shot.height,
      displayId: shot.displayId,
      originX: toNumber(selected?.originX, 0),
      originY: toNumber(selected?.originY, 0),
      pointWidth: toNumber(selected?.pointWidth, shot.width),
      pointHeight: toNumber(selected?.pointHeight, shot.height),
      pixelWidth: toNumber(selected?.width, shot.width),
      pixelHeight: toNumber(selected?.height, shot.height),
      regionX: x0,
      regionY: y0,
      capturedAt: Date.now(),
    };
    const saveNote = shot.savedPath ? `\nSaved to: ${shot.savedPath}` : "";
    return {
      content: normalizeContent([
        { type: "image", data: shot.base64, mimeType: shot.mimeType },
        { type: "text", text: `Zoom capture region=(${x0},${y0})..(${x1},${y1}) size=${width}x${height}.${saveNote}` },
      ]),
      details: {
        action: "zoom",
        region: [x0, y0, x1, y1],
        width,
        height,
        displayId: shot.displayId,
        pointWidth: toNumber(selected?.pointWidth, 0),
        pointHeight: toNumber(selected?.pointHeight, 0),
        originX: toNumber(selected?.originX, 0),
        originY: toNumber(selected?.originY, 0),
        savedPath: shot.savedPath,
      },
    };
  }

  if (toolName === "cursor_position") {
    const pos = await getMousePosition();
    const relative = mapGlobalToLastScreenshot(state, pos);
    const extra = relative ? `; relative to last capture: (${relative.x}, ${relative.y})` : "";
    return makeTextResult(`Cursor position: (${pos.x}, ${pos.y})${extra}`, {
      ...pos,
      relativeToLastCapture: relative || undefined,
    });
  }

  if (toolName === "wait") {
    const duration = Math.max(0, Math.min(100, Number(params.duration) || 0));
    await sleep(duration * 1000);
    return makeTextResult(`Waited ${duration} second(s).`);
  }

  if (toolName === "read_clipboard") {
    requireClipboardGrant(state, "clipboardRead");
    const text = await readClipboard();
    return makeTextResult(text || "(clipboard is empty)");
  }

  if (toolName === "write_clipboard") {
    requireClipboardGrant(state, "clipboardWrite");
    const text = String(params.text || "");
    await writeClipboard(text);
    return makeTextResult(`Wrote ${text.length} character(s) to clipboard.`);
  }

  if (toolName === "computer_batch") {
    await ensureFrontmostAllowed(state);
    const actions = Array.isArray(params.actions) ? params.actions : [];
    if (!actions.length) throw new Error("actions must contain at least one item.");
    const lines = [];
    const content = [];
    for (let i = 0; i < actions.length; i++) {
      const item = actions[i] || {};
      const action = String(item.action || "").trim();
      const result = await runAction(action, item, state);
      const textBlock = Array.isArray(result?.content)
        ? result.content.find((block) => block?.type === "text")
        : null;
      lines.push(`${i + 1}. ${action}${textBlock?.text ? ` — ${textBlock.text}` : ""}`);
      if (Array.isArray(result?.content)) {
        for (const block of result.content) {
          if (block?.type === "image") content.push(block);
        }
      }
    }
    content.push({ type: "text", text: `Batch complete (${actions.length} action(s)):\n${lines.join("\n")}` });
    return { content: normalizeContent(content) };
  }

  // Aliases from computer_batch action names.
  if (toolName === "mouse_move") {
    await ensureFrontmostAllowed(state);
    const target = resolveCoordinateInGlobalSpace(state, params.coordinate);
    const { x, y } = target;
    await moveMouseTo(x, y);
    const suffix = target.mapped ? ` (mapped from ${target.inputX}, ${target.inputY})` : "";
    return makeTextResult(`Moved mouse to (${x}, ${y})${suffix}.`, target);
  }

  if (toolName === "click_text") {
    await ensureFrontmostAllowed(state);
    const query = String(params.text || "").trim();
    if (!query) throw new Error("text is required.");
    const partial = params.partial !== false;
    const occurrence = Number.isFinite(params.occurrence) ? Number(params.occurrence) : 1;
    const result = await clickFrontmostElementByText({ text: query, partial, occurrence });
    if (result?.ok) {
      return makeTextResult(
        `Clicked "${result.matched || query}" via ${result.method || "AX"} in ${result.process || "frontmost app"}.`,
        result,
      );
    }
    const center = Array.isArray(result?.center) && result.center.length === 2
      ? { x: Math.round(Number(result.center[0])), y: Math.round(Number(result.center[1])) }
      : null;
    if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
      await moveMouseTo(center.x, center.y);
      await clickMouseAt({ x: center.x, y: center.y, button: "left", count: 1 });
      return makeTextResult(
        `Clicked "${result?.matched || query}" by coordinate fallback at (${center.x}, ${center.y}).`,
        { ...result, ok: true, method: "coordinate_fallback" },
      );
    }
    throw new Error(result?.error || `No matching UI element found for text "${query}".`);
  }

  if (toolName === "left_click" || toolName === "double_click" || toolName === "triple_click"
    || toolName === "right_click" || toolName === "middle_click") {
    await ensureFrontmostAllowed(state);
    const target = resolveCoordinateInGlobalSpace(state, params.coordinate);
    const { x, y } = target;
    const clickCount = toolName === "double_click" ? 2 : toolName === "triple_click" ? 3 : 1;
    const button = toolName === "right_click" ? "right" : toolName === "middle_click" ? "middle" : "left";
    const modifiers = parseModifierTokens(params.text || "");
    await moveMouseTo(x, y);
    await clickMouseAt({ x, y, button, count: clickCount, modifiers });
    const suffix = target.mapped ? ` (mapped from ${target.inputX}, ${target.inputY})` : "";
    return makeTextResult(`${toolName} at (${x}, ${y})${suffix}.`, target);
  }

  if (toolName === "left_mouse_down") {
    await ensureFrontmostAllowed(state);
    if (state.leftMouseDown) throw new Error("Left mouse button is already held down.");
    await mouseButtonEvent("down");
    state.leftMouseDown = true;
    return makeTextResult("Left mouse button pressed and held.");
  }

  if (toolName === "left_mouse_up") {
    await ensureFrontmostAllowed(state);
    if (state.leftMouseDown) {
      await mouseButtonEvent("up");
      state.leftMouseDown = false;
      return makeTextResult("Left mouse button released.");
    }
    return makeTextResult("Left mouse button was not held; no action taken.");
  }

  if (toolName === "left_click_drag") {
    await ensureFrontmostAllowed(state);
    const end = resolveCoordinateInGlobalSpace(state, params.coordinate);
    const start = params.start_coordinate ? resolveCoordinateInGlobalSpace(state, params.start_coordinate) : null;
    await dragMouse({ start, end });
    state.leftMouseDown = false;
    return makeTextResult(`Dragged mouse to (${end.x}, ${end.y}).`, { end, start: start || undefined });
  }

  if (toolName === "scroll") {
    await ensureFrontmostAllowed(state);
    const target = resolveCoordinateInGlobalSpace(state, params.coordinate);
    const { x, y } = target;
    const direction = String(params.scroll_direction || "").toLowerCase();
    const amount = Number(params.scroll_amount);
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new Error("scroll_direction must be one of: up/down/left/right.");
    }
    if (!Number.isFinite(amount)) {
      throw new Error("scroll_amount must be an integer.");
    }
    await scrollAt({ x, y, direction, amount });
    const suffix = target.mapped ? ` (mapped from ${target.inputX}, ${target.inputY})` : "";
    return makeTextResult(`Scrolled ${direction} by ${Math.round(amount)} at (${x}, ${y})${suffix}.`, target);
  }

  if (toolName === "type") {
    await ensureFrontmostAllowed(state);
    const text = String(params.text || "");
    if (!text) throw new Error("text is required.");
    await typeText(text, state.grantFlags);
    return makeTextResult(`Typed ${text.length} character(s).`);
  }

  if (toolName === "key") {
    await ensureFrontmostAllowed(state);
    const text = String(params.text || "").trim();
    if (!text) throw new Error("text is required.");
    if (looksLikeSystemCombo(text) && !state.grantFlags.systemKeyCombos) {
      throw new Error("System key combos are blocked. Re-run request_access with systemKeyCombos=true.");
    }
    const repeat = Number.isFinite(params.repeat) ? Number(params.repeat) : 1;
    await sendKeyChord(text, repeat);
    return makeTextResult(`Pressed key combo "${text}" x${Math.max(1, Math.round(repeat))}.`);
  }

  if (toolName === "hold_key") {
    await ensureFrontmostAllowed(state);
    const text = String(params.text || "").trim();
    const duration = Math.max(0, Math.min(100, Number(params.duration) || 0));
    if (!text) throw new Error("text is required.");
    if (looksLikeSystemCombo(text) && !state.grantFlags.systemKeyCombos) {
      throw new Error("System key combos are blocked. Re-run request_access with systemKeyCombos=true.");
    }
    await sendKeyChord(text, 1);
    await sleep(duration * 1000);
    return makeTextResult(`Held key combo "${text}" for ${duration} second(s) (simulated).`);
  }

  throw new Error(`Unsupported computer-use tool: ${toolName}`);
}

function wrapTool(toolName, description, schema, opts = {}) {
  const {
    createContext,
    onToolStart,
    onToolEnd,
  } = opts;
  return tool(
    toolName,
    description,
    schema,
    async (args, extra) => {
      const toolCallId = `${toolName}:${Date.now()}:${randomUUID().slice(0, 8)}`;
      const sessionKey = resolveSessionKey(createContext, extra);
      const state = getSessionState(sessionKey);

      onToolStart?.({
        type: "tool_start",
        name: toolName,
        toolCallId,
        args,
      });
      try {
        const result = await runAction(toolName, args, state);
        const content = normalizeContent(result?.content || [{ type: "text", text: "" }]);
        onToolEnd?.({
          type: "tool_end",
          name: toolName,
          toolCallId,
          args,
          success: true,
          content,
          details: result?.details,
        });
        return { content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Unknown error");
        onToolEnd?.({
          type: "tool_end",
          name: toolName,
          toolCallId,
          args,
          success: false,
          content: [{ type: "text", text: message }],
          details: { error: message },
        });
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    },
  );
}

export function createComputerUseMcpServer(name = "computer_use", opts = {}) {
  const coordinateDesc = "Horizontal/vertical position in pixels from the latest screenshot/zoom image. Coordinates are auto-mapped across display origin and HiDPI scale.";
  const coordinate = z.array(z.number()).length(2).describe(coordinateDesc);

  const tools = [
    wrapTool(
      "request_access",
      "Request permission to control apps for this session. Must be called before desktop actions.",
      z.object({
        apps: z.array(z.string()).min(1).describe("App display names or bundle IDs."),
        reason: z.string().describe("Short reason for requesting access."),
        clipboardRead: z.boolean().optional(),
        clipboardWrite: z.boolean().optional(),
        systemKeyCombos: z.boolean().optional(),
      }),
      opts,
    ),
    wrapTool(
      "screenshot",
      "Take a screenshot of the current display.",
      z.object({
        save_to_disk: z.boolean().optional(),
      }),
      opts,
    ),
    wrapTool(
      "zoom",
      "Take a higher-resolution capture of a rectangular region.",
      z.object({
        region: z.array(z.number().int()).length(4),
        save_to_disk: z.boolean().optional(),
      }),
      opts,
    ),
    wrapTool(
      "click_text",
      "Find a visible UI element in the frontmost app by text and click it (recommended when coordinate clicks are unstable).",
      z.object({
        text: z.string(),
        partial: z.boolean().optional(),
        occurrence: z.number().int().min(1).max(100).optional(),
      }),
      opts,
    ),
    wrapTool("left_click", "Left-click at coordinates.", z.object({ coordinate, text: z.string().optional() }), opts),
    wrapTool("double_click", "Double-click at coordinates.", z.object({ coordinate, text: z.string().optional() }), opts),
    wrapTool("triple_click", "Triple-click at coordinates.", z.object({ coordinate, text: z.string().optional() }), opts),
    wrapTool("right_click", "Right-click at coordinates.", z.object({ coordinate, text: z.string().optional() }), opts),
    wrapTool("middle_click", "Middle-click at coordinates.", z.object({ coordinate, text: z.string().optional() }), opts),
    wrapTool("type", "Type text into the focused element.", z.object({ text: z.string() }), opts),
    wrapTool(
      "key",
      "Press a key or key combination, e.g. cmd+a, enter, escape.",
      z.object({ text: z.string(), repeat: z.number().int().min(1).max(100).optional() }),
      opts,
    ),
    wrapTool(
      "scroll",
      "Scroll at coordinates.",
      z.object({
        coordinate,
        scroll_direction: z.enum(["up", "down", "left", "right"]),
        scroll_amount: z.number().int().min(0).max(100),
      }),
      opts,
    ),
    wrapTool(
      "left_click_drag",
      "Drag from start_coordinate (or current cursor) to coordinate.",
      z.object({
        coordinate,
        start_coordinate: coordinate.optional(),
      }),
      opts,
    ),
    wrapTool("mouse_move", "Move mouse cursor.", z.object({ coordinate }), opts),
    wrapTool("open_application", "Open/activate an application already granted in request_access.", z.object({ app: z.string() }), opts),
    wrapTool("switch_display", "Switch display for subsequent screenshots, or pass auto.", z.object({ display: z.string() }), opts),
    wrapTool("list_granted_applications", "List currently granted apps and flags.", z.object({}), opts),
    wrapTool("read_clipboard", "Read clipboard text (requires clipboardRead grant).", z.object({}), opts),
    wrapTool("write_clipboard", "Write clipboard text (requires clipboardWrite grant).", z.object({ text: z.string() }), opts),
    wrapTool("wait", "Wait for duration seconds.", z.object({ duration: z.number().min(0).max(100) }), opts),
    wrapTool("cursor_position", "Get current cursor position.", z.object({}), opts),
    wrapTool("hold_key", "Hold a key/chord for duration seconds.", z.object({ text: z.string(), duration: z.number().min(0).max(100) }), opts),
    wrapTool("left_mouse_down", "Press and hold left mouse button.", z.object({}), opts),
    wrapTool("left_mouse_up", "Release left mouse button.", z.object({}), opts),
    wrapTool("computer_batch", "Run multiple desktop actions in one call.", z.object({ actions: z.array(actionItemSchema).min(1) }), opts),
  ];

  return createSdkMcpServer({
    name,
    version: "1.0.0",
    tools,
  });
}
