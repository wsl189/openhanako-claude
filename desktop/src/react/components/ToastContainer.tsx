import { useEffect, useRef } from 'react';
import { useStore } from '../stores';

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} text={t.text} type={t.type} />
      ))}
    </div>
  );
}

function ToastItem({ id, text, type }: { id: number; text: string; type: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => ref.current?.classList.add('show'));
  }, []);

  function dismiss() {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => useStore.getState().removeToast(id), 300);
  }

  return (
    <div ref={ref} className={`hana-toast ${type}`}>
      <span>{text}</span>
      <button className="hana-toast-close" onClick={dismiss}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
