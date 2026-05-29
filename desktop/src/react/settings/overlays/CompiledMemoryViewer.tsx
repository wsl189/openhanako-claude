import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { renderMarkdown } from '../../utils/markdown';

export function CompiledMemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  const memorySummary = useSettingsStore((state) => state.memorySummary);

  useEffect(() => {
    const handler = () => {
      setVisible(true);
      void load();
    };
    window.addEventListener('hana-view-compiled-memory', handler);
    return () => window.removeEventListener('hana-view-compiled-memory', handler);
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/memory/summary?agentId=${encodeURIComponent(aid || '')}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      useSettingsStore.setState({ memorySummary: data });
    } catch (err: any) {
      useSettingsStore.getState().showToast(err.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  const close = () => setVisible(false);

  if (!visible) return null;

  return (
    <div className="memory-viewer-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="memory-viewer">
        <div className="memory-viewer-header">
          <h3 className="memory-viewer-title">{t('settings.memory.compiled')}</h3>
          <button className="memory-viewer-close" onClick={close}>✕</button>
        </div>
        <div className="memory-viewer-body compiled-memory-body">
          {loading ? (
            <div className="memory-viewer-empty">{t('settings.archivedSessions.loading')}</div>
          ) : memorySummary?.content?.trim() ? (
            <div className="compiled-memory-md md-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(memorySummary.content) }} />
          ) : (
            <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
