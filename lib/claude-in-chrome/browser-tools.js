export const BROWSER_TOOLS = [
  {
    name: "tabs_context_mcp",
    description:
      "Get current browser tab context in the MCP tab group. Call this first before other browser tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "tabs_create_mcp",
    description: "Create a new tab in the MCP tab group and return its tabId.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description:
      "Navigate a tab to a URL, or use 'back'/'forward' for history navigation.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        url: { type: "string" },
      },
      required: ["tabId", "url"],
      additionalProperties: true,
    },
  },
  {
    name: "read_page",
    description:
      "Read accessibility tree from page. Supports filter/depth/ref_id/max_chars.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        filter: { type: "string", enum: ["interactive", "all"] },
        depth: { type: "number" },
        ref_id: { type: "string" },
        max_chars: { type: "number" },
      },
      required: ["tabId"],
      additionalProperties: true,
    },
  },
  {
    name: "find",
    description: "Find page elements by natural-language query.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        query: { type: "string" },
      },
      required: ["tabId", "query"],
      additionalProperties: true,
    },
  },
  {
    name: "form_input",
    description: "Set value for form element by ref or selector mapping.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        ref: { type: "string" },
        value: { type: ["string", "number", "boolean"] },
      },
      required: ["tabId", "ref", "value"],
      additionalProperties: true,
    },
  },
  {
    name: "javascript_tool",
    description: "Execute JavaScript in the target tab context.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        action: { type: "string" },
        text: { type: "string" },
      },
      required: ["tabId", "action", "text"],
      additionalProperties: true,
    },
  },
  {
    name: "computer",
    description:
      "Mouse/keyboard/screenshot actions in browser viewport. Supports click/type/scroll/key/wait/zoom etc.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        action: { type: "string" },
        coordinate: { type: "array", items: { type: "number" } },
        start_coordinate: { type: "array", items: { type: "number" } },
        region: { type: "array", items: { type: "number" } },
        text: { type: "string" },
        duration: { type: "number" },
        scroll_direction: { type: "string" },
        scroll_amount: { type: "number" },
        ref: { type: "string" },
        modifiers: { type: "string" },
      },
      required: ["tabId", "action"],
      additionalProperties: true,
    },
  },
  {
    name: "resize_window",
    description: "Resize browser window for a tab's window.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["tabId", "width", "height"],
      additionalProperties: true,
    },
  },
  {
    name: "gif_creator",
    description: "Start/stop/export GIF recording for browser interactions.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        action: { type: "string" },
      },
      required: ["tabId", "action"],
      additionalProperties: true,
    },
  },
  {
    name: "upload_image",
    description: "Upload local image file to current page input/dropzone.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        path: { type: "string" },
        ref: { type: "string" },
      },
      required: ["tabId", "path"],
      additionalProperties: true,
    },
  },
  {
    name: "get_page_text",
    description: "Extract plain text content from current page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
      required: ["tabId"],
      additionalProperties: true,
    },
  },
  {
    name: "update_plan",
    description: "Update/show automation style execution plan card inside extension.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  },
  {
    name: "read_console_messages",
    description: "Read console logs for tab; support pattern filtering.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        pattern: { type: "string" },
      },
      required: ["tabId"],
      additionalProperties: true,
    },
  },
  {
    name: "read_network_requests",
    description: "Read captured network requests for tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
      required: ["tabId"],
      additionalProperties: true,
    },
  },
  {
    name: "shortcuts_list",
    description: "List configured browser automation shortcuts.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
      required: ["tabId"],
      additionalProperties: true,
    },
  },
  {
    name: "shortcuts_execute",
    description: "Execute a configured shortcut by id.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        shortcut_id: { type: "string" },
      },
      required: ["tabId", "shortcut_id"],
      additionalProperties: true,
    },
  },
];
