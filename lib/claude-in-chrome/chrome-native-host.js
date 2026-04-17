import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import {
  getSecureSocketPath,
  getSocketDir,
} from "./common.js";

const VERSION = "1.0.0";
const MAX_MESSAGE_SIZE = 1024 * 1024;

function debugLog(...args) {
  if (String(process.env.HANAKO_CHROME_DEBUG || "").trim() !== "1") return;
  // eslint-disable-next-line no-console
  console.error("[hanako-chrome-native-host]", ...args);
}

export function sendChromeMessage(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const bytes = Buffer.from(text, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(bytes.length, 0);
  process.stdout.write(head);
  process.stdout.write(bytes);
}

class ChromeMessageReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.waiter = null;

    process.stdin.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._tryResolve();
    });
    process.stdin.on("end", () => {
      this.closed = true;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(null);
      }
    });
    process.stdin.on("error", () => {
      this.closed = true;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(null);
      }
    });
  }

  _extract() {
    if (this.buffer.length < 4) return undefined;
    const length = this.buffer.readUInt32LE(0);
    if (length <= 0 || length > MAX_MESSAGE_SIZE) {
      this.buffer = Buffer.alloc(0);
      return null;
    }
    if (this.buffer.length < 4 + length) return undefined;

    const body = this.buffer.subarray(4, 4 + length);
    this.buffer = this.buffer.subarray(4 + length);
    return body.toString("utf8");
  }

  _tryResolve() {
    if (!this.waiter) return;
    const next = this._extract();
    if (next === undefined) return;
    const resolve = this.waiter;
    this.waiter = null;
    resolve(next);
  }

  async read() {
    if (this.closed) return null;
    const immediate = this._extract();
    if (immediate !== undefined) return immediate;
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

class NativeHostBridge {
  constructor() {
    this.server = null;
    this.running = false;
    this.socketPath = null;
    this.nextClientId = 1;
    this.clients = new Map();
  }

  async start() {
    if (this.running) return;

    this.socketPath = getSecureSocketPath();

    if (process.platform !== "win32") {
      const socketDir = getSocketDir();
      try {
        const dirStat = fs.statSync(socketDir);
        if (!dirStat.isDirectory()) {
          fs.rmSync(socketDir, { force: true });
        }
      } catch {
        // ignore
      }

      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(socketDir, 0o700); } catch {}

      // cleanup stale sockets
      try {
        for (const file of fs.readdirSync(socketDir)) {
          if (!file.endsWith(".sock")) continue;
          const pid = Number.parseInt(file.replace(/\.sock$/, ""), 10);
          if (!Number.isInteger(pid) || pid <= 1) {
            try { fs.rmSync(path.join(socketDir, file), { force: true }); } catch {}
            continue;
          }
          try {
            process.kill(pid, 0);
          } catch {
            try { fs.rmSync(path.join(socketDir, file), { force: true }); } catch {}
          }
        }
      } catch {
        // ignore
      }
    }

    await new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onClient(socket));
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });

    if (process.platform !== "win32") {
      try { fs.chmodSync(this.socketPath, 0o600); } catch {}
    }

    this.running = true;
    debugLog("socket listening", this.socketPath);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    for (const client of this.clients.values()) {
      try { client.socket.destroy(); } catch {}
    }
    this.clients.clear();

    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }

    if (process.platform !== "win32" && this.socketPath) {
      try { fs.rmSync(this.socketPath, { force: true }); } catch {}
      try {
        const dir = getSocketDir();
        const left = fs.readdirSync(dir);
        if (left.length === 0) fs.rmdirSync(dir);
      } catch {
        // ignore
      }
    }
  }

  _broadcastMessage(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(payload.length, 0);
    const packet = Buffer.concat([head, payload]);

    for (const [id, client] of this.clients.entries()) {
      try {
        client.socket.write(packet);
      } catch {
        try { client.socket.destroy(); } catch {}
        this.clients.delete(id);
      }
    }
  }

  async handleChromeMessage(messageText) {
    let msg = null;
    try {
      msg = JSON.parse(String(messageText || "{}"));
    } catch {
      sendChromeMessage({ type: "error", error: "Invalid message format" });
      return;
    }

    const type = String(msg?.type || "");
    switch (type) {
      case "ping":
        sendChromeMessage({ type: "pong", timestamp: Date.now() });
        return;
      case "get_status":
        sendChromeMessage({ type: "status_response", native_host_version: VERSION });
        return;
      case "tool_response": {
        const { type: _ignored, ...data } = msg;
        this._broadcastMessage(data);
        return;
      }
      case "notification": {
        const { type: _ignored, ...data } = msg;
        this._broadcastMessage(data);
        return;
      }
      default:
        sendChromeMessage({ type: "error", error: `Unknown message type: ${type || "unknown"}` });
    }
  }

  _onClient(socket) {
    const clientId = this.nextClientId++;
    const client = {
      socket,
      buffer: Buffer.alloc(0),
    };
    this.clients.set(clientId, client);

    sendChromeMessage({ type: "mcp_connected" });

    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);

      while (client.buffer.length >= 4) {
        const length = client.buffer.readUInt32LE(0);
        if (length <= 0 || length > MAX_MESSAGE_SIZE) {
          socket.destroy();
          return;
        }
        if (client.buffer.length < 4 + length) break;

        const payload = client.buffer.subarray(4, 4 + length);
        client.buffer = client.buffer.subarray(4 + length);

        let req;
        try {
          req = JSON.parse(payload.toString("utf8"));
        } catch {
          continue;
        }

        sendChromeMessage({
          type: "tool_request",
          method: req?.method,
          params: req?.params,
        });
      }
    });

    const cleanup = () => {
      if (!this.clients.has(clientId)) return;
      this.clients.delete(clientId);
      sendChromeMessage({ type: "mcp_disconnected" });
    };

    socket.on("error", cleanup);
    socket.on("close", cleanup);
  }
}

export async function runChromeNativeHost() {
  const bridge = new NativeHostBridge();
  const reader = new ChromeMessageReader();

  await bridge.start();

  while (true) {
    const message = await reader.read();
    if (message === null) break;
    await bridge.handleChromeMessage(message);
  }

  await bridge.stop();
}
