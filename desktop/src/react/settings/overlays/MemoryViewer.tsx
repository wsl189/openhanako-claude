import React, { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { formatSessionDate } from '../../utils/format';

type MemoryLayer = 'facts' | 'episodes' | 'evidence' | 'playbooks' | 'inactive';

interface MemoryListItem {
  id: string;
  layer: MemoryLayer;
  preview: string;
  truthTime?: string | null;
  origin?: string;
  scope?: string;
  itemType?: string;
  timeliness?: string;
  category?: string;
  validation?: string;
}

interface MemoryDetail {
  id: string;
  layer: MemoryLayer;
  content: string;
  preview?: string;
  sourceRefs?: Array<{ layer?: string; id?: string }>;
  truthTime?: string | null;
  auditTrail?: Record<string, any>;
}

const LAYERS: MemoryLayer[] = ['facts', 'episodes', 'evidence', 'playbooks', 'inactive'];

function formatMeta(item: MemoryListItem) {
  const parts = [];
  if (item.truthTime) parts.push(formatSessionDate(item.truthTime));
  if (item.origin) parts.push(item.origin);
  if (item.scope) parts.push(item.scope);
  if (item.timeliness) parts.push(item.timeliness);
  if (item.category) parts.push(item.category);
  return parts.join(' · ');
}

export function MemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [layer, setLayer] = useState<MemoryLayer>('facts');
  const [items, setItems] = useState<MemoryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailModalLoading, setDetailModalLoading] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailModalData, setDetailModalData] = useState<MemoryDetail | null>(null);
  const [detailModalLayer, setDetailModalLayer] = useState<MemoryLayer>('facts');
  const [error, setError] = useState('');
  const listScrollRef = useRef<HTMLDivElement>(null);

  const layerLabels = {
    facts: t('settings.memory.layers.facts'),
    episodes: t('settings.memory.layers.episodes'),
    evidence: t('settings.memory.layers.evidence'),
    playbooks: t('settings.memory.layers.playbooks'),
    inactive: t('settings.memory.layers.inactive'),
  };

  const fetchPage = async (targetLayer: MemoryLayer, reset = false, cursor: string | null = null) => {
    setLoading(true);
    setError('');
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const params = new URLSearchParams({
        agentId: aid || '',
        layer: targetLayer,
        limit: '25',
      });
      if (cursor) params.set('cursor', cursor);
      const res = await hanaFetch(`/api/memory/library?${params.toString()}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const nextItems = Array.isArray(data.items) ? data.items : [];
      setItems((prev) => (reset ? nextItems : [...prev, ...nextItems]));
      setNextCursor(data.nextCursor || null);
    } catch (err: any) {
      setError(err.message || String(err));
      if (reset) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const loadDetails = async (item: MemoryListItem) => {
    const requestLayer = (item.layer as any) === 'experience' ? 'playbooks' : item.layer;
    setSelectedId(item.id);
    setDetailModalOpen(true);
    setDetailModalData(null);
    setDetailModalLoading(true);
    setDetailModalLayer(requestLayer);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch('/api/memory/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: aid, id: item.id, layer: requestLayer }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDetailModalData(data);
    } catch (err: any) {
      const fallback: MemoryDetail = {
        id: item.id,
        layer: requestLayer,
        content: err.message || String(err),
      };
      setDetailModalData(fallback);
    } finally {
      setDetailModalLoading(false);
    }
  };

  const restoreItem = async (item: MemoryListItem) => {
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch('/api/memory/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: aid, ids: [item.id] }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      window.dispatchEvent(new Event('hana-memory-updated'));
      setSelectedId((prev) => (prev === item.id ? null : prev));
      setDetailModalOpen(false);
      setDetailModalData(null);
      void fetchPage(layer, true);
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
    } catch (err: any) {
      useSettingsStore.getState().showToast(`${t('settings.saveFailed')}: ${err.message || String(err)}`, 'error');
    }
  };

  useEffect(() => {
    const openViewer = () => {
      setVisible(true);
      setLayer('facts');
    };
    const openInactiveLayer = () => {
      setVisible(true);
      setLayer('inactive');
    };
    window.addEventListener('hana-view-memories', openViewer);
    window.addEventListener('hana-view-memories-inactive', openInactiveLayer);
    return () => {
      window.removeEventListener('hana-view-memories', openViewer);
      window.removeEventListener('hana-view-memories-inactive', openInactiveLayer);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setDetailModalOpen(false);
    setDetailModalData(null);
    setDetailModalLayer(layer);
    void fetchPage(layer, true);
  }, [layer, visible]);

  useEffect(() => {
    if (!visible) return;
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
  }, [layer, visible]);

  useEffect(() => {
    if (!visible) return;
    const reload = () => {
      setSelectedId(null);
      setDetailModalOpen(false);
      setDetailModalData(null);
      setDetailModalLayer(layer);
      void fetchPage(layer, true);
    };
    window.addEventListener('hana-memory-updated', reload);
    window.addEventListener('hana-memory-archived', reload);
    return () => {
      window.removeEventListener('hana-memory-updated', reload);
      window.removeEventListener('hana-memory-archived', reload);
    };
  }, [layer, visible]);

  const close = () => setVisible(false);
  const closeDetailModal = () => {
    setDetailModalOpen(false);
    setDetailModalData(null);
    setDetailModalLoading(false);
  };

  if (!visible) return null;

  return (
    <div className="memory-viewer-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="memory-viewer memory-library-viewer">
        <div className="memory-viewer-header">
          <h3 className="memory-viewer-title">{t('settings.memory.actions.viewTitle')}</h3>
          <button
            type="button"
            className="memory-viewer-close"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
          >
            ✕
          </button>
        </div>

        <div className="memory-layer-tabs">
          {LAYERS.map((entry) => (
            <button
              key={entry}
              className={`memory-action-btn${layer === entry ? ' is-active' : ' secondary'}`}
              onClick={() => setLayer(entry)}
            >
              {layerLabels[entry]}
            </button>
          ))}
        </div>

        <div className="memory-viewer-body memory-library-body single-col">
          <div className="memory-library-col">
            {error ? (
              <div className="memory-viewer-empty memory-library-empty">{error}</div>
            ) : items.length === 0 && !loading ? (
              <div className="memory-viewer-empty memory-library-empty">{t('settings.memory.actions.empty')}</div>
            ) : (
              <div
                key={layer}
                ref={listScrollRef}
                className="memory-library-list memory-layer-fade"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  if (!nextCursor || loading) return;
                  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
                    void fetchPage(layer, false, nextCursor);
                  }
                }}
              >
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`memory-library-item${selectedId === item.id ? ' selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="memory-library-item-main"
                      onClick={() => loadDetails(item)}
                    >
                      <div className="memory-library-item-preview">{item.preview || t('settings.memory.emptyPreview')}</div>
                      <div className="memory-library-item-meta">{formatMeta(item)}</div>
                    </button>
                    {layer === 'inactive' ? (
                      <button
                        type="button"
                        className="memory-library-item-restore"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void restoreItem(item);
                        }}
                      >
                        {t('settings.memory.actions.restore')}
                      </button>
                    ) : null}
                  </div>
                ))}
                {loading ? (
                  <div className="memory-viewer-empty">{t('settings.archivedSessions.loading')}</div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {detailModalOpen ? (
          <div
            className="memory-detail-modal-overlay"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1400,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onClick={(e) => { if (e.target === e.currentTarget) closeDetailModal(); }}
          >
            <div
              className="memory-detail-modal"
              style={{
                width: 'min(720px, calc(100vw - 48px))',
                maxHeight: 'calc(100vh - 96px)',
                display: 'flex',
                flexDirection: 'column',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="memory-detail-modal-header">
                <h4 className="memory-detail-modal-title">{layerLabels[detailModalLayer]}</h4>
                <button
                  type="button"
                  className="memory-viewer-close"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeDetailModal();
                  }}
                >
                  ✕
                </button>
              </div>
              <div className="memory-detail-modal-body">
                {detailModalLoading ? (
                  <div className="memory-viewer-empty">{t('settings.archivedSessions.loading')}</div>
                ) : detailModalData ? (
                  <div className="memory-detail-content">
                    <div className="memory-detail-meta">
                      {detailModalData.truthTime ? formatSessionDate(detailModalData.truthTime) : layerLabels[detailModalLayer]}
                    </div>
                    <pre className="memory-detail-pre">{detailModalData.content}</pre>
                    {Array.isArray(detailModalData.sourceRefs) && detailModalData.sourceRefs.length > 0 ? (
                      <div>
                        <div className="memory-detail-subtitle">{t('settings.memory.detailSourceRefs')}</div>
                        <pre className="memory-detail-pre subtle">
                          {JSON.stringify(detailModalData.sourceRefs, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {detailModalData.auditTrail ? (
                      <div>
                        <div className="memory-detail-subtitle">{t('settings.memory.detailAudit')}</div>
                        <pre className="memory-detail-pre subtle">
                          {JSON.stringify(detailModalData.auditTrail, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
