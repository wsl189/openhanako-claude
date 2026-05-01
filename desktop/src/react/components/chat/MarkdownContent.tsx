/**
 * MarkdownContent — 渲染预处理好的 markdown HTML
 *
 * 用 dangerouslySetInnerHTML 设置内容，
 * useEffect 注入代码块复制按钮。
 */

import { memo, useRef, useEffect } from 'react';
import { injectCopyButtons } from '../../utils/format';
import { repairMarkdownHtml } from '../../utils/markdown';

interface Props {
  html: string;
  className?: string;
  animateNewText?: boolean;
}

function isCopyButtonTextNode(node: Node): boolean {
  let el = node.parentElement;
  while (el) {
    if (el.classList.contains('copy-btn')) return true;
    el = el.parentElement;
  }
  return false;
}

function getRenderableText(container: HTMLElement): string {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let text = '';

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (isCopyButtonTextNode(node)) continue;
    text += node.nodeValue || '';
  }

  return text;
}

function markTextTail(container: HTMLElement, previousTextLength: number): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remainingBeforeTail = Math.max(0, previousTextLength);
  const tailTargets: Array<{ node: Text; offset: number }> = [];

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (isCopyButtonTextNode(node)) continue;
    const text = node.nodeValue || '';
    if (!text) continue;
    if (remainingBeforeTail >= text.length) {
      remainingBeforeTail -= text.length;
      continue;
    }

    tailTargets.push({ node, offset: remainingBeforeTail });
    remainingBeforeTail = 0;
  }

  for (const { node, offset } of tailTargets) {
    const tail = offset > 0 ? node.splitText(offset) : node;
    const parent = tail.parentNode;
    if (!parent) continue;
    const span = document.createElement('span');
    span.className = 'stream-text-tail';
    parent.insertBefore(span, tail);
    span.appendChild(tail);
  }
}

export const MarkdownContent = memo(function MarkdownContent({ html, className, animateNewText = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const previousTextRef = useRef<string | null>(null);
  const safeHtml = repairMarkdownHtml(html);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const nextText = getRenderableText(el);
    const previousText = previousTextRef.current;
    previousTextRef.current = nextText;

    if (animateNewText && nextText) {
      if (previousText == null) {
        markTextTail(el, 0);
      } else if (nextText.length > previousText.length && nextText.startsWith(previousText)) {
        markTextTail(el, previousText.length);
      }
    }

    injectCopyButtons(el);
  }, [safeHtml, animateNewText]);

  return (
    <div
      ref={ref}
      className={className || 'md-content'}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
});
