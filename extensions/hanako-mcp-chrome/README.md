# Hanako MCP Chrome Extension (No Anthropic Account)

This extension speaks directly to Hanako's native host + MCP socket bridge.
It does **not** require signing in to an Anthropic account.

## Extension ID

`ngcldcdhlkapibhbofllhlafkhmeehpb`

The ID is fixed by the `manifest.json` key so `allowed_origins` can be pre-whitelisted by Hanako.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/tc/PythonProject/openhanako/extensions/hanako-mcp-chrome`

## Verify MCP Link

1. Start Hanako normally.
2. Make sure Hanako writes native host manifest (it happens automatically when `claude-in-chrome` provider is active).
3. In Hanako, run browser tools (`mcp__claude_in_chrome__tabs_context_mcp` first).
4. You should see tool responses from this extension without any Anthropic login flow.

## Tool Coverage

Implemented tool handlers for local-mode Claude-in-Chrome MCP:

- `tabs_context_mcp`
- `tabs_create_mcp`
- `navigate`
- `resize_window`
- `javascript_tool`
- `read_page`
- `find`
- `form_input`
- `computer`
- `gif_creator`
- `upload_image`
- `get_page_text`
- `update_plan`
- `read_console_messages`
- `read_network_requests`
- `shortcuts_list`
- `shortcuts_execute`

## Optional: Extra Extension IDs

If you use additional custom extension builds, set:

- `HANAKO_CHROME_EXTENSION_IDS=id1,id2,...`

Hanako will append these IDs to native host `allowed_origins`.

## Optional: Custom Native Host Name

If you want a custom host identifier:

- set `HANAKO_CHROME_NATIVE_HOST_IDENTIFIER`
- update `HOST_NAME` in `service_worker.js` to the same value
