/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useEffect, useRef, useState } from 'react';

interface Props {
  content: string;
  sealed: boolean;
  dimmed?: boolean;
  streamLike?: boolean;
  runningMs?: number;
}

const THINKING_COLLAPSE_LINE_THRESHOLD = 4;
const THINKING_TAIL_ANIMATION_MS = 360;

export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  sealed,
  dimmed = false,
  streamLike = false,
  runningMs,
}: Props) {
  void runningMs;
  const [expanded, setExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const [tailStart, setTailStart] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousContentRef = useRef<string | null>(null);
  const tailTimerRef = useRef<number | null>(null);
  const bodyContent = content || '';
  const shouldAnimateTail = (!sealed || streamLike) && !!bodyContent;

  useEffect(() => {
    const previous = previousContentRef.current;
    previousContentRef.current = bodyContent;

    if (tailTimerRef.current != null) {
      window.clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
    }

    if (!shouldAnimateTail || !bodyContent) {
      setTailStart(null);
      return;
    }
    if (previous == null) {
      setTailStart(0);
    } else if (bodyContent.length > previous.length && bodyContent.startsWith(previous)) {
      setTailStart(previous.length);
    } else {
      setTailStart(null);
      return;
    }

    tailTimerRef.current = window.setTimeout(() => {
      setTailStart(null);
      tailTimerRef.current = null;
    }, THINKING_TAIL_ANIMATION_MS);

    return () => {
      if (tailTimerRef.current != null) {
        window.clearTimeout(tailTimerRef.current);
        tailTimerRef.current = null;
      }
    };
  }, [bodyContent, shouldAnimateTail]);

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
        {!sealed && <span className="thinking-dots"><span /><span /><span /></span>}
      </div>
      {!!bodyContent && (
        <div className={`thinking-block-panel${shouldCollapse && !expanded ? ' collapsed' : ''}`}>
          <div
            ref={contentRef}
            className={`thinking-block-body${shouldCollapse && !expanded ? ' clamp' : ''}`}
          >
            {tailStart != null && tailStart < bodyContent.length ? (
              <>
                {bodyContent.slice(0, tailStart)}
                <span className="stream-text-tail">{bodyContent.slice(tailStart)}</span>
              </>
            ) : bodyContent}
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
