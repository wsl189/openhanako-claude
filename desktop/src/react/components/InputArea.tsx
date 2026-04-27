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
import type { AttachedFile } from '../stores/input-slice';
import { loadModels } from '../utils/ui-helpers';

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

// ── 主组件 ──

export function InputArea() {
  return <InputAreaInner />;
}

function InputAreaInner() {
  const { t, locale } = useI18n();

  // Zustand state
  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const pendingSessionModel = useStore(s => s.pendingSessionModel);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const sessionTodos = useStore(s => s.sessionTodos);
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposing = useRef(false);
  const voiceAnchorRef = useRef<{ prefix: string; suffix: string; interim: string } | null>(null);
  const textDraftBySessionRef = useRef<Record<string, string>>({});
  const attachmentDraftBySessionRef = useRef<Record<string, AttachedFile[]>>({});
  const docContextDraftBySessionRef = useRef<Record<string, boolean>>({});

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
    handleKeyDown: handleVoiceKeyDown,
    handleKeyUp: handleVoiceKeyUp,
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
  const toggleDocContext = useStore(s => s.toggleDocContext);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);

  // 按 session 保存输入草稿（文本 / 附件 / 文档上下文开关）
  useEffect(() => {
    textDraftBySessionRef.current[inputSessionKey] = inputText;
  }, [inputText, inputSessionKey]);

  useEffect(() => {
    attachmentDraftBySessionRef.current[inputSessionKey] = attachedFiles.map((file) => ({ ...file }));
    docContextDraftBySessionRef.current[inputSessionKey] = docContextAttached;
  }, [attachedFiles, docContextAttached, inputSessionKey]);

  useEffect(() => {
    const prevKey = prevInputSessionKeyRef.current;
    if (prevKey !== inputSessionKey) {
      textDraftBySessionRef.current[prevKey] = inputText;
      attachmentDraftBySessionRef.current[prevKey] = attachedFiles.map((file) => ({ ...file }));
      docContextDraftBySessionRef.current[prevKey] = docContextAttached;
    }
    prevInputSessionKeyRef.current = inputSessionKey;

    const nextText = textDraftBySessionRef.current[inputSessionKey] ?? '';
    const nextFiles = (attachmentDraftBySessionRef.current[inputSessionKey] || []).map((file) => ({ ...file }));
    const nextDocContextAttached = !!docContextDraftBySessionRef.current[inputSessionKey];

    setInputText(nextText);
    setAttachedFiles(nextFiles);
    setDocContextAttached(nextDocContextAttached);
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

  // ── 统一命令发送 ──

  /** 统一的"以用户身份发送"入口，所有斜杠命令共用 */
  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (useStore.getState().isStreaming) return false;
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
  const hasContent = inputText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached;
  const canSend = hasContent && connected && !isStreaming;

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
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        // "data:image/png;base64,xxxxx" → 拆出 mimeType 和 base64
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) return;
        const [, mimeType, base64Data] = match;
        const ext = mimeType.split('/')[1] || 'png';
        addAttachedFile({
          path: `clipboard-${Date.now()}.${ext}`,
          name: `${t('input.pastedImage')}.${ext}`,
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
  }, [addAttachedFile]);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    const draftModelIdBeforeEnsure = pendingNewSession ? resolveSelectedModelId() : '';

    // 斜杠命令拦截
    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    const safeAttachedFiles = attachedFiles.filter((f) => !isHttpUrlPath(f.path));
    const hasFiles = safeAttachedFiles.length > 0;
    if ((!text && !hasFiles && !docContextAttached) || !connected) return;
    if (isStreaming) return; // streaming 时由 handleSteer 处理
    if (sending) return;
    setSending(true);

    try {
      if (pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) return;
        loadSessions();
      }

      // 分离图片附件（用于视觉输入）
      const imageFiles = hasFiles ? safeAttachedFiles.filter(f => !f.isDirectory && isImageFile(f.name)) : [];

      let finalText = text;
      if (hasFiles) {
        // 无论是否图片，都把原始路径写入文本，避免模型只看到远端视觉 URL 而拿不到本地路径。
        const fileBlock = safeAttachedFiles
          .map(f => f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`)
          .join('\n');
        finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
      }

      // 图片文件读 base64 编码
      const hana = (window as any).hana;
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      const inlineImageMap = new Map<string, { base64Data: string; mimeType: string }>();
      if (imageFiles.length > 0) {
        for (const img of imageFiles) {
          try {
            if (img.base64Data && img.mimeType) {
              // 内联 base64（粘贴图片）
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
            // ignore: 路径文本已在上面的 fileBlock 中
          }
        }
      }

      // 文档上下文：把当前打开的文档路径附加到消息里
      let docForRender: { path: string; name: string } | null = null;
      if (docContextAttached && currentDoc) {
        const docBlock = `[参考文档] ${currentDoc.path}`;
        finalText = finalText ? `${finalText}\n\n${docBlock}` : docBlock;
        docForRender = currentDoc;
      }

      if (docContextAttached) {
        setDocContextAttached(false);
      }

      const filesToRender = hasFiles ? [...safeAttachedFiles] : null;
      // 文档上下文渲染为附件卡片
      const allFiles = filesToRender ? [...filesToRender] : [];
      if (docForRender) {
        allFiles.push({ path: docForRender.path, name: docForRender.name });
      }
      // 用户消息写入 store
      const sessionPath = useStore.getState().currentSessionPath;
      if (sessionPath) {
        const { renderMarkdown } = await import('../utils/markdown');
        useStore.getState().appendItem(sessionPath, {
          type: 'message',
          data: {
            id: `user-${Date.now()}`,
            role: 'user',
            text,
            textHtml: renderMarkdown(text),
            attachments: allFiles.length > 0
              ? allFiles.map((f: any) => {
                const inlineImage = inlineImageMap.get(f.path);
                return {
                  path: f.path,
                  name: f.name,
                  isDir: !!f.isDirectory,
                  base64Data: inlineImage?.base64Data ?? f.base64Data,
                  mimeType: inlineImage?.mimeType ?? f.mimeType,
                };
              })
              : undefined,
          },
        });
        useStore.setState({ welcomeVisible: false });
        beginOptimisticStreamingTurn(sessionPath);
      }

      setInputText('');
      clearAttachedFiles();

      const ws = getWebSocket();
      const wsMsg: any = { type: 'prompt', text: finalText, sessionPath: useStore.getState().currentSessionPath };
      // 仅草稿首轮携带 modelId，避免把其它 session 的当前模型覆盖成全局/错误值。
      if (draftModelIdBeforeEnsure) wsMsg.modelId = draftModelIdBeforeEnsure;
      if (images.length > 0) wsMsg.images = images;
      ws?.send(JSON.stringify(wsMsg));
    } finally {
      setSending(false);
    }
  }, [inputText, attachedFiles, docContextAttached, connected, isStreaming, sending, pendingNewSession, currentDoc, clearAttachedFiles, setDocContextAttached, slashMenuOpen, filteredCommands, slashSelected, beginOptimisticStreamingTurn, resolveSelectedModelId]);

  // ── Steer (插话) ──
  const handleSteer = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !isStreaming) return;
    const ws = getWebSocket();
    if (!ws) return;

    // steer：用户消息写入 store
    const sessionPath = useStore.getState().currentSessionPath;
    if (sessionPath) {
      const { renderMarkdown } = await import('../utils/markdown');
      useStore.getState().appendItem(sessionPath, {
        type: 'message',
        data: { id: `user-${Date.now()}`, role: 'user', text, textHtml: renderMarkdown(text) },
      });
    }

    setInputText('');
    ws.send(JSON.stringify({ type: 'steer', text, sessionPath: useStore.getState().currentSessionPath }));
  }, [inputText, isStreaming]);

  // ── Stop generation ──
  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [isStreaming]);

  // ── Key handler ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (handleVoiceKeyDown(e)) return;

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
      if (isStreaming && inputText.trim()) {
        handleSteer();
      } else {
        handleSend();
      }
    }
  }, [handleSend, handleSteer, isStreaming, inputText, slashMenuOpen, filteredCommands, slashSelected, handleVoiceKeyDown]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    handleVoiceKeyUp(e);
  }, [handleVoiceKeyUp]);

  return (
    <>
      <TodoDisplay todos={sessionTodos} />

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
          onKeyUp={handleKeyUp}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }}
        />

        <div className="input-bottom-bar">
          <div className="input-actions">
            <DocContextButton
              active={docContextAttached}
              disabled={!hasDoc}
              onToggle={toggleDocContext}
            />
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
          </div>
          <div className="input-controls">
            <ContextRing />
            <ModelSelector
              models={models}
              disabled={sending}
            />
            <SendButton
              isStreaming={isStreaming}
              hasInput={!!inputText.trim()}
              disabled={isStreaming ? false : !canSend}
              onSend={handleSend}
              onSteer={handleSteer}
              onStop={handleStop}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Todo Display ──

function TodoDisplay({ todos }: { todos: Array<{ text: string; done: boolean }> }) {
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter(td => td.done).length;

  return (
    <div className="input-top-bar">
      <div className={'todo-display has-todos' + (open ? ' open' : '')}>
        <button className="todo-trigger" onClick={() => setOpen(!open)}>
          <span className="todo-trigger-icon">☑</span>
          <span className="todo-trigger-label">To Do</span>
          <span className="todo-trigger-count">{done}/{todos.length}</span>
        </button>
        {open && (
          <div className="todo-list">
            {todos.map((td, i) => (
              <div key={i} className={'todo-item' + (td.done ? ' done' : '')}>
                <span className="todo-check">{td.done ? '✓' : '○'}</span> {td.text}
              </div>
            ))}
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
  const currentTitle = String(currentQuestion?.header || '').trim()
    || String(currentQuestion?.question || '').trim()
    || `${isZh ? '问题' : 'Question'} ${currentIndex + 1}`;
  const currentDescription = String(currentQuestion?.header || '').trim() && String(currentQuestion?.question || '').trim()
    ? String(currentQuestion.question || '').trim()
    : '';
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
      <div className="input-prompt-head">
        <span className="input-prompt-kicker">{isZh ? '等待输入' : 'Needs Input'}</span>
        {queueSize > 1 && (
          <span className="input-prompt-queue">
            {isZh ? `后续还有 ${queueSize - 1} 项` : `${queueSize - 1} more pending`}
          </span>
        )}
      </div>
      <div className="input-prompt-title">{isZh ? 'Agent 需要你的输入' : 'Agent Needs Your Input'}</div>
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
        <input
          type="text"
          className="input-prompt-answer"
          value={answers[currentQuestionId] || ''}
          disabled={isSubmitting}
          placeholder={isZh ? '可选：补充说明（留空则使用已选项）' : 'Optional: add details (blank = selected option)'}
          onChange={(e) => setAnswers((prev) => ({ ...prev, [currentQuestionId]: e.target.value }))}
        />
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
          className="input-prompt-btn approve"
          disabled={isSubmitting}
          onClick={handleAskApprove}
        >
          {isZh ? '提交' : 'Submit'}
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

// ── Doc Context Button ──

function DocContextButton({ active, disabled, onToggle }: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      className={'desk-context-btn' + (active ? ' active' : '')}
      title={t('input.docContext')}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      <span className="desk-context-label">{t('input.docContext')}</span>
    </button>
  );
}

// ── Context Usage Ring ──

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
  const windowK = safeContextWindow != null ? Math.round(safeContextWindow / 1000) : 0;
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
          <div className="context-ring-tooltip-row">{t('input.contextWindow', { windowK })}</div>
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
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

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
    if (disabled) return;
    if (isDraftSession) {
      setPendingSessionModel(modelId);
      // 新建会话草稿阶段本地高亮选择；真正会话创建后由 ensureSession 落盘到该 session。
      setModels(models.map((m) => ({ ...m, isCurrent: m.id === modelId })));
      setCurrentModel(modelId);
      setOpen(false);
      return;
    }
    const previousModels = models.map((m) => ({ ...m }));
    // 先做本地乐观更新，避免 UI 卡在 unknown/旧模型。
    setModels(models.map((m) => ({ ...m, isCurrent: m.id === modelId })));
    setCurrentModel(modelId);
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      await loadModels(null);
    } catch (err: any) {
      setModels(previousModels);
      console.error('[model] switch failed:', err);
      showToast(extractFetchErrorMessage(err, t('model.switchFailed')), 'error');
    }
    setOpen(false);
  }, [disabled, isDraftSession, setPendingSessionModel, setModels, setCurrentModel, models, t]);

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

  return (
    <div className={'model-selector' + (open ? ' open' : '')} ref={ref}>
      <button
        className="model-pill"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          setOpen(!open);
        }}
      >
        <span>{current?.name || t('model.unknown') || '...'}</span>
        <span className="model-arrow">▾</span>
      </button>
      {open && (
        <div className="model-dropdown">
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

function SendButton({ isStreaming, hasInput, disabled, onSend, onSteer, onStop }: {
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 三态：发送 / 插话 / 停止
  const mode = isStreaming ? (hasInput ? 'steer' : 'stop') : 'send';

  return (
    <button
      className={'send-btn' + (mode === 'steer' ? ' is-steer' : mode === 'stop' ? ' is-streaming' : '')}
      disabled={disabled}
      onClick={mode === 'steer' ? onSteer : mode === 'stop' ? onStop : onSend}
    >
      {mode === 'send' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span className="send-label-text">{t('chat.send')}</span>
        </span>
      )}
      {mode === 'steer' && (
        <span className="send-label">
          <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="send-label-text">{t('chat.steer')}</span>
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
