/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useSmoothStream } from '../../hooks/use-smooth-stream';

interface Props {
  content: string;
  sealed: boolean;
  dimmed?: boolean;
}

const THINKING_COLLAPSE_LINE_THRESHOLD = 4;

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed, dimmed = false }: Props) {
  const t = window.t ?? ((p: string) => p);
  const [expanded, setExpanded] = useState(true);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stateText = sealed ? t('thinking.done') : t('thinking.active');
  const { displayedContent } = useSmoothStream({
    content,
    isStreaming: !sealed,
    minDelay: 16,
  });

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight || '22') || 22;
    const maxHeight = lineHeight * THINKING_COLLAPSE_LINE_THRESHOLD;
    setShouldCollapse(el.scrollHeight > maxHeight + 10);
  }, [displayedContent]);

  return (
    <div className={`thinking-block proma-like${dimmed ? ' dimmed' : ''}${sealed ? ' sealed' : ' running'}`}>
      <div className="thinking-block-summary">
        <span className="thinking-block-title">THINKING</span>
        {!sealed && <span className="thinking-dots"><span /><span /><span /></span>}
        <span className={`thinking-block-state${sealed ? ' done' : ' running'}`}>{stateText}</span>
      </div>
      {!!content && (
        <div className={`thinking-block-panel${shouldCollapse && !expanded ? ' collapsed' : ''}`}>
          <div
            ref={contentRef}
            className={`thinking-block-body${shouldCollapse && !expanded ? ' clamp' : ''}`}
          >
            {displayedContent}
          </div>
          {shouldCollapse && (
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
