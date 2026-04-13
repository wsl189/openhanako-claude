/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useSmoothStream } from '../../hooks/use-smooth-stream';

interface Props {
  content: string;
  sealed: boolean;
  dimmed?: boolean;
  streamLike?: boolean;
  runningMs?: number;
}

const THINKING_COLLAPSE_LINE_THRESHOLD = 4;

function formatRunningDuration(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  sealed,
  dimmed = false,
  streamLike = false,
  runningMs,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shouldStreamText = (!sealed || streamLike) && !!content;
  const { displayedContent } = useSmoothStream({
    content,
    isStreaming: shouldStreamText,
    minDelay: 20,
    startFromEmptyWhenStreaming: false,
  });
  const bodyContent = content
    ? (shouldStreamText ? displayedContent : content)
    : '';

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight || '22') || 22;
    const maxHeight = lineHeight * THINKING_COLLAPSE_LINE_THRESHOLD;
    setShouldCollapse(el.scrollHeight > maxHeight + 10);
  }, [bodyContent]);

  return (
    <div className={`thinking-block proma-like${dimmed ? ' dimmed' : ''}${sealed ? ' sealed' : ' running'}`}>
      <div className="thinking-block-summary">
        <span className="thinking-block-title">THINKING</span>
        {!sealed && <span className="thinking-dots"><span /><span /><span /></span>}
        {!sealed && typeof runningMs === 'number' && runningMs >= 0 && (
          <span className="thinking-block-elapsed">{formatRunningDuration(runningMs)}</span>
        )}
      </div>
      {!!bodyContent && (
        <div className={`thinking-block-panel${shouldCollapse && !expanded ? ' collapsed' : ''}`}>
          <div
            ref={contentRef}
            className={`thinking-block-body${shouldCollapse && !expanded ? ' clamp' : ''}`}
          >
            {bodyContent}
          </div>
          {shouldCollapse && !!content && (
            <button
              type="button"
              className="thinking-block-toggle"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? '收起' : '展开思考'}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
