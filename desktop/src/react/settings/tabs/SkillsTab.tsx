import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore, type SkillInfo } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';

const platform = (window as any).platform;
type RemoteSkillResult = { slug: string; name?: string; score?: number; stars?: number | null };
type ClawhubInstallJob = {
  id: string;
  slug: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress?: number;
  message?: string;
  error?: string | null;
  skill?: any;
};
const CLAWHUB_SEARCH_TIMEOUT_MS = 60_000;
const CLAWHUB_INSTALL_TIMEOUT_MS = 30 * 60_000;
const CLAWHUB_INSTALL_POLL_INTERVAL_MS = 700;
const CLAWHUB_INSTALL_POLL_REQUEST_TIMEOUT_MS = 45_000;
const CLAWHUB_INSTALL_POLL_MAX_ERRORS = 5;

export function SkillsTab() {
  const { skillsList, showToast } = useSettingsStore();
  const [reloading, setReloading] = useState(false);
  const [remoteQuery, setRemoteQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<RemoteSkillResult[]>([]);
  const [remoteSearching, setRemoteSearching] = useState(false);
  const [remoteSearched, setRemoteSearched] = useState(false);
  const [remoteDismissed, setRemoteDismissed] = useState(false);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<string, number>>({});
  const [installMessage, setInstallMessage] = useState<Record<string, string>>({});
  const marketRef = useRef<HTMLDivElement | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/skills');
      const data = await res.json();
      useSettingsStore.setState({ skillsList: data.skills || [] });
    } catch (err) {
      console.error('[skills] load failed:', err);
    }
  }, []);

  const reloadSkills = useCallback(async () => {
    setReloading(true);
    try {
      const res = await hanaFetch('/api/skills/reload', { method: 'POST' });
      const data = await res.json();
      if (data.skills) {
        useSettingsStore.setState({ skillsList: data.skills });
      } else {
        await loadSkills();
      }
      showToast(t('settings.skills.reloaded'), 'success');
      platform?.notifyMainWindow?.('skills-changed', {});
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setReloading(false);
    }
  }, [loadSkills, showToast]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const visible = skillsList.filter(s => !s.hidden);

  useEffect(() => {
    if (remoteResults.length === 0) return;
    const onDocDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (marketRef.current?.contains(target)) return;
      setRemoteResults([]);
      setRemoteDismissed(true);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [remoteResults.length]);

  const finishInstallProgress = useCallback((slug: string, success: boolean) => {
    if (success) {
      setInstallProgress(prev => ({ ...prev, [slug]: 100 }));
      window.setTimeout(() => {
        setInstallProgress(prev => {
          const next = { ...prev };
          delete next[slug];
          return next;
        });
        setInstallMessage(prev => {
          const next = { ...prev };
          delete next[slug];
          return next;
        });
      }, 280);
      return;
    }
    setInstallProgress(prev => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    setInstallMessage(prev => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  const [nameHints, setNameHints] = useState<Record<string, string>>({});
  useEffect(() => {
    const locale = (window as any).i18n?.locale || 'zh';
    if (locale === 'en' || visible.length === 0) return;
    const names = visible.map(s => s.name).filter(n => !nameHints[n]);
    if (names.length === 0) return;
    hanaFetch('/api/skills/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names, lang: locale }),
    })
      .then(r => r.json())
      .then(map => { if (map && typeof map === 'object') setNameHints(prev => ({ ...prev, ...map })); })
      .catch(() => {});
  }, [visible.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureInstalledLoaded = useCallback((skill: any) => {
    if (!skill) return;
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const list = useSettingsStore.getState().skillsList || [];
    const targetDir = typeof skill.baseDir === 'string' ? normalize(skill.baseDir) : '';
    const found = list.find((s: any) => {
      const sameName = skill.name && s.name === skill.name;
      const sameDir = !!targetDir && typeof s.baseDir === 'string' && normalize(s.baseDir) === targetDir;
      return sameName || sameDir;
    });
    if (!found) {
      throw new Error(t('settings.skills.installNotLoaded'));
    }
  }, []);

  const installSkill = async () => {
    const selectedPath = await platform?.selectSkill?.();
    if (!selectedPath) return;
    await installSkillFromPath(selectedPath);
  };

  const installSkillFromPath = async (filePath: string) => {
    try {
      const res = await hanaFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await loadSkills();
      platform?.notifyMainWindow?.('skills-changed', {});
      ensureInstalledLoaded(data.skill);
      showToast(t('settings.skills.installSuccess', { name: data.skill?.name || '' }), 'success');
    } catch (err: any) {
      showToast(t('settings.skills.installError') + ': ' + err.message, 'error');
    }
  };

  const deleteSkill = async (name: string) => {
    const msg = t('settings.skills.deleteConfirm', { name });
    if (!confirm(msg)) return;
    try {
      const res = await hanaFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
      platform?.notifyMainWindow?.('skills-changed', {});
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = platform?.getFilePath?.(file) || (file as any)?.path;
    if (filePath) await installSkillFromPath(filePath);
  };

  const searchRemoteSkills = async () => {
    const keyword = remoteQuery.trim();
    if (!keyword) {
      setRemoteResults([]);
      setRemoteSearched(false);
      setRemoteDismissed(false);
      return;
    }
    setRemoteSearched(true);
    setRemoteDismissed(false);
    setRemoteSearching(true);
    try {
      const res = await hanaFetch('/api/skills/clawhub/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: keyword, limit: 10 }),
        timeout: CLAWHUB_SEARCH_TIMEOUT_MS,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRemoteResults(Array.isArray(data.results) ? data.results : []);
    } catch (err: any) {
      showToast(t('settings.skills.searchError') + ': ' + err.message, 'error');
    } finally {
      setRemoteSearching(false);
    }
  };

  const installRemoteSkill = async (slug: string) => {
    if (installingSlug) return;
    setInstallingSlug(slug);
    setInstallProgress(prev => ({ ...prev, [slug]: 4 }));
    setInstallMessage(prev => ({ ...prev, [slug]: 'queued' }));
    try {
      const startRes = await hanaFetch('/api/skills/clawhub/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
        timeout: 20_000,
      });
      const startData = await startRes.json();
      if (startData.error) throw new Error(startData.error);
      const jobId = String(startData.jobId || '').trim();
      if (!jobId) throw new Error('missing install job id');

      const beginAt = Date.now();
      let finalJob: ClawhubInstallJob | null = null;
      let pollErrors = 0;
      while (Date.now() - beginAt < CLAWHUB_INSTALL_TIMEOUT_MS) {
        try {
          const pollRes = await hanaFetch(`/api/skills/clawhub/install/${encodeURIComponent(jobId)}`, {
            timeout: CLAWHUB_INSTALL_POLL_REQUEST_TIMEOUT_MS,
          });
          const pollData = await pollRes.json();
          if (pollData.error) throw new Error(pollData.error);
          pollErrors = 0;
          const job = (pollData.job || pollData) as ClawhubInstallJob;
          const progress = Math.max(0, Math.min(100, Number(job?.progress) || 0));
          setInstallProgress(prev => ({ ...prev, [slug]: progress }));
          if (job?.message) {
            setInstallMessage(prev => ({ ...prev, [slug]: job.message! }));
          }
          if (job.status === 'succeeded' || job.status === 'failed') {
            finalJob = job;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, CLAWHUB_INSTALL_POLL_INTERVAL_MS));
        } catch (pollErr) {
          pollErrors += 1;
          if (pollErrors >= CLAWHUB_INSTALL_POLL_MAX_ERRORS) {
            throw pollErr;
          }
          await new Promise(resolve => setTimeout(resolve, 1200 * pollErrors));
        }
      }

      if (!finalJob) {
        throw new Error('安装等待超时，任务可能仍在后台继续，请稍后刷新技能列表');
      }
      if (finalJob.status === 'failed') {
        throw new Error(finalJob.error || finalJob.message || 'install failed');
      }

      await loadSkills();
      platform?.notifyMainWindow?.('skills-changed', {});
      ensureInstalledLoaded(finalJob.skill);
      showToast(t('settings.skills.installSuccess', { name: finalJob.skill?.name || slug }), 'success');
      finishInstallProgress(slug, true);
    } catch (err: any) {
      finishInstallProgress(slug, false);
      showToast(t('settings.skills.installError') + ': ' + err.message, 'error');
    } finally {
      setInstallingSlug(null);
    }
  };

  return (
    <div className="settings-tab-content active" data-tab="skills">
      <section className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">{t('settings.skills.title')}</h2>
          <button
            className="settings-icon-btn"
            title={t('settings.skills.reload')}
            onClick={reloadSkills}
            disabled={reloading}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={reloading ? 'spin' : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <div
          className="skills-dropzone"
          onClick={installSkill}
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drag-over'); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('drag-over')}
          onDrop={handleDrop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{t('settings.skills.dropzone')}</span>
        </div>

        <div className="skill-market-block" ref={marketRef}>
          <div className="skill-market-title">{t('settings.skills.searchTitle')}</div>
          <div className="skill-market-row">
            <input
              className="settings-input skill-market-input"
              type="text"
              value={remoteQuery}
              placeholder={t('settings.skills.searchPlaceholder')}
              onChange={(e) => {
                setRemoteQuery(e.target.value);
                setRemoteSearched(false);
                setRemoteDismissed(false);
                if (!e.target.value.trim()) {
                  setRemoteResults([]);
                }
              }}
              onKeyDown={(e) => {
                const native = e.nativeEvent as any;
                if (native?.isComposing || (e as any).isComposing || (e as any).keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  searchRemoteSkills();
                }
              }}
            />
            <button
              className="settings-save-btn-sm skill-market-search-btn"
              onClick={searchRemoteSkills}
              disabled={remoteSearching}
            >
              {remoteSearching ? t('settings.skills.searching') : t('settings.skills.searchBtn')}
            </button>
          </div>

          {remoteResults.length > 0 ? (
            <div className="skill-market-results">
              {remoteResults.map(item => (
                <div className="skill-market-item" key={item.slug}>
                  <div className="skill-market-item-main">
                    <span className="skill-market-item-slug">{item.slug}</span>
                    {item.name && <span className="skill-market-item-name">{item.name}</span>}
                    <span className="skill-market-item-meta">
                      <span className="skill-market-item-meta-chip">{`★ ${typeof item.stars === 'number' ? item.stars.toLocaleString() : '-'}`}</span>
                      <span className="skill-market-item-meta-chip">{`score ${typeof item.score === 'number' ? item.score.toFixed(3) : '-'}`}</span>
                    </span>
                    {installingSlug === item.slug && installMessage[item.slug] && (
                      <span className="skill-market-item-status">{installMessage[item.slug]}</span>
                    )}
                  </div>
                  <button
                    className="skill-market-add"
                    title={t('settings.skills.installFromSearch')}
                    onClick={() => installRemoteSkill(item.slug)}
                    disabled={installingSlug === item.slug || typeof installProgress[item.slug] === 'number'}
                  >
                    {typeof installProgress[item.slug] === 'number' ? (
                      `${Math.round(installProgress[item.slug])}%`
                    ) : (
                      '+'
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            remoteSearched && !remoteDismissed && remoteQuery.trim() && !remoteSearching
              ? <div className="skill-market-empty">{t('settings.skills.searchEmpty')}</div>
              : null
          )}
        </div>

        {visible.length === 0 ? (
          <p className="settings-desc skills-empty">{t('settings.skills.noSkills')}</p>
        ) : (
          <div className="skills-list-block skills-list-block-spaced">
            {visible.map(skill => (
              <SkillRow
                key={skill.name}
                skill={skill}
                nameHint={nameHints[skill.name]}
                onDelete={deleteSkill}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SkillRow({ skill, nameHint, onDelete }: {
  skill: SkillInfo;
  nameHint?: string;
  onDelete: (name: string) => void;
}) {
  const rawDesc = skill.description || '';
  const cnMatch = rawDesc.match(/[\u4e00-\u9fff].*$/s);
  let displayDesc = cnMatch ? cnMatch[0] : rawDesc;
  displayDesc = displayDesc.replace(/\s*MANDATORY TRIGGERS:.*$/si, '').trim();
  if (displayDesc.length > 80) displayDesc = displayDesc.slice(0, 80) + '…';

  return (
    <div
      className="skills-list-item"
      onClick={() => {
        if (skill.baseDir) {
          (window as any).platform?.openSkillViewer?.({
            name: skill.name,
            baseDir: skill.baseDir,
            filePath: skill.filePath,
            installed: true,
          });
        }
      }}
    >
      <div className="skills-list-info">
        <span className="skills-list-name">
          {skill.name}
          {nameHint && <span className="skills-list-name-hint">{nameHint}</span>}
        </span>
        <span className="skills-list-desc">{displayDesc}</span>
      </div>
      <div className="skills-list-actions">
        <button
          className="skill-card-delete"
          title={t('settings.skills.delete')}
          onClick={(e) => { e.stopPropagation(); onDelete(skill.name); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
