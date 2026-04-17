import { createConnection } from "net";

export class SocketConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SocketConnectionError";
  }
}

function isNotification(message) {
  return !!message && typeof message === "object"
    && typeof message.method === "string"
    && !Object.prototype.hasOwnProperty.call(message, "result")
    && !Object.prototype.hasOwnProperty.call(message, "error");
}

export class McpSocketClient {
  constructor({ serverName, logger, getSocketPaths }) {
    this.serverName = serverName || "claude-in-chrome";
    this.logger = logger || console;
    this.getSocketPaths = getSocketPaths;

    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.responseBuffer = Buffer.alloc(0);
    this.responseCallback = null;
    this.notificationHandler = null;
  }

  setNotificationHandler(handler) {
    this.notificationHandler = typeof handler === "function" ? handler : null;
  }

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    this.responseBuffer = Buffer.alloc(0);
    this.responseCallback = null;
  }

  async ensureConnected() {
    if (this.connected && this.socket) return true;
    if (this.connecting) {
      return this._waitForConnection();
    }

    const candidates = Array.isArray(this.getSocketPaths?.())
      ? this.getSocketPaths().filter(Boolean)
      : [];
    if (candidates.length === 0) {
      throw new SocketConnectionError("No socket path candidates available");
    }

    let lastError = null;
    for (const socketPath of candidates) {
      try {
        await this._connectTo(socketPath);
        return true;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new SocketConnectionError("Failed to connect to chrome native host socket");
  }

  _waitForConnection() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.connected && this.socket) return resolve(true);
        if (!this.connecting) return reject(new SocketConnectionError("Socket connection attempt failed"));
        if (Date.now() - started > 5000) {
          return reject(new SocketConnectionError("Connection timed out after 5000ms"));
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  _connectTo(socketPath) {
    this.disconnect();
    this.connecting = true;

    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.connecting = false;
        socket.removeAllListeners();
        socket.destroy();
        reject(new SocketConnectionError(err?.message || String(err || "connect failed")));
      };

      const timeout = setTimeout(() => {
        fail(new Error(`connect timeout: ${socketPath}`));
      }, 4000);

      socket.on("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.socket = socket;
        this.connected = true;
        this.connecting = false;
        this._attachSocketHandlers(socket);
        resolve(true);
      });

      socket.on("error", fail);
    });
  }

  _attachSocketHandlers(socket) {
    socket.on("data", (data) => {
      this.responseBuffer = Buffer.concat([this.responseBuffer, data]);

      while (this.responseBuffer.length >= 4) {
        const length = this.responseBuffer.readUInt32LE(0);
        if (this.responseBuffer.length < 4 + length) break;

        const payload = this.responseBuffer.slice(4, 4 + length);
        this.responseBuffer = this.responseBuffer.slice(4 + length);

        let message;
        try {
          message = JSON.parse(payload.toString("utf-8"));
        } catch {
          continue;
        }

        if (isNotification(message)) {
          this.notificationHandler?.(message);
          continue;
        }

        if (this.responseCallback) {
          const cb = this.responseCallback;
          this.responseCallback = null;
          cb(message);
        }
      }
    });

    socket.on("close", () => {
      this.connected = false;
      this.connecting = false;
      if (this.socket === socket) this.socket = null;
    });

    socket.on("error", () => {
      this.connected = false;
      this.connecting = false;
      if (this.socket === socket) this.socket = null;
    });
  }

  async callTool(name, args = {}) {
    await this.ensureConnected();
    const normalizedArgs = normalizeToolArgs(name, args);

    const request = {
      method: "execute_tool",
      params: {
        client_id: "hanako",
        tool: name,
        args: normalizedArgs,
      },
    };

    return this._sendRequest(request);
  }

  _sendRequest(request) {
    if (!this.socket || !this.connected) {
      throw new SocketConnectionError("Socket is not connected");
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responseCallback = null;
        reject(new SocketConnectionError("Tool request timed out after 30000ms"));
      }, 30000);

      this.responseCallback = (response) => {
        clearTimeout(timeout);
        resolve(response);
      };

      const data = Buffer.from(JSON.stringify(request), "utf-8");
      const head = Buffer.alloc(4);
      head.writeUInt32LE(data.length, 0);
      this.socket.write(Buffer.concat([head, data]));
    });
  }
}

function normalizeToolArgs(name, args = {}) {
  const toolName = String(name || "").trim();
  const payload = (args && typeof args === "object") ? { ...args } : {};
  if (toolName !== "computer") return payload;

  const raw = String(payload.action || "").trim();
  if (!raw) return payload;

  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  const aliases = {
    click: "left_click",
    tap: "left_click",
    move: "hover",
    move_mouse: "hover",
    rightclick: "right_click",
    doubleclick: "double_click",
    tripleclick: "triple_click",
    drag: "left_click_drag",
    drag_to: "left_click_drag",
  };

  payload.action = aliases[normalized] || normalized;
  return payload;
}
