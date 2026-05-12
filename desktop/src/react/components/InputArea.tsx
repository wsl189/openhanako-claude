/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 替代 app-input-shim.ts + app-ui-shim.ts 中的模型/PlanMode/Todo 逻辑。
 * 由 App.tsx 在 .input-area 容器内直接渲染。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../stores';
import { isImageFile, isHttpUrlPath } from '../utils/format';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { ensureSession, loadSessions } from '../stores/session-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { resolveInputSessionKey, type PendingInputPrompt } from '../stores/misc-slice';
import { getWebSocket } from '../services/websocket';
import { streamBufferManager } from '../hooks/use-stream-buffer';
import { usePushToTalk } from '../hooks/use-push-to-talk';
import { SVG_ICONS } from '../utils/icons';
import {
  basename,
  buildDiffContent,
  extractLatestEditSummary,
  type DiffLine,
  type FileChangeSummary,
  type MessageEditSummary,
} from '../utils/chat-edit-summary';
import { openPreview } from '../stores/artifact-actions';
import type { AttachedFile } from '../stores/input-slice';
import type { Artifact } from '../types';

const CHAT_EDIT_MESSAGE_EVENT = 'hana:chat-edit-message';
const CHAT_RESEND_MESSAGE_EVENT = 'hana:chat-resend-message';

// ── Toast 通知 ──

function showToast(text: string, type: 'success' | 'error' = 'success', duration = 20000) {
  useStore.getState().addToast(text, type, duration);
}

function extractFetchErrorMessage(err: unknown, fallback: string): string {
  const message = String((err as any)?.message || '').trim();
  if (!message) return fallback;
  const detail = message.split(' - ').pop()?.trim();
  if (detail && detail !== message) return detail;
  return message;
}

// ── 斜杠命令 ──

const isZh = (window as any).i18n?.locale?.startsWith?.('zh') ?? true;

const XING_PROMPT = isZh
  ? `回顾这个 session 里我（用户）发送的消息。只从我的对话内容中提取指导、偏好、纠正和工作流程，整理成一份可复用的工作指南。

注意：不要提取系统提示词、记忆文件、人格设定等预注入内容，只关注我在本次对话中实际说的话。

要求：
1. 只保留可复用的模式，过滤仅限本次的具体上下文（如具体文件名、具体话题）
2. 按类别组织：风格偏好、工作流程、质量标准、注意事项
3. 措辞用指令式（"做 X"、"避免 Y"）
4. 步骤流程用编号列出

标题要具体，能一眼看出这个工作流是干什么的（例："战争报道事实核查流程""论文润色风格指南"），不要用泛化的名字（如"工作流总结""对话复盘"）。

严格按照以下格式输出（注意用直引号 "，不要用弯引号 ""）：

<xing title="具体的工作流名称">
## 风格偏好
- 做 X
- 避免 Y

## 工作流程
1. 第一步
2. 第二步
</xing>

以上是格式示范，实际内容根据对话提取。`
  : `Review the messages I (the user) sent in this session. Extract only guidance, preferences, corrections, and workflows from my conversation content, and compile them into a reusable work guide.

Note: Do not extract system prompts, memory files, persona settings, or other pre-injected content. Only focus on what I actually said in this conversation.

Requirements:
1. Keep only reusable patterns; filter out context specific to this session (e.g., specific filenames or topics)
2. Organize by category: style preferences, workflows, quality standards, caveats
3. Use imperative phrasing ("Do X", "Avoid Y")
4. Number sequential steps

The title should be specific enough to tell at a glance what this workflow is about (e.g., "War Reporting Fact-Check Process", "Paper Polishing Style Guide"). Avoid generic names (e.g., "Workflow Summary", "Conversation Review").

Output strictly in the following format (use straight quotes ", not curly quotes):

<xing title="Specific workflow name">
## Style Preferences
- Do X
- Avoid Y

## Workflow
1. Step one
2. Step two
</xing>

The above is a format example; actual content should be extracted from the conversation.`;

// ── 斜杠命令定义 ──

interface SlashCommand {
  name: string;
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  execute: () => Promise<void>;
}

type QueuedChatTask = {
  id: string;
  sessionPath: string;
  text: string;
  finalText: string;
  attachments?: AttachedFile[];
  renderAttachments?: Array<AttachedFile & { isDir?: boolean }>;
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
  modelId?: string;
  createdAt: number;
};

const SUPPORTED_CHAT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const CHAT_IMAGE_MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-jpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp',
  'image/ms-bmp': 'image/bmp',
};
const CHAT_IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function normalizeChatImageMime(mimeType: string): string {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (!normalized) return '';
  return CHAT_IMAGE_MIME_ALIASES[normalized] || normalized;
}

function chatImageExtFromMime(mimeType: string): string {
  const normalized = normalizeChatImageMime(mimeType);
  return CHAT_IMAGE_EXT_BY_MIME[normalized] || 'png';
}

function resolveClipboardImageName(file: File | null, ext: string, tFn: (key: string) => string): string {
  const rawName = String(file?.name || '').trim();
  if (!rawName) return `${tFn('input.pastedImage')}.${ext}`;
  const baseName = rawName.split(/[\\/]/).pop() || '';
  if (!baseName) return `${tFn('input.pastedImage')}.${ext}`;
  return baseName;
}

async function transcodeImageDataUrlToPngBase64(dataUrl: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const width = Math.max(1, img.naturalWidth || img.width || 1);
        const height = Math.max(1, img.naturalHeight || img.height || 1);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const pngDataUrl = canvas.toDataURL('image/png');
        const match = pngDataUrl.match(/^data:image\/png;base64,([\s\S]+)$/i);
        resolve(match ? String(match[1] || '').replace(/\s+/g, '') : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ── 主组件 ──

export function InputArea() {
  return <InputAreaInner />;
}

function InputAreaInner() {
  const { t, locale } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.isStreaming);
  const streamingSessions = useStore(s => s.streamingSessions);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const pendingSessionModel = useStore(s => s.pendingSessionModel);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const chatSessions = useStore(s => s.chatSessions);
  const sessionTodos = useStore(s => s.sessionTodos);
  const attachedFiles = useStore(s => s.attachedFiles);
  const artifacts = useStore(s => s.artifacts);
  const currentArtifactId = useStore(s => s.currentArtifactId);
  const previewOpen = useStore(s => s.previewOpen);
  const models = useStore(s => s.models);
  const agentYuan = useStore(s => s.agentYuan);
  const pendingInputPromptsBySession = useStore(s => s.pendingInputPromptsBySession);
  const removePendingInputPrompt = useStore(s => s.removePendingInputPrompt);

  const resolveSelectedModelId = useCallback((): string => {
    const state = useStore.getState();
    const selected = state.pendingNewSession
      ? (
          state.pendingSessionModel
          || state.models.find((m) => m.isCurrent)?.id
          || state.currentModel
          || ''
        )
      : (
          state.models.find((m) => m.isCurrent)?.id
          || state.currentModel
          || state.pendingSessionModel
          || ''
        );
    return String(selected || '').trim();
  }, []);

  // Local state
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null); // command name while executing
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [queuedTasks, setQueuedTasks] = useState<QueuedChatTask[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachFileInputRef = useRef<HTMLInputElement>(null);
  const isComposing = useRef(false);
  const processingQueuedTaskRef = useRef(false);
  const voiceAnchorRef = useRef<{ prefix: string; suffix: string; interim: string } | null>(null);
  const textDraftBySessionRef = useRef<Record<string, string>>({});
  const attachmentDraftBySessionRef = useRef<Record<string, AttachedFile[]>>({});

  const buildVoiceAnchoredText = useCallback((anchor: { prefix: string; suffix: string }, rawText: string) => {
    const text = String(rawText || '').trim();
    const needsLeadingSpace = !!text && anchor.prefix.length > 0 && !/\s$/.test(anchor.prefix);
    const needsTrailingSpace = !!text && anchor.suffix.length > 0 && !/^\s/.test(anchor.suffix);
    const leading = needsLeadingSpace ? ' ' : '';
    const trailing = needsTrailingSpace ? ' ' : '';
    const nextValue = `${anchor.prefix}${leading}${text}${trailing}${anchor.suffix}`;
    const cursor = `${anchor.prefix}${leading}${text}`.length;
    return { text, leading, nextValue, cursor };
  }, []);

  const prepareVoiceAnchor = useCallback(() => {
    const node = textareaRef.current;
    const value = node?.value ?? inputText;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? start;
    const before = value.slice(0, start);
    const after = value.slice(end);
    // 首次按下空格会漏写一个空格，这里在激活录音时把它剥离掉。
    const strippedBefore = before.replace(/[ \u3000]$/, '');
    const nextValue = strippedBefore + after;
    const cursor = strippedBefore.length;

    voiceAnchorRef.current = { prefix: strippedBefore, suffix: after, interim: '' };
    setInputText(nextValue);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }, [inputText]);

  const applyVoiceInterimTranscript = useCallback((rawText: string) => {
    const anchor = voiceAnchorRef.current;
    if (!anchor) return;
    const next = buildVoiceAnchoredText(anchor, rawText);
    setInputText(next.nextValue);
    voiceAnchorRef.current = { ...anchor, interim: next.text };
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  }, [buildVoiceAnchoredText]);

  const applyVoiceTranscript = useCallback((rawText: string) => {
    const text = String(rawText || '').trim();
    if (!text) return;

    const anchor = voiceAnchorRef.current;
    if (!anchor) {
      setInputText((prev) => {
        const leading = prev && !/\s$/.test(prev) ? ' ' : '';
        return `${prev}${leading}${text}`;
      });
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        const pos = el.value.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
      return;
    }

    const next = buildVoiceAnchoredText(anchor, text);
    setInputText(next.nextValue);
    voiceAnchorRef.current = {
      prefix: `${anchor.prefix}${next.leading}${next.text}`,
      suffix: anchor.suffix,
      interim: '',
    };
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  }, [buildVoiceAnchoredText]);

  const voiceLanguage = useMemo(
    () => String(locale || (window as any).i18n?.locale || navigator.language || ''),
    [locale],
  );
  const {
    supported: voiceSupported,
    state: voiceState,
    error: voiceErrorRaw,
    volumeLevel: voiceVolumeLevel,
    clearError: clearVoiceError,
  } = usePushToTalk({
    enabled: true,
    language: voiceLanguage,
    onActivate: prepareVoiceAnchor,
    onInterimTranscript: applyVoiceInterimTranscript,
    onTranscript: applyVoiceTranscript,
  });

  const voiceError = useMemo(() => {
    if (!voiceErrorRaw) return '';
    if (voiceErrorRaw === 'NO_SPEECH') return t('input.voiceNoSpeech');
    if (voiceErrorRaw === 'MIC_PERMISSION_DENIED') return t('input.voiceMicDenied');
    if (voiceErrorRaw === 'VOICE_RECORDER_ERROR') return t('input.voiceRecorderError');
    return extractFetchErrorMessage({ message: voiceErrorRaw }, voiceErrorRaw);
  }, [locale, t, voiceErrorRaw]);

  useEffect(() => {
    if (!voiceErrorRaw) return;
    const timer = setTimeout(() => clearVoiceError(), 4000);
    return () => clearTimeout(timer);
  }, [voiceErrorRaw, clearVoiceError]);

  useEffect(() => {
    if (voiceState === 'idle') voiceAnchorRef.current = null;
  }, [voiceState]);

  const voiceStatusText = useMemo(() => {
    if (!voiceSupported) return '';
    if (voiceState === 'warming') return t('input.voiceWarming');
    if (voiceState === 'recording') return t('input.voiceRecording');
    if (voiceState === 'processing') return t('input.voiceProcessing');
    return t('input.voiceHoldHint');
  }, [locale, t, voiceState, voiceSupported]);

  const inputSessionKey = useMemo(
    () => resolveInputSessionKey(currentSessionPath, pendingNewSession),
    [currentSessionPath, pendingNewSession],
  );
  const pendingInputPrompts = useMemo(
    () => pendingInputPromptsBySession[inputSessionKey] || [],
    [pendingInputPromptsBySession, inputSessionKey],
  );
  const activeInputPrompt = pendingInputPrompts[0] || null;
  const prevInputSessionKeyRef = useRef(inputSessionKey);
  const currentSessionIsStreaming = currentSessionPath
    ? streamingSessions.includes(currentSessionPath)
    : isStreaming;
  const inputIsStreaming = isStreaming || currentSessionIsStreaming;
  const queuedTasksForCurrentSession = useMemo(
    () => queuedTasks.filter((task) => task.sessionPath === currentSessionPath),
    [queuedTasks, currentSessionPath],
  );
  const latestEditSummary = useMemo(() => {
    if (!currentSessionPath || inputIsStreaming) return null;
    const session = chatSessions[currentSessionPath];
    return extractLatestEditSummary(session?.items);
  }, [chatSessions, currentSessionPath, inputIsStreaming]);

  // Focus trigger from store
  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) textareaRef.current?.focus();
  }, [inputFocusTrigger]);

  // Zustand actions
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const setAttachedFiles = useStore(s => s.setAttachedFiles);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);

  // 按 session 保存输入草稿（文本 / 附件）
  useEffect(() => {
    textDraftBySessionRef.current[inputSessionKey] = inputText;
  }, [inputText, inputSessionKey]);

  useEffect(() => {
    attachmentDraftBySessionRef.current[inputSessionKey] = attachedFiles.map((file) => ({ ...file }));
  }, [attachedFiles, inputSessionKey]);

  useEffect(() => {
    const prevKey = prevInputSessionKeyRef.current;
    if (prevKey !== inputSessionKey) {
      textDraftBySessionRef.current[prevKey] = inputText;
      attachmentDraftBySessionRef.current[prevKey] = attachedFiles.map((file) => ({ ...file }));
    }
    prevInputSessionKeyRef.current = inputSessionKey;

    const nextText = textDraftBySessionRef.current[inputSessionKey] ?? '';
    const nextFiles = (attachmentDraftBySessionRef.current[inputSessionKey] || []).map((file) => ({ ...file }));

    setInputText(nextText);
    setAttachedFiles(nextFiles);
    setSlashMenuOpen(false);
  }, [inputSessionKey]);

  const beginOptimisticStreamingTurn = useCallback((sessionPath: string | null) => {
    if (!sessionPath) return;
    const now = Date.now();
    useStore.setState((prev: any) => {
      const list: string[] = Array.isArray(prev.streamingSessions) ? prev.streamingSessions : [];
      const sinceMap: Record<string, number> = (prev.streamingSinceByPath || {}) as Record<string, number>;
      return {
        isStreaming: true,
        streamingSessions: list.includes(sessionPath) ? list : [...list, sessionPath],
        streamingSinceByPath: {
          ...sinceMap,
          [sessionPath]: sinceMap[sessionPath] ?? now,
        },
      };
    });
    streamBufferManager.startTurn(sessionPath);
  }, []);

  // Doc context: current open artifact with filePath
  const currentDoc = useMemo(() => {
    if (!previewOpen || !currentArtifactId) return null;
    const art = artifacts.find(a => a.id === currentArtifactId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [previewOpen, currentArtifactId, artifacts]);
  const hasDoc = !!currentDoc;
  const autoDocContextAttached = hasDoc;

  // ── 统一命令发送 ──

  const prepareCurrentChatTask = useCallback(async (
    sessionPath: string,
    modelId?: string,
  ): Promise<QueuedChatTask | null> => {
    const text = inputText.trim();
    const safeAttachedFiles = attachedFiles.filter((f) => !isHttpUrlPath(f.path));
    const hasFiles = safeAttachedFiles.length > 0;
    if (!sessionPath || (!text && !hasFiles && !(autoDocContextAttached && currentDoc))) return null;

    const imageFiles = hasFiles ? safeAttachedFiles.filter(f => !f.isDirectory && isImageFile(f.name)) : [];
    let finalText = text;
    if (hasFiles) {
      const fileBlock = safeAttachedFiles
        .map(f => f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`)
        .join('\n');
      finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
    }

    const hana = (window as any).hana;
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const inlineImageMap = new Map<string, { base64Data: string; mimeType: string }>();
    if (imageFiles.length > 0) {
      for (const img of imageFiles) {
        try {
          if (img.base64Data && img.mimeType) {
            images.push({ type: 'image', data: img.base64Data, mimeType: img.mimeType });
            inlineImageMap.set(img.path, { base64Data: img.base64Data, mimeType: img.mimeType });
          } else if (hana?.readFileBase64) {
            const base64: string = await hana.readFileBase64(img.path);
            if (base64) {
              const ext = img.name.toLowerCase().replace(/^.*\./, '');
              const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
              const mimeType = mimeMap[ext] || 'image/png';
              images.push({ type: 'image', data: base64, mimeType });
              inlineImageMap.set(img.path, { base64Data: base64, mimeType });
            }
          }
        } catch {
          // 路径文本已在 fileBlock 中，读取失败不阻塞发送。
        }
      }
    }

    let docForRender: { path: string; name: string } | null = null;
    if (autoDocContextAttached && currentDoc) {
      const docBlock = `[参考文档] ${currentDoc.path}`;
      finalText = finalText ? `${finalText}\n\n${docBlock}` : docBlock;
      docForRender = currentDoc;
    }

    const renderAttachments: Array<AttachedFile & { isDir?: boolean }> = [];
    if (hasFiles) {
      for (const f of safeAttachedFiles) {
        const inlineImage = inlineImageMap.get(f.path);
        renderAttachments.push({
          ...f,
          isDir: !!f.isDirectory,
          base64Data: inlineImage?.base64Data ?? f.base64Data,
          mimeType: inlineImage?.mimeType ?? f.mimeType,
        });
      }
    }
    if (docForRender) {
      renderAttachments.push({
        path: docForRender.path,
        name: docForRender.name,
        isDirectory: false,
        isDir: false,
      } as AttachedFile & { isDir?: boolean });
    }

    return {
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sessionPath,
      text: text || finalText,
      finalText,
      attachments: safeAttachedFiles.map((file) => ({ ...file })),
      renderAttachments: renderAttachments.length > 0 ? renderAttachments : undefined,
      images: images.length > 0 ? images : undefined,
      modelId,
      createdAt: Date.now(),
    };
  }, [inputText, attachedFiles, autoDocContextAttached, currentDoc]);

  const clearComposerAfterTaskCapture = useCallback(() => {
    setInputText('');
    clearAttachedFiles();
  }, [clearAttachedFiles]);

  const executeChatTask = useCallback(async (task: QueuedChatTask, mode: 'prompt' | 'steer' = 'prompt') => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const { renderMarkdown } = await import('../utils/markdown');
    useStore.getState().appendItem(task.sessionPath, {
      type: 'message',
      data: {
        id: `user-${Date.now()}`,
        role: 'user',
        text: task.text,
        textHtml: renderMarkdown(task.text),
        attachments: task.renderAttachments && task.renderAttachments.length > 0
          ? task.renderAttachments.map((f: any) => ({
            path: f.path,
            name: f.name,
            isDir: !!f.isDir || !!f.isDirectory,
            base64Data: f.base64Data,
            mimeType: f.mimeType,
          }))
          : undefined,
      },
    });
    useStore.setState({ welcomeVisible: false });
    if (mode === 'prompt') {
      beginOptimisticStreamingTurn(task.sessionPath);
    }

    const wsMsg: any = { type: mode, text: task.finalText, sessionPath: task.sessionPath };
    if (mode === 'prompt' && task.modelId) wsMsg.modelId = task.modelId;
    if (task.images && task.images.length > 0) wsMsg.images = task.images;
    ws.send(JSON.stringify(wsMsg));
    return true;
  }, [beginOptimisticStreamingTurn]);

  /** 统一的"以用户身份发送"入口，所有斜杠命令共用 */
  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const live = useStore.getState();
    const liveStreamingSessions = Array.isArray(live.streamingSessions) ? live.streamingSessions : [];
    if (live.isStreaming || (live.currentSessionPath && liveStreamingSessions.includes(live.currentSessionPath))) {
      return false;
    }
    const draftModelIdBeforeEnsure = pendingNewSession ? resolveSelectedModelId() : '';

    if (pendingNewSession) {
      const ok = await ensureSession();
      if (!ok) return false;
      loadSessions();
    }

    // 用户消息写入 store，React 渲染
    const sessionPath = useStore.getState().currentSessionPath;
    if (sessionPath) {
      const { renderMarkdown } = await import('../utils/markdown');
      const msgText = displayText ?? text;
      useStore.getState().appendItem(sessionPath, {
        type: 'message',
        data: { id: `user-${Date.now()}`, role: 'user', text: msgText, textHtml: renderMarkdown(msgText) },
      });
      useStore.setState({ welcomeVisible: false });
      beginOptimisticStreamingTurn(sessionPath);
    }
    const wsMsg: any = { type: 'prompt', text, sessionPath: useStore.getState().currentSessionPath };
    // 仅在草稿会话首轮发送时透传一次模型，避免每轮 prompt 意外覆盖 session 绑定模型。
    if (draftModelIdBeforeEnsure) wsMsg.modelId = draftModelIdBeforeEnsure;
    ws.send(JSON.stringify(wsMsg));
    return true;
  }, [pendingNewSession, beginOptimisticStreamingTurn, resolveSelectedModelId]);

  // ── 斜杠命令 ──

  const showSlashResult = useCallback((text: string, type: 'success' | 'error') => {
    setSlashBusy(null);
    setSlashResult({ text, type });
    setTimeout(() => setSlashResult(null), 3000);
  }, []);

  const executeDiary = useCallback(async () => {
    setSlashBusy('diary');
    setSlashResult(null);
    setInputText('');
    setSlashMenuOpen(false);

    try {
      const res = await hanaFetch('/api/diary/write', { method: 'POST', timeout: 180_000 });
      const data = await res.json();

      if (!res.ok || data.error) {
        showSlashResult(data.error || t('slash.diaryFailed'), 'error');
        return;
      }

      // 立即刷新右侧书桌，确保 diary/日记 目录实时出现
      loadDeskFiles().catch(() => {});
      showSlashResult(t('slash.diaryDone'), 'success');
    } catch (err: any) {
      const timeoutLike = err?.name === 'AbortError';
      showSlashResult(timeoutLike ? t('slash.diaryTimeout') : t('slash.diaryFailed'), 'error');
    }
  }, [t, showSlashResult]);

  const executeXing = useCallback(async () => {
    setInputText('');
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser]);

  const slashCommands: SlashCommand[] = useMemo(() => [
    {
      name: 'diary',
      label: '/diary',
      description: t('slash.diary'),
      busyLabel: t('slash.diaryBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      execute: executeDiary,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('slash.xing'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
      execute: executeXing,
    },
  ], [executeDiary, executeXing, t]);

  // 过滤匹配的命令
  const filteredCommands = useMemo(() => {
    if (!inputText.startsWith('/')) return slashCommands;
    const query = inputText.slice(1).toLowerCase();
    return slashCommands.filter(c => c.name.startsWith(query));
  }, [inputText, slashCommands]);

  // 输入 / 时打开菜单
  const handleInputChange = useCallback((value: string) => {
    setInputText(value);
    if (value.startsWith('/') && value.length <= 20) {
      setSlashMenuOpen(true);
      setSlashSelected(0);
    } else {
      setSlashMenuOpen(false);
    }
  }, []);

  // Can send?
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || autoDocContextAttached;
  const canSubmit = hasContent && connected && !sending;

  const appendPickedFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const maxAttachments = 9;
    let count = attachedFiles.length;
    const seenPathSet = new Set(attachedFiles.map((file) => file.path));

    for (const file of Array.from(files)) {
      if (count >= maxAttachments) break;
      const absolutePath = window.platform?.getFilePath?.(file);
      if (!absolutePath || isHttpUrlPath(absolutePath) || seenPathSet.has(absolutePath)) continue;

      addAttachedFile({
        path: absolutePath,
        name: file.name || absolutePath.split('/').pop() || absolutePath,
        isDirectory: false,
      });
      seenPathSet.add(absolutePath);
      count += 1;
    }
  }, [addAttachedFile, attachedFiles]);

  const handleAttachPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    appendPickedFiles(e.target.files);
    e.currentTarget.value = '';
  }, [appendPickedFiles]);

  const handlePickAttachments = useCallback(() => {
    attachFileInputRef.current?.click();
  }, []);

  // ── Auto resize ──
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [inputText]);

  // ── Placeholder from yuan ──
  const placeholder = (() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();


  // ── Paste image ──
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      const itemMime = normalizeChatImageMime(item.type);
      const file = item.getAsFile();
      const fileMime = normalizeChatImageMime(file?.type || '');
      const looksLikeImage = itemMime.startsWith('image/') || fileMime.startsWith('image/');
      if (!looksLikeImage || !file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result || '');
        const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/i);
        if (!match) return;

        let mimeType = normalizeChatImageMime(match[1] || fileMime || itemMime || 'image/png');
        let base64Data = String(match[2] || '').replace(/\s+/g, '');

        if (!mimeType.startsWith('image/')) mimeType = fileMime || itemMime || 'image/png';
        if (!SUPPORTED_CHAT_IMAGE_MIME.has(mimeType)) {
          const converted = await transcodeImageDataUrlToPngBase64(dataUrl);
          if (!converted) {
            showToast(t('error.unsupportedImageFormat', { mime: mimeType || 'unknown' }), 'error', 2500);
            return;
          }
          mimeType = 'image/png';
          base64Data = converted;
        }

        const ext = chatImageExtFromMime(mimeType);
        const displayName = resolveClipboardImageName(file, ext, t);
        addAttachedFile({
          path: `clipboard-${Date.now()}.${ext}`,
          name: displayName,
          base64Data,
          mimeType,
        });
      };
      reader.readAsDataURL(file);
      break; // 只处理第一张
    }

    const plainText = e.clipboardData?.getData('text/plain') ?? '';
    if (!plainText) return;

    // 复制聊天区“用户消息”到输入框时，浏览器会附带尾部空行（通常是 \n\n）。
    // 仅在来源明确是用户消息文本时去掉尾部空行，避免影响普通外部粘贴。
    const htmlText = e.clipboardData?.getData('text/html') ?? '';
    const fromUserMessage = htmlText.includes('user-msg-text');
    if (!fromUserMessage) return;

    const normalized = plainText
      .replace(/\r\n?/g, '\n')
      .replace(/\n{2,}$/g, '');

    if (normalized === plainText) return;

    e.preventDefault();
    const el = e.currentTarget as HTMLTextAreaElement;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const current = el.value ?? '';
    const next = current.slice(0, start) + normalized + current.slice(end);
    setInputText(next);

    requestAnimationFrame(() => {
      const cursor = start + normalized.length;
      el.setSelectionRange(cursor, cursor);
    });
  }, [addAttachedFile, t]);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    // 优先读取 textarea 实时值，规避点击发送时 React state 尚未同步的问题（Windows + IME 更常见）。
    const liveText = textareaRef.current?.value ?? inputText;
    const text = liveText.trim();
    const draftModelIdBeforeEnsure = pendingNewSession ? resolveSelectedModelId() : '';

    // 斜杠命令拦截
    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    const hasFiles = attachedFiles.filter((f) => !isHttpUrlPath(f.path)).length > 0;
    if ((!text && !hasFiles && !autoDocContextAttached) || !connected) return;
    if (sending) return;
    setSending(true);

    try {
      if (!inputIsStreaming && pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) return;
        loadSessions();
      }

      const sessionPath = useStore.getState().currentSessionPath;
      if (!sessionPath) return;
      const task = await prepareCurrentChatTask(sessionPath, draftModelIdBeforeEnsure || undefined);
      if (!task) return;

      clearComposerAfterTaskCapture();
      if (inputIsStreaming) {
        setQueuedTasks((prev) => [...prev, task]);
        return;
      }
      await executeChatTask(task, 'prompt');
    } finally {
      setSending(false);
    }
  }, [
    inputText,
    attachedFiles,
    autoDocContextAttached,
    connected,
    inputIsStreaming,
    sending,
    pendingNewSession,
    slashMenuOpen,
    filteredCommands,
    slashSelected,
    prepareCurrentChatTask,
    clearComposerAfterTaskCapture,
    executeChatTask,
    resolveSelectedModelId,
  ]);

  const resendUserMessage = useCallback(async (rawText: string) => {
    const text = String(rawText || '').trim();
    if (!text || !connected || sending) return;
    const draftModelIdBeforeEnsure = pendingNewSession ? resolveSelectedModelId() : '';
    setSending(true);
    try {
      if (!inputIsStreaming && pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) return;
        loadSessions();
      }
      const sessionPath = useStore.getState().currentSessionPath;
      if (!sessionPath) return;
      const task: QueuedChatTask = {
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sessionPath,
        text,
        finalText: text,
        modelId: draftModelIdBeforeEnsure || undefined,
        createdAt: Date.now(),
      };
      if (inputIsStreaming) {
        setQueuedTasks((prev) => [...prev, task]);
        return;
      }
      await executeChatTask(task, 'prompt');
    } finally {
      setSending(false);
    }
  }, [connected, sending, pendingNewSession, resolveSelectedModelId, inputIsStreaming, executeChatTask]);

  useEffect(() => {
    const onEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      const text = String(detail?.text || '');
      setInputText(text);
      setSlashMenuOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const cursor = text.length;
        el.setSelectionRange(cursor, cursor);
      });
    };
    const onResend = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      void resendUserMessage(String(detail?.text || ''));
    };

    window.addEventListener(CHAT_EDIT_MESSAGE_EVENT, onEdit as EventListener);
    window.addEventListener(CHAT_RESEND_MESSAGE_EVENT, onResend as EventListener);
    return () => {
      window.removeEventListener(CHAT_EDIT_MESSAGE_EVENT, onEdit as EventListener);
      window.removeEventListener(CHAT_RESEND_MESSAGE_EVENT, onResend as EventListener);
    };
  }, [resendUserMessage]);

  // ── Steer (插话) ──
  const handleGuideTask = useCallback(async (task: QueuedChatTask) => {
    if (!inputIsStreaming) return;
    setQueuedTasks((prev) => prev.filter((item) => item.id !== task.id));
    await executeChatTask(task, 'steer');
  }, [executeChatTask, inputIsStreaming]);

  const handleRemoveQueuedTask = useCallback((taskId: string) => {
    setQueuedTasks((prev) => prev.filter((item) => item.id !== taskId));
  }, []);

  const handleEditQueuedTask = useCallback((task: QueuedChatTask) => {
    setQueuedTasks((prev) => prev.filter((item) => item.id !== task.id));
    setInputText(task.text);
    setAttachedFiles((task.attachments || []).map((file) => ({ ...file })));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = el.value.length;
      el.setSelectionRange(pos, pos);
    });
  }, [setAttachedFiles]);

  // ── Stop generation ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!inputIsStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [inputIsStreaming]);

  useEffect(() => {
    if (inputIsStreaming || !currentSessionPath || processingQueuedTaskRef.current) return;
    const nextTask = queuedTasks.find((task) => task.sessionPath === currentSessionPath);
    if (!nextTask) return;

    processingQueuedTaskRef.current = true;
    setQueuedTasks((prev) => prev.filter((task) => task.id !== nextTask.id));
    executeChatTask(nextTask, 'prompt')
      .catch((err) => {
        const fallback = String((window as any).i18n?.locale || '').startsWith('zh')
          ? '队列任务发送失败，请重试。'
          : 'Failed to send queued task. Please retry.';
        showToast(extractFetchErrorMessage(err, fallback), 'error', 5000);
      })
      .finally(() => {
        processingQueuedTaskRef.current = false;
      });
  }, [inputIsStreaming, currentSessionPath, queuedTasks, executeChatTask]);

  // ── Key handler ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 斜杠菜单导航
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelected(i => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelected];
        if (cmd) setInputText('/' + cmd.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, slashMenuOpen, filteredCommands, slashSelected]);

  return (
    <>
      <TodoDisplay todos={sessionTodos} isStreaming={inputIsStreaming} />
      {latestEditSummary && (
        <ChatEditSummaryBar
          summary={latestEditSummary}
        />
      )}

      {attachedFiles.length > 0 && (
        <AttachedFilesBar
          files={attachedFiles}
          onRemove={removeAttachedFile}
        />
      )}

      {slashMenuOpen && filteredCommands.length > 0 && (
        <SlashCommandMenu
          commands={filteredCommands}
          selected={slashSelected}
          busy={slashBusy}
          onSelect={(cmd) => cmd.execute()}
          onHover={(i) => setSlashSelected(i)}
        />
      )}

      {slashBusy && (
        <div className="slash-busy-bar">
          <span className="slash-busy-dot" />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}</span>
        </div>
      )}
      {!slashBusy && slashResult && (
        <div className={`slash-busy-bar slash-result-${slashResult.type}`}>
          <span>{slashResult.text}</span>
        </div>
      )}
      {voiceError && (
        <div className="slash-busy-bar slash-result-error">
          <span>{voiceError}</span>
        </div>
      )}

      {queuedTasksForCurrentSession.length > 0 && (
        <QueuedChatTaskList
          tasks={queuedTasksForCurrentSession}
          isStreaming={inputIsStreaming}
          onGuide={handleGuideTask}
          onRemove={handleRemoveQueuedTask}
          onEdit={handleEditQueuedTask}
        />
      )}

      {activeInputPrompt && (
        <InputPromptPanel
          prompt={activeInputPrompt}
          queueSize={pendingInputPrompts.length}
          onResolved={(confirmId) => removePendingInputPrompt(confirmId, inputSessionKey)}
        />
      )}

      <div className="input-wrapper">
        <textarea
          ref={textareaRef}
          id="inputBox"
          className="input-box"
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          value={inputText}
          onChange={e => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }}
        />

        <div className="input-bottom-bar">
          <div className="input-actions">
            <div className="attach-menu-wrap">
              <button
                type="button"
                className="attach-menu-trigger"
                title={t('input.addAttachment')}
                aria-label={t('input.addAttachment')}
                onClick={handlePickAttachments}
              >
                <span className="attach-menu-plus">+</span>
              </button>
              <input
                ref={attachFileInputRef}
                className="attach-menu-file-input"
                type="file"
                multiple
                onChange={handleAttachPickerChange}
              />
            </div>
          </div>
          <div className="input-controls">
            {voiceSupported && (
              <span
                className={`voice-mic-indicator state-${voiceState}${voiceState !== 'idle' ? ' active' : ''}`}
                title={voiceStatusText}
                aria-label={voiceStatusText}
                style={{ '--voice-level': voiceVolumeLevel.toFixed(3) } as any}
              >
                <span
                  className="voice-mic-glyph"
                  aria-hidden="true"
                >
                  <span
                    className="voice-mic-outline"
                    dangerouslySetInnerHTML={{ __html: SVG_ICONS.mic }}
                  />
                  <span
                    className="voice-mic-fill"
                    dangerouslySetInnerHTML={{ __html: SVG_ICONS.micFill }}
                  />
                </span>
              </span>
            )}
            <ContextRing />
            <ModelSelector
              models={models}
              disabled={sending}
            />
            <SendButton
              isStreaming={inputIsStreaming}
              hasInput={hasContent}
              disabled={inputIsStreaming ? (!hasContent ? false : !canSubmit) : !canSubmit}
              onSend={handleSend}
              onStop={handleStop}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function QueuedChatTaskList({
  tasks,
  isStreaming,
  onGuide,
  onRemove,
  onEdit,
}: {
  tasks: QueuedChatTask[];
  isStreaming: boolean;
  onGuide: (task: QueuedChatTask) => void;
  onRemove: (taskId: string) => void;
  onEdit: (task: QueuedChatTask) => void;
}) {
  const isZh = String((window as any).i18n?.locale || '').startsWith('zh');
  return (
    <div className="queued-chat-list" aria-live="polite">
      {tasks.map((task, index) => (
        <div key={task.id} className="queued-chat-item">
          <div className="queued-chat-main">
            <span className="queued-chat-index">{index + 1}</span>
            <span className="queued-chat-text">{task.text}</span>
          </div>
          <div className="queued-chat-actions">
            <button
              type="button"
              className="queued-chat-guide"
              disabled={!isStreaming}
              onClick={() => onGuide(task)}
              title={isZh ? '立即引导当前回复' : 'Guide current response now'}
            >
              <span className="queued-chat-guide-icon">↪</span>
              <span>{isZh ? '引导' : 'Guide'}</span>
            </button>
            <button
              type="button"
              className="queued-chat-icon-btn"
              onClick={() => onRemove(task.id)}
              title={isZh ? '删除' : 'Delete'}
              aria-label={isZh ? '删除' : 'Delete'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v5" />
                <path d="M14 11v5" />
              </svg>
            </button>
            <button
              type="button"
              className="queued-chat-icon-btn"
              onClick={() => onEdit(task)}
              title={isZh ? '重新编辑' : 'Edit again'}
              aria-label={isZh ? '重新编辑' : 'Edit again'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatEditSummaryBar({
  summary,
}: {
  summary: MessageEditSummary;
}) {
  const [expanded, setExpanded] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState('');
  const zh = String((window as any).i18n?.locale || '').startsWith('zh');

  const summaryText = useMemo(() => (
    zh
      ? `${summary.files.length} 个文件已更改`
      : `${summary.files.length} changed file${summary.files.length > 1 ? 's' : ''}`
  ), [summary.files.length, zh]);

  const openFileDiffPreview = useCallback((file: FileChangeSummary) => {
    const ext = file.filePath.includes('.')
      ? file.filePath.split('.').pop()?.toLowerCase() || ''
      : '';
    const artifact: Artifact = {
      id: `chat-edit-diff-${summary.messageId}-${file.filePath}`,
      type: 'diff',
      title: `${basename(file.filePath)} · Diff`,
      filePath: file.filePath,
      ext,
      language: ext || undefined,
      content: buildDiffContent(file.diffLines),
      meta: { diffLines: file.diffLines },
    };
    setActiveFilePath(file.filePath);
    openPreview(artifact, { replaceRightSidebar: true });
  }, [summary.messageId]);

  const handleReview = useCallback(() => {
    const first = summary.files[0];
    if (!first) return;
    openFileDiffPreview(first);
  }, [openFileDiffPreview, summary.files]);

  return (
    <div className={`chat-edit-summary${expanded ? ' expanded' : ''}`}>
      <div className="chat-edit-summary-head">
        <button
          type="button"
          className="chat-edit-summary-main"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          <span className="chat-edit-summary-title">{summaryText}</span>
          <span className="chat-edit-summary-plus">+{summary.totalPlus}</span>
          <span className="chat-edit-summary-minus">-{summary.totalMinus}</span>
        </button>
        <div className="chat-edit-summary-actions">
          <button
            type="button"
            className="chat-edit-summary-action"
            onClick={handleReview}
            disabled={summary.files.length === 0}
          >
            {zh ? '审核' : 'Review'}
          </button>
          <button
            type="button"
            className="chat-edit-summary-expand"
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={expanded ? (zh ? '收起' : 'Collapse') : (zh ? '展开' : 'Expand')}
          >
            {expanded ? '▴' : '▾'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="chat-edit-summary-list">
          {summary.files.map((file) => (
            <button
              type="button"
              key={file.filePath}
              className={`chat-edit-summary-file${activeFilePath === file.filePath ? ' active' : ''}`}
              onClick={() => openFileDiffPreview(file)}
            >
              <span className="chat-edit-summary-file-path">{file.filePath}</span>
              <span className="chat-edit-summary-plus">+{file.plus}</span>
              <span className="chat-edit-summary-minus">-{file.minus}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Todo Display ──

type TodoDisplayItem = {
  text?: string;
  content?: string;
  status?: string;
  done?: boolean;
};

function TodoDisplay({ todos, isStreaming }: { todos: TodoDisplayItem[]; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const visibleTodos = useMemo(() => (
    (todos || [])
      .map((td) => {
        const text = String(td.text || td.content || '').trim();
        const status = String(td.status || '').trim();
        return {
          ...td,
          text,
          status,
          done: td.done === true || status === 'completed',
        };
      })
      .filter(td => td.text)
  ), [todos]);
  const done = visibleTodos.filter(td => td.done).length;
  const allDone = visibleTodos.length > 0 && done === visibleTodos.length;
  // 全部完成后直接隐藏，避免后续每轮流式回复又把旧清单弹出来。
  const shouldHide = visibleTodos.length === 0 || allDone;

  useEffect(() => {
    if (shouldHide) {
      setOpen(false);
      return;
    }
    setOpen(true);
  }, [shouldHide, visibleTodos.length, done, isStreaming]);

  if (shouldHide) return null;

  return (
    <div className="input-top-bar">
      <div className={'todo-display has-todos' + (open ? ' open' : '')}>
        <button className="todo-trigger" onClick={() => setOpen(!open)}>
          <span className="todo-trigger-icon">☑</span>
          <span className="todo-trigger-label">To Do</span>
          <span className="todo-trigger-count">{done}/{visibleTodos.length}</span>
        </button>
        {open && (
          <div className="todo-list">
            {visibleTodos.map((td, i) => {
              const running = !td.done && td.status === 'in_progress';
              return (
                <div
                  key={i}
                  className={'todo-item' + (td.done ? ' done' : '') + (running ? ' running' : '')}
                >
                  <span className="todo-check">
                    {running ? <span className="todo-spinner" /> : (td.done ? '✓' : '○')}
                  </span>
                  <span className="todo-text">{td.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function InputPromptPanel({
  prompt,
  queueSize,
  onResolved,
}: {
  prompt: PendingInputPrompt;
  queueSize: number;
  onResolved: (confirmId: string) => void;
}) {
  const [submittingAction, setSubmittingAction] = useState<'confirmed' | 'rejected' | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string | string[]>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [activeAskIndex, setActiveAskIndex] = useState(0);
  const isZh = String((window as any).i18n?.locale || '').startsWith('zh');

  useEffect(() => {
    setSubmittingAction(null);
    setAnswers({});
    setActiveAskIndex(0);
    if (prompt.kind !== 'ask_user') {
      setSelectedOptions({});
      return;
    }
    const init: Record<string, string | string[]> = {};
    for (const question of prompt.questions || []) {
      const id = String(question?.id || '').trim();
      if (!id) continue;
      const firstOption = String(question?.options?.[0]?.label || '').trim();
      if (!firstOption) continue;
      if (question.multiSelect) init[id] = [firstOption];
      else init[id] = firstOption;
    }
    setSelectedOptions(init);
  }, [prompt]);

  useEffect(() => {
    if (prompt.kind !== 'ask_user') return;
    const maxIndex = Math.max(0, prompt.questions.length - 1);
    setActiveAskIndex((prev) => Math.min(prev, maxIndex));
  }, [prompt]);

  const submitPrompt = useCallback(async (
    action: 'confirmed' | 'rejected',
    value?: Record<string, unknown>,
  ) => {
    if (submittingAction) return;
    setSubmittingAction(action);
    try {
      await hanaFetch(`/api/confirm/${prompt.confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value ? { action, value } : { action }),
      });
      onResolved(prompt.confirmId);
    } catch (err) {
      const fallback = isZh ? '确认提交失败，请重试。' : 'Failed to submit confirmation, please retry.';
      showToast(extractFetchErrorMessage(err, fallback), 'error', 5000);
    } finally {
      setSubmittingAction(null);
    }
  }, [prompt.confirmId, submittingAction, onResolved, isZh]);

  const handleAskApprove = useCallback(async () => {
    if (prompt.kind !== 'ask_user') return;
    const finalAnswers: Record<string, unknown> = {};
    for (let i = 0; i < prompt.questions.length; i += 1) {
      const question = prompt.questions[i];
      const id = String(question?.id || '').trim() || `q_${i + 1}`;
      const freeText = String(answers[id] || '').trim();
      if (freeText) {
        finalAnswers[id] = freeText;
        continue;
      }

      const fallback = String(question?.options?.[0]?.label || '').trim();
      if (question.multiSelect) {
        const selected = selectedOptions[id];
        const labels = Array.isArray(selected)
          ? selected.map((item) => String(item || '').trim()).filter(Boolean)
          : (typeof selected === 'string' && selected.trim() ? [selected.trim()] : []);
        if (labels.length > 0) {
          finalAnswers[id] = labels.join(', ');
        } else if (fallback) {
          finalAnswers[id] = fallback;
        }
        continue;
      }

      const selected = selectedOptions[id];
      const selectedText = typeof selected === 'string' ? selected.trim() : '';
      const value = selectedText || fallback;
      if (value) finalAnswers[id] = value;
    }
    await submitPrompt('confirmed', finalAnswers);
  }, [prompt, answers, selectedOptions, submitPrompt]);

  const handleReject = useCallback(async () => {
    await submitPrompt('rejected');
  }, [submitPrompt]);

  const isSubmitting = !!submittingAction;

  if (prompt.kind === 'plan_mode') {
    const isEnter = prompt.phase === 'enter';
    const title = isEnter
      ? (isZh ? '请求进入计划模式' : 'Request to Enter Plan Mode')
      : (isZh ? '请求退出计划模式' : 'Request to Exit Plan Mode');
    const subtitle = isEnter
      ? (isZh ? 'Agent 想先给出计划，再执行操作。' : 'Agent wants to provide a plan before execution.')
      : (isZh ? 'Agent 已完成计划，请确认是否结束计划模式。' : 'Agent has finished planning, confirm whether to exit plan mode.');
    const planItems = Array.isArray(prompt.allowedPrompts)
      ? prompt.allowedPrompts.filter((item) => item?.prompt)
      : [];

    return (
      <div className="input-prompt-panel" role="group" aria-live="polite">
        <div className="input-prompt-head">
          <span className="input-prompt-kicker">{isZh ? '等待确认' : 'Pending Confirmation'}</span>
          {queueSize > 1 && (
            <span className="input-prompt-queue">
              {isZh ? `后续还有 ${queueSize - 1} 项` : `${queueSize - 1} more pending`}
            </span>
          )}
        </div>
        <div className="input-prompt-title">{title}</div>
        <div className="input-prompt-subtitle">{subtitle}</div>
        {prompt.prompt ? <div className="input-prompt-text">{prompt.prompt}</div> : null}
        {planItems.length > 0 ? (
          <div className="input-prompt-plan-list">
            {planItems.map((item, idx) => (
              <div key={`${item.tool}-${idx}`} className="input-prompt-plan-item">
                {idx + 1}. [{item.tool || 'Bash'}] {item.prompt}
              </div>
            ))}
          </div>
        ) : null}
        <div className="input-prompt-actions">
          <button
            type="button"
            className="input-prompt-btn approve"
            disabled={isSubmitting}
            onClick={() => submitPrompt('confirmed')}
          >
            {isZh ? '确认' : 'Approve'}
          </button>
          <button
            type="button"
            className="input-prompt-btn reject"
            disabled={isSubmitting}
            onClick={handleReject}
          >
            {isZh ? '拒绝' : 'Reject'}
          </button>
        </div>
      </div>
    );
  }

  const askQuestions = prompt.questions || [];
  const currentIndex = Math.min(activeAskIndex, Math.max(askQuestions.length - 1, 0));
  const currentQuestion = askQuestions[currentIndex];
  const currentQuestionId = String(currentQuestion?.id || '').trim() || `q_${currentIndex + 1}`;
  const currentTitle = String(currentQuestion?.question || '').trim()
    || String(currentQuestion?.header || '').trim()
    || `${isZh ? '问题' : 'Question'} ${currentIndex + 1}`;
  const currentDescription = '';
  const currentOptions = Array.isArray(currentQuestion?.options)
    ? currentQuestion.options.filter((option) => option?.label)
    : [];
  const hasPrevQuestion = currentIndex > 0;
  const hasNextQuestion = currentIndex < askQuestions.length - 1;
  const isQuestionAnswered = (question: (typeof askQuestions)[number], idx: number): boolean => {
    const id = String(question?.id || '').trim() || `q_${idx + 1}`;
    const freeText = String(answers[id] || '').trim();
    if (freeText) return true;
    const selected = selectedOptions[id];
    if (Array.isArray(selected)) return selected.some((item) => String(item || '').trim().length > 0);
    return String(selected || '').trim().length > 0;
  };

  return (
    <div className="input-prompt-panel" role="group" aria-live="polite">
      {queueSize > 1 ? (
        <div className="input-prompt-head">
          <span className="input-prompt-queue">
            {isZh ? `后续还有 ${queueSize - 1} 项` : `${queueSize - 1} more pending`}
          </span>
        </div>
      ) : null}
      {askQuestions.length > 1 ? (
        <div className="input-prompt-steps" role="tablist" aria-label={isZh ? '问题步骤' : 'Question steps'}>
          {askQuestions.map((question, idx) => {
            const shortTitle = String(question?.header || '').trim()
              || String(question?.question || '').trim()
              || `${isZh ? '问题' : 'Question'} ${idx + 1}`;
            const modeText = question.multiSelect ? (isZh ? '多选' : 'Multi') : (isZh ? '单选' : 'Single');
            const done = isQuestionAnswered(question, idx);
            return (
              <button
                key={`${question?.id || idx}`}
                type="button"
                role="tab"
                className={`input-prompt-step${idx === currentIndex ? ' active' : ''}${done ? ' done' : ''}`}
                aria-selected={idx === currentIndex}
                disabled={isSubmitting}
                onClick={() => setActiveAskIndex(idx)}
                title={shortTitle}
              >
                <span className="input-prompt-step-text">{`${idx + 1}-${modeText}: ${shortTitle}`}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="input-prompt-question">
        <div className="input-prompt-question-title">{currentTitle}</div>
        {currentDescription ? <div className="input-prompt-question-desc">{currentDescription}</div> : null}
        {currentOptions.length > 0 ? (
          <div className="input-prompt-option-list">
            {currentOptions.map((option, optIdx) => {
              const current = selectedOptions[currentQuestionId];
              const selected = currentQuestion?.multiSelect
                ? Array.isArray(current) && current.includes(option.label)
                : current === option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`input-prompt-option-row${selected ? ' selected' : ''}`}
                  title={option.description || option.label}
                  disabled={isSubmitting}
                  onClick={() => {
                    setSelectedOptions((prev) => {
                      if (!currentQuestion?.multiSelect) {
                        return { ...prev, [currentQuestionId]: option.label };
                      }
                      const currentList = Array.isArray(prev[currentQuestionId]) ? (prev[currentQuestionId] as string[]) : [];
                      const list = [...currentList];
                      const existing = list.includes(option.label);
                      const next = existing
                        ? list.filter((item) => item !== option.label)
                        : [...list, option.label];
                      return { ...prev, [currentQuestionId]: next };
                    });
                  }}
                >
                  <span className="input-prompt-option-index">{optIdx + 1}</span>
                  <span className="input-prompt-option-main">
                    <span className="input-prompt-option-label">{option.label}</span>
                    {option.description ? <span className="input-prompt-option-desc">{option.description}</span> : null}
                  </span>
                  <span className="input-prompt-option-state">{selected ? (isZh ? '已选' : 'Selected') : ''}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="input-prompt-actions">
        {askQuestions.length > 1 ? (
          <button
            type="button"
            className="input-prompt-btn nav"
            disabled={isSubmitting || !hasPrevQuestion}
            onClick={() => setActiveAskIndex((prev) => Math.max(0, prev - 1))}
          >
            {isZh ? '上一题' : 'Prev'}
          </button>
        ) : null}
        {askQuestions.length > 1 ? (
          <button
            type="button"
            className="input-prompt-btn nav"
            disabled={isSubmitting || !hasNextQuestion}
            onClick={() => setActiveAskIndex((prev) => Math.min(askQuestions.length - 1, prev + 1))}
          >
            {isZh ? '下一题' : 'Next'}
          </button>
        ) : null}
        <button
          type="button"
          className="input-prompt-btn approve submit-right"
          disabled={isSubmitting}
          onClick={handleAskApprove}
        >
          {isZh ? '提交' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

// ── Attached Files ──

function AttachedFilesBar({ files, onRemove }: {
  files: Array<{ path: string; name: string; isDirectory?: boolean }>;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="attached-files">
      {files.map((f, i) => (
        <span key={f.path} className="file-tag">
          <span className="file-tag-name">
            <span
              className="file-tag-icon"
              dangerouslySetInnerHTML={{ __html: f.isDirectory ? SVG_ICONS?.folder : SVG_ICONS?.clip }}
            />
            {f.name}
          </span>
          <button className="file-tag-remove" onClick={() => onRemove(i)}>✕</button>
        </span>
      ))}
    </div>
  );
}

// ── Context Usage Ring ──

function formatTokenWindow(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '0k';
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : +m.toFixed(1)}M`;
  }
  const k = value / 1024;
  if (Number.isInteger(k)) return `${k}k`;
  return `${Math.round(value / 1000)}k`;
}

function ContextRing() {
  const { t } = useI18n();
  const agentYuan = useStore(s => s.agentYuan);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const isStreaming = useStore(s => s.isStreaming);
  const models = useStore(s => s.models);
  const [tokens, setTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const currentModelName = useMemo(
    () => models.find((m) => m.isCurrent)?.name || '',
    [models],
  );

  // 从 Zustand store 同步 context 数据
  const storeContextTokens = useStore(s => s.contextTokens);
  const storeContextWindow = useStore(s => s.contextWindow);
  const storeContextPercent = useStore(s => s.contextPercent);
  const storeCompacting = useStore(s => s.compacting);

  useEffect(() => {
    setTokens(storeContextTokens ?? null);
    setContextWindow(storeContextWindow ?? null);
    setPercent(storeContextPercent ?? null);
    setCompacting(storeCompacting);
  }, [storeContextTokens, storeContextWindow, storeContextPercent, storeCompacting]);

  const isDraftSession = pendingNewSession && !currentSessionPath;
  const safeTokens = isDraftSession ? null : tokens;
  const safeContextWindow = isDraftSession ? null : contextWindow;
  const safePercent = isDraftSession ? null : percent;
  const safeCompacting = isDraftSession ? false : compacting;

  const handleCompact = useCallback(() => {
    if (safeCompacting) return;
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'compact', sessionPath: useStore.getState().currentSessionPath }));
    }
  }, [safeCompacting]);

  const hasContextData = safeContextWindow != null;
  const pct = safePercent ?? 0;

  // SVG 圆环参数（更小更粗）
  const r = 6;
  const sw = 2.5;
  const size = (r + sw) * 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - Math.min(pct, 100) / 100);
  const yuan = agentYuan || 'hanako';

  // token 数量格式化
  const tokensK = safeTokens != null ? Math.round(safeTokens / 1000) : 0;
  const windowLabel = formatTokenWindow(safeContextWindow);
  const pctText = Math.round(pct);

  return (
    <span className="context-ring-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        className={`context-ring${safeCompacting ? ' compacting' : ''}`}
        data-yuan={yuan}
        onDoubleClick={handleCompact}
        disabled={safeCompacting || !hasContextData}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={r} fill="none" stroke="var(--ring-bg)" strokeWidth={sw} />
          <circle
            cx={center} cy={center} r={r}
            fill="none"
            stroke="var(--ring-fg)"
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform={`rotate(-90 ${center} ${center})`}
            className="context-ring-progress"
          />
        </svg>
      </button>
      {hovered && hasContextData && (
        <div className="context-ring-tooltip">
          {currentModelName && (
            <div className="context-ring-tooltip-row">{t('input.currentModel', { name: currentModelName })}</div>
          )}
          <div className="context-ring-tooltip-row">{t('input.contextWindow', { window: windowLabel, windowK: windowLabel })}</div>
          <div className="context-ring-tooltip-row">{t('input.tokensUsed', { tokensK, pct: pctText })}</div>
        </div>
      )}
    </span>
  );
}

// ── Model Selector ──

function ModelSelector({
  models,
  disabled = false,
}: {
  models: Array<{ id: string; name: string; provider?: string; isCurrent?: boolean }>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingSessionModel = useStore(s => s.pendingSessionModel);
  const setPendingSessionModel = useStore(s => s.setPendingSessionModel);
  const setModels = useStore(s => s.setModels);
  const setCurrentModel = useStore(s => s.setCurrentModel);
  const isDraftSession = pendingNewSession && !currentSessionPath;
  const canSelectModel = isDraftSession && !disabled;
  const currentModel = useStore(s => s.currentModel);
  const selectedModelId = useMemo(
    () => String(
      (isDraftSession
        ? (pendingSessionModel || currentModel)
        : currentModel)
      || models.find((m) => m.isCurrent)?.id
      || models[0]?.id
      || '',
    ).trim(),
    [isDraftSession, pendingSessionModel, currentModel, models],
  );

  const current = useMemo(() => {
    return models.find((m) => m.id === selectedModelId) || models[0];
  }, [models, selectedModelId]);

  useEffect(() => {
    if (!canSelectModel && open) setOpen(false);
  }, [canSelectModel, open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const switchModel = useCallback(async (modelId: string) => {
    if (!canSelectModel) return;
    setPendingSessionModel(modelId);
    // 新建会话草稿阶段本地高亮选择；真正会话创建后由 ensureSession 落盘到该 session。
    setModels(models.map((m) => ({ ...m, isCurrent: m.id === modelId })));
    setCurrentModel(modelId);
    setOpen(false);
  }, [canSelectModel, setPendingSessionModel, setModels, setCurrentModel, models]);

  // 按 provider 分组
  const grouped = useMemo(() => {
    const groups: Record<string, typeof models> = {};
    for (const m of models) {
      const key = m.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    // 当前模型不在 favorites 时强制加入
    if (current && !models.find(m => m.id === current.id)) {
      const key = current.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].unshift(current);
    }
    return groups;
  }, [models, current]);

  const groupKeys = Object.keys(grouped);
  const hasMultipleProviders = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '');
  const totalRenderedModelCount = useMemo(
    () => groupKeys.reduce((count, provider) => count + (grouped[provider]?.length || 0), 0),
    [groupKeys, grouped],
  );
  const dropdownNeedsScroll = totalRenderedModelCount > 8;
  const visibleHeaderCount = useMemo(() => {
    if (!hasMultipleProviders || !dropdownNeedsScroll) return 0;

    let remainingVisibleModels = 8;
    let headerCount = 0;

    for (const provider of groupKeys) {
      const items = grouped[provider] || [];
      if (!items.length || remainingVisibleModels <= 0) continue;
      headerCount += 1;
      remainingVisibleModels -= Math.min(items.length, remainingVisibleModels);
      if (remainingVisibleModels <= 0) break;
    }

    return headerCount;
  }, [dropdownNeedsScroll, groupKeys, grouped, hasMultipleProviders]);

  return (
    <div className={'model-selector' + (open ? ' open' : '') + (!canSelectModel ? ' locked' : '')} ref={ref}>
      <button
        className="model-pill"
        disabled={!canSelectModel}
        onClick={(e) => {
          e.stopPropagation();
          if (!canSelectModel) return;
          setOpen(!open);
        }}
      >
        <span>{current?.name || t('model.unknown') || '...'}</span>
        {canSelectModel && <span className="model-arrow">▾</span>}
      </button>
      {open && (
        <div
          className={'model-dropdown' + (dropdownNeedsScroll ? ' scrollable' : '')}
          style={dropdownNeedsScroll ? {
            ['--model-visible-option-count' as string]: '8',
            ['--model-visible-header-count' as string]: String(visibleHeaderCount),
          } : undefined}
        >
          {groupKeys.map(provider => {
            const items = grouped[provider];
            return (
              <div key={provider || '__none'}>
                {hasMultipleProviders && (
                  <div className="model-group-header">{provider || '—'}</div>
                )}
                {items.map(m => (
                  <button
                    key={m.id}
                    className={'model-option' + (m.id === selectedModelId ? ' active' : '')}
                    onClick={() => switchModel(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Slash Command Menu ──

function SlashCommandMenu({ commands, selected, busy, onSelect, onHover }: {
  commands: SlashCommand[];
  selected: number;
  busy: string | null;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="slash-menu">
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={'slash-menu-item' + (i === selected ? ' selected' : '') + (busy === cmd.name ? ' busy' : '')}
          onMouseEnter={() => onHover(i)}
          onClick={() => !busy && onSelect(cmd)}
          disabled={!!busy}
        >
          <span className="slash-menu-icon" dangerouslySetInnerHTML={{ __html: cmd.icon }} />
          <span className="slash-menu-label">{cmd.label}</span>
          <span className="slash-menu-desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

// ── Send Button ──

function SendButton({ isStreaming, hasInput, disabled, onSend, onStop }: {
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 三态：发送 / 排队 / 停止
  const mode = isStreaming ? (hasInput ? 'queue' : 'stop') : 'send';

  return (
    <button
      type="button"
      className={'send-btn' + (mode === 'queue' ? ' is-queue' : mode === 'stop' ? ' is-streaming' : '')}
      disabled={disabled}
      onMouseDown={(e) => {
        // 防止按钮按下时 textarea 先失焦，导致输入法合成态在 Windows 下打断。
        e.preventDefault();
      }}
      onClick={() => {
        if (mode === 'stop') {
          onStop();
          return;
        }
        // 等待输入法 composition/input 先落盘，再触发发送。
        requestAnimationFrame(() => { onSend(); });
      }}
    >
      {mode === 'send' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span className="send-label-text">{t('chat.send')}</span>
        </span>
      )}
      {mode === 'queue' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span className="send-label-text">{t('chat.send')}</span>
        </span>
      )}
      {mode === 'stop' && (
        <span className="send-label">
          <svg className="stop-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span className="send-label-text">{t('chat.stop')}</span>
        </span>
      )}
    </button>
  );
}
