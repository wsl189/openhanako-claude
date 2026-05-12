/**
 * UserMessage — 用户消息气泡
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import type { ChatMessage, UserAttachment, DeskContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { openFilePreviewWithOptions } from '../../utils/file-preview';
import { isHttpUrlPath } from '../../utils/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHAT_EDIT_MESSAGE_EVENT = 'hana:chat-edit-message';
const CHAT_RESEND_MESSAGE_EVENT = 'hana:chat-resend-message';

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
}

export const UserMessage = memo(function UserMessage({ message, showAvatar }: Props) {
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const t = window.t ?? ((p: string) => p);
  const userName = useStore(s => s.userName) || t('common.me');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [previewZoom, setPreviewZoom] = useState(0.9);

  const getMessageText = useCallback(() => {
    if (message.text) return String(message.text);
    if (!message.textHtml) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = message.textHtml;
    return tmp.innerText || '';
  }, [message.text, message.textHtml]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [userAvatarUrl]);

  const handleCopy = useCallback(() => {
    const text = getMessageText().trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [getMessageText]);

  const handleEdit = useCallback(() => {
    const text = getMessageText();
    if (!text.trim()) return;
    window.dispatchEvent(new CustomEvent(CHAT_EDIT_MESSAGE_EVENT, { detail: { text } }));
  }, [getMessageText]);

  const handleResend = useCallback(() => {
    const text = getMessageText();
    if (!text.trim()) return;
    window.dispatchEvent(new CustomEvent(CHAT_RESEND_MESSAGE_EVENT, { detail: { text } }));
  }, [getMessageText]);

  useEffect(() => {
    if (!previewImage) return undefined;
    setPreviewZoom(0.9);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [previewImage]);

  const clampZoom = useCallback((value: number) => {
    return Math.max(0.45, Math.min(2.4, value));
  }, []);

  const handlePreviewWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = Math.exp(-e.deltaY * 0.0018);
    setPreviewZoom((prev) => clampZoom(prev * zoomFactor));
  }, [clampZoom]);

  return (
    <div className="message-group user">
      {showAvatar && (
        <div className="avatar-row user">
          <span className="avatar-name">{userName}</span>
          {userAvatarUrl && !avatarFailed ? (
            <img
              className="avatar user-avatar-img"
              src={userAvatarUrl}
              alt={userName}
              draggable={false}
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span className="avatar user-avatar-default" aria-hidden="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
          )}
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <UserAttachmentsView
          attachments={message.attachments}
          deskContext={message.deskContext}
          onPreviewImage={(src, name) => setPreviewImage({ src, name })}
        />
      )}
      <div className="message user">
        {message.textHtml && <MarkdownContent html={message.textHtml} className="md-content user-msg-text" />}
        {message.textHtml && (
          <div className="user-msg-actions">
            <button
              className={`user-msg-action-btn user-msg-copy-btn${copied ? ' copied' : ''}`}
              onClick={handleCopy}
              title={copied ? t('common.copied') : t('common.copyText')}
              aria-label={copied ? t('common.copied') : t('common.copyText')}
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                {copied
                  ? <polyline points="20 6 9 17 4 12" />
                  : (
                    <>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
              </svg>
            </button>
            <button
              className="user-msg-action-btn user-msg-edit-btn"
              onClick={handleEdit}
              title={t('common.edit')}
              aria-label={t('common.edit')}
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
            <button
              className="user-msg-action-btn user-msg-resend-btn"
              onClick={handleResend}
              title={t('channel.resend')}
              aria-label={t('channel.resend')}
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
                <path d="M20.5 15a9 9 0 0 1-14.1 3.4L1 14" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {previewImage && (
        <div
          className="attach-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.name}
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="attach-image-lightbox-frame"
            onClick={(e) => e.stopPropagation()}
            onWheel={handlePreviewWheel}
            style={{ transform: `scale(${previewZoom})` }}
          >
            <img
              className="attach-image-lightbox-img"
              src={previewImage.src}
              alt={previewImage.name}
              draggable={false}
            />
          </div>
        </div>
      )}
    </div>
  );
});

// ── 附件区 ──

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function attachmentMime(att: UserAttachment): string {
  if (att.mimeType) return att.mimeType;
  const ext = (att.name.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'image/png';
}

const AttachmentFileCard = memo(function AttachmentFileCard({
  att,
  onOpenFile,
}: {
  att: UserAttachment;
  onOpenFile?: (att: UserAttachment) => void;
}) {
  const ext = att.name.split('.').pop() || '';
  const handleClick = () => {
    if (!onOpenFile || att.isDir || !att.path || isHttpUrlPath(att.path)) return;
    onOpenFile(att);
  };

  const card = (
    <>
      <span className="attach-file-icon">
        {att.isDir ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        )}
      </span>
      <span className="attach-file-name">{att.name}</span>
      {ext && <span className="attach-file-ext">{ext}</span>}
    </>
  );

  if (!att.isDir && onOpenFile && att.path && !isHttpUrlPath(att.path)) {
    return (
      <button type="button" className="attach-file attach-file-btn" onClick={handleClick} title={att.path}>
        {card}
      </button>
    );
  }

  return (
    <div className="attach-file">
      {card}
    </div>
  );
});

const AttachmentImage = memo(function AttachmentImage({
  att,
  onPreviewImage,
  onOpenFile,
}: {
  att: UserAttachment;
  onPreviewImage: (src: string, name: string) => void;
  onOpenFile: (att: UserAttachment) => void;
}) {
  const [src, setSrc] = useState<string | null>(() => {
    if (!att.base64Data) return null;
    return `data:${attachmentMime(att)};base64,${att.base64Data}`;
  });
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
    if (att.base64Data) {
      setSrc(`data:${attachmentMime(att)};base64,${att.base64Data}`);
      return;
    }
    const platform = (window as any).platform;
    if (!att.path || !platform?.readFileBase64) {
      setSrc(null);
      return;
    }

    let cancelled = false;
    platform.readFileBase64(att.path)
      .then((base64: string | null) => {
        if (cancelled) return;
        if (!base64) {
          setSrc(null);
          return;
        }
        setSrc(`data:${attachmentMime(att)};base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => { cancelled = true; };
  }, [att.path, att.name, att.base64Data, att.mimeType]);

  if (src && !errored) {
    return (
      <button
        type="button"
        className="attach-image attach-image-btn"
        onClick={() => onPreviewImage(src, att.name)}
        title={att.name}
      >
        <img
          src={src}
          alt={att.name}
          loading="lazy"
          onError={() => setErrored(true)}
        />
      </button>
    );
  }
  return <AttachmentFileCard att={att} onOpenFile={onOpenFile} />;
});

const UserAttachmentsView = memo(function UserAttachmentsView({
  attachments,
  deskContext,
  onPreviewImage,
}: {
  attachments: UserAttachment[];
  deskContext?: DeskContext | null;
  onPreviewImage: (src: string, name: string) => void;
}) {
  const openAttachmentFile = useCallback((att: UserAttachment) => {
    if (!att.path || att.isDir || isHttpUrlPath(att.path)) return;
    const ext = (att.name.split('.').pop() || '').toLowerCase();
    void openFilePreviewWithOptions(att.path, att.name, ext, { replaceRightSidebar: true });
  }, []);

  const isImage = useCallback((att: UserAttachment) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(att.name);
  }, []);

  return (
    <div className="user-attachments">
      {attachments.map((att, i) => {
        if (isImage(att)) {
          return <AttachmentImage key={i} att={att} onPreviewImage={onPreviewImage} onOpenFile={openAttachmentFile} />;
        }
        return <AttachmentFileCard key={i} att={att} onOpenFile={openAttachmentFile} />;
      })}
      {deskContext && (
        <div className="attach-file attach-desk">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="attach-file-name">{(window.t ?? ((p: string) => p))('sidebar.jian')} ({deskContext.fileCount})</span>
        </div>
      )}
    </div>
  );
});
