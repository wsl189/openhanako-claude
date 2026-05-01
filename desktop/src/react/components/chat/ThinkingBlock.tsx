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
  const contentRef = useRef<HTMLDivElement | null>(null);
  const bodyContent = content || '';
  void streamLike;

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight || '22') || 22;
    const maxHeight = lineHeight * THINKING_COLLAPSE_LINE_THRESHOLD;
    setShouldCollapse(el.scrollHeight > maxHeight + 10);
  }, [bodyContent]);

  return (
    <div className={`thinking-block proma-like${dimmed ? ' dimmed' : ''}${sealed ? ' sealed' : ' running'}`}>
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
