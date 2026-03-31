import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { cronToHuman } from '../utils/format';
import { normalizeAgentDisplayName, yuanFallbackAvatar } from '../utils/agent-helpers';
import { SelectWidget } from '../settings/widgets/SelectWidget';

interface CronJob {
  id: string;
  enabled: boolean;
  type?: 'at' | 'every' | 'cron' | string;
  label?: string;
  prompt?: string;
  schedule: string | number;
  model?: string;
  agentId?: string;
  agentName?: string;
}

interface PromptModalJob {
  id: string;
  agentId?: string;
  label: string;
  prompt: string;
}

function normalizeDefaultModelValue(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower === 'default' || lower === 'default model' || value === '默认' || value === '默认模型') {
    return '';
  }
  return value;
}

export function AutomationPanel() {
  const activePanel = useStore(s => s.activePanel);
  const agents = useStore(s => s.agents);
  const addToast = useStore(s => s.addToast);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [promptModalOpen, setPromptModalOpen] = useState(false);
  const [promptModalJob, setPromptModalJob] = useState<PromptModalJob | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [cronRes, favRes] = await Promise.all([
        hanaFetch('/api/desk/cron?all=1'),
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
  }, []);

  useEffect(() => {
    if (activePanel === 'automation') loadData();
  }, [activePanel, loadData]);

  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
  }, []);

  const toggleJob = useCallback(async (jobId: string, agentId?: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id: jobId, ...(agentId ? { agentId } : {}) }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] toggle failed:', err);
    }
  }, [loadData]);

  const removeJob = useCallback(async (jobId: string, agentId?: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: jobId, ...(agentId ? { agentId } : {}) }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] remove failed:', err);
    }
  }, [loadData]);

  const updateJob = useCallback(async (jobId: string, fields: Record<string, unknown>, agentId?: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: jobId, ...fields, ...(agentId ? { agentId } : {}) }),
      });
      await loadData();
      return true;
    } catch (err) {
      console.error('[automation] update failed:', err);
      return false;
    }
  }, [loadData]);

  const openPromptModal = useCallback((job: CronJob) => {
    const labelText = job.label || job.prompt?.slice(0, 40) || job.id;
    setPromptSaving(false);
    setPromptModalJob({
      id: job.id,
      agentId: job.agentId,
      label: labelText,
      prompt: String(job.prompt ?? ''),
    });
    setPromptDraft(String(job.prompt ?? ''));
    setPromptModalOpen(true);
  }, []);

  const closePromptModal = useCallback(async () => {
    setPromptModalOpen(false);

    if (!promptModalJob) return;
    if (promptDraft === promptModalJob.prompt) return;

    setPromptSaving(true);
    const ok = await Promise.race<boolean>([
      updateJob(promptModalJob.id, { prompt: promptDraft }, promptModalJob.agentId),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
    setPromptSaving(false);
    if (!ok) {
      addToast((window.t ?? ((p: string) => p))('automation.promptSaveFailed'), 'error', 3000);
    }
  }, [addToast, promptDraft, promptModalJob, updateJob]);

  useEffect(() => {
    if (!promptModalOpen) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        void closePromptModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePromptModal, promptModalOpen]);

  useEffect(() => {
    if (activePanel === 'automation') return;
    if (!promptModalOpen && !promptModalJob) return;
    setPromptModalOpen(false);
    setPromptSaving(false);
    setPromptModalJob(null);
    setPromptDraft('');
  }, [activePanel, promptModalJob, promptModalOpen]);

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
                  onEditPrompt={openPromptModal}
                />
              ))
            )}
          </div>
        </div>
      </div>
      <div
        className={`automation-prompt-overlay${promptModalOpen ? ' visible' : ''}`}
        onClick={(e) => { if (e.target === e.currentTarget) void closePromptModal(); }}
      >
        <div className="automation-prompt-card">
          <button
            className="automation-prompt-close-btn"
            type="button"
            onClick={() => void closePromptModal()}
            aria-label={(window.t ?? ((p: string) => p))('automation.promptClose')}
            title={(window.t ?? ((p: string) => p))('automation.promptClose')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <h3 className="automation-prompt-title">{(window.t ?? ((p: string) => p))('automation.promptTitle')}</h3>
          <div className="automation-prompt-label">{promptModalJob?.label || ''}</div>
          <textarea
            className="settings-input automation-prompt-input"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            placeholder={(window.t ?? ((p: string) => p))('automation.promptPlaceholder')}
          />
          <div className="automation-prompt-hint">{(window.t ?? ((p: string) => p))('automation.promptHint')}</div>
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
  onEditPrompt,
}: {
  job: CronJob;
  agents: Array<{ id: string; name: string; yuan: string }>;
  favorites: string[];
  onToggle: (id: string, agentId?: string) => void;
  onRemove: (id: string, agentId?: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>, agentId?: string) => Promise<boolean>;
  onEditPrompt: (job: CronJob) => void;
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
      void onUpdate(job.id, { label: newText }, job.agentId);
    }
    setEditing(false);
  }, [editValue, labelText, job.id, job.agentId, onUpdate]);

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
  const normalizedModelValue = normalizeDefaultModelValue(job.model);
  if (normalizedModelValue && !modelSet.has(normalizedModelValue)) modelOptions.push(normalizedModelValue);
  modelOptions.push(...favorites);
  const modelSelectOptions = [
    { value: '', label: (window.t ?? ((p: string) => p))('automation.defaultModel') },
    ...modelOptions.map(mid => ({ value: mid, label: mid })),
  ];

  return (
    <div className="auto-item">
      <button
        className={'hana-toggle auto-item-toggle' + (job.enabled ? ' on' : '')}
        title={job.enabled ? 'Disable' : 'Enable'}
        onClick={() => onToggle(job.id, job.agentId)}
      />
      <div className="auto-item-main">
        <div className="auto-item-topline">
          <div className="auto-item-executor">
            <img
              className="auto-item-executor-avatar"
              src={avatarSrc}
              onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ownerYuan); }}
            />
            <span className="auto-item-executor-name">{ownerName}</span>
          </div>
          <span className="auto-item-schedule">{cronToHuman(job.schedule, job.type)}</span>
          <span className="auto-item-model-actions">
            <span className="auto-item-model-wrap">
              <SelectWidget
                options={modelSelectOptions}
                value={normalizedModelValue}
                onChange={(modelId) => void onUpdate(job.id, { model: modelId }, job.agentId)}
                placeholder={(window.t ?? ((p: string) => p))('automation.defaultModel')}
              />
            </span>
            <button
              className="auto-item-prompt-btn"
              type="button"
              onClick={() => onEditPrompt(job)}
              title={(window.t ?? ((p: string) => p))('automation.promptBtn')}
            >
              {(window.t ?? ((p: string) => p))('automation.promptBtn')}
            </button>
          </span>
        </div>
        <div className="auto-item-bottomline">
          <div className="auto-item-label-wrap">
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
              <>
                <span className="auto-item-label" onDoubleClick={startEdit}>{labelText}</span>
                <button className="auto-item-btn auto-item-btn-inline auto-item-btn-edit" title={(window.t ?? ((p: string) => p))('automation.edit')} onClick={startEdit}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              </>
            )}
          </div>
          <div className="auto-item-actions">
            <button className="auto-item-btn danger auto-item-btn-delete" title={(window.t ?? ((p: string) => p))('automation.delete')} onClick={() => onRemove(job.id, job.agentId)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
