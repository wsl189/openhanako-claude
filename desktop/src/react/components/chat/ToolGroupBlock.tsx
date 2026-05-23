/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolCall } from '../../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  tools: ToolCall[];
  agentName: string;
  dimmed?: boolean;
  animate?: boolean;
}

const TOOL_PANEL_TEXT_MAX_LEN = 10_000;
const TOOL_PREVIEW_EMPTY_LINE = '\u200B';
const TOOL_REVEAL_BASE_DELAY_MS = 150;
const TOOL_REVEAL_MAX_DELAY_MS = 480;
const TOOL_REVEAL_AFTER_THINKING_DELAY_MS = 260;

function humanizeToolName(name: string): string {
  return String(name || '')
    .replace(/^functions\./, '')
    .replace(/^multi_tool_use\./, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function splitToolNameTokens(name: string): string[] {
  return String(name || '')
    .split(/[^A-Za-z0-9]+/g)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function stripDuplicateMcpToolPrefix(serverName: string, toolName: string): string {
  const serverTokens = splitToolNameTokens(serverName);
  const toolTokens = splitToolNameTokens(toolName);
  if (serverTokens.length === 0 || toolTokens.length <= serverTokens.length) return toolName;
  const startsWithServer = serverTokens.every((token, index) => toolTokens[index] === token);
  if (!startsWithServer) return toolName;

  const prefixPattern = serverTokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[._-]+');
  return toolName
    .replace(new RegExp(`^${prefixPattern}(?:[._-]+|$)`, 'i'), '')
    .trim();
}

function getDisplayToolName(name: string): string {
  const raw = String(name || '').trim();
  const mcpMatch = raw.match(/^mcp__([A-Za-z0-9_-]+)__(.+)$/);
  if (!mcpMatch) return humanizeToolName(raw);

  const serverName = mcpMatch[1];
  const childName = stripDuplicateMcpToolPrefix(serverName, mcpMatch[2]);
  const serverLabel = humanizeToolName(serverName);
  const childLabel = humanizeToolName(childName);
  return childLabel ? `${serverLabel} ${childLabel}` : serverLabel;
}

function stripLeadingEmoji(input: string): string {
  return String(input || '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+/u, '')
    .trim();
}

function isZhLocale(): boolean {
  const locale = String((window as any).i18n?.locale || navigator.language || '').toLowerCase();
  return locale.startsWith('zh');
}

function getToolLabel(name: string, phase: string, agentName: string, args?: Record<string, unknown>): string {
  const t = (window as any).t;
  const vars = { name: agentName };

  const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (action) {
    const actionKey = `tool.${name}.actions.${action}.${phase}`;
    const actionVal = t?.(actionKey, vars);
    if (actionVal && actionVal !== actionKey) return actionVal;
  }

  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;

  const toolName = getDisplayToolName(name) || name;
  const fallbackNamedKey = `tool._fallback.${phase}Named`;
  const fallbackNamedVal = t?.(fallbackNamedKey, { ...vars, tool: toolName });
  if (fallbackNamedVal && fallbackNamedVal !== fallbackNamedKey) return fallbackNamedVal;

  const fallbackKey = `tool._fallback.${phase}`;
  const fallbackVal = t?.(fallbackKey, vars);
  if (fallbackVal && fallbackVal !== fallbackKey) return `${fallbackVal} (${toolName})`;

  return toolName;
}

type ToolActionKind =
  | 'askUser'
  | 'command'
  | 'consoleRead'
  | 'docs'
  | 'message'
  | 'script'
  | 'readFile'
  | 'writeFile'
  | 'editFile'
  | 'findFiles'
  | 'searchFiles'
  | 'listDir'
  | 'webSearch'
  | 'webFetch'
  | 'browser'
  | 'browserStart'
  | 'browserStop'
  | 'browserNavigate'
  | 'browserSnapshot'
  | 'browserClick'
  | 'browserType'
  | 'browserScroll'
  | 'browserSelect'
  | 'browserKey'
  | 'browserWait'
  | 'browserShow'
  | 'tabContext'
  | 'tabCreate'
  | 'screenshot'
  | 'pageRead'
  | 'pageFind'
  | 'formInput'
  | 'resizeWindow'
  | 'gif'
  | 'uploadFile'
  | 'networkRead'
  | 'shortcutsList'
  | 'shortcutsRun'
  | 'image'
  | 'imageGenerate'
  | 'pdf'
  | 'memorySearch'
  | 'memoryPin'
  | 'memoryUnpin'
  | 'experienceRecall'
  | 'experienceRecord'
  | 'skill'
  | 'skillInstall'
  | 'todo'
  | 'automationList'
  | 'automationCreate'
  | 'automationRemove'
  | 'automationToggle'
  | 'delegate'
  | 'claudeCore'
  | 'notification'
  | 'channelRead'
  | 'channelPost'
  | 'channelCreate'
  | 'channelList'
  | 'fileOutput'
  | 'artifact'
  | 'settingsSearch'
  | 'settingsUpdate'
  | 'resource'
  | 'resourceList'
  | 'planEnter'
  | 'planExit'
  | 'planUpdate'
  | 'worktreeEnter'
  | 'worktreeExit'
  | 'taskOutput'
  | 'taskStop'
  | 'notebook'
  | 'remote';

const TOOL_ACTION_COPY: Record<'zh' | 'en', Record<ToolActionKind, Record<'running' | 'done' | 'failed', string>>> = {
  zh: {
    askUser: { running: '正在询问用户', done: '询问用户', failed: '询问用户失败' },
    command: { running: '正在运行命令', done: '运行命令', failed: '命令失败' },
    consoleRead: { running: '正在读取控制台', done: '读取控制台', failed: '读取控制台失败' },
    docs: { running: '正在读取文档', done: '读取文档', failed: '读取文档失败' },
    message: { running: '正在发送消息', done: '发送消息', failed: '发送消息失败' },
    script: { running: '正在运行脚本', done: '运行脚本', failed: '脚本失败' },
    readFile: { running: '正在读取文件', done: '读取文件', failed: '读取文件失败' },
    writeFile: { running: '正在写入文件', done: '写入文件', failed: '写入文件失败' },
    editFile: { running: '正在编辑文件', done: '编辑文件', failed: '编辑文件失败' },
    findFiles: { running: '正在查找文件', done: '查找文件', failed: '查找文件失败' },
    searchFiles: { running: '正在搜索内容', done: '搜索内容', failed: '搜索内容失败' },
    listDir: { running: '正在列出目录', done: '列出目录', failed: '列出目录失败' },
    webSearch: { running: '正在搜索网页', done: '搜索网页', failed: '搜索网页失败' },
    webFetch: { running: '正在读取网页', done: '读取网页', failed: '读取网页失败' },
    browser: { running: '正在操作浏览器', done: '操作浏览器', failed: '浏览器操作失败' },
    browserStart: { running: '正在启动浏览器', done: '启动浏览器', failed: '启动浏览器失败' },
    browserStop: { running: '正在关闭浏览器', done: '关闭浏览器', failed: '关闭浏览器失败' },
    browserNavigate: { running: '正在打开页面', done: '打开页面', failed: '打开页面失败' },
    browserSnapshot: { running: '正在读取页面结构', done: '读取页面结构', failed: '读取页面结构失败' },
    browserClick: { running: '正在点击页面', done: '点击页面', failed: '点击页面失败' },
    browserType: { running: '正在输入文本', done: '输入文本', failed: '输入文本失败' },
    browserScroll: { running: '正在滚动页面', done: '滚动页面', failed: '滚动页面失败' },
    browserSelect: { running: '正在选择选项', done: '选择选项', failed: '选择选项失败' },
    browserKey: { running: '正在发送按键', done: '发送按键', failed: '发送按键失败' },
    browserWait: { running: '正在等待页面', done: '等待页面', failed: '等待页面失败' },
    browserShow: { running: '正在切到浏览器', done: '切到浏览器', failed: '切到浏览器失败' },
    tabContext: { running: '正在读取标签页', done: '读取标签页', failed: '读取标签页失败' },
    tabCreate: { running: '正在新建标签页', done: '新建标签页', failed: '新建标签页失败' },
    screenshot: { running: '正在截图', done: '截图', failed: '截图失败' },
    pageRead: { running: '正在读取页面', done: '读取页面', failed: '读取页面失败' },
    pageFind: { running: '正在查找页面元素', done: '查找页面元素', failed: '查找页面元素失败' },
    formInput: { running: '正在填写表单', done: '填写表单', failed: '填写表单失败' },
    resizeWindow: { running: '正在调整窗口', done: '调整窗口', failed: '调整窗口失败' },
    gif: { running: '正在处理录屏', done: '处理录屏', failed: '处理录屏失败' },
    uploadFile: { running: '正在上传文件', done: '上传文件', failed: '上传文件失败' },
    networkRead: { running: '正在读取网络请求', done: '读取网络请求', failed: '读取网络请求失败' },
    shortcutsList: { running: '正在读取快捷操作', done: '读取快捷操作', failed: '读取快捷操作失败' },
    shortcutsRun: { running: '正在执行快捷操作', done: '执行快捷操作', failed: '执行快捷操作失败' },
    image: { running: '正在处理图片', done: '处理图片', failed: '处理图片失败' },
    imageGenerate: { running: '正在生成图片', done: '生成图片', failed: '生成图片失败' },
    pdf: { running: '正在转换 PDF', done: '转换 PDF', failed: '转换 PDF 失败' },
    memorySearch: { running: '正在检索记忆', done: '检索记忆', failed: '检索记忆失败' },
    memoryPin: { running: '正在置顶记忆', done: '置顶记忆', failed: '置顶记忆失败' },
    memoryUnpin: { running: '正在移除记忆', done: '移除记忆', failed: '移除记忆失败' },
    experienceRecall: { running: '正在查看经验', done: '查看经验', failed: '查看经验失败' },
    experienceRecord: { running: '正在记录经验', done: '记录经验', failed: '记录经验失败' },
    skill: { running: '正在加载技能', done: '加载技能', failed: '加载技能失败' },
    skillInstall: { running: '正在安装技能', done: '安装技能', failed: '安装技能失败' },
    todo: { running: '正在更新待办', done: '更新待办', failed: '更新待办失败' },
    automationList: { running: '正在查看定时任务', done: '查看定时任务', failed: '查看定时任务失败' },
    automationCreate: { running: '正在创建定时任务', done: '创建定时任务', failed: '创建定时任务失败' },
    automationRemove: { running: '正在删除定时任务', done: '删除定时任务', failed: '删除定时任务失败' },
    automationToggle: { running: '正在切换定时任务', done: '切换定时任务', failed: '切换定时任务失败' },
    delegate: { running: '正在委派任务', done: '委派任务', failed: '委派任务失败' },
    claudeCore: { running: '正在调用 Claude Core', done: '调用 Claude Core', failed: 'Claude Core 失败' },
    notification: { running: '正在发送通知', done: '发送通知', failed: '发送通知失败' },
    channelRead: { running: '正在读取频道', done: '读取频道', failed: '读取频道失败' },
    channelPost: { running: '正在发送频道消息', done: '发送频道消息', failed: '发送频道消息失败' },
    channelCreate: { running: '正在创建频道', done: '创建频道', failed: '创建频道失败' },
    channelList: { running: '正在列出频道', done: '列出频道', failed: '列出频道失败' },
    fileOutput: { running: '正在准备文件', done: '准备文件', failed: '准备文件失败' },
    artifact: { running: '正在创建产物', done: '创建产物', failed: '创建产物失败' },
    settingsSearch: { running: '正在搜索设置', done: '搜索设置', failed: '搜索设置失败' },
    settingsUpdate: { running: '正在调整设置', done: '调整设置', failed: '调整设置失败' },
    resource: { running: '正在读取资源', done: '读取资源', failed: '读取资源失败' },
    resourceList: { running: '正在列出资源', done: '列出资源', failed: '列出资源失败' },
    planEnter: { running: '正在进入计划模式', done: '进入计划模式', failed: '进入计划模式失败' },
    planExit: { running: '正在退出计划模式', done: '退出计划模式', failed: '退出计划模式失败' },
    planUpdate: { running: '正在更新计划', done: '更新计划', failed: '更新计划失败' },
    worktreeEnter: { running: '正在进入工作树', done: '进入工作树', failed: '进入工作树失败' },
    worktreeExit: { running: '正在退出工作树', done: '退出工作树', failed: '退出工作树失败' },
    taskOutput: { running: '正在读取任务输出', done: '读取任务输出', failed: '读取任务输出失败' },
    taskStop: { running: '正在停止任务', done: '停止任务', failed: '停止任务失败' },
    notebook: { running: '正在编辑 Notebook', done: '编辑 Notebook', failed: '编辑 Notebook 失败' },
    remote: { running: '正在触发远程流程', done: '触发远程流程', failed: '触发远程流程失败' },
  },
  en: {
    askUser: { running: 'Asking user', done: 'Asked user', failed: 'User question failed' },
    command: { running: 'Running command', done: 'Ran command', failed: 'Command failed' },
    consoleRead: { running: 'Reading console', done: 'Read console', failed: 'Console read failed' },
    docs: { running: 'Reading docs', done: 'Read docs', failed: 'Docs read failed' },
    message: { running: 'Sending message', done: 'Sent message', failed: 'Message failed' },
    script: { running: 'Running script', done: 'Ran script', failed: 'Script failed' },
    readFile: { running: 'Reading file', done: 'Read file', failed: 'File read failed' },
    writeFile: { running: 'Writing file', done: 'Wrote file', failed: 'File write failed' },
    editFile: { running: 'Editing file', done: 'Edited file', failed: 'File edit failed' },
    findFiles: { running: 'Finding files', done: 'Found files', failed: 'File search failed' },
    searchFiles: { running: 'Searching files', done: 'Searched files', failed: 'File search failed' },
    listDir: { running: 'Listing directory', done: 'Listed directory', failed: 'Directory listing failed' },
    webSearch: { running: 'Searching web', done: 'Searched web', failed: 'Web search failed' },
    webFetch: { running: 'Reading webpage', done: 'Read webpage', failed: 'Webpage read failed' },
    browser: { running: 'Using browser', done: 'Used browser', failed: 'Browser action failed' },
    browserStart: { running: 'Starting browser', done: 'Started browser', failed: 'Browser start failed' },
    browserStop: { running: 'Closing browser', done: 'Closed browser', failed: 'Browser close failed' },
    browserNavigate: { running: 'Opening page', done: 'Opened page', failed: 'Page open failed' },
    browserSnapshot: { running: 'Reading page structure', done: 'Read page structure', failed: 'Page structure failed' },
    browserClick: { running: 'Clicking page', done: 'Clicked page', failed: 'Click failed' },
    browserType: { running: 'Typing text', done: 'Typed text', failed: 'Typing failed' },
    browserScroll: { running: 'Scrolling page', done: 'Scrolled page', failed: 'Scroll failed' },
    browserSelect: { running: 'Selecting option', done: 'Selected option', failed: 'Select failed' },
    browserKey: { running: 'Sending key', done: 'Sent key', failed: 'Key input failed' },
    browserWait: { running: 'Waiting on page', done: 'Waited on page', failed: 'Page wait failed' },
    browserShow: { running: 'Showing browser', done: 'Showed browser', failed: 'Show browser failed' },
    tabContext: { running: 'Reading tabs', done: 'Read tabs', failed: 'Tab read failed' },
    tabCreate: { running: 'Creating tab', done: 'Created tab', failed: 'Tab create failed' },
    screenshot: { running: 'Taking screenshot', done: 'Took screenshot', failed: 'Screenshot failed' },
    pageRead: { running: 'Reading page', done: 'Read page', failed: 'Page read failed' },
    pageFind: { running: 'Finding page element', done: 'Found page element', failed: 'Page find failed' },
    formInput: { running: 'Filling form', done: 'Filled form', failed: 'Form input failed' },
    resizeWindow: { running: 'Resizing window', done: 'Resized window', failed: 'Window resize failed' },
    gif: { running: 'Processing recording', done: 'Processed recording', failed: 'Recording failed' },
    uploadFile: { running: 'Uploading file', done: 'Uploaded file', failed: 'File upload failed' },
    networkRead: { running: 'Reading network requests', done: 'Read network requests', failed: 'Network read failed' },
    shortcutsList: { running: 'Reading shortcuts', done: 'Read shortcuts', failed: 'Shortcut read failed' },
    shortcutsRun: { running: 'Running shortcut', done: 'Ran shortcut', failed: 'Shortcut failed' },
    image: { running: 'Processing image', done: 'Processed image', failed: 'Image processing failed' },
    imageGenerate: { running: 'Generating image', done: 'Generated image', failed: 'Image generation failed' },
    pdf: { running: 'Converting PDF', done: 'Converted PDF', failed: 'PDF conversion failed' },
    memorySearch: { running: 'Searching memory', done: 'Searched memory', failed: 'Memory search failed' },
    memoryPin: { running: 'Pinning memory', done: 'Pinned memory', failed: 'Memory pin failed' },
    memoryUnpin: { running: 'Removing memory', done: 'Removed memory', failed: 'Memory removal failed' },
    experienceRecall: { running: 'Recalling experience', done: 'Recalled experience', failed: 'Experience recall failed' },
    experienceRecord: { running: 'Recording experience', done: 'Recorded experience', failed: 'Experience record failed' },
    skill: { running: 'Loading skill', done: 'Loaded skill', failed: 'Skill load failed' },
    skillInstall: { running: 'Installing skill', done: 'Installed skill', failed: 'Skill install failed' },
    todo: { running: 'Updating todos', done: 'Updated todos', failed: 'Todo update failed' },
    automationList: { running: 'Listing scheduled tasks', done: 'Listed scheduled tasks', failed: 'Schedule list failed' },
    automationCreate: { running: 'Creating scheduled task', done: 'Created scheduled task', failed: 'Schedule create failed' },
    automationRemove: { running: 'Removing scheduled task', done: 'Removed scheduled task', failed: 'Schedule remove failed' },
    automationToggle: { running: 'Toggling scheduled task', done: 'Toggled scheduled task', failed: 'Schedule toggle failed' },
    delegate: { running: 'Delegating task', done: 'Delegated task', failed: 'Delegation failed' },
    claudeCore: { running: 'Calling Claude Core', done: 'Called Claude Core', failed: 'Claude Core failed' },
    notification: { running: 'Sending notification', done: 'Sent notification', failed: 'Notification failed' },
    channelRead: { running: 'Reading channel', done: 'Read channel', failed: 'Channel read failed' },
    channelPost: { running: 'Posting to channel', done: 'Posted to channel', failed: 'Channel post failed' },
    channelCreate: { running: 'Creating channel', done: 'Created channel', failed: 'Channel create failed' },
    channelList: { running: 'Listing channels', done: 'Listed channels', failed: 'Channel list failed' },
    fileOutput: { running: 'Preparing file', done: 'Prepared file', failed: 'File preparation failed' },
    artifact: { running: 'Creating artifact', done: 'Created artifact', failed: 'Artifact creation failed' },
    settingsSearch: { running: 'Searching settings', done: 'Searched settings', failed: 'Settings search failed' },
    settingsUpdate: { running: 'Updating settings', done: 'Updated settings', failed: 'Settings update failed' },
    resource: { running: 'Reading resource', done: 'Read resource', failed: 'Resource read failed' },
    resourceList: { running: 'Listing resources', done: 'Listed resources', failed: 'Resource list failed' },
    planEnter: { running: 'Entering plan mode', done: 'Entered plan mode', failed: 'Plan mode failed' },
    planExit: { running: 'Exiting plan mode', done: 'Exited plan mode', failed: 'Exit plan failed' },
    planUpdate: { running: 'Updating plan', done: 'Updated plan', failed: 'Plan update failed' },
    worktreeEnter: { running: 'Entering worktree', done: 'Entered worktree', failed: 'Worktree enter failed' },
    worktreeExit: { running: 'Exiting worktree', done: 'Exited worktree', failed: 'Worktree exit failed' },
    taskOutput: { running: 'Reading task output', done: 'Read task output', failed: 'Task output failed' },
    taskStop: { running: 'Stopping task', done: 'Stopped task', failed: 'Task stop failed' },
    notebook: { running: 'Editing notebook', done: 'Edited notebook', failed: 'Notebook edit failed' },
    remote: { running: 'Triggering remote workflow', done: 'Triggered remote workflow', failed: 'Remote trigger failed' },
  },
};

function getToolLeafName(name: string): string {
  const raw = normalizeToolName(name)
    .replace(/^functions\./, '')
    .replace(/^multi_tool_use\./, '');
  const parts = raw.split('__').filter(Boolean);
  if (parts[0] === 'mcp' && parts.length >= 3) return parts.slice(2).join('__');
  return raw;
}

function getMcpServerName(name: string): string {
  const raw = normalizeToolName(name);
  const parts = raw.split('__').filter(Boolean);
  return parts[0] === 'mcp' && parts.length >= 3 ? parts[1] : '';
}

function compactToolToken(value: string): string {
  return String(value || '').replace(/[^a-z0-9]+/g, '');
}

function getToolActionKind(name: string, args?: Record<string, unknown>): ToolActionKind | null {
  const raw = normalizeToolName(name);
  const leaf = getToolLeafName(name);
  const compactLeaf = compactToolToken(leaf);
  const compactRaw = compactToolToken(raw);
  const server = getMcpServerName(name);
  const compactServer = compactToolToken(server);
  const display = getDisplayToolName(name).toLowerCase();
  const action = typeof args?.action === 'string'
    ? args.action.trim().toLowerCase()
    : (typeof args?.mode === 'string' ? args.mode.trim().toLowerCase() : '');

  const browserActionMap: Record<string, ToolActionKind> = {
    start: 'browserStart',
    stop: 'browserStop',
    close: 'browserStop',
    navigate: 'browserNavigate',
    open: 'browserNavigate',
    goto: 'browserNavigate',
    snapshot: 'browserSnapshot',
    accessibilitysnapshot: 'browserSnapshot',
    click: 'browserClick',
    type: 'browserType',
    fill: 'browserType',
    input: 'browserType',
    scroll: 'browserScroll',
    select: 'browserSelect',
    selectoption: 'browserSelect',
    key: 'browserKey',
    press: 'browserKey',
    presskey: 'browserKey',
    wait: 'browserWait',
    waitfor: 'browserWait',
    evaluate: 'script',
    screenshot: 'screenshot',
    show: 'browserShow',
    resize: 'resizeWindow',
    zoom: 'browser',
  };
  const compactAction = compactToolToken(action);

  if (compactRaw.includes('noderepl') || ['js', 'javascripttool', 'python', 'evaluate'].includes(compactLeaf)) return 'script';
  if (['bash', 'shell', 'exec', 'execcommand', 'command'].includes(compactLeaf) || compactRaw.includes('execcommand')) return 'command';

  if (compactLeaf === 'task') return 'delegate';
  if (compactLeaf === 'askuserquestion') return 'askUser';
  if (compactLeaf === 'enterplanmode') return 'planEnter';
  if (compactLeaf === 'exitplanmode') return 'planExit';
  if (compactLeaf === 'enterworktree') return 'worktreeEnter';
  if (compactLeaf === 'exitworktree') return 'worktreeExit';
  if (compactLeaf === 'taskoutput') return 'taskOutput';
  if (compactLeaf === 'taskstop') return 'taskStop';
  if (compactLeaf === 'todowrite' || compactLeaf === 'todo') return 'todo';
  if (compactLeaf === 'notebookedit') return 'notebook';
  if (compactLeaf === 'remotetrigger') return 'remote';
  if (compactLeaf === 'skill') return 'skill';
  if (compactLeaf === 'webfetch' || compactLeaf.includes('webfetch')) return 'webFetch';
  if (compactLeaf === 'websearch' || compactLeaf.includes('websearch')) return 'webSearch';
  if (compactLeaf === 'listmcpresourcestool' || compactLeaf === 'listmcpresources') return 'resourceList';
  if (compactLeaf === 'readmcpresourcetool' || compactLeaf === 'readmcpresource') return 'resource';

  if (['read', 'readfile', 'fileread'].includes(compactLeaf)) return 'readFile';
  if (['write', 'writefile', 'createfile'].includes(compactLeaf)) return 'writeFile';
  if (['edit', 'editfile', 'editdiff', 'applypatch'].includes(compactLeaf)) return 'editFile';
  if (['glob', 'findfiles'].includes(compactLeaf)) return 'findFiles';
  if (['grep', 'searchfiles', 'ripgrep', 'rg'].includes(compactLeaf)) return 'searchFiles';
  if (['ls', 'listfiles', 'listdir', 'listdirectory'].includes(compactLeaf)) return 'listDir';

  if (compactServer === 'claudeinchrome') {
    if (compactLeaf === 'tabscontextmcp') return 'tabContext';
    if (compactLeaf === 'tabscreatemcp') return 'tabCreate';
    if (compactLeaf === 'navigate') return 'browserNavigate';
    if (compactLeaf === 'readpage' || compactLeaf === 'getpagetext') return 'pageRead';
    if (compactLeaf === 'find') return 'pageFind';
    if (compactLeaf === 'forminput') return 'formInput';
    if (compactLeaf === 'javascripttool') return 'script';
    if (compactLeaf === 'computer') return browserActionMap[compactAction] || 'browser';
    if (compactLeaf === 'resizewindow') return 'resizeWindow';
    if (compactLeaf === 'gifcreator') return 'gif';
    if (compactLeaf === 'uploadimage') return 'uploadFile';
    if (compactLeaf === 'updateplan') return 'planUpdate';
    if (compactLeaf === 'readconsolemessages') return 'consoleRead';
    if (compactLeaf === 'readnetworkrequests') return 'networkRead';
    if (compactLeaf === 'shortcutslist') return 'shortcutsList';
    if (compactLeaf === 'shortcutsexecute') return 'shortcutsRun';
  }

  if (compactServer === 'playwright') {
    if (compactLeaf.includes('navigate')) return 'browserNavigate';
    if (compactLeaf.includes('click')) return 'browserClick';
    if (compactLeaf.includes('type') || compactLeaf.includes('fill')) return 'browserType';
    if (compactLeaf.includes('select')) return 'browserSelect';
    if (compactLeaf.includes('press') || compactLeaf.includes('key')) return 'browserKey';
    if (compactLeaf.includes('wait')) return 'browserWait';
    if (compactLeaf.includes('snapshot')) return 'browserSnapshot';
    if (compactLeaf.includes('screenshot')) return 'screenshot';
    if (compactLeaf.includes('evaluate')) return 'script';
    if (compactLeaf.includes('upload')) return 'uploadFile';
    if (compactLeaf.includes('resize')) return 'resizeWindow';
    if (compactLeaf.includes('close')) return 'browserStop';
    return 'browser';
  }

  if (compactServer === 'context7') {
    if (compactLeaf.includes('resolvelibrary')) return 'resource';
    if (compactLeaf.includes('getlibrarydocs') || compactLeaf.includes('docs')) return 'docs';
    return 'resource';
  }

  if (compactLeaf.includes('websearch') || compactLeaf === 'searchquery' || display.includes('web search') || display.includes('search web')) return 'webSearch';
  if (compactLeaf.includes('webfetch') || compactLeaf.includes('fetch') || ['open', 'openurl'].includes(compactLeaf)) return 'webFetch';
  if (compactLeaf.includes('browser')) {
    if (compactLeaf.includes('navigate')) return 'browserNavigate';
    if (compactLeaf.includes('click')) return 'browserClick';
    if (compactLeaf.includes('type') || compactLeaf.includes('fill')) return 'browserType';
    if (compactLeaf.includes('scroll')) return 'browserScroll';
    if (compactLeaf.includes('select')) return 'browserSelect';
    if (compactLeaf.includes('press') || compactLeaf.includes('key')) return 'browserKey';
    if (compactLeaf.includes('wait')) return 'browserWait';
    if (compactLeaf.includes('snapshot')) return 'browserSnapshot';
    if (compactLeaf.includes('screenshot')) return 'screenshot';
    if (compactLeaf.includes('evaluate')) return 'script';
    if (compactLeaf.includes('upload')) return 'uploadFile';
    if (compactLeaf.includes('resize')) return 'resizeWindow';
    if (compactLeaf.includes('close')) return 'browserStop';
    return browserActionMap[compactAction] || 'browser';
  }
  if (compactLeaf === 'readpage' || compactLeaf === 'getpagetext') return 'pageRead';
  if (compactLeaf === 'forminput') return 'formInput';
  if (compactLeaf === 'tabscontextmcp') return 'tabContext';
  if (compactLeaf === 'tabscreatemcp') return 'tabCreate';
  if (compactLeaf === 'readconsolemessages') return 'consoleRead';
  if (compactLeaf === 'readnetworkrequests') return 'networkRead';
  if (compactLeaf === 'shortcutslist') return 'shortcutsList';
  if (compactLeaf === 'shortcutsexecute') return 'shortcutsRun';
  if (compactLeaf.includes('screenshot')) return 'screenshot';
  if (compactLeaf === 'describeimages' || compactLeaf.includes('understandimage') || compactLeaf.includes('vision')) return 'image';
  if (compactLeaf === 'generateimages' || compactLeaf.includes('generateimage') || compactLeaf.includes('imagegen')) return 'imageGenerate';
  if (compactLeaf.includes('image')) return 'image';
  if (compactLeaf.includes('pdf')) return 'pdf';

  if (compactLeaf === 'searchmemory') return 'memorySearch';
  if (compactLeaf === 'pinmemory') return 'memoryPin';
  if (compactLeaf === 'unpinmemory') return 'memoryUnpin';
  if (compactLeaf === 'recallexperience') return 'experienceRecall';
  if (compactLeaf === 'recordexperience') return 'experienceRecord';
  if (compactLeaf.includes('memory')) return 'memorySearch';
  if (compactLeaf.includes('installskill')) return 'skillInstall';
  if (compactLeaf.includes('skill')) return 'skill';
  if (compactLeaf.includes('todo')) return 'todo';

  if (compactLeaf === 'cron' || compactLeaf.includes('automation')) {
    if (['list', 'show'].includes(compactAction)) return 'automationList';
    if (['add', 'create', 'pendingadd', 'added'].includes(compactAction)) return 'automationCreate';
    if (['remove', 'delete', 'cancel'].includes(compactAction)) return 'automationRemove';
    if (['toggle', 'enable', 'disable'].includes(compactAction)) return 'automationToggle';
    return 'automationList';
  }

  if (compactLeaf === 'channel') {
    if (compactAction === 'read') return 'channelRead';
    if (compactAction === 'post' || compactAction === 'send') return 'channelPost';
    if (compactAction === 'create') return 'channelCreate';
    if (compactAction === 'list') return 'channelList';
    return 'message';
  }
  if (compactLeaf === 'notify') return 'notification';
  if (compactLeaf === 'dm' || compactLeaf === 'messageagent') return 'message';
  if (compactLeaf.includes('delegate') || compactLeaf.includes('askagent') || compactLeaf.includes('spawnagent')) return 'delegate';
  if (compactLeaf.includes('claudecore')) return 'claudeCore';
  if (compactLeaf.includes('presentfiles') || compactLeaf.includes('outputfile')) return 'fileOutput';
  if (compactLeaf.includes('artifact')) return 'artifact';
  if (compactLeaf.includes('updatesettings') || compactLeaf.includes('settings')) {
    return compactAction === 'search' ? 'settingsSearch' : 'settingsUpdate';
  }
  if (compactLeaf.includes('resource')) return compactLeaf.includes('list') ? 'resourceList' : 'resource';
  if (compactLeaf === 'find') return 'findFiles';
  if (compactLeaf === 'list') return 'listDir';

  return null;
}

function buildToolActionLine(
  name: string,
  phase: 'running' | 'done' | 'failed',
  detail: string,
  args?: Record<string, unknown>,
): string {
  const toolName = getDisplayToolName(name) || name || 'Tool';
  const t = (window as any).t;
  const actionKind = getToolActionKind(name, args);
  const localeKey = isZhLocale() ? 'zh' : 'en';
  const actionLabel = actionKind ? TOOL_ACTION_COPY[localeKey][actionKind][phase] : '';
  if (actionLabel) {
    return detail ? `${actionLabel} · ${detail}` : actionLabel;
  }

  const phaseMap: Record<typeof phase, string> = {
    running: stripLeadingEmoji(t?.('tool._line.running') || (localeKey === 'zh' ? '运行' : 'Running')),
    done: stripLeadingEmoji(t?.('tool._line.done') || (localeKey === 'zh' ? '完成' : 'Done')),
    failed: stripLeadingEmoji(t?.('tool._line.failed') || (localeKey === 'zh' ? '失败' : 'Failed')),
  };

  return detail
    ? `${phaseMap[phase]} ${toolName} · ${detail}`
    : `${phaseMap[phase]} ${toolName}`;
}

function renderActionLineWithDiffColors(text: string) {
  const parts = String(text || '').split(/(\s[+-]\d+(?=\s|$))/g);
  return parts.map((part, idx) => {
    const m = part.match(/^(\s)([+-]\d+)$/);
    if (!m) return part;
    const cls = m[2].startsWith('+') ? 'tool-diff-plus' : 'tool-diff-minus';
    return (
      <span key={`diff-${idx}`}>
        {m[1]}
        <span className={cls}>{m[2]}</span>
      </span>
    );
  });
}

function normalizePreviewText(raw: unknown, maxLen = TOOL_PANEL_TEXT_MAX_LEN): string {
  const text = String(raw ?? '')
    .replace(/\r/g, '')
    .trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 120) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(value);
}

function previewReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (looksLikeBase64(value)) return `[omitted base64, ${value.length} chars]`;
    if (value.length > 1600) return `${value.slice(0, 1600)}… (${value.length} chars)`;
  }
  return value;
}

function stringifyPreview(value: unknown): string {
  if (value == null) return '';
  try {
    return normalizePreviewText(JSON.stringify(value, previewReplacer, 2));
  } catch {
    return normalizePreviewText(String(value));
  }
}

function getCommandInput(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const direct = normalizePreviewText(args.command ?? args.cmd);
  if (direct) return direct;
  return '';
}

function normalizeToolName(name: string): string {
  return String(name || '').trim().toLowerCase();
}

type StructuredToolInput =
  | { kind: 'none' }
  | { kind: 'write'; filePath: string; content: string; lineCount: number }
  | { kind: 'edit'; filePath: string; oldText: string; newText: string; replaceAll: boolean };

function splitPreviewLines(text: string): string[] {
  if (!text) return [TOOL_PREVIEW_EMPTY_LINE];
  return text.split('\n').map((line) => line || TOOL_PREVIEW_EMPTY_LINE);
}

function buildStructuredToolInput(name: string, args?: Record<string, unknown>): StructuredToolInput {
  if (!args || typeof args !== 'object') return { kind: 'none' };
  const tool = normalizeToolName(name);
  const filePath = normalizePreviewText(args.file_path ?? args.path ?? args.filePath);

  if (tool === 'write') {
    const content = normalizePreviewText(args.content);
    if (!filePath && !content) return { kind: 'none' };
    const lineCount = content ? content.split('\n').length : 0;
    return { kind: 'write', filePath, content, lineCount };
  }

  if (tool === 'edit' || tool === 'edit-diff') {
    const oldText = normalizePreviewText(args.old_string ?? args.old_text);
    const newText = normalizePreviewText(args.new_string ?? args.new_text);
    const replaceAll = args.replace_all === true;
    if (!filePath && !oldText && !newText) return { kind: 'none' };
    return { kind: 'edit', filePath, oldText, newText, replaceAll };
  }

  return { kind: 'none' };
}

function ToolCodeLines({ text, symbol, tone }: { text: string; symbol: string; tone: 'write' | 'old' | 'new' }) {
  const lines = splitPreviewLines(text);
  return (
    <div className={`tool-code-block ${tone}`}>
      {lines.map((line, idx) => (
        <div className="tool-code-line" key={`${symbol}-${idx}`}>
          <span className="tool-code-prefix">{symbol}</span>
          <span className="tool-code-content">{line}</span>
        </div>
      ))}
    </div>
  );
}

function StructuredInputPanel({ input }: { input: StructuredToolInput }) {
  if (input.kind === 'none') return null;
  if (input.kind === 'write') {
    return (
      <div className="tool-structured">
        {!!input.filePath && (
          <div className="tool-structured-meta">
            <span>file_path: {input.filePath}</span>
            {input.lineCount > 0 && <span className="tool-structured-flag">{input.lineCount} lines</span>}
          </div>
        )}
        <ToolCodeLines text={input.content} symbol="+" tone="write" />
      </div>
    );
  }
  return (
    <div className="tool-structured">
      {!!input.filePath && (
        <div className="tool-structured-meta">
          <span>file_path: {input.filePath}</span>
          {input.replaceAll && <span className="tool-structured-flag">replace_all</span>}
        </div>
      )}
      {!!input.oldText && (
        <div className="tool-structured-section">
          <div className="tool-structured-section-title">old_string</div>
          <ToolCodeLines text={input.oldText} symbol="-" tone="old" />
        </div>
      )}
      {!!input.newText && (
        <div className="tool-structured-section">
          <div className="tool-structured-section-title">new_string</div>
          <ToolCodeLines text={input.newText} symbol="+" tone="new" />
        </div>
      )}
    </div>
  );
}

function getWriteInputText(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const filePath = normalizePreviewText(args.file_path ?? args.path ?? args.filePath);
  const content = normalizePreviewText(args.content);
  if (!filePath && !content) return '';
  const parts: string[] = [];
  if (filePath) parts.push(`file_path: ${filePath}`);
  if (content) {
    if (parts.length > 0) parts.push('');
    parts.push(content);
  }
  return parts.join('\n');
}

function getEditInputText(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const filePath = normalizePreviewText(args.file_path ?? args.path ?? args.filePath);
  const oldText = normalizePreviewText(args.old_string ?? args.old_text);
  const newText = normalizePreviewText(args.new_string ?? args.new_text);
  const replaceAll = args.replace_all === true;
  if (!filePath && !oldText && !newText) return '';
  const parts: string[] = [];
  if (filePath) parts.push(`file_path: ${filePath}`);
  if (replaceAll) parts.push('replace_all: true');
  if (oldText) {
    if (parts.length > 0) parts.push('');
    parts.push('--- old_string ---');
    parts.push(oldText);
  }
  if (newText) {
    if (parts.length > 0) parts.push('');
    parts.push('--- new_string ---');
    parts.push(newText);
  }
  return parts.join('\n');
}

function getInputText(name: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const tool = normalizeToolName(name);
  if (tool === 'write') {
    const writeText = getWriteInputText(args);
    if (writeText) return writeText;
  }
  if (tool === 'edit' || tool === 'edit-diff') {
    const editText = getEditInputText(args);
    if (editText) return editText;
  }
  const command = getCommandInput(args);
  if (command) return command;
  return stringifyPreview(args);
}

function getOutputText(tool: ToolCall): string {
  const direct = normalizePreviewText(tool.resultText);
  if (direct) return direct;
  if (!tool.details || typeof tool.details !== 'object') return '';
  const keys = ['error', 'summary', 'message', 'output', 'result'];
  for (const key of keys) {
    const value = tool.details[key];
    const text = normalizePreviewText(value);
    if (text) return text;
  }
  return '';
}

function getDetailsText(tool: ToolCall): string {
  if (!tool.details || typeof tool.details !== 'object') return '';
  const details = { ...tool.details };
  if ('content' in details) delete (details as any).content;
  if ('thumbnail' in details) delete (details as any).thumbnail;
  if ('base64' in details) delete (details as any).base64;
  return stringifyPreview(details);
}

export const ToolGroupBlock = memo(function ToolGroupBlock({
  tools,
  agentName,
  dimmed = false,
  animate = false,
}: Props) {
  const [revealedToolCount, setRevealedToolCount] = useState(() => (
    animate ? Math.min(1, tools.length) : tools.length
  ));
  const nextToolDone = tools[revealedToolCount]?.done ?? true;

  useEffect(() => {
    if (!animate) {
      setRevealedToolCount(tools.length);
      return;
    }
    if (revealedToolCount > tools.length) {
      setRevealedToolCount(tools.length);
      return;
    }
    if (revealedToolCount === 0 && tools.length > 0) {
      setRevealedToolCount(1);
    }
  }, [animate, tools.length, revealedToolCount]);

  useEffect(() => {
    if (!animate) return;
    if (revealedToolCount >= tools.length) return;

    const nextIndex = revealedToolCount;
    let delay = TOOL_REVEAL_BASE_DELAY_MS + Math.min(4, Math.max(0, tools.length - nextIndex)) * 18;
    if (!nextToolDone) delay = Math.max(delay, TOOL_REVEAL_AFTER_THINKING_DELAY_MS);
    delay = Math.min(delay, TOOL_REVEAL_MAX_DELAY_MS);

    const timer = window.setTimeout(() => {
      setRevealedToolCount((count) => Math.min(tools.length, count + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [animate, revealedToolCount, tools.length, nextToolDone]);

  const visibleTools = useMemo(
    () => (animate ? tools.slice(0, Math.max(0, revealedToolCount)) : tools),
    [animate, tools, revealedToolCount],
  );

  return (
    <div className={`tool-group proma-like${dimmed ? ' dimmed' : ''}${animate ? ' streaming' : ''}`}>
      <div className="tool-group-content">
        {visibleTools.map((tool, i) => (
          <ToolIndicator
            key={tool.toolUseId || `${tool.name}-${i}`}
            tool={tool}
            agentName={agentName}
            order={i}
          />
        ))}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({
  tool,
  agentName,
  order,
}: {
  tool: ToolCall;
  agentName: string;
  order: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = extractToolDetail(tool.name, tool.args, tool.details);
  const phase = (tool.done ? (tool.success ? 'done' : 'failed') : 'running') as 'running' | 'done' | 'failed';
  const label = getToolLabel(tool.name, phase, agentName, tool.args);
  const actionLine = buildToolActionLine(tool.name, phase, detail, tool.args);
  const t = (window as any).t;
  const doneText = stripLeadingEmoji(t?.('tool._line.done') || '完成');
  const failedText = stripLeadingEmoji(t?.('tool._line.failed') || '失败');
  const inputText = useMemo(() => getInputText(tool.name, tool.args), [tool.name, tool.args]);
  const structuredInput = useMemo(() => buildStructuredToolInput(tool.name, tool.args), [tool.name, tool.args]);
  const outputText = useMemo(() => getOutputText(tool), [tool.resultText, tool.details]);
  const detailsText = useMemo(() => getDetailsText(tool), [tool.details]);
  const hasStructuredInput = structuredInput.kind !== 'none';
  const canExpand = hasStructuredInput || !!inputText || !!outputText || !!detailsText;

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <div
      className={`tool-item ${expanded ? 'expanded' : ''}`}
      data-phase={phase}
      data-tool={tool.name}
      style={{ animationDelay: `${Math.min(order, 10) * 45}ms` }}
    >
      <button
        type="button"
        className={`tool-indicator ${phase}${canExpand ? ' expandable' : ''}`}
        data-phase={phase}
        data-tool={tool.name}
        data-done={String(tool.done)}
        onClick={() => { if (canExpand) setExpanded((v) => !v); }}
        aria-expanded={canExpand ? expanded : undefined}
        aria-label={label}
        disabled={!canExpand}
      >
        <span className="tool-leading">{phase === 'failed' ? '!' : (phase === 'done' ? '✓' : '›')}</span>
        <span className="tool-desc">{renderActionLineWithDiffColors(actionLine)}</span>
        {tag && <span className="tool-tag">{tag}</span>}
        {tool.done ? (
          <span className={`tool-status ${tool.success ? 'done' : 'failed'}`}>
            {tool.success ? doneText : failedText}
          </span>
        ) : (
          <span className="tool-dots"><span /><span /><span /></span>
        )}
        {canExpand && <span className="tool-expand">{expanded ? '▾' : '▸'}</span>}
      </button>

      {canExpand && (
        <div
          className={`tool-panel-collapse${expanded ? ' expanded' : ' collapsed'}`}
          aria-hidden={!expanded}
        >
          <div className="tool-panel-collapse-inner">
            <div className="tool-panel">
              {(hasStructuredInput || inputText) && (
                <div className="tool-panel-row">
                  <div className="tool-panel-label">Input</div>
                  {hasStructuredInput
                    ? <StructuredInputPanel input={structuredInput} />
                    : <pre className="tool-panel-pre">{inputText}</pre>}
                </div>
              )}
              {outputText && (
                <div className="tool-panel-row">
                  <div className="tool-panel-label">Output</div>
                  <pre className="tool-panel-pre">{outputText}</pre>
                </div>
              )}
              {detailsText && (
                <div className="tool-panel-row">
                  <div className="tool-panel-label">Details</div>
                  <pre className="tool-panel-pre">{detailsText}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
