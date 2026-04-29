#!/usr/bin/env python3
"""Windows Computer Use helper — same JSON protocol as mac_helper.py.

Uses win32gui / win32api / win32process / psutil / pyperclip / pyautogui
to replicate macOS-specific Quartz/AppKit functionality on Windows.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

import mss
from PIL import Image, ImageChops, ImageStat

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")


def _init_dpi_awareness() -> None:
    """Prefer per-monitor DPI awareness so monitor bounds/cursor math are stable."""
    try:
        user32 = ctypes.windll.user32
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:
        pass
    try:
        # PROCESS_PER_MONITOR_DPI_AWARE = 2
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


_init_dpi_awareness()

import pyautogui  # noqa: E402

# The desktop app decodes helper stdout as UTF-8. On Windows, redirected Python
# stdout defaults to the active ANSI code page (for example GBK), which mangles
# localized app names from the registry. Force UTF-8 at process start so JSON
# responses stay stable regardless of the user's system locale.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

# ---------------------------------------------------------------------------
# Key mapping — Windows uses 'win' instead of 'command'
# ---------------------------------------------------------------------------
KEY_MAP = {
    "a": "a", "b": "b", "c": "c", "d": "d", "e": "e",
    "f": "f", "g": "g", "h": "h", "i": "i", "j": "j",
    "k": "k", "l": "l", "m": "m", "n": "n", "o": "o",
    "p": "p", "q": "q", "r": "r", "s": "s", "t": "t",
    "u": "u", "v": "v", "w": "w", "x": "x", "y": "y",
    "z": "z",
    "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
    "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
    # Modifier keys — map macOS names to Windows equivalents
    "cmd": "win",
    "command": "win",
    "meta": "win",
    "super": "win",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "opt": "alt",
    "fn": "fn",
    # Navigation / editing
    "escape": "esc",
    "esc": "esc",
    "enter": "enter",
    "return": "enter",
    "tab": "tab",
    "space": "space",
    "backspace": "backspace",
    "delete": "delete",
    "forwarddelete": "delete",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "home": "home",
    "end": "end",
    "pageup": "pageup",
    "pagedown": "pagedown",
    "capslock": "capslock",
    # Function keys
    "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
    "f5": "f5", "f6": "f6", "f7": "f7", "f8": "f8",
    "f9": "f9", "f10": "f10", "f11": "f11", "f12": "f12",
    # Symbols
    "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\",
    ";": ";", "'": "'", ",": ",", ".": ".", "/": "/", "`": "`",
}


def normalize_key(name: str) -> str:
    key = name.strip().lower()
    if key not in KEY_MAP:
        raise ValueError(f"Unsupported key: {name}")
    return KEY_MAP[key]


# ---------------------------------------------------------------------------
# JSON output helpers
# ---------------------------------------------------------------------------

def json_output(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def error_output(message: str, code: str = "runtime_error") -> None:
    json_output({"ok": False, "error": {"code": code, "message": message}})


def bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value not in {"0", "false", "False", ""}


# ---------------------------------------------------------------------------
# Display / Monitor helpers (Win32 monitor APIs + per-monitor DPI)
# ---------------------------------------------------------------------------

def get_displays() -> list[dict[str, Any]]:
    """Enumerate monitors with stable IDs and per-monitor DPI scaling."""
    import win32api
    import win32con

    displays: list[dict[str, Any]] = []
    for idx, (hmonitor, _, _) in enumerate(win32api.EnumDisplayMonitors()):
        info = win32api.GetMonitorInfo(hmonitor)
        left, top, right, bottom = info["Monitor"]
        width = int(right - left)
        height = int(bottom - top)
        is_primary = bool(info.get("Flags", 0) & win32con.MONITORINFOF_PRIMARY)
        scale_factor = _get_monitor_scale(hmonitor)
        # Use the HMONITOR handle as a stable display ID for this session.
        display_id = int(hmonitor)
        name = f"Display {idx + 1}" + (" (Primary)" if is_primary else "")
        displays.append(
            {
                "id": display_id,
                "displayId": display_id,
                "width": width,
                "height": height,
                "scaleFactor": scale_factor,
                "originX": int(left),
                "originY": int(top),
                "isPrimary": is_primary,
                "name": name,
                "label": name,
            }
        )
    return displays


def _get_monitor_scale(hmonitor: int) -> float:
    """Get per-monitor effective DPI scale. Falls back to 1.0."""
    try:
        xdpi = ctypes.c_uint(96)
        ydpi = ctypes.c_uint(96)
        # MDT_EFFECTIVE_DPI = 0
        hr = ctypes.windll.shcore.GetDpiForMonitor(
            ctypes.c_void_p(hmonitor),
            0,
            ctypes.byref(xdpi),
            ctypes.byref(ydpi),
        )
        if hr == 0 and xdpi.value > 0:
            return float(xdpi.value) / 96.0
    except Exception:
        pass
    return 1.0


def choose_display(display_id: int | None) -> dict[str, Any]:
    displays = get_displays()
    if not displays:
        raise RuntimeError("No active displays found")
    if display_id is None:
        for display in displays:
            if display["isPrimary"]:
                return display
        return displays[0]
    for display in displays:
        if display["displayId"] == display_id or display["id"] == display_id:
            return display
    # Backward compatibility with older runtime IDs that used 0..N-1 indices.
    if isinstance(display_id, int) and 0 <= display_id < len(displays):
        return displays[display_id]
    raise RuntimeError(f"Unknown display: {display_id}")


# ---------------------------------------------------------------------------
# Screen capture (mss — cross-platform, identical to mac_helper)
# ---------------------------------------------------------------------------

def capture_display(display_id: int | None, resize: tuple[int, int] | None = None) -> dict[str, Any]:
    display = choose_display(display_id)
    monitor = {
        "left": display["originX"],
        "top": display["originY"],
        "width": display["width"],
        "height": display["height"],
    }
    with mss.mss() as sct:
        raw = sct.grab(monitor)
        image = Image.frombytes("RGB", raw.size, raw.rgb)
    if resize:
        image = image.resize(resize, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=75, optimize=True)
    base64_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {
        "base64": base64_data,
        "width": image.width,
        "height": image.height,
        "displayWidth": display["width"],
        "displayHeight": display["height"],
        "displayId": display["displayId"],
        "originX": display["originX"],
        "originY": display["originY"],
        "display": display,
    }


def capture_region(region: dict[str, int], resize: tuple[int, int] | None = None) -> dict[str, Any]:
    with mss.mss() as sct:
        raw = sct.grab(region)
        image = Image.frombytes("RGB", raw.size, raw.rgb)
    if resize:
        image = image.resize(resize, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=75, optimize=True)
    base64_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"base64": base64_data, "width": image.width, "height": image.height}


def _decode_image(base64_data: str | None = None, file_path: str | None = None) -> Image.Image:
    if file_path:
        raw = Path(file_path).read_bytes()
        return Image.open(BytesIO(raw)).convert("RGB")
    payload = str(base64_data or "")
    if payload.startswith("data:image/"):
        payload = payload.split(",", 1)[1] if "," in payload else payload
    raw = base64.b64decode(payload)
    return Image.open(BytesIO(raw)).convert("RGB")


def _crop_center_patch(image: Image.Image, x: int, y: int, size: int) -> tuple[Image.Image, int, int]:
    half = max(1, size // 2)
    cx = max(0, min(int(x), image.width - 1))
    cy = max(0, min(int(y), image.height - 1))
    left = max(0, cx - half)
    top = max(0, cy - half)
    right = min(image.width, left + size)
    bottom = min(image.height, top + size)
    # Keep dimensions consistent near edges.
    left = max(0, right - size)
    top = max(0, bottom - size)
    return image.crop((left, top, right, bottom)), left, top


def _mad(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a, b)
    stat = ImageStat.Stat(diff)
    return float(sum(stat.mean) / len(stat.mean))


def analyze_patch(
    before_base64: str | None,
    after_base64: str | None,
    x: int,
    y: int,
    patch_size: int = 25,
    search_radius: int = 40,
    before_path: str | None = None,
    after_path: str | None = None,
) -> dict[str, Any]:
    before = _decode_image(before_base64, before_path)
    after = _decode_image(after_base64, after_path)
    # Align by normalized position if sizes differ.
    px = int(round((max(0, min(x, before.width - 1)) / max(1, before.width - 1)) * max(0, after.width - 1)))
    py = int(round((max(0, min(y, before.height - 1)) / max(1, before.height - 1)) * max(0, after.height - 1)))
    patch_size = max(9, int(patch_size))
    search_radius = max(0, int(search_radius))

    patch, _, _ = _crop_center_patch(before, x, y, patch_size)
    center_patch, _, _ = _crop_center_patch(after, px, py, patch_size)
    same_diff = _mad(patch, center_patch)

    best_diff = same_diff
    best_x = px
    best_y = py
    if search_radius > 0:
        for dx in range(-search_radius, search_radius + 1):
            for dy in range(-search_radius, search_radius + 1):
                cx = max(0, min(px + dx, after.width - 1))
                cy = max(0, min(py + dy, after.height - 1))
                candidate, _, _ = _crop_center_patch(after, cx, cy, patch_size)
                score = _mad(patch, candidate)
                if score < best_diff:
                    best_diff = score
                    best_x = cx
                    best_y = cy

    return {
        "sameDiff": same_diff,
        "bestDiff": best_diff,
        "bestX": int(best_x),
        "bestY": int(best_y),
        "sameX": int(px),
        "sameY": int(py),
        "patchSize": patch_size,
        "searchRadius": search_radius,
    }


# ---------------------------------------------------------------------------
# Window management (win32gui)
# ---------------------------------------------------------------------------

def list_windows() -> list[dict[str, Any]]:
    """List visible on-screen windows with their bounds."""
    import win32gui

    results: list[dict[str, Any]] = []

    def _enum_cb(hwnd: int, _: Any) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        except Exception:
            return
        width = right - left
        height = bottom - top
        if width <= 1 or height <= 1:
            return
        # Get the process name as owner
        owner = _get_window_process_name(hwnd)
        results.append({
            "ownerName": owner,
            "title": title,
            "bounds": {"x": left, "y": top, "width": width, "height": height},
        })

    win32gui.EnumWindows(_enum_cb, None)
    return results


def _get_window_process_name(hwnd: int) -> str:
    """Get the exe name of the process owning a window handle."""
    try:
        import win32process
        import psutil
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        proc = psutil.Process(pid)
        return proc.name()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Application management
# ---------------------------------------------------------------------------

def _get_exe_path_for_pid(pid: int) -> str | None:
    try:
        import psutil
        return psutil.Process(pid).exe()
    except Exception:
        return None


def installed_apps() -> list[dict[str, Any]]:
    """List installed programs from Windows registry and Start Menu shortcuts."""
    import winreg

    results: dict[str, dict[str, Any]] = {}
    reg_paths = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]

    for hive, sub_key in reg_paths:
        try:
            key = winreg.OpenKey(hive, sub_key)
        except OSError:
            continue
        try:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(key, i)
                    i += 1
                except OSError:
                    break
                try:
                    app_key = winreg.OpenKey(key, name)
                except OSError:
                    continue
                try:
                    display_name = winreg.QueryValueEx(app_key, "DisplayName")[0]
                except OSError:
                    winreg.CloseKey(app_key)
                    continue
                # Use the registry key name as a stable identifier (like bundleId)
                try:
                    install_location = winreg.QueryValueEx(app_key, "InstallLocation")[0]
                except OSError:
                    install_location = ""
                try:
                    display_icon = winreg.QueryValueEx(app_key, "DisplayIcon")[0]
                except OSError:
                    display_icon = ""
                normalized_icon = str(display_icon).split(",")[0].strip().strip('"')
                normalized_install_location = str(install_location).strip().strip('"')

                bundle_id = name
                for candidate in (normalized_icon, normalized_install_location):
                    if not candidate:
                        continue
                    candidate_path = Path(candidate)
                    if candidate_path.suffix.lower() == ".exe":
                        bundle_id = candidate_path.stem
                        break

                app_path = normalized_icon or normalized_install_location or ""
                if bundle_id not in results:
                    results[bundle_id] = {
                        "bundleId": bundle_id,
                        "displayName": str(display_name),
                        "path": app_path,
                    }
                winreg.CloseKey(app_key)
        finally:
            winreg.CloseKey(key)

    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def running_apps() -> list[dict[str, Any]]:
    """List running GUI applications."""
    import psutil

    apps: list[dict[str, Any]] = []
    seen: set[str] = set()

    for proc in psutil.process_iter(["pid", "name", "exe"]):
        try:
            name = proc.info["name"] or ""
            exe_path = proc.info["exe"] or ""
            if not name or name in seen:
                continue
            # Skip system/background processes (no window)
            if not exe_path:
                continue
            seen.add(name)
            # Use exe name (without .exe) as bundleId
            bundle_id = Path(exe_path).stem if exe_path else name
            apps.append({"bundleId": bundle_id, "displayName": name})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return sorted(apps, key=lambda item: item["displayName"].lower())


def app_display_name(bundle_id: str) -> str | None:
    """Find display name for a given bundleId (exe stem or registry key)."""
    import psutil
    for proc in psutil.process_iter(["name", "exe"]):
        try:
            exe = proc.info["exe"] or ""
            if exe and Path(exe).stem == bundle_id:
                return proc.info["name"]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


def frontmost_app() -> dict[str, str] | None:
    """Get the currently focused (foreground) application."""
    import win32gui
    import win32process
    import psutil

    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return None
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        proc = psutil.Process(pid)
        exe_path = proc.exe()
        return {
            "bundleId": Path(exe_path).stem,
            "displayName": proc.name(),
        }
    except Exception:
        return None


def app_under_point(x: int, y: int) -> dict[str, str] | None:
    """Find the app whose window is under the given screen coordinate."""
    import win32gui
    import win32process
    import psutil

    hwnd = win32gui.WindowFromPoint((x, y))
    if not hwnd:
        return frontmost_app()
    # Walk up to the top-level owner
    root = win32gui.GetAncestor(hwnd, 3)  # GA_ROOTOWNER = 3
    if root:
        hwnd = root
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        proc = psutil.Process(pid)
        exe_path = proc.exe()
        return {
            "bundleId": Path(exe_path).stem,
            "displayName": proc.name(),
        }
    except Exception:
        return frontmost_app()


def find_window_displays(bundle_ids: list[str]) -> list[dict[str, Any]]:
    """For each bundleId, find which display(s) its windows are on."""
    if not bundle_ids:
        return []

    displays = get_displays()
    windows = list_windows()

    # Build exe-stem -> ownerName mapping
    names_by_bundle: dict[str, str | None] = {}
    for bid in bundle_ids:
        names_by_bundle[bid] = app_display_name(bid)

    result = []
    for bundle_id in bundle_ids:
        target_name = names_by_bundle.get(bundle_id)
        display_ids: set[int] = set()
        for window in windows:
            owner = window["ownerName"]
            if not owner:
                continue
            # Match by exe name
            owner_stem = Path(owner).stem if owner.endswith(".exe") else owner
            if target_name and owner != target_name and owner_stem != bundle_id:
                continue
            if not target_name and owner_stem != bundle_id and owner != bundle_id:
                continue
            # Check which displays this window overlaps
            wx = window["bounds"]["x"]
            wy = window["bounds"]["y"]
            ww = window["bounds"]["width"]
            wh = window["bounds"]["height"]
            for display in displays:
                dx = display["originX"]
                dy = display["originY"]
                dw = display["width"]
                dh = display["height"]
                # Check rectangle intersection
                if wx < dx + dw and wx + ww > dx and wy < dy + dh and wy + wh > dy:
                    display_ids.add(int(display["displayId"]))
        result.append({"bundleId": bundle_id, "displayIds": sorted(display_ids)})
    return result


def open_app(bundle_id: str) -> None:
    """Open an application by its bundleId (exe path or program name)."""
    # Try to find the exe path from registry
    import winreg
    exe_path = None

    reg_paths = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, sub_key in reg_paths:
        try:
            key = winreg.OpenKey(hive, sub_key)
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(key, i)
                    i += 1
                except OSError:
                    break
                try:
                    app_key = winreg.OpenKey(key, name)
                except OSError:
                    continue
                try:
                    display_icon = winreg.QueryValueEx(app_key, "DisplayIcon")[0]
                except OSError:
                    display_icon = ""
                try:
                    install_location = winreg.QueryValueEx(app_key, "InstallLocation")[0]
                except OSError:
                    install_location = ""

                normalized_icon = str(display_icon).split(",")[0].strip().strip('"')
                normalized_install_location = str(install_location).strip().strip('"')

                derived_bundle_id = name
                for candidate in (normalized_icon, normalized_install_location):
                    if not candidate:
                        continue
                    candidate_path = Path(candidate)
                    if candidate_path.suffix.lower() == ".exe":
                        derived_bundle_id = candidate_path.stem
                        break

                if name == bundle_id or derived_bundle_id == bundle_id:
                    exe_path = normalized_icon or normalized_install_location or None
                    winreg.CloseKey(app_key)
                    break
                winreg.CloseKey(app_key)
            winreg.CloseKey(key)
            if exe_path:
                break
        except OSError:
            continue

    if exe_path and Path(exe_path).exists():
        os.startfile(exe_path)
    else:
        # Fallback: try to run it directly
        try:
            subprocess.Popen([bundle_id], shell=True)
        except Exception:
            raise RuntimeError(f"App not found for identifier: {bundle_id}")


# ---------------------------------------------------------------------------
# Clipboard (pyperclip — cross-platform)
# ---------------------------------------------------------------------------

def read_clipboard() -> str:
    import pyperclip
    try:
        return pyperclip.paste() or ""
    except Exception:
        return ""


def write_clipboard(text: str) -> None:
    import pyperclip
    pyperclip.copy(text)


def paste_clipboard() -> None:
    pyautogui.hotkey("ctrl", "v", interval=0.02)


# ---------------------------------------------------------------------------
# Permissions — Windows doesn't have macOS-style TCC
# ---------------------------------------------------------------------------

def check_permissions() -> dict[str, bool | None]:
    """Windows does not require explicit accessibility/screen-recording
    permissions like macOS TCC. Always report as granted."""
    return {
        "accessibility": True,
        "screenRecording": True,
    }


# ---------------------------------------------------------------------------
# Input actions
# ---------------------------------------------------------------------------

def move_cursor_absolute(x: int, y: int) -> None:
    """Use native SetCursorPos to avoid pyautogui coordinate drift on some setups."""
    try:
        import win32api
        win32api.SetCursorPos((int(x), int(y)))
        return
    except Exception:
        # Fallback for constrained environments
        pyautogui.moveTo(int(x), int(y))


def _mouse_toggle_native(button: str, down: bool) -> None:
    import win32api
    import win32con

    btn = (button or "left").lower()
    if btn == "right":
        flag = win32con.MOUSEEVENTF_RIGHTDOWN if down else win32con.MOUSEEVENTF_RIGHTUP
    elif btn in {"middle", "center"}:
        flag = win32con.MOUSEEVENTF_MIDDLEDOWN if down else win32con.MOUSEEVENTF_MIDDLEUP
    else:
        flag = win32con.MOUSEEVENTF_LEFTDOWN if down else win32con.MOUSEEVENTF_LEFTUP
    win32api.mouse_event(flag, 0, 0, 0, 0)


def _click_native(button: str, count: int) -> None:
    n = max(1, int(count))
    for i in range(n):
        _mouse_toggle_native(button, True)
        _mouse_toggle_native(button, False)
        if i + 1 < n:
            time.sleep(0.05)


def click(x: int, y: int, button: str, count: int, modifiers: list[str] | None) -> None:
    move_cursor_absolute(int(x), int(y))
    if modifiers:
        normalized = [normalize_key(m) for m in modifiers]
        for key in normalized:
            pyautogui.keyDown(key)
        try:
            _click_native(button, count)
        finally:
            for key in reversed(normalized):
                pyautogui.keyUp(key)
    else:
        _click_native(button, count)


def scroll(x: int, y: int, delta_x: int, delta_y: int) -> None:
    move_cursor_absolute(int(x), int(y))
    if delta_y:
        pyautogui.scroll(int(delta_y), x=x, y=y)
    if delta_x:
        pyautogui.hscroll(int(delta_x), x=x, y=y)


def drag(from_point: dict[str, Any] | None, to_point: dict[str, Any]) -> None:
    if from_point:
        sx = int(from_point["x"])
        sy = int(from_point["y"])
    else:
        try:
            import win32api
            sx, sy = win32api.GetCursorPos()
        except Exception:
            sx, sy = pyautogui.position()
            sx, sy = int(sx), int(sy)
    tx = int(to_point["x"])
    ty = int(to_point["y"])

    move_cursor_absolute(sx, sy)
    time.sleep(0.03)
    _mouse_toggle_native("left", True)
    time.sleep(0.03)
    # Midpoint improves drag recognition in some apps.
    mx = (sx + tx) // 2
    my = (sy + ty) // 2
    move_cursor_absolute(mx, my)
    time.sleep(0.03)
    move_cursor_absolute(tx, ty)
    time.sleep(0.03)
    _mouse_toggle_native("left", False)


def key_action(sequence: str, repeat: int = 1) -> None:
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    for _ in range(max(1, repeat)):
        if len(parts) == 1:
            pyautogui.press(parts[0])
        else:
            pyautogui.hotkey(*parts, interval=0.02)
        time.sleep(0.01)


def hold_keys(keys: list[str], duration_ms: int) -> None:
    normalized = [normalize_key(k) for k in keys]
    for key in normalized:
        pyautogui.keyDown(key)
    try:
        time.sleep(max(duration_ms, 0) / 1000)
    finally:
        for key in reversed(normalized):
            pyautogui.keyUp(key)


def type_text(text: str) -> None:
    pyautogui.write(text, interval=0.008)


# ---------------------------------------------------------------------------
# Main dispatcher — exact same command protocol as mac_helper.py
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args()
    payload = json.loads(args.payload)

    try:
        command = args.command
        if command == "check_permissions":
            perms = check_permissions()
            json_output({"ok": True, "result": perms})
            return 0
        if command == "list_displays":
            json_output({"ok": True, "result": get_displays()})
            return 0
        if command == "get_display_size":
            json_output({"ok": True, "result": choose_display(payload.get("displayId"))})
            return 0
        if command == "screenshot":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            result = capture_display(payload.get("displayId"), resize)
            json_output({"ok": True, "result": result})
            return 0
        if command == "resolve_prepare_capture":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            result = capture_display(payload.get("preferredDisplayId"), resize)
            result["hidden"] = []
            result["resolvedDisplayId"] = result["displayId"]
            json_output({"ok": True, "result": result})
            return 0
        if command == "zoom":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            region = {
                "left": int(payload["x"]),
                "top": int(payload["y"]),
                "width": int(payload["width"]),
                "height": int(payload["height"]),
            }
            json_output({"ok": True, "result": capture_region(region, resize)})
            return 0
        if command == "analyze_patch":
            patch_size = payload.get("patchSize")
            search_radius = payload.get("searchRadius")
            result = analyze_patch(
                payload.get("beforeBase64"),
                payload.get("afterBase64"),
                int(payload.get("x") or 0),
                int(payload.get("y") or 0),
                int(25 if patch_size is None else patch_size),
                int(40 if search_radius is None else search_radius),
                payload.get("beforePath"),
                payload.get("afterPath"),
            )
            json_output({"ok": True, "result": result})
            return 0
        if command == "prepare_for_action":
            json_output({"ok": True, "result": []})
            return 0
        if command == "preview_hide_set":
            json_output({"ok": True, "result": []})
            return 0
        if command == "find_window_displays":
            json_output({"ok": True, "result": find_window_displays(list(payload.get("bundleIds") or []))})
            return 0
        if command == "key":
            key_action(str(payload["keySequence"]), int(payload.get("repeat") or 1))
            json_output({"ok": True, "result": True})
            return 0
        if command == "hold_key":
            hold_keys(list(payload.get("keyNames") or []), int(payload.get("durationMs") or 0))
            json_output({"ok": True, "result": True})
            return 0
        if command == "type":
            type_text(str(payload.get("text") or ""))
            json_output({"ok": True, "result": True})
            return 0
        if command == "click":
            click(int(payload["x"]), int(payload["y"]), str(payload.get("button") or "left"), int(payload.get("count") or 1), payload.get("modifiers"))
            json_output({"ok": True, "result": True})
            return 0
        if command == "drag":
            drag(payload.get("from"), payload["to"])
            json_output({"ok": True, "result": True})
            return 0
        if command == "move_mouse":
            move_cursor_absolute(int(payload["x"]), int(payload["y"]))
            json_output({"ok": True, "result": True})
            return 0
        if command == "scroll":
            scroll(int(payload["x"]), int(payload["y"]), int(payload.get("deltaX") or 0), int(payload.get("deltaY") or 0))
            json_output({"ok": True, "result": True})
            return 0
        if command == "mouse_down":
            _mouse_toggle_native("left", True)
            json_output({"ok": True, "result": True})
            return 0
        if command == "mouse_up":
            _mouse_toggle_native("left", False)
            json_output({"ok": True, "result": True})
            return 0
        if command == "cursor_position":
            try:
                import win32api
                x, y = win32api.GetCursorPos()
            except Exception:
                x, y = pyautogui.position()
            json_output({"ok": True, "result": {"x": int(x), "y": int(y)}})
            return 0
        if command == "frontmost_app":
            json_output({"ok": True, "result": frontmost_app()})
            return 0
        if command == "app_under_point":
            json_output({"ok": True, "result": app_under_point(int(payload["x"]), int(payload["y"]))})
            return 0
        if command == "list_installed_apps":
            json_output({"ok": True, "result": installed_apps()})
            return 0
        if command == "list_running_apps":
            json_output({"ok": True, "result": running_apps()})
            return 0
        if command == "open_app":
            open_app(str(payload["bundleId"]))
            json_output({"ok": True, "result": True})
            return 0
        if command == "read_clipboard":
            json_output({"ok": True, "result": read_clipboard()})
            return 0
        if command == "write_clipboard":
            write_clipboard(str(payload.get("text") or ""))
            json_output({"ok": True, "result": True})
            return 0
        if command == "paste_clipboard":
            paste_clipboard()
            json_output({"ok": True, "result": True})
            return 0
        error_output(f"Unknown command: {command}", code="bad_command")
        return 2
    except Exception as exc:
        error_output(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
