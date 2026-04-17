const HOST_NAME = 'com.anthropic.claude_code_browser_extension'
const EXTENSION_VERSION = '0.1.0'
const MCP_GROUP_TITLE = 'Claude MCP'
const MAX_TEXT_CHARS_DEFAULT = 50000
const MAX_IMAGE_STORE = 80
const MAX_GIF_FRAMES = 120
const NATIVE_RECONNECT_MS = 2000

const DEFAULT_SHORTCUTS = [
  {
    id: 'workflow_debug_console',
    command: 'debug_console',
    description: 'Collect recent console errors and warnings for this tab',
    isWorkflow: true,
  },
  {
    id: 'workflow_capture_state',
    command: 'capture_state',
    description: 'Capture current page screenshot and text content',
    isWorkflow: true,
  },
]

const state = {
  nativePort: null,
  nativeReconnectTimer: null,
  mcpConnected: false,
  groupId: null,
  groupWindowId: null,
  refsByTab: new Map(),
  nextRefIdByTab: new Map(),
  imageStore: new Map(),
  gifSessions: new Map(),
  shortcuts: DEFAULT_SHORTCUTS.slice(),
  debuggerAttachedTabs: new Set(),
  consoleLogsByTab: new Map(),
  networkStoreByTab: new Map(),
}

init().catch(error => {
  log('init failed', error)
})

chrome.runtime.onInstalled.addListener(() => {
  void init()
})

chrome.runtime.onStartup.addListener(() => {
  void init()
})

chrome.tabs.onRemoved.addListener(tabId => {
  cleanupTabState(tabId)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === 'string' && changeInfo.url.length > 0) {
    state.consoleLogsByTab.set(tabId, [])
    state.networkStoreByTab.set(tabId, { entries: [], byRequestId: new Map() })
  }
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (typeof tabId !== 'number') {
    return
  }

  if (method === 'Runtime.consoleAPICalled') {
    const level = String(params?.type || 'log')
    const args = Array.isArray(params?.args) ? params.args : []
    const text = args.map(remoteObjectToText).join(' ')
    pushConsoleLog(tabId, {
      timestamp: Date.now(),
      level,
      text,
      source: 'console',
      url: extractConsoleCallUrl(params),
    })
    return
  }

  if (method === 'Runtime.exceptionThrown') {
    const details = params?.exceptionDetails || {}
    const message = String(
      details?.exception?.description || details?.text || 'Exception thrown',
    )
    pushConsoleLog(tabId, {
      timestamp: Date.now(),
      level: 'error',
      text: message,
      source: 'exception',
      url: details?.url,
    })
    return
  }

  if (method === 'Log.entryAdded') {
    const entry = params?.entry || {}
    pushConsoleLog(tabId, {
      timestamp: Date.now(),
      level: String(entry?.level || 'info'),
      text: String(entry?.text || ''),
      source: 'log',
      url: entry?.url,
    })
    return
  }

  if (method === 'Network.requestWillBeSent') {
    const request = params?.request || {}
    const requestId = String(params?.requestId || '')
    if (!requestId) return

    const store = getNetworkStore(tabId)
    const entry = {
      requestId,
      url: String(request.url || ''),
      method: String(request.method || 'GET'),
      type: String(params?.type || ''),
      status: null,
      ok: null,
      failed: false,
      errorText: null,
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      mimeType: null,
    }

    store.entries.push(entry)
    store.byRequestId.set(requestId, entry)
    if (store.entries.length > 500) {
      store.entries.splice(0, store.entries.length - 500)
    }
    return
  }

  if (method === 'Network.responseReceived') {
    const requestId = String(params?.requestId || '')
    const response = params?.response || {}
    const store = getNetworkStore(tabId)
    const entry = store.byRequestId.get(requestId)
    if (!entry) return

    entry.status = Number(response?.status || 0)
    entry.ok = entry.status >= 200 && entry.status < 400
    entry.mimeType = response?.mimeType ? String(response.mimeType) : null
    return
  }

  if (method === 'Network.loadingFinished') {
    const requestId = String(params?.requestId || '')
    const store = getNetworkStore(tabId)
    const entry = store.byRequestId.get(requestId)
    if (!entry) return

    entry.finishedAt = Date.now()
    entry.durationMs = entry.finishedAt - entry.startedAt
    return
  }

  if (method === 'Network.loadingFailed') {
    const requestId = String(params?.requestId || '')
    const store = getNetworkStore(tabId)
    const entry = store.byRequestId.get(requestId)
    if (!entry) return

    entry.failed = true
    entry.errorText = String(params?.errorText || 'request_failed')
    entry.finishedAt = Date.now()
    entry.durationMs = entry.finishedAt - entry.startedAt
  }
})

chrome.debugger.onDetach.addListener(source => {
  const tabId = source.tabId
  if (typeof tabId === 'number') {
    state.debuggerAttachedTabs.delete(tabId)
  }
})

async function init() {
  await restorePersistentState()
  connectNativeHost()
}

async function restorePersistentState() {
  const data = await chrome.storage.local.get(['mcp_group', 'mcp_shortcuts'])
  const group = data?.mcp_group
  if (group && typeof group === 'object') {
    if (typeof group.groupId === 'number') {
      state.groupId = group.groupId
    }
    if (typeof group.windowId === 'number') {
      state.groupWindowId = group.windowId
    }
  }

  const storedShortcuts = data?.mcp_shortcuts
  if (Array.isArray(storedShortcuts) && storedShortcuts.length > 0) {
    state.shortcuts = storedShortcuts
      .map(item => normalizeShortcut(item))
      .filter(Boolean)
  }
}

function normalizeShortcut(item) {
  if (!item || typeof item !== 'object') return null
  const id = typeof item.id === 'string' ? item.id : null
  const command = typeof item.command === 'string' ? item.command : null
  const description =
    typeof item.description === 'string' ? item.description : 'Shortcut'
  const isWorkflow = Boolean(item.isWorkflow)
  if (!id || !command) return null
  return { id, command, description, isWorkflow }
}

function connectNativeHost() {
  if (state.nativePort) {
    return
  }

  try {
    const port = chrome.runtime.connectNative(HOST_NAME)
    state.nativePort = port

    port.onMessage.addListener(message => {
      void handleNativeMessage(message)
    })

    port.onDisconnect.addListener(() => {
      state.nativePort = null
      state.mcpConnected = false

      const lastError = chrome.runtime.lastError
      if (lastError?.message) {
        log('native host disconnected', lastError.message)
      }
      scheduleNativeReconnect()
    })

    postNativeMessage({ type: 'get_status' })
  } catch (error) {
    log('failed to connect native host', error)
    scheduleNativeReconnect()
  }
}

function scheduleNativeReconnect() {
  if (state.nativeReconnectTimer) {
    return
  }
  state.nativeReconnectTimer = setTimeout(() => {
    state.nativeReconnectTimer = null
    connectNativeHost()
  }, NATIVE_RECONNECT_MS)
}

function postNativeMessage(payload) {
  if (!state.nativePort) {
    return
  }
  try {
    state.nativePort.postMessage(payload)
  } catch (error) {
    log('postNativeMessage failed', error)
  }
}

async function handleNativeMessage(message) {
  const type = typeof message?.type === 'string' ? message.type : ''

  if (type === 'ping') {
    postNativeMessage({ type: 'pong', timestamp: Date.now() })
    return
  }

  if (type === 'get_status') {
    postNativeMessage({
      type: 'status_response',
      native_host_version: '1.0.0',
      extension_version: EXTENSION_VERSION,
      mcp_connected: state.mcpConnected,
    })
    return
  }

  if (type === 'mcp_connected') {
    state.mcpConnected = true
    return
  }

  if (type === 'mcp_disconnected') {
    state.mcpConnected = false
    return
  }

  if (type !== 'tool_request') {
    postToolError(`Unsupported message type: ${type || 'unknown'}`)
    return
  }

  const method = typeof message?.method === 'string' ? message.method : ''
  const params = isObject(message?.params) ? message.params : {}
  const tool = typeof params?.tool === 'string' ? params.tool : ''
  const args = isObject(params?.args) ? params.args : {}

  if (method !== 'execute_tool' || !tool) {
    postToolError('Invalid tool request payload')
    return
  }

  try {
    const result = await dispatchTool(tool, args)
    postToolResult(result.content, result.isError)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    postToolError(messageText)
  }
}

function postToolResult(content, isError = false) {
  if (isError) {
    postNativeMessage({
      type: 'tool_response',
      error: { content },
    })
  } else {
    postNativeMessage({
      type: 'tool_response',
      result: { content },
    })
  }
}

function postToolError(text) {
  postToolResult([textItem(text)], true)
}

async function dispatchTool(tool, args) {
  switch (tool) {
    case 'tabs_context_mcp':
      return handleTabsContext(args)
    case 'tabs_create_mcp':
      return handleTabsCreate()
    case 'navigate':
      return handleNavigate(args)
    case 'resize_window':
      return handleResizeWindow(args)
    case 'javascript_tool':
      return handleJavascriptTool(args)
    case 'read_page':
      return handleReadPage(args)
    case 'find':
      return handleFind(args)
    case 'form_input':
      return handleFormInput(args)
    case 'computer':
      return handleComputer(args)
    case 'gif_creator':
      return handleGifCreator(args)
    case 'upload_image':
      return handleUploadImage(args)
    case 'get_page_text':
      return handleGetPageText(args)
    case 'update_plan':
      return handleUpdatePlan(args)
    case 'read_console_messages':
      return handleReadConsoleMessages(args)
    case 'read_network_requests':
      return handleReadNetworkRequests(args)
    case 'shortcuts_list':
      return handleShortcutsList(args)
    case 'shortcuts_execute':
      return handleShortcutsExecute(args)
    default:
      return errorResult(`Unsupported tool: ${tool}`)
  }
}

function okTextResult(text) {
  return {
    content: [textItem(text)],
    isError: false,
  }
}

function okResult(content) {
  return { content, isError: false }
}

function errorResult(text) {
  return {
    content: [textItem(text)],
    isError: true,
  }
}

function textItem(text) {
  return {
    type: 'text',
    text: String(text),
  }
}

function imageItem(base64Data, mimeType = 'image/png') {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeType,
      data: base64Data,
    },
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getTabIdArg(args) {
  const tabId = Number(args?.tabId)
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('tabId is required and must be a positive integer')
  }
  return tabId
}

function getRefMap(tabId) {
  if (!state.refsByTab.has(tabId)) {
    state.refsByTab.set(tabId, new Map())
  }
  return state.refsByTab.get(tabId)
}

function nextRefId(tabId) {
  const next = (state.nextRefIdByTab.get(tabId) || 1)
  state.nextRefIdByTab.set(tabId, next + 1)
  return `ref_${next}`
}

function registerSelectors(tabId, selectors) {
  const refMap = getRefMap(tabId)
  const refs = []
  for (const selector of selectors) {
    if (typeof selector !== 'string' || selector.length === 0) {
      refs.push(null)
      continue
    }
    const ref = nextRefId(tabId)
    refMap.set(ref, selector)
    refs.push(ref)
  }
  return refs
}

function resolveSelectorFromRef(tabId, ref) {
  const refMap = getRefMap(tabId)
  return refMap.get(ref) || null
}

function cleanupTabState(tabId) {
  state.refsByTab.delete(tabId)
  state.nextRefIdByTab.delete(tabId)
  state.gifSessions.delete(tabId)
  state.consoleLogsByTab.delete(tabId)
  state.networkStoreByTab.delete(tabId)
  state.debuggerAttachedTabs.delete(tabId)
}

async function ensureMcpGroup(createIfEmpty) {
  if (typeof state.groupId === 'number') {
    try {
      const group = await chrome.tabGroups.get(state.groupId)
      state.groupWindowId = group.windowId
      return { groupId: group.id, windowId: group.windowId }
    } catch {
      state.groupId = null
      state.groupWindowId = null
    }
  }

  const groups = await chrome.tabGroups.query({ title: MCP_GROUP_TITLE })
  if (groups.length > 0) {
    const group = groups[0]
    state.groupId = group.id
    state.groupWindowId = group.windowId
    await persistGroupState()
    return { groupId: group.id, windowId: group.windowId }
  }

  if (!createIfEmpty) {
    return null
  }

  const createdWindow = await chrome.windows.create({
    url: 'about:blank',
    focused: true,
    type: 'normal',
  })

  const tab = createdWindow.tabs?.[0]
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Failed to create initial tab for MCP group')
  }

  const groupId = await chrome.tabs.group({ tabIds: [tab.id] })
  await chrome.tabGroups.update(groupId, {
    title: MCP_GROUP_TITLE,
    color: 'blue',
    collapsed: false,
  })

  state.groupId = groupId
  state.groupWindowId = createdWindow.id || tab.windowId
  await persistGroupState()

  return {
    groupId,
    windowId: state.groupWindowId,
  }
}

async function persistGroupState() {
  await chrome.storage.local.set({
    mcp_group: {
      groupId: state.groupId,
      windowId: state.groupWindowId,
    },
  })
}

async function handleTabsContext(args) {
  const createIfEmpty = Boolean(args?.createIfEmpty)
  const group = await ensureMcpGroup(createIfEmpty)

  let tabs = []
  if (group) {
    tabs = await chrome.tabs.query({ groupId: group.groupId })
  } else {
    tabs = await chrome.tabs.query({ currentWindow: true })
  }

  const availableTabs = tabs
    .filter(tab => typeof tab.id === 'number')
    .map(tab => ({
      tabId: tab.id,
      title: tab.title || '(untitled)',
      url: tab.url || '',
      windowId: tab.windowId,
      groupId: tab.groupId,
      active: Boolean(tab.active),
    }))

  const human =
    availableTabs.length === 0
      ? 'No tabs available.'
      : availableTabs
          .map(tab => `- tabId ${tab.tabId}: "${tab.title}" (${tab.url})`)
          .join('\n')

  return okResult([
    textItem(JSON.stringify({ availableTabs })),
    textItem(`Tab Context:\n${human}`),
  ])
}

async function handleTabsCreate() {
  const group = await ensureMcpGroup(true)
  if (!group) {
    return errorResult('Failed to create MCP tab group')
  }

  const tab = await chrome.tabs.create({
    windowId: group.windowId,
    url: 'about:blank',
    active: true,
  })

  if (typeof tab.id !== 'number') {
    return errorResult('Failed to create new tab')
  }

  await chrome.tabs.group({
    groupId: group.groupId,
    tabIds: [tab.id],
  })

  return okResult([
    textItem(
      JSON.stringify({
        tabId: tab.id,
        title: tab.title || '(untitled)',
        url: tab.url || '',
      }),
    ),
    textItem(`Created new tab ${tab.id} in MCP group.`),
  ])
}

function normalizeTargetUrl(rawUrl) {
  if (rawUrl === 'back' || rawUrl === 'forward') {
    return rawUrl
  }
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('url is required')
  }
  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl
  }
  if (/^[a-z]+:/i.test(rawUrl)) {
    return rawUrl
  }
  return `https://${rawUrl}`
}

async function handleNavigate(args) {
  const tabId = getTabIdArg(args)
  const rawUrl = typeof args?.url === 'string' ? args.url.trim() : ''
  const target = normalizeTargetUrl(rawUrl)

  if (target === 'back' || target === 'forward') {
    await executeInTab(tabId, scriptNavigateHistory, [target])
    await sleep(300)
    await maybeRecordFrame(tabId, `navigate:${target}`)
    return okTextResult(`Navigated ${target}.`)
  }

  await chrome.tabs.update(tabId, { url: target, active: true })
  await waitForTabComplete(tabId, 15000)
  await maybeRecordFrame(tabId, `navigate:${target}`)

  return okTextResult(`Navigated tab ${tabId} to ${target}`)
}

function scriptNavigateHistory(direction) {
  if (direction === 'back') {
    history.back()
  } else if (direction === 'forward') {
    history.forward()
  }
  return { ok: true }
}

async function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      resolve(false)
    }, timeoutMs)

    const listener = (updatedTabId, changeInfo) => {
      if (done) return
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'complete') {
        done = true
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve(true)
      }
    }

    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function handleResizeWindow(args) {
  const tabId = getTabIdArg(args)
  const width = Number(args?.width)
  const height = Number(args?.height)

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return errorResult('width and height are required numbers')
  }

  const tab = await chrome.tabs.get(tabId)
  await chrome.windows.update(tab.windowId, {
    state: 'normal',
    width: Math.max(300, Math.round(width)),
    height: Math.max(200, Math.round(height)),
    focused: true,
  })

  await maybeRecordFrame(tabId, `resize:${width}x${height}`)

  return okTextResult(`Resized window to ${Math.round(width)}x${Math.round(height)}.`)
}

async function handleJavascriptTool(args) {
  const tabId = getTabIdArg(args)
  const code = typeof args?.text === 'string' ? args.text : ''

  if (!code) {
    return errorResult('text (JavaScript code) is required')
  }

  const result = await executeInTab(tabId, scriptEvaluateJs, [code])
  if (!isObject(result)) {
    return errorResult('Failed to execute JavaScript')
  }

  if (result.ok) {
    return okResult([textItem(String(result.value))])
  }

  return errorResult(String(result.error || 'JavaScript execution failed'))
}

async function scriptEvaluateJs(code) {
  try {
    let value
    try {
      const expressionRunner = new Function(`return (${code});`)
      value = expressionRunner()
    } catch {
      const statementRunner = new Function(code)
      value = statementRunner()
    }

    if (value && typeof value.then === 'function') {
      value = await value
    }

    return { ok: true, value: stringifyForTransport(value) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  function stringifyForTransport(value) {
    if (value === null || value === undefined) {
      return String(value)
    }
    if (typeof value === 'string') {
      return value
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
}

async function handleReadPage(args) {
  const tabId = getTabIdArg(args)
  const filter = args?.filter === 'interactive' ? 'interactive' : 'all'
  const depth = Math.max(1, Math.min(40, Number(args?.depth || 15)))
  const maxChars = Math.max(1000, Number(args?.max_chars || MAX_TEXT_CHARS_DEFAULT))
  const refId = typeof args?.ref_id === 'string' ? args.ref_id : null

  let rootSelector = null
  if (refId) {
    rootSelector = resolveSelectorFromRef(tabId, refId)
    if (!rootSelector) {
      return errorResult(`Unknown ref_id: ${refId}`)
    }
  }

  const payload = await executeInTab(tabId, scriptCollectPageTree, [
    {
      filter,
      depth,
      rootSelector,
    },
  ])

  if (!isObject(payload)) {
    return errorResult('Failed to read page content')
  }
  if (payload.error) {
    return errorResult(String(payload.error))
  }

  const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
  const selectors = nodes.map(node => (isObject(node) ? node.selector : null))
  const refs = registerSelectors(tabId, selectors)

  const lines = []
  const elementSummary = []

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (!isObject(node)) continue

    const ref = refs[i]
    if (!ref) continue

    const indent = '  '.repeat(Math.max(0, Number(node.depth || 0)))
    const tag = String(node.tag || 'element')
    const text = String(node.text || '').replace(/\s+/g, ' ').trim()
    const role = node.role ? ` role=${String(node.role)}` : ''
    const interactive = node.interactive ? ' [interactive]' : ''
    const clippedText = text.length > 120 ? `${text.slice(0, 117)}...` : text

    lines.push(`${indent}[${ref}] <${tag}>${role}${interactive} ${clippedText}`.trim())
    elementSummary.push({ ref, tag, text: clippedText, role: node.role || null })
  }

  let pretty = lines.join('\n')
  if (pretty.length > maxChars) {
    pretty = `${pretty.slice(0, maxChars)}\n\n[Output truncated to ${maxChars} characters. Narrow with ref_id or depth.]`
  }

  return okResult([
    textItem(JSON.stringify({ elements: elementSummary })),
    textItem(pretty || 'No elements found.'),
  ])
}

function scriptCollectPageTree(options) {
  const filter = options?.filter === 'interactive' ? 'interactive' : 'all'
  const depthLimit = Number.isFinite(options?.depth) ? options.depth : 15
  const rootSelector = typeof options?.rootSelector === 'string' ? options.rootSelector : null

  const root = rootSelector
    ? document.querySelector(rootSelector)
    : document.body || document.documentElement

  if (!root) {
    return { error: 'Unable to locate root element' }
  }

  const nodes = []
  const maxNodes = 2500

  const stack = [{ el: root, depth: 0 }]
  while (stack.length > 0 && nodes.length < maxNodes) {
    const { el, depth } = stack.pop()
    if (!(el instanceof Element)) {
      continue
    }

    if (depth > depthLimit) {
      continue
    }

    const interactive = isInteractive(el)
    if (filter === 'all' || interactive) {
      nodes.push({
        depth,
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        interactive,
        text: getElementText(el),
      })
    }

    const children = Array.from(el.children)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ el: children[i], depth: depth + 1 })
    }
  }

  return { nodes }

  function isInteractive(el) {
    if (!(el instanceof HTMLElement)) return false
    const tag = el.tagName.toLowerCase()
    if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'label'].includes(tag)) {
      return true
    }
    if (el.hasAttribute('contenteditable')) return true
    if (el.hasAttribute('onclick')) return true
    const role = (el.getAttribute('role') || '').toLowerCase()
    return ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab'].includes(role)
  }

  function getElementText(el) {
    const aria = el.getAttribute('aria-label') || ''
    const placeholder = el.getAttribute('placeholder') || ''
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    const merged = [aria, placeholder, text].filter(Boolean).join(' | ')
    return merged.slice(0, 220)
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return ''
    const parts = []
    let cursor = el
    while (cursor && cursor.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = cursor.tagName.toLowerCase()
      if (cursor.id) {
        part += `#${cssEscape(cursor.id)}`
        parts.unshift(part)
        break
      }
      const parent = cursor.parentElement
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          child => child.tagName === cursor.tagName,
        )
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(cursor) + 1
          part += `:nth-of-type(${index})`
        }
      }
      parts.unshift(part)
      cursor = parent
    }
    return parts.join(' > ')
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value)
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }
}

async function handleFind(args) {
  const tabId = getTabIdArg(args)
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return errorResult('query is required')
  }

  const payload = await executeInTab(tabId, scriptFindElements, [query])
  if (!isObject(payload)) {
    return errorResult('Failed to find elements')
  }

  const results = Array.isArray(payload.results) ? payload.results.slice(0, 20) : []
  if (results.length === 0) {
    return okTextResult(`No elements matched query: ${query}`)
  }

  const selectors = results.map(item => (isObject(item) ? item.selector : null))
  const refs = registerSelectors(tabId, selectors)

  const matches = []
  const lines = []

  for (let i = 0; i < results.length; i += 1) {
    const row = results[i]
    if (!isObject(row)) continue
    const ref = refs[i]
    if (!ref) continue

    const text = String(row.text || '').replace(/\s+/g, ' ').trim()
    const tag = String(row.tag || 'element')
    const score = Number(row.score || 0)

    matches.push({
      ref,
      tag,
      text,
      score,
    })

    lines.push(`[${ref}] <${tag}> score=${score.toFixed(2)} ${text}`)
  }

  return okResult([
    textItem(JSON.stringify({ query, matches })),
    textItem(lines.join('\n')),
  ])
}

function scriptFindElements(query) {
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const candidates = Array.from(
    document.querySelectorAll(
      'a,button,input,textarea,select,[role], [aria-label], [placeholder], [contenteditable="true"], [onclick]',
    ),
  )

  const scored = candidates
    .map(el => {
      if (!(el instanceof Element)) return null

      const text = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('placeholder') || '',
        (el.textContent || '').trim(),
        el.id || '',
        el.className || '',
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      const haystack = text.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += 1
        }
      }

      if (score === 0 && terms.length > 0) {
        return null
      }

      if (el.tagName.toLowerCase() === 'button') {
        score += 0.35
      }

      return {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 220),
        score,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  return {
    results: scored.slice(0, 50),
  }

  function cssPath(el) {
    const parts = []
    let cursor = el
    while (cursor && cursor.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = cursor.tagName.toLowerCase()
      if (cursor.id) {
        part += `#${cssEscape(cursor.id)}`
        parts.unshift(part)
        break
      }
      const parent = cursor.parentElement
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          child => child.tagName === cursor.tagName,
        )
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(cursor) + 1
          part += `:nth-of-type(${index})`
        }
      }
      parts.unshift(part)
      cursor = parent
    }
    return parts.join(' > ')
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value)
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }
}

async function handleFormInput(args) {
  const tabId = getTabIdArg(args)
  const ref = typeof args?.ref === 'string' ? args.ref : ''
  if (!ref) {
    return errorResult('ref is required')
  }

  const selector = resolveSelectorFromRef(tabId, ref)
  if (!selector) {
    return errorResult(`Unknown ref: ${ref}`)
  }

  const value = args?.value
  const payload = await executeInTab(tabId, scriptSetFormInput, [
    {
      selector,
      value,
    },
  ])

  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Failed to set form input'))
  }

  await maybeRecordFrame(tabId, `form_input:${ref}`)

  return okTextResult(`Set value for ${ref}`)
}

function scriptSetFormInput(input) {
  const selector = String(input?.selector || '')
  const value = input?.value

  const element = document.querySelector(selector)
  if (!(element instanceof Element)) {
    return { ok: false, error: 'Element not found' }
  }

  if (element instanceof HTMLInputElement) {
    const type = (element.type || '').toLowerCase()

    if (type === 'checkbox' || type === 'radio') {
      element.checked = Boolean(value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    }

    element.focus()
    element.value = value == null ? '' : String(value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }

  if (element instanceof HTMLTextAreaElement) {
    element.focus()
    element.value = value == null ? '' : String(value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }

  if (element instanceof HTMLSelectElement) {
    const target = value == null ? '' : String(value)
    const option = Array.from(element.options).find(
      item => item.value === target || item.text.trim() === target,
    )
    if (option) {
      element.value = option.value
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    }
    return { ok: false, error: 'Option not found' }
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus()
    element.innerText = value == null ? '' : String(value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true }
  }

  return { ok: false, error: 'Element type does not support form input' }
}

async function handleComputer(args) {
  const tabId = getTabIdArg(args)
  const rawAction = typeof args?.action === 'string' ? args.action : ''
  const action = normalizeComputerAction(rawAction)

  switch (action) {
    case 'screenshot':
      return handleComputerScreenshot(tabId)
    case 'zoom':
      return handleComputerZoom(tabId, args)
    case 'wait':
      return handleComputerWait(tabId, args)
    case 'scroll':
      return handleComputerScroll(tabId, args)
    case 'scroll_to':
      return handleComputerScrollTo(tabId, args)
    case 'type':
      return handleComputerType(tabId, args)
    case 'key':
      return handleComputerKey(tabId, args)
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click':
    case 'left_click_drag':
    case 'hover':
      return handleComputerMouse(tabId, action, args)
    default:
      return errorResult(`Unsupported computer action: ${rawAction || action}`)
  }
}

function normalizeComputerAction(rawAction) {
  const action = String(rawAction || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')

  const aliases = {
    click: 'left_click',
    tap: 'left_click',
    move: 'hover',
    move_mouse: 'hover',
    rightclick: 'right_click',
    doubleclick: 'double_click',
    tripleclick: 'triple_click',
    drag: 'left_click_drag',
    drag_to: 'left_click_drag',
  }

  return aliases[action] || action
}

async function handleComputerScreenshot(tabId) {
  const dataUrl = await captureTabScreenshot(tabId)
  if (!dataUrl) {
    return errorResult('Failed to capture screenshot')
  }

  const imageId = saveImageDataUrl(dataUrl)
  await maybeRecordFrame(tabId, 'screenshot')

  const { base64Data, mimeType } = splitDataUrl(dataUrl)
  return okResult([
    textItem(JSON.stringify({ imageId, mimeType })),
    imageItem(base64Data, mimeType),
  ])
}

async function handleComputerZoom(tabId, args) {
  const region = Array.isArray(args?.region) ? args.region.map(Number) : []
  if (region.length !== 4 || region.some(n => !Number.isFinite(n))) {
    return errorResult('zoom action requires region: [x0, y0, x1, y1]')
  }

  const [x0, y0, x1, y1] = region
  const x = Math.max(0, Math.min(x0, x1))
  const y = Math.max(0, Math.min(y0, y1))
  const w = Math.max(1, Math.abs(x1 - x0))
  const h = Math.max(1, Math.abs(y1 - y0))

  const dataUrl = await captureTabScreenshot(tabId)
  if (!dataUrl) {
    return errorResult('Failed to capture screenshot for zoom')
  }

  const cropped = await cropDataUrl(dataUrl, x, y, w, h)
  const imageId = saveImageDataUrl(cropped)

  const { base64Data, mimeType } = splitDataUrl(cropped)
  await maybeRecordFrame(tabId, 'zoom')

  return okResult([
    textItem(JSON.stringify({ imageId, mimeType, region: [x, y, w, h] })),
    imageItem(base64Data, mimeType),
  ])
}

async function handleComputerWait(tabId, args) {
  const duration = Math.max(0, Math.min(30, Number(args?.duration || 1)))
  await sleep(duration * 1000)
  await maybeRecordFrame(tabId, `wait:${duration}`)
  return okTextResult(`Waited ${duration} seconds.`)
}

async function handleComputerScroll(tabId, args) {
  const direction = typeof args?.scroll_direction === 'string' ? args.scroll_direction : 'down'
  const amount = Math.max(1, Math.min(10, Number(args?.scroll_amount || 3)))
  const delta = 280 * amount

  const deltas = {
    up: [0, -delta],
    down: [0, delta],
    left: [-delta, 0],
    right: [delta, 0],
  }

  const [dx, dy] = deltas[direction] || deltas.down
  await executeInTab(tabId, scriptScrollBy, [dx, dy])
  await maybeRecordFrame(tabId, `scroll:${direction}:${amount}`)
  return okTextResult(`Scrolled ${direction}.`)
}

function scriptScrollBy(dx, dy) {
  window.scrollBy(dx, dy)
  return { ok: true }
}

async function handleComputerScrollTo(tabId, args) {
  const ref = typeof args?.ref === 'string' ? args.ref : ''
  if (!ref) {
    return errorResult('scroll_to requires ref')
  }

  const selector = resolveSelectorFromRef(tabId, ref)
  if (!selector) {
    return errorResult(`Unknown ref: ${ref}`)
  }

  const payload = await executeInTab(tabId, scriptScrollToSelector, [selector])
  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Failed to scroll to element'))
  }

  await maybeRecordFrame(tabId, `scroll_to:${ref}`)
  return okTextResult(`Scrolled to ${ref}`)
}

function scriptScrollToSelector(selector) {
  const element = document.querySelector(selector)
  if (!(element instanceof Element)) {
    return { ok: false, error: 'Element not found' }
  }

  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
  return { ok: true }
}

async function handleComputerType(tabId, args) {
  const text = typeof args?.text === 'string' ? args.text : ''
  const payload = await executeInTab(tabId, scriptTypeIntoFocusedElement, [text])
  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Failed to type text'))
  }

  await maybeRecordFrame(tabId, 'type')
  return okTextResult('Typed text.')
}

function scriptTypeIntoFocusedElement(text) {
  const active = document.activeElement
  if (!active) {
    return { ok: false, error: 'No focused element' }
  }

  const value = text == null ? '' : String(text)

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? active.value.length
    const end = active.selectionEnd ?? active.value.length
    active.setRangeText(value, start, end, 'end')
    active.dispatchEvent(new Event('input', { bubbles: true }))
    active.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    active.focus()
    document.execCommand('insertText', false, value)
    active.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true }
  }

  return { ok: false, error: 'Focused element does not accept typing' }
}

async function handleComputerKey(tabId, args) {
  const text = typeof args?.text === 'string' ? args.text : ''
  const repeat = Math.max(1, Math.min(100, Number(args?.repeat || 1)))

  const payload = await executeInTab(tabId, scriptDispatchKeys, [text, repeat])
  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Failed to send key events'))
  }

  await maybeRecordFrame(tabId, `key:${text}`)
  return okTextResult(`Sent key sequence: ${text || '(empty)'}`)
}

function scriptDispatchKeys(sequence, repeat) {
  const tokens = String(sequence || '')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return { ok: false, error: 'No key sequence provided' }
  }

  const target = document.activeElement || document.body
  if (!(target instanceof EventTarget)) {
    return { ok: false, error: 'No valid keyboard target' }
  }

  for (let i = 0; i < repeat; i += 1) {
    for (const token of tokens) {
      const combo = token.split('+').map(k => k.trim().toLowerCase())
      const key = combo[combo.length - 1]
      const mods = combo.slice(0, -1)

      const eventInit = {
        key: normalizeKeyName(key),
        code: normalizeCodeName(key),
        bubbles: true,
        cancelable: true,
        ctrlKey: mods.includes('ctrl') || mods.includes('control'),
        shiftKey: mods.includes('shift'),
        altKey: mods.includes('alt') || mods.includes('option'),
        metaKey:
          mods.includes('cmd') ||
          mods.includes('meta') ||
          mods.includes('win') ||
          mods.includes('windows'),
      }

      target.dispatchEvent(new KeyboardEvent('keydown', eventInit))
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit))
    }
  }

  return { ok: true }

  function normalizeKeyName(name) {
    if (name === 'enter') return 'Enter'
    if (name === 'escape' || name === 'esc') return 'Escape'
    if (name === 'backspace') return 'Backspace'
    if (name === 'delete' || name === 'del') return 'Delete'
    if (name === 'tab') return 'Tab'
    if (name === 'space') return ' '
    if (name === 'arrowup') return 'ArrowUp'
    if (name === 'arrowdown') return 'ArrowDown'
    if (name === 'arrowleft') return 'ArrowLeft'
    if (name === 'arrowright') return 'ArrowRight'
    return name.length === 1 ? name : name.charAt(0).toUpperCase() + name.slice(1)
  }

  function normalizeCodeName(name) {
    if (name.length === 1) {
      const ch = name.toUpperCase()
      if (/[A-Z]/.test(ch)) return `Key${ch}`
      if (/[0-9]/.test(ch)) return `Digit${ch}`
    }
    if (name === 'enter') return 'Enter'
    if (name === 'tab') return 'Tab'
    if (name === 'space') return 'Space'
    if (name === 'backspace') return 'Backspace'
    if (name === 'delete') return 'Delete'
    if (name === 'arrowup') return 'ArrowUp'
    if (name === 'arrowdown') return 'ArrowDown'
    if (name === 'arrowleft') return 'ArrowLeft'
    if (name === 'arrowright') return 'ArrowRight'
    return 'Unidentified'
  }
}

async function handleComputerMouse(tabId, action, args) {
  const ref = typeof args?.ref === 'string' ? args.ref : null
  const selector = ref ? resolveSelectorFromRef(tabId, ref) : null

  const coordinate =
    Array.isArray(args?.coordinate) && args.coordinate.length >= 2
      ? [Number(args.coordinate[0]), Number(args.coordinate[1])]
      : null
  const startCoordinate =
    Array.isArray(args?.start_coordinate) && args.start_coordinate.length >= 2
      ? [Number(args.start_coordinate[0]), Number(args.start_coordinate[1])]
      : null

  if (ref && !selector) {
    return errorResult(`Unknown ref: ${ref}`)
  }

  if (!selector && !coordinate && action !== 'left_click_drag') {
    return errorResult('Mouse action requires ref or coordinate')
  }

  if (action === 'left_click_drag' && (!startCoordinate || !coordinate)) {
    return errorResult('left_click_drag requires start_coordinate and coordinate')
  }

  const payload = await executeInTab(tabId, scriptMouseAction, [
    {
      action,
      selector,
      coordinate,
      startCoordinate,
      modifiers: typeof args?.modifiers === 'string' ? args.modifiers : '',
    },
  ])

  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Mouse action failed'))
  }

  await maybeRecordFrame(tabId, action)
  return okTextResult(`Mouse action completed: ${action}`)
}

function scriptMouseAction(input) {
  const action = String(input?.action || '')
  const selector = typeof input?.selector === 'string' ? input.selector : null
  const coordinate = Array.isArray(input?.coordinate) ? input.coordinate : null
  const startCoordinate = Array.isArray(input?.startCoordinate)
    ? input.startCoordinate
    : null
  const modifiers = parseModifiers(String(input?.modifiers || ''))

  const target = resolveTarget(selector, coordinate)
  if (action !== 'left_click_drag' && !target.element) {
    return { ok: false, error: 'Target element not found' }
  }

  if (action === 'hover') {
    dispatchMouse(target.element, 'mousemove', target.x, target.y, {
      ...modifiers,
      buttons: 0,
    })
    dispatchMouse(target.element, 'mouseover', target.x, target.y, {
      ...modifiers,
      buttons: 0,
    })
    return { ok: true }
  }

  if (action === 'left_click_drag') {
    const sx = Number(startCoordinate[0])
    const sy = Number(startCoordinate[1])
    const ex = Number(coordinate[0])
    const ey = Number(coordinate[1])

    const startEl = document.elementFromPoint(sx, sy) || document.body
    const endEl = document.elementFromPoint(ex, ey) || startEl

    dispatchMouse(startEl, 'mousemove', sx, sy, { ...modifiers, buttons: 0 })
    dispatchMouse(startEl, 'mousedown', sx, sy, {
      ...modifiers,
      button: 0,
      buttons: 1,
      detail: 1,
    })
    dispatchMouse(endEl, 'mousemove', ex, ey, { ...modifiers, buttons: 1 })
    dispatchMouse(endEl, 'mouseup', ex, ey, {
      ...modifiers,
      button: 0,
      buttons: 0,
      detail: 1,
    })
    dispatchMouse(endEl, 'click', ex, ey, {
      ...modifiers,
      button: 0,
      buttons: 0,
      detail: 1,
    })
    return { ok: true }
  }

  const detailMap = {
    left_click: 1,
    double_click: 2,
    triple_click: 3,
    right_click: 1,
  }

  const detail = detailMap[action] || 1
  const button = action === 'right_click' ? 2 : 0

  dispatchMouse(target.element, 'mousemove', target.x, target.y, {
    ...modifiers,
    buttons: 0,
  })
  dispatchMouse(target.element, 'mousedown', target.x, target.y, {
    ...modifiers,
    button,
    buttons: button === 2 ? 2 : 1,
    detail,
  })
  dispatchMouse(target.element, 'mouseup', target.x, target.y, {
    ...modifiers,
    button,
    buttons: 0,
    detail,
  })

  if (action === 'right_click') {
    dispatchMouse(target.element, 'contextmenu', target.x, target.y, {
      ...modifiers,
      button,
      buttons: 0,
      detail,
    })
    return { ok: true }
  }

  if (action === 'double_click' || action === 'triple_click') {
    for (let i = 0; i < detail; i += 1) {
      dispatchMouse(target.element, 'click', target.x, target.y, {
        ...modifiers,
        button,
        buttons: 0,
        detail: i + 1,
      })
    }
    if (action === 'double_click') {
      dispatchMouse(target.element, 'dblclick', target.x, target.y, {
        ...modifiers,
        button,
        buttons: 0,
        detail: 2,
      })
    }
    return { ok: true }
  }

  dispatchMouse(target.element, 'click', target.x, target.y, {
    ...modifiers,
    button,
    buttons: 0,
    detail,
  })

  if (target.element instanceof HTMLElement) {
    target.element.focus({ preventScroll: true })
  }

  return { ok: true }

  function resolveTarget(selectorValue, coordinateValue) {
    if (selectorValue) {
      const el = document.querySelector(selectorValue)
      if (el instanceof Element) {
        const rect = el.getBoundingClientRect()
        return {
          element: el,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        }
      }
    }

    if (Array.isArray(coordinateValue)) {
      const x = Number(coordinateValue[0])
      const y = Number(coordinateValue[1])
      const el = document.elementFromPoint(x, y)
      return {
        element: el,
        x,
        y,
      }
    }

    return {
      element: null,
      x: 0,
      y: 0,
    }
  }

  function dispatchMouse(targetEl, type, x, y, init) {
    if (!(targetEl instanceof EventTarget)) {
      return
    }
    targetEl.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        ...init,
      }),
    )
  }

  function parseModifiers(raw) {
    const bits = raw
      .toLowerCase()
      .split('+')
      .map(item => item.trim())
      .filter(Boolean)

    return {
      ctrlKey: bits.includes('ctrl') || bits.includes('control'),
      shiftKey: bits.includes('shift'),
      altKey: bits.includes('alt') || bits.includes('option'),
      metaKey:
        bits.includes('cmd') ||
        bits.includes('meta') ||
        bits.includes('win') ||
        bits.includes('windows'),
    }
  }
}

async function handleGifCreator(args) {
  const tabId = getTabIdArg(args)
  const action = typeof args?.action === 'string' ? args.action : ''

  if (!state.gifSessions.has(tabId)) {
    state.gifSessions.set(tabId, {
      recording: false,
      frames: [],
      startedAt: null,
    })
  }

  const session = state.gifSessions.get(tabId)

  if (action === 'clear') {
    session.recording = false
    session.frames = []
    session.startedAt = null
    return okTextResult('Cleared recording frames.')
  }

  if (action === 'start_recording') {
    session.recording = true
    session.frames = []
    session.startedAt = Date.now()

    const dataUrl = await captureTabScreenshot(tabId)
    if (dataUrl) {
      session.frames.push({
        dataUrl,
        timestamp: Date.now(),
        label: 'start',
      })
    }

    return okTextResult('GIF recording started.')
  }

  if (action === 'stop_recording') {
    if (session.recording) {
      const dataUrl = await captureTabScreenshot(tabId)
      if (dataUrl) {
        session.frames.push({
          dataUrl,
          timestamp: Date.now(),
          label: 'stop',
        })
      }
    }

    session.recording = false
    return okTextResult(`GIF recording stopped (${session.frames.length} frame(s)).`)
  }

  if (action === 'export') {
    if (!Array.isArray(session.frames) || session.frames.length === 0) {
      return errorResult('No frames recorded. Start and stop recording first.')
    }

    const frameDataUrls = session.frames.map(frame => frame.dataUrl).slice(0, MAX_GIF_FRAMES)
    const quality = Number(args?.options?.quality || 10)
    const delayMs = Math.max(80, Math.min(2000, Math.round(qualityToDelay(quality))))

    const gifBytes = await encodeGifFromDataUrls(frameDataUrls, delayMs)
    const gifBlob = new Blob([gifBytes], { type: 'image/gif' })
    const dataUrl = await blobToDataUrl(gifBlob)
    const imageId = saveImageDataUrl(dataUrl)

    const filename =
      typeof args?.filename === 'string' && args.filename.trim().length > 0
        ? ensureGifFilename(args.filename.trim())
        : `recording-${Date.now()}.gif`

    let downloadId = null
    if (args?.download === true) {
      const objectUrl = URL.createObjectURL(gifBlob)
      try {
        downloadId = await chrome.downloads.download({
          url: objectUrl,
          filename,
          saveAs: false,
        })
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      }
    }

    const { base64Data, mimeType } = splitDataUrl(dataUrl)

    return okResult([
      textItem(
        JSON.stringify({
          imageId,
          mimeType,
          filename,
          frameCount: frameDataUrls.length,
          downloadId,
        }),
      ),
      imageItem(base64Data, mimeType),
    ])
  }

  return errorResult(`Unsupported gif_creator action: ${action}`)
}

function ensureGifFilename(name) {
  return name.toLowerCase().endsWith('.gif') ? name : `${name}.gif`
}

function qualityToDelay(quality) {
  const clamped = Math.max(1, Math.min(30, quality))
  return 120 + clamped * 35
}

async function maybeRecordFrame(tabId, label) {
  const session = state.gifSessions.get(tabId)
  if (!session || !session.recording) {
    return
  }

  const dataUrl = await captureTabScreenshot(tabId)
  if (!dataUrl) {
    return
  }

  session.frames.push({
    dataUrl,
    timestamp: Date.now(),
    label,
  })

  if (session.frames.length > MAX_GIF_FRAMES) {
    session.frames.splice(0, session.frames.length - MAX_GIF_FRAMES)
  }
}

async function handleUploadImage(args) {
  const tabId = getTabIdArg(args)
  const imageId = typeof args?.imageId === 'string' ? args.imageId : ''
  if (!imageId) {
    return errorResult('imageId is required')
  }

  const image = state.imageStore.get(imageId)
  if (!image) {
    return errorResult(`Unknown imageId: ${imageId}`)
  }

  const filename =
    typeof args?.filename === 'string' && args.filename.trim().length > 0
      ? args.filename.trim()
      : 'image.png'

  const ref = typeof args?.ref === 'string' ? args.ref : null
  const coordinate =
    Array.isArray(args?.coordinate) && args.coordinate.length >= 2
      ? [Number(args.coordinate[0]), Number(args.coordinate[1])]
      : null

  if (!ref && !coordinate) {
    return errorResult('Provide either ref or coordinate')
  }

  if (ref && coordinate) {
    return errorResult('Provide only one of ref or coordinate, not both')
  }

  let selector = null
  if (ref) {
    selector = resolveSelectorFromRef(tabId, ref)
    if (!selector) {
      return errorResult(`Unknown ref: ${ref}`)
    }
  }

  const payload = await executeInTab(tabId, scriptUploadImage, [
    {
      selector,
      coordinate,
      filename,
      mimeType: image.mimeType,
      base64Data: image.base64Data,
    },
  ])

  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Image upload failed'))
  }

  await maybeRecordFrame(tabId, 'upload_image')
  return okTextResult('Image uploaded successfully.')
}

function scriptUploadImage(input) {
  const selector = typeof input?.selector === 'string' ? input.selector : null
  const coordinate = Array.isArray(input?.coordinate) ? input.coordinate : null
  const filename = typeof input?.filename === 'string' ? input.filename : 'image.png'
  const mimeType = typeof input?.mimeType === 'string' ? input.mimeType : 'image/png'
  const base64Data = typeof input?.base64Data === 'string' ? input.base64Data : ''

  if (!base64Data) {
    return { ok: false, error: 'Missing image data' }
  }

  const bytes = Uint8Array.from(atob(base64Data), ch => ch.charCodeAt(0))
  const file = new File([bytes], filename, { type: mimeType })
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(file)

  let target = null
  if (selector) {
    target = document.querySelector(selector)
  } else if (coordinate && coordinate.length >= 2) {
    target = document.elementFromPoint(Number(coordinate[0]), Number(coordinate[1]))
  }

  if (!(target instanceof Element)) {
    return { ok: false, error: 'Upload target not found' }
  }

  if (target instanceof HTMLInputElement && target.type === 'file') {
    target.files = dataTransfer.files
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }

  const rect = target.getBoundingClientRect()
  const clientX = rect.left + rect.width / 2
  const clientY = rect.top + rect.height / 2

  target.dispatchEvent(
    new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX,
      clientY,
    }),
  )
  target.dispatchEvent(
    new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX,
      clientY,
    }),
  )
  target.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX,
      clientY,
    }),
  )

  return { ok: true }
}

async function handleGetPageText(args) {
  const tabId = getTabIdArg(args)
  const payload = await executeInTab(tabId, scriptExtractPageText, [])

  if (!isObject(payload) || !payload.ok) {
    return errorResult(String(payload?.error || 'Failed to extract page text'))
  }

  const text = String(payload.text || '')
  return okResult([
    textItem(JSON.stringify({ length: text.length })),
    textItem(text),
  ])
}

function scriptExtractPageText() {
  const article =
    document.querySelector('main article') ||
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.body

  if (!(article instanceof HTMLElement)) {
    return { ok: false, error: 'No readable content found' }
  }

  const text = (article.innerText || article.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  return { ok: true, text }
}

async function handleUpdatePlan(args) {
  const domains = Array.isArray(args?.domains)
    ? args.domains.map(item => String(item)).filter(Boolean)
    : []
  const approach = Array.isArray(args?.approach)
    ? args.approach.map(item => String(item)).filter(Boolean)
    : []

  return okResult([
    textItem(JSON.stringify({ approved: true, domains, approach })),
    textItem('Plan accepted for this local extension session.'),
  ])
}

function pushConsoleLog(tabId, entry) {
  if (!state.consoleLogsByTab.has(tabId)) {
    state.consoleLogsByTab.set(tabId, [])
  }
  const logs = state.consoleLogsByTab.get(tabId)
  logs.push(entry)
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000)
  }
}

function getNetworkStore(tabId) {
  if (!state.networkStoreByTab.has(tabId)) {
    state.networkStoreByTab.set(tabId, {
      entries: [],
      byRequestId: new Map(),
    })
  }
  return state.networkStoreByTab.get(tabId)
}

async function ensureDebugger(tabId) {
  if (state.debuggerAttachedTabs.has(tabId)) {
    return
  }

  const target = { tabId }
  await chrome.debugger.attach(target, '1.3')
  await chrome.debugger.sendCommand(target, 'Runtime.enable')
  await chrome.debugger.sendCommand(target, 'Log.enable')
  await chrome.debugger.sendCommand(target, 'Network.enable')

  state.debuggerAttachedTabs.add(tabId)
}

async function handleReadConsoleMessages(args) {
  const tabId = getTabIdArg(args)

  try {
    await ensureDebugger(tabId)
  } catch (error) {
    return errorResult(
      `Unable to attach debugger for console capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const onlyErrors = Boolean(args?.onlyErrors)
  const clear = Boolean(args?.clear)
  const limit = Math.max(1, Math.min(500, Number(args?.limit || 100)))
  const pattern = typeof args?.pattern === 'string' ? args.pattern : ''

  let matcher = null
  if (pattern) {
    try {
      matcher = new RegExp(pattern, 'i')
    } catch {
      return errorResult(`Invalid regex pattern: ${pattern}`)
    }
  }

  const logs = (state.consoleLogsByTab.get(tabId) || []).slice()
  const filtered = logs
    .filter(entry => {
      if (onlyErrors && !/error|exception|fatal/i.test(String(entry.level))) {
        return false
      }
      if (matcher && !matcher.test(String(entry.text || ''))) {
        return false
      }
      return true
    })
    .slice(-limit)

  if (clear) {
    state.consoleLogsByTab.set(tabId, [])
  }

  const lines = filtered.map(entry => {
    const ts = new Date(entry.timestamp).toISOString()
    const level = String(entry.level || 'log').toUpperCase()
    const url = entry.url ? ` ${entry.url}` : ''
    return `[${ts}] [${level}] ${entry.text}${url}`
  })

  return okResult([
    textItem(JSON.stringify({ messages: filtered })),
    textItem(lines.join('\n') || 'No matching console messages.'),
  ])
}

async function handleReadNetworkRequests(args) {
  const tabId = getTabIdArg(args)

  try {
    await ensureDebugger(tabId)
  } catch (error) {
    return errorResult(
      `Unable to attach debugger for network capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const urlPattern = typeof args?.urlPattern === 'string' ? args.urlPattern : ''
  const clear = Boolean(args?.clear)
  const limit = Math.max(1, Math.min(500, Number(args?.limit || 100)))

  const store = getNetworkStore(tabId)
  const entries = store.entries
    .filter(entry => (urlPattern ? String(entry.url).includes(urlPattern) : true))
    .slice(-limit)

  if (clear) {
    state.networkStoreByTab.set(tabId, { entries: [], byRequestId: new Map() })
  }

  const lines = entries.map(entry => {
    const status = entry.status == null ? '-' : String(entry.status)
    const dur = entry.durationMs == null ? '-' : `${entry.durationMs}ms`
    const fail = entry.failed ? ` failed=${entry.errorText || 'true'}` : ''
    return `${entry.method} ${entry.url} status=${status} duration=${dur}${fail}`
  })

  return okResult([
    textItem(JSON.stringify({ requests: entries })),
    textItem(lines.join('\n') || 'No matching network requests.'),
  ])
}

async function handleShortcutsList(args) {
  getTabIdArg(args)

  const shortcuts = state.shortcuts.slice()
  return okResult([
    textItem(JSON.stringify({ shortcuts })),
    textItem(
      shortcuts
        .map(item => {
          const workflowTag = item.isWorkflow ? ' (workflow)' : ''
          return `${item.id} /${item.command}${workflowTag}: ${item.description}`
        })
        .join('\n') || 'No shortcuts available.',
    ),
  ])
}

async function handleShortcutsExecute(args) {
  const tabId = getTabIdArg(args)
  const shortcutId = typeof args?.shortcutId === 'string' ? args.shortcutId : ''
  const command = typeof args?.command === 'string' ? args.command : ''

  const shortcut = state.shortcuts.find(item => {
    if (shortcutId && item.id === shortcutId) return true
    if (command && item.command === command) return true
    return false
  })

  if (!shortcut) {
    return errorResult('Shortcut not found. Use shortcuts_list first.')
  }

  const prompt = `Shortcut /${shortcut.command} triggered on tab ${tabId}.`
  postNativeMessage({
    type: 'notification',
    method: 'notifications/message',
    params: { prompt, tabId },
  })

  return okResult([
    textItem(
      JSON.stringify({
        started: true,
        tabId,
        shortcut,
      }),
    ),
    textItem(`Started shortcut /${shortcut.command}.`),
  ])
}

async function captureTabScreenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tabId, { active: true })
    await sleep(80)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    })
    return typeof dataUrl === 'string' ? dataUrl : null
  } catch (error) {
    log('captureTabScreenshot failed', error)
    return null
  }
}

function saveImageDataUrl(dataUrl) {
  const { base64Data, mimeType } = splitDataUrl(dataUrl)
  const imageId = crypto.randomUUID()
  state.imageStore.set(imageId, {
    base64Data,
    mimeType,
    createdAt: Date.now(),
  })

  if (state.imageStore.size > MAX_IMAGE_STORE) {
    const sorted = Array.from(state.imageStore.entries()).sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    )
    const overflow = sorted.length - MAX_IMAGE_STORE
    for (let i = 0; i < overflow; i += 1) {
      state.imageStore.delete(sorted[i][0])
    }
  }

  return imageId
}

function splitDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ''))
  if (!match) {
    throw new Error('Invalid data URL')
  }
  return {
    mimeType: match[1],
    base64Data: match[2],
  }
}

async function cropDataUrl(dataUrl, x, y, width, height) {
  const sourceBlob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(sourceBlob)

  const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(x)))
  const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(y)))
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(width)))
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(height)))

  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blobToDataUrl(blob)
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)
  return `data:${blob.type};base64,${base64}`
}

async function encodeGifFromDataUrls(dataUrls, delayMs) {
  const frames = []
  let width = 0
  let height = 0

  for (const dataUrl of dataUrls) {
    const imageData = await dataUrlToImageData(dataUrl)
    if (!imageData) continue

    if (width === 0 || height === 0) {
      width = imageData.width
      height = imageData.height
    }

    if (imageData.width !== width || imageData.height !== height) {
      const normalized = resizeImageData(imageData, width, height)
      frames.push(rgbaToIndexed332(normalized.data))
    } else {
      frames.push(rgbaToIndexed332(imageData.data))
    }
  }

  if (frames.length === 0 || width === 0 || height === 0) {
    throw new Error('No valid frames for GIF export')
  }

  const delayCs = Math.max(1, Math.round(delayMs / 10))
  const palette = build332Palette()

  return encodeGifBinary({
    width,
    height,
    palette,
    frames,
    delayCs,
    loop: 0,
  })
}

async function dataUrlToImageData(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return imageData
  } catch (error) {
    log('dataUrlToImageData failed', error)
    return null
  }
}

function resizeImageData(imageData, targetWidth, targetHeight) {
  const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height)
  const srcCtx = srcCanvas.getContext('2d')
  srcCtx.putImageData(imageData, 0, 0)

  const outCanvas = new OffscreenCanvas(targetWidth, targetHeight)
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true })
  outCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight)
  return outCtx.getImageData(0, 0, targetWidth, targetHeight)
}

function build332Palette() {
  const palette = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i += 1) {
    const r = (i >> 5) & 0x07
    const g = (i >> 2) & 0x07
    const b = i & 0x03
    palette[i * 3] = Math.round((r / 7) * 255)
    palette[i * 3 + 1] = Math.round((g / 7) * 255)
    palette[i * 3 + 2] = Math.round((b / 3) * 255)
  }
  return palette
}

function rgbaToIndexed332(rgba) {
  const out = new Uint8Array(rgba.length / 4)
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    const r = rgba[i] >> 5
    const g = rgba[i + 1] >> 5
    const b = rgba[i + 2] >> 6
    out[p] = (r << 5) | (g << 2) | b
  }
  return out
}

function encodeGifBinary(config) {
  const { width, height, palette, frames, delayCs, loop } = config
  const bytes = []

  const pushByte = value => bytes.push(value & 0xff)
  const pushWord = value => {
    pushByte(value & 0xff)
    pushByte((value >> 8) & 0xff)
  }
  const pushString = value => {
    for (let i = 0; i < value.length; i += 1) {
      pushByte(value.charCodeAt(i))
    }
  }
  const pushBytes = array => {
    for (let i = 0; i < array.length; i += 1) {
      pushByte(array[i])
    }
  }

  pushString('GIF89a')
  pushWord(width)
  pushWord(height)

  // Global color table (256 colors), color resolution=7, sorted=0
  pushByte(0xf7)
  pushByte(0x00)
  pushByte(0x00)
  pushBytes(palette)

  // Netscape loop extension
  pushByte(0x21)
  pushByte(0xff)
  pushByte(0x0b)
  pushString('NETSCAPE2.0')
  pushByte(0x03)
  pushByte(0x01)
  pushWord(loop)
  pushByte(0x00)

  for (const frame of frames) {
    // Graphic control extension
    pushByte(0x21)
    pushByte(0xf9)
    pushByte(0x04)
    // Disposal method 2 (restore to background), no transparency
    pushByte(0x08)
    pushWord(delayCs)
    pushByte(0x00)
    pushByte(0x00)

    // Image descriptor
    pushByte(0x2c)
    pushWord(0)
    pushWord(0)
    pushWord(width)
    pushWord(height)
    pushByte(0x00)

    // LZW minimum code size for 8-bit indexed palette
    pushByte(8)
    const compressed = lzwEncode(frame, 8)
    writeSubBlocks(compressed, pushByte)
  }

  pushByte(0x3b)
  return new Uint8Array(bytes)
}

function writeSubBlocks(data, pushByte) {
  let offset = 0
  while (offset < data.length) {
    const size = Math.min(255, data.length - offset)
    pushByte(size)
    for (let i = 0; i < size; i += 1) {
      pushByte(data[offset + i])
    }
    offset += size
  }
  pushByte(0)
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1

  let codeSize = minCodeSize + 1
  let nextCode = eoiCode + 1

  let dictionary = new Map()
  const resetDictionary = () => {
    dictionary = new Map()
    for (let i = 0; i < clearCode; i += 1) {
      dictionary.set(String.fromCharCode(i), i)
    }
    codeSize = minCodeSize + 1
    nextCode = eoiCode + 1
  }

  resetDictionary()

  const output = []
  let bitBuffer = 0
  let bitCount = 0

  const writeCode = code => {
    bitBuffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      output.push(bitBuffer & 0xff)
      bitBuffer >>= 8
      bitCount -= 8
    }
  }

  writeCode(clearCode)

  let w = String.fromCharCode(indices[0])

  for (let i = 1; i < indices.length; i += 1) {
    const k = String.fromCharCode(indices[i])
    const wk = w + k

    if (dictionary.has(wk)) {
      w = wk
      continue
    }

    writeCode(dictionary.get(w))

    if (nextCode < 4096) {
      dictionary.set(wk, nextCode)
      nextCode += 1
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize += 1
      }
    } else {
      writeCode(clearCode)
      resetDictionary()
    }

    w = k
  }

  writeCode(dictionary.get(w))
  writeCode(eoiCode)

  if (bitCount > 0) {
    output.push(bitBuffer & 0xff)
  }

  return Uint8Array.from(output)
}

async function executeInTab(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  })

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('No script execution result returned')
  }

  return result[0]?.result
}

function remoteObjectToText(obj) {
  if (!obj || typeof obj !== 'object') {
    return String(obj)
  }

  if (obj.type === 'string') {
    return String(obj.value || '')
  }
  if (obj.type === 'number' || obj.type === 'boolean') {
    return String(obj.value)
  }
  if (obj.type === 'undefined') {
    return 'undefined'
  }
  if (obj.value != null) {
    return String(obj.value)
  }
  if (obj.description) {
    return String(obj.description)
  }
  return JSON.stringify(obj)
}

function extractConsoleCallUrl(params) {
  const stack = params?.stackTrace
  if (!stack || !Array.isArray(stack.callFrames)) {
    return null
  }
  const first = stack.callFrames[0]
  if (first && typeof first.url === 'string') {
    return first.url
  }
  return null
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function log(...args) {
  console.log('[Claude Core MCP Bridge]', ...args)
}
