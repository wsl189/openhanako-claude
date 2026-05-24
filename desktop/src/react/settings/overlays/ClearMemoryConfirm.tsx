import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { loadSettingsConfig } from '../actions';

async function collectLibraryIds(
  agentId: string | null,
  layer: 'facts' | 'episodes' | 'evidence' | 'playbooks',
) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      agentId: agentId || '',
      layer,
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await hanaFetch(`/api/memory/library?${params.toString()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const pageItems = Array.isArray(data.items) ? data.items : [];
    ids.push(...pageItems.map((item: any) => String(item.id || '')).filter(Boolean));
    cursor = data.nextCursor || null;
  } while (cursor);
  return ids;
}

export function ClearMemoryConfirm() {
  const { showToast } = useSettingsStore();
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener('hana-show-clear-confirm', handler);
    return () => window.removeEventListener('hana-show-clear-confirm', handler);
  }, []);

  const close = () => {
    if (!submitting) setVisible(false);
  };

  const doArchive = async () => {
    setSubmitting(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const [factIds, episodeIds, evidenceIds, playbookIds] = await Promise.all([
        collectLibraryIds(aid, 'facts'),
        collectLibraryIds(aid, 'episodes'),
        collectLibraryIds(aid, 'evidence'),
        collectLibraryIds(aid, 'playbooks'),
      ]);
      const marksRes = await hanaFetch(`/api/memory/marks?agentId=${encodeURIComponent(aid || '')}`);
      const marksData = await marksRes.json();
      if (marksData.error) throw new Error(marksData.error);
      const markIds = Array.isArray(marksData.items)
        ? marksData.items.map((item: any) => `mark:${item.id}`).filter(Boolean)
        : [];
      const ids = [...factIds, ...episodeIds, ...evidenceIds, ...playbookIds, ...markIds];
      if (ids.length === 0) {
        showToast(t('settings.memory.actions.empty'), 'success');
        close();
        return;
      }
      const res = await hanaFetch('/api/memory/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: aid, ids }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await loadSettingsConfig();
      window.dispatchEvent(new Event('hana-memory-archived'));
      window.dispatchEvent(new Event('hana-view-memories-inactive'));
      showToast(t('settings.memory.actions.clearSuccess'), 'success');
      setVisible(false);
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="memory-confirm-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="memory-confirm-card">
        <p className="memory-confirm-text">{t('settings.memory.actions.clearConfirm')}</p>
        <div className="memory-confirm-actions">
          <button className="memory-confirm-cancel" onClick={close} disabled={submitting}>
            {t('settings.memory.actions.cancel')}
          </button>
          <button className="memory-confirm-danger" onClick={doArchive} disabled={submitting}>
            {t('settings.memory.actions.confirmClear')}
          </button>
        </div>
      </div>
    </div>
  );
}
