/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback } from 'react';

interface Props {
  content: string;
  sealed: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed }: Props) {
  const t = window.t ?? ((p: string) => p);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);
  const stateText = sealed ? t('thinking.done') : t('thinking.active');

  return (
    <details
      className={`thinking-block${open ? ' open' : ''}${sealed ? ' sealed' : ' running'}`}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="thinking-block-summary" onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`thinking-block-arrow${open ? ' open' : ''}`}>›</span>
        <span className="thinking-block-title">THINKING</span>
        {!sealed && <span className="thinking-dots"><span /><span /><span /></span>}
        <span className={`thinking-block-state${sealed ? ' done' : ' running'}`}>{stateText}</span>
      </summary>
      {open && content && (
        <div className="thinking-block-panel">
          <div className="thinking-block-body">{content}</div>
        </div>
      )}
    </details>
  );
});
