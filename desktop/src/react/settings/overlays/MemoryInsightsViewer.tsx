import React, { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { formatSessionDate } from '../../utils/format';

type InsightTab = 'reflections' | 'profile' | 'retrievals';

interface MemoryBlock {
  id: string;
  kind: string;
  title: string;
  itemCount?: number;
  items?: string[];
  content?: string;
}

interface ReflectionResponse {
  title?: string;
  content?: string;
  blocks?: MemoryBlock[];
}

interface ProfileBlocksResponse {
  title?: string;
  content?: string;
  blocks?: MemoryBlock[];
}

interface RetrievalResult {
  id: string;
  preview?: string;
  truthTime?: string | null;
  weightedScore?: number | null;
  componentScores?: Record<string, any> | null;
  entityMatches?: Array<{ key?: string; kind?: string; value?: string }>;
}

interface RetrievalLog {
  id: string;
  query: string;
  layer: string;
  rankingVersion?: string | null;
  createdAt?: string | null;
  configSnapshot?: Record<string, any>;
  results?: RetrievalResult[];
}

function BlockList({ blocks, emptyText }: { blocks: MemoryBlock[]; emptyText: string }) {
  if (blocks.length === 0) {
    return <div className="memory-viewer-empty">{emptyText}</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {blocks.map((block) => (
        <div
          key={block.id}
          style={{
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16,
            padding: 14,
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {block.title}
            {block.itemCount ? ` · ${block.itemCount}` : ''}
          </div>
          {Array.isArray(block.items) && block.items.length > 0 ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {block.items.map((item, idx) => (
                <div key={`${block.id}:${idx}`} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {item}
                </div>
              ))}
            </div>
          ) : (
            <pre className="memory-detail-pre subtle">{block.content || ''}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

export function MemoryInsightsViewer() {
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<InsightTab>('reflections');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reflections, setReflections] = useState<ReflectionResponse | null>(null);
  const [profileBlocks, setProfileBlocks] = useState<ProfileBlocksResponse | null>(null);
  const [retrievals, setRetrievals] = useState<RetrievalLog[]>([]);
  const [selectedRetrievalId, setSelectedRetrievalId] = useState<string | null>(null);

  const selectedRetrieval = useMemo(
    () => retrievals.find((item) => item.id === selectedRetrievalId) || retrievals[0] || null,
    [retrievals, selectedRetrievalId],
  );

  useEffect(() => {
    const open = () => {
      setVisible(true);
      setTab('reflections');
      void load();
    };
    window.addEventListener('hana-view-memory-insights', open);
    return () => window.removeEventListener('hana-view-memory-insights', open);
  }, []);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const [reflectionRes, profileBlocksRes, retrievalsRes] = await Promise.all([
        hanaFetch(`/api/memory/reflection?agentId=${encodeURIComponent(aid || '')}`),
        hanaFetch(`/api/memory/profile/blocks?agentId=${encodeURIComponent(aid || '')}`),
        hanaFetch(`/api/memory/retrievals?agentId=${encodeURIComponent(aid || '')}&limit=20`),
      ]);
      const reflectionData = await reflectionRes.json();
      const profileBlocksData = await profileBlocksRes.json();
      const retrievalsData = await retrievalsRes.json();
      if (reflectionData?.error) throw new Error(reflectionData.error);
      if (profileBlocksData?.error) throw new Error(profileBlocksData.error);
      if (retrievalsData?.error) throw new Error(retrievalsData.error);
      setReflections(reflectionData);
      setProfileBlocks(profileBlocksData);
      const nextRetrievals = Array.isArray(retrievalsData.items) ? retrievalsData.items : [];
      setRetrievals(nextRetrievals);
      setSelectedRetrievalId(nextRetrievals[0]?.id || null);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const close = () => setVisible(false);

  if (!visible) return null;

  const tabs: Array<{ id: InsightTab; label: string }> = [
    { id: 'reflections', label: t('settings.memory.insights.tabs.reflections') },
    { id: 'profile', label: t('settings.memory.insights.tabs.profile') },
    { id: 'retrievals', label: t('settings.memory.insights.tabs.retrievals') },
  ];

  return (
    <div className="memory-viewer-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="memory-viewer memory-library-viewer" style={{ width: 'min(980px, calc(100vw - 48px))' }}>
        <div className="memory-viewer-header">
          <h3 className="memory-viewer-title">{t('settings.memory.insights.title')}</h3>
          <button className="memory-viewer-close" onClick={close}>✕</button>
        </div>

        <div className="memory-layer-tabs">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={`memory-action-btn${tab === item.id ? ' is-active' : ' secondary'}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="memory-viewer-body memory-library-body single-col">
          {loading ? (
            <div className="memory-viewer-empty">{t('settings.archivedSessions.loading')}</div>
          ) : error ? (
            <div className="memory-viewer-empty">{error}</div>
          ) : tab === 'reflections' ? (
            <BlockList
              blocks={Array.isArray(reflections?.blocks) ? reflections.blocks : []}
              emptyText={t('settings.memory.insights.emptyReflections')}
            />
          ) : tab === 'profile' ? (
            <BlockList
              blocks={Array.isArray(profileBlocks?.blocks) ? profileBlocks.blocks : []}
              emptyText={t('settings.memory.insights.emptyProfile')}
            />
          ) : retrievals.length === 0 ? (
            <div className="memory-viewer-empty">{t('settings.memory.insights.emptyRetrievals')}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 320px) 1fr', gap: 16 }}>
              <div className="memory-library-list" style={{ maxHeight: 520 }}>
                {retrievals.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`memory-library-item-main${selectedRetrieval?.id === item.id ? ' selected' : ''}`}
                    style={{ width: '100%', textAlign: 'left', marginBottom: 8 }}
                    onClick={() => setSelectedRetrievalId(item.id)}
                  >
                    <div className="memory-library-item-preview">{item.query || t('settings.memory.insights.emptyRetrievals')}</div>
                    <div className="memory-library-item-meta">
                      {[item.layer, item.createdAt ? formatSessionDate(item.createdAt) : ''].filter(Boolean).join(' · ')}
                    </div>
                  </button>
                ))}
              </div>
              <div style={{ overflow: 'auto', maxHeight: 520, paddingRight: 4 }}>
                {selectedRetrieval ? (
                  <div className="memory-detail-content">
                    <div className="memory-detail-meta">{selectedRetrieval.query}</div>
                    <pre className="memory-detail-pre subtle">
                      {JSON.stringify({
                        requestedLayer: selectedRetrieval.configSnapshot?.requestedLayer || null,
                        resolvedLayer: selectedRetrieval.layer,
                        resolvedIntent: selectedRetrieval.configSnapshot?.resolvedIntent || null,
                        resolvedScope: selectedRetrieval.configSnapshot?.resolvedScope || null,
                        includedLayers: selectedRetrieval.configSnapshot?.includedLayers || null,
                        rankingVersion: selectedRetrieval.rankingVersion || null,
                      }, null, 2)}
                    </pre>
                    <div className="memory-detail-subtitle">{t('settings.memory.insights.retrievalResults')}</div>
                    <div style={{ display: 'grid', gap: 10 }}>
                      {(selectedRetrieval.results || []).map((result, index) => (
                        <div
                          key={result.id}
                          style={{
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 14,
                            padding: 12,
                            background: 'rgba(255,255,255,0.02)',
                          }}
                        >
                          <div className="memory-library-item-meta" style={{ marginBottom: 6 }}>
                            #{index + 1}
                          </div>
                          <div className="memory-library-item-preview">{result.preview || result.id}</div>
                          <div className="memory-library-item-meta">
                            {[result.truthTime ? formatSessionDate(result.truthTime) : '', result.weightedScore != null ? `score ${Number(result.weightedScore).toFixed(3)}` : '']
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                          {Array.isArray(result.entityMatches) && result.entityMatches.length > 0 ? (
                            <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                              {t('settings.memory.insights.entityMatches')}: {result.entityMatches.map((item) => item.value || item.key).filter(Boolean).join(' / ')}
                            </div>
                          ) : null}
                          {result.componentScores ? (
                            <pre className="memory-detail-pre subtle" style={{ marginTop: 8 }}>
                              {JSON.stringify(result.componentScores, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
