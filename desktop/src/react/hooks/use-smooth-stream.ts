/**
 * useSmoothStream - smooth text rendering for streaming UI blocks.
 *
 * Converts bursty stream updates into a steady, character-by-character reveal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseSmoothStreamOptions {
  content: string;
  isStreaming: boolean;
  minDelay?: number;
  startFromEmptyWhenStreaming?: boolean;
}

interface UseSmoothStreamReturn {
  displayedContent: string;
}

const segmenter = new Intl.Segmenter(
  ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-PT', 'ru-RU'],
);

function segmentText(text: string): string[] {
  return Array.from(segmenter.segment(text)).map((entry) => entry.segment);
}

export function useSmoothStream({
  content,
  isStreaming,
  minDelay = 12,
  startFromEmptyWhenStreaming = false,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
  const initialContent = startFromEmptyWhenStreaming && isStreaming ? '' : content;
  const [displayedContent, setDisplayedContent] = useState(initialContent);

  const queueRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);
  const displayedRef = useRef(initialContent);
  const prevContentRef = useRef(initialContent);
  const lastRenderTimeRef = useRef(0);
  const streamDoneRef = useRef(!isStreaming);

  streamDoneRef.current = !isStreaming;

  useEffect(() => {
    const prevContent = prevContentRef.current;
    const nextContent = content;
    if (nextContent === prevContent) return;

    const isAppend = nextContent.startsWith(prevContent);
    if (isAppend) {
      const delta = nextContent.slice(prevContent.length);
      if (delta) queueRef.current.push(...segmentText(delta));
    } else {
      queueRef.current = [];
      displayedRef.current = nextContent;
      setDisplayedContent(nextContent);
    }

    prevContentRef.current = nextContent;
  }, [content]);

  useEffect(() => {
    if (isStreaming) return;
    if (rafRef.current) return;

    if (queueRef.current.length > 0) {
      displayedRef.current += queueRef.current.join('');
      queueRef.current = [];
    }
    if (displayedRef.current !== content) displayedRef.current = content;
    setDisplayedContent(displayedRef.current);
  }, [isStreaming, content]);

  const renderLoop = useCallback((currentTime: number) => {
    const queue = queueRef.current;

    if (queue.length === 0) {
      if (streamDoneRef.current) {
        if (displayedRef.current !== prevContentRef.current) {
          displayedRef.current = prevContentRef.current;
          setDisplayedContent(displayedRef.current);
        }
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    if (currentTime - lastRenderTimeRef.current < minDelay) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }
    lastRenderTimeRef.current = currentTime;

    const divisor = streamDoneRef.current ? 4 : 8;
    const count = Math.max(1, Math.floor(queue.length / divisor));
    const chunk = queue.splice(0, count);
    displayedRef.current += chunk.join('');
    setDisplayedContent(displayedRef.current);

    if (queue.length > 0 || !streamDoneRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    if (displayedRef.current !== prevContentRef.current) {
      displayedRef.current = prevContentRef.current;
      setDisplayedContent(displayedRef.current);
    }
    rafRef.current = null;
  }, [minDelay]);

  useEffect(() => {
    if ((isStreaming || queueRef.current.length > 0) && !rafRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop);
    }
    return () => {
      if (!rafRef.current) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isStreaming, renderLoop]);

  return { displayedContent };
}
