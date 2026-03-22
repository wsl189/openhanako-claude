import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { cronToHuman } from '../utils/format';
import { normalizeAgentDisplayName, yuanFallbackAvatar } from '../utils/agent-helpers';

interface CronJob {
  id: string;
  enabled: boolean;
  label?: string;
  prompt?: string;
  schedule: string | number;
  model?: string;
  agentId?: string;
  agentName?: string;
}

export function AutomationPanel() {
  const activePanel = useStore(s => s.activePanel);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const agents = useStore(s => s.agents);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const query = currentSessionPath ? `?sessionPath=${encodeURIComponent(currentSessionPath)}` : '';
      const [cronRes, favRes] = await Promise.all([
        hanaFetch(`/api/desk/cron${query}`),
        hanaFetch('/api/favorites'),
      ]);
      const cronData = await cronRes.json();
      let favs: string[] = [];
      try { favs = (await favRes.json()).favorites || []; } catch {}
      setJobs(cronData.jobs || []);
      setFavorites(favs);
      updateBadge(cronData.jobs || []);
    } catch (err) {
      console.error('[automation] load failed:', err);
    }
  }, [currentSessionPath]);

  useEffect(() => {
    if (activePanel === 'automation') loadData();
  }, [activePanel, loadData, currentSessionPath]);

  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
  }, []);

  const toggleJob = useCallback(async (jobId: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id: jobId, sessionPath: currentSessionPath }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] toggle failed:', err);
    }
  }, [loadData, currentSessionPath]);

  const removeJob = useCallback(async (jobId: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: jobId, sessionPath: currentSessionPath }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] remove failed:', err);
    }
  }, [loadData, currentSessionPath]);

  const updateJob = useCallback(async (jobId: string, fields: Record<string, unknown>) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: jobId, ...fields, sessionPath: currentSessionPath }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] update failed:', err);
    }
  }, [loadData, currentSessionPath]);

  if (activePanel !== 'automation') return null;

  return (
    <div className="floating-panel" id="automationPanel">
      <div className="floating-panel-inner">
        <div className="floating-panel-header">
          <h2 className="floating-panel-title">{(window.t ?? ((p: string) => p))('automation.title')}</h2>
          <button className="floating-panel-close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="floating-panel-body">
          <div className="automation-list" id="automationList">
            {jobs.length === 0 ? (
              <div className="automation-empty">{(window.t ?? ((p: string) => p))('automation.empty')}</div>
            ) : (
              jobs.map(job => (
                <AutomationItem
                  key={job.id}
                  job={job}
                  agents={agents}
                  favorites={favorites}
                  onToggle={toggleJob}
                  onRemove={removeJob}
                  onUpdate={updateJob}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

function AutomationItem({
  job,
  agents,
  favorites,
  onToggle,
  onRemove,
  onUpdate,
}: {
  job: CronJob;
  agents: Array<{ id: string; name: string; yuan: string }>;
  favorites: string[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const labelText = job.label || job.prompt?.slice(0, 40) || job.id;

  const startEdit = useCallback(() => {
    setEditValue(labelText);
    setEditing(true);
  }, [labelText]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitEdit = useCallback(() => {
    const newText = editValue.trim();
    if (newText && newText !== labelText) {
      onUpdate(job.id, { label: newText });
    }
    setEditing(false);
  }, [editValue, labelText, job.id, onUpdate]);

  const ownerAgent = agents.find(a => a.id === job.agentId);
  const rawOwnerName = job.agentName || ownerAgent?.name || job.agentId || '';
  const ownerName = normalizeAgentDisplayName(
    rawOwnerName,
    agents.flatMap(a => [a.id, a.name]),
  );
  const ownerYuan = ownerAgent?.yuan || 'hanako';
  const avatarSrc = job.agentId ? hanaUrl(`/api/agents/${job.agentId}/avatar`) : yuanFallbackAvatar(ownerYuan);

  // 构建模型选项
  const modelOptions: string[] = [];
  const modelSet = new Set(favorites);
  if (job.model && !modelSet.has(job.model)) modelOptions.push(job.model);
  modelOptions.push(...favorites);

  return (
    <div className="auto-item">
      <button
        className={'hana-toggle' + (job.enabled ? ' on' : '')}
        title={job.enabled ? 'Disable' : 'Enable'}
        onClick={() => onToggle(job.id)}
      />
      <div className="auto-item-info">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            className="auto-item-label-input"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
              if (e.key === 'Escape') { setEditValue(labelText); inputRef.current?.blur(); }
            }}
          />
        ) : (
          <span className="auto-item-label" onDoubleClick={startEdit}>{labelText}</span>
        )}
        <div className="auto-item-meta">
          <div className="auto-item-executor">
            <img
              className="auto-item-executor-avatar"
              src={avatarSrc}
              onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ownerYuan); }}
            />
            <span className="auto-item-executor-name">{ownerName}</span>
          </div>
          <span className="auto-item-schedule">{cronToHuman(job.schedule)}</span>
          {favorites.length > 0 && (
            <span className="auto-item-model-wrap">
              <select
                className="auto-item-model-select"
                title="Model"
                value={job.model || ''}
                onChange={e => onUpdate(job.id, { model: e.target.value })}
              >
                <option value="">{(window.t ?? ((p: string) => p))('automation.defaultModel')}</option>
                {modelOptions.map(mid => (
                  <option key={mid} value={mid}>{mid}</option>
                ))}
              </select>
            </span>
          )}
        </div>
      </div>
      <div className="auto-item-actions">
        <button className="auto-item-btn" title={(window.t ?? ((p: string) => p))('automation.edit')} onClick={startEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button className="auto-item-btn danger" title={(window.t ?? ((p: string) => p))('automation.delete')} onClick={() => onRemove(job.id)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
