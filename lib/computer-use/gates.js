import { ALL_SUB_GATES_ON } from "./vendor/index.js";

function boolFromEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return fallback;
}

function coordinateModeFromEnv() {
  const raw = String(
    process.env.HANAKO_COMPUTER_USE_COORDINATE_MODE
      || process.env.CLAUDE_COMPUTER_USE_COORDINATE_MODE
      || "",
  ).trim().toLowerCase();
  return raw === "normalized_0_100" ? "normalized_0_100" : "pixels";
}

export function getChicagoEnabled() {
  return boolFromEnv("HANAKO_COMPUTER_USE_ENABLED", true)
    && boolFromEnv("CLAUDE_COMPUTER_USE_ENABLED", true);
}

export function getChicagoSubGates() {
  return {
    ...ALL_SUB_GATES_ON,
    pixelValidation: boolFromEnv("HANAKO_COMPUTER_USE_PIXEL_VALIDATION", ALL_SUB_GATES_ON.pixelValidation),
    clipboardPasteMultiline: boolFromEnv(
      "HANAKO_COMPUTER_USE_CLIPBOARD_PASTE",
      ALL_SUB_GATES_ON.clipboardPasteMultiline,
    ),
    mouseAnimation: boolFromEnv(
      "HANAKO_COMPUTER_USE_MOUSE_ANIMATION",
      ALL_SUB_GATES_ON.mouseAnimation,
    ),
    hideBeforeAction: boolFromEnv(
      "HANAKO_COMPUTER_USE_HIDE_BEFORE_ACTION",
      ALL_SUB_GATES_ON.hideBeforeAction,
    ),
    autoTargetDisplay: boolFromEnv(
      "HANAKO_COMPUTER_USE_AUTO_TARGET_DISPLAY",
      ALL_SUB_GATES_ON.autoTargetDisplay,
    ),
    clipboardGuard: boolFromEnv(
      "HANAKO_COMPUTER_USE_CLIPBOARD_GUARD",
      ALL_SUB_GATES_ON.clipboardGuard,
    ),
  };
}

let frozenCoordinateMode;
export function getChicagoCoordinateMode() {
  if (!frozenCoordinateMode) {
    frozenCoordinateMode = coordinateModeFromEnv();
  }
  return frozenCoordinateMode;
}
