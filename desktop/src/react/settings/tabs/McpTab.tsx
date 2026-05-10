import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';

const platform = (window as any).platform;

type McpServerType = 'stdio' | 'sse' | 'http';
type ExternalMcpServer = {
  type?: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
};

type McpHealthStatus = 'checking' | 'ok' | 'error' | 'disabled';
type McpHealthItem = {
  status: McpHealthStatus;
  message?: string;
  latencyMs?: number;
};

function normalizeName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_]/g, '_');
}

function parseArgs(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(t('settings.mcp.argsInvalid'));
    return parsed.map(item => String(item || '').trim()).filter(Boolean);
  }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return text.split(/\s+/).map(item => item.trim()).filter(Boolean);
}

function parseStringMap(raw: string, errorKey: string): Record<string, string> | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t(errorKey));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const name = String(key || '').trim();
    if (!name) continue;
    out[name] = String(value ?? '');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function McpTab() {
  const store = useSettingsStore();
  const { settingsConfig, showToast } = store;
  const servers = useMemo(() => {
    const raw = settingsConfig?.mcp?.external_servers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, ExternalMcpServer>;
  }, [settingsConfig]);
  const serverEntries = useMemo(() => Object.entries(servers)
    .filter(([, value]) => value && typeof value === 'object')
    .sort(([a], [b]) => a.localeCompare(b)), [servers]);
  const builtinServerNames = useMemo(() => {
    const raw = settingsConfig?.mcp?.builtin_servers;
    if (!Array.isArray(raw)) return new Set<string>();
    return new Set(raw.map(item => normalizeName(String(item || ''))).filter(Boolean));
  }, [settingsConfig]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<McpServerType>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [healthByServer, setHealthByServer] = useState<Record<string, McpHealthItem>>({});
  const [pendingDelete, setPendingDelete] = useState<{
    name: string;
    label: string;
  } | null>(null);

  const resetForm = useCallback(() => {
    setEditingServerName(null);
    setName('');
    setType('stdio');
    setCommand('');
    setArgs('');
    setUrl('');
    setEnvText('');
    setHeadersText('');
  }, []);

  const openAddModal = useCallback(() => {
    resetForm();
    setModalOpen(true);
  }, [resetForm]);

  const openEditModal = useCallback((serverName: string, server: ExternalMcpServer) => {
    const nextType = (server.type || (server.url ? 'sse' : 'stdio')) as McpServerType;
    setEditingServerName(serverName);
    setName(serverName);
    setType(nextType);
    setCommand(server.command || '');
    setArgs(Array.isArray(server.args) ? server.args.join('\n') : '');
    setUrl(server.url || '');
    setEnvText(server.env ? JSON.stringify(server.env, null, 2) : '');
    setHeadersText(server.headers ? JSON.stringify(server.headers, null, 2) : '');
    setModalOpen(true);
  }, []);

  const refreshConnectivity = useCallback(async () => {
    if (serverEntries.length === 0) {
      setHealthByServer({});
      return;
    }
    const checking: Record<string, McpHealthItem> = {};
    for (const [serverName, server] of serverEntries) {
      checking[serverName] = { status: server.disabled ? 'disabled' : 'checking' };
    }
    setHealthByServer(checking);
    try {
      const res = await hanaFetch('/api/config/mcp/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(String(data.error));
      const next: Record<string, McpHealthItem> = {};
      const raw = (data?.results && typeof data.results === 'object') ? data.results : {};
      for (const [serverName, server] of serverEntries) {
        const item = raw[serverName];
        if (item && typeof item === 'object') {
          const status = String(item.status || '').trim();
          next[serverName] = {
            status: status === 'ok' || status === 'error' || status === 'disabled' ? status : 'error',
            message: item.message ? String(item.message) : '',
            latencyMs: Number.isFinite(item.latencyMs) ? Number(item.latencyMs) : undefined,
          };
        } else {
          next[serverName] = { status: server.disabled ? 'disabled' : 'error' };
        }
      }
      setHealthByServer(next);
    } catch {
      const failed: Record<string, McpHealthItem> = {};
      for (const [serverName, server] of serverEntries) {
        failed[serverName] = { status: server.disabled ? 'disabled' : 'error' };
      }
      setHealthByServer(failed);
    }
  }, [serverEntries, servers]);

  useEffect(() => {
    void refreshConnectivity();
  }, [refreshConnectivity]);

  async function patchMcp(externalServersPatch: Record<string, ExternalMcpServer | null>) {
    const agentId = store.getSettingsAgentId();
    if (!agentId) throw new Error('agent not found');
    const res = await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcp: { external_servers: externalServersPatch } }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const refresh = await hanaFetch(`/api/agents/${agentId}/config`);
    const nextConfig = await refresh.json();
    const prevConfig = useSettingsStore.getState().settingsConfig || {};
    for (const key of ['_identity', '_ishiki', '_userProfile', '_experience']) {
      if (key in prevConfig && !(key in nextConfig)) nextConfig[key] = (prevConfig as any)[key];
    }
    useSettingsStore.setState({ settingsConfig: nextConfig });
    platform?.settingsChanged?.('agent-updated', { agentId });
  }

  async function addServer() {
    const key = normalizeName(name);
    if (!key) {
      showToast(t('settings.mcp.nameRequired'), 'error');
      return;
    }
    try {
      setSaving(true);
      const next: ExternalMcpServer = { type };
      if (type === 'stdio') {
        const cleanCommand = command.trim();
        if (!cleanCommand) throw new Error(t('settings.mcp.commandRequired'));
        const parsedArgs = parseArgs(args);
        const parsedEnv = parseStringMap(envText, 'settings.mcp.envInvalid');
        next.command = cleanCommand;
        if (parsedArgs.length > 0) next.args = parsedArgs;
        if (parsedEnv) next.env = parsedEnv;
      } else {
        const cleanUrl = url.trim();
        if (!cleanUrl) throw new Error(t('settings.mcp.urlRequired'));
        const parsedHeaders = parseStringMap(headersText, 'settings.mcp.headersInvalid');
        next.url = cleanUrl;
        if (parsedHeaders) next.headers = parsedHeaders;
      }
      const patch: Record<string, ExternalMcpServer | null> = { [key]: next };
      if (editingServerName && editingServerName !== key) patch[editingServerName] = null;
      await patchMcp(patch);
      setModalOpen(false);
      resetForm();
      showToast(t('settings.saved'), 'success');
      void refreshConnectivity();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function deleteServer(serverName: string) {
    try {
      setDeletingName(serverName);
      await patchMcp({ [serverName]: null });
      showToast(t('settings.mcp.deleted'), 'success');
      void refreshConnectivity();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    } finally {
      setDeletingName(null);
    }
  }

  async function confirmPendingDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await deleteServer(target.name);
  }

  return (
    <div className="settings-tab-content active" data-tab="mcp">
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.mcp.title')}</h2>
        <p className="settings-hint">{t('settings.mcp.desc')}</p>
        <div className="mcp-top-actions">
          <button className="mcp-add-tile" onClick={openAddModal}>
            <span className="mcp-add-tile-plus">+</span>
            <span className="mcp-add-tile-text">{t('settings.mcp.clickAdd')}</span>
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.mcp.added')}</h2>
        {serverEntries.length === 0 ? (
          <div className="pin-empty">{t('settings.mcp.empty')}</div>
        ) : (
          <div className="mcp-server-list">
            {serverEntries.map(([serverName, server]) => {
              const isBuiltin = builtinServerNames.has(serverName);
              return (
              <div
                className="mcp-server-item"
                key={serverName}
                role={isBuiltin ? undefined : 'button'}
                tabIndex={isBuiltin ? -1 : 0}
                onClick={isBuiltin ? undefined : () => openEditModal(serverName, server)}
                onKeyDown={(ev) => {
                  if (isBuiltin) return;
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    openEditModal(serverName, server);
                  }
                }}
              >
                <div className="mcp-server-main">
                  <div className="mcp-server-head">
                    <span
                      className={`mcp-status-dot mcp-status-${healthByServer[serverName]?.status || 'checking'}`}
                      title={healthByServer[serverName]?.message || ''}
                    />
                    <span className="mcp-server-name">{serverName}</span>
                    <span className={`mcp-server-type${server.disabled ? ' disabled' : ''}`}>
                      {server.disabled ? t('settings.mcp.statusDisabled') : (server.type || 'stdio')}
                    </span>
                    {isBuiltin && (
                      <span className="mcp-server-type">{t('settings.mcp.builtinMcp')}</span>
                    )}
                  </div>
                </div>
                {!isBuiltin && (
                  <button
                    className="provider-item-action delete"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setPendingDelete({
                        name: serverName,
                        label: serverName,
                      });
                    }}
                    disabled={deletingName === serverName}
                    title={t('settings.mcp.delete')}
                  >
                    {deletingName === serverName ? '...' : 'x'}
                  </button>
                )}
              </div>
              );
            })}
          </div>
        )}
      </section>

      {pendingDelete && (
        <div
          className="agent-delete-overlay visible"
          onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
        >
          <div className="agent-delete-card">
            <div className="agent-delete-step">
              <h3 className="agent-delete-title">{t('settings.mcp.deleteTitle', { name: pendingDelete.label })}</h3>
              <p className="agent-delete-desc">{t('settings.mcp.deleteDesc')}</p>
              <div className="agent-delete-actions">
                <button className="agent-delete-cancel" onClick={() => setPendingDelete(null)}>
                  {t('settings.agent.deleteCancel')}
                </button>
                <button className="agent-delete-danger" onClick={confirmPendingDelete}>
                  {t('settings.agent.deleteNext')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div
          className="agent-delete-overlay visible"
          onClick={(e) => { if (e.target === e.currentTarget && !saving) setModalOpen(false); }}
        >
          <div className="mcp-modal-card">
            <div className="mcp-modal-head">
              <h3 className="mcp-modal-title">
                {editingServerName ? t('settings.mcp.editTitle') : t('settings.mcp.addTitle')}
              </h3>
              <button className="mcp-modal-close" onClick={() => setModalOpen(false)} disabled={saving}>x</button>
            </div>
            <div className="mcp-add-panel">
              <div className="settings-row">
                <div className="settings-field settings-field-half">
                  <label className="settings-field-label">{t('settings.mcp.name')}</label>
                  <input
                    className="settings-input"
                    value={name}
                    onChange={ev => setName(ev.target.value)}
                    placeholder={t('settings.mcp.namePlaceholder')}
                  />
                </div>
                <div className="settings-field settings-field-half">
                  <label className="settings-field-label">{t('settings.mcp.type')}</label>
                  <select className="settings-input" value={type} onChange={ev => setType(ev.target.value as McpServerType)}>
                    <option value="stdio">stdio</option>
                    <option value="sse">sse</option>
                    <option value="http">http</option>
                  </select>
                </div>
              </div>

              {type === 'stdio' ? (
                <>
                  <div className="settings-field">
                    <label className="settings-field-label">{t('settings.mcp.command')}</label>
                    <input
                      className="settings-input"
                      value={command}
                      onChange={ev => setCommand(ev.target.value)}
                      placeholder={t('settings.mcp.commandPlaceholder')}
                    />
                  </div>
                  <div className="settings-field">
                    <label className="settings-field-label">{t('settings.mcp.args')}</label>
                    <textarea
                      className="settings-textarea mcp-textarea"
                      value={args}
                      onChange={ev => setArgs(ev.target.value)}
                      placeholder={t('settings.mcp.argsPlaceholder')}
                    />
                  </div>
                  <div className="settings-field">
                    <label className="settings-field-label">{t('settings.mcp.env')}</label>
                    <textarea
                      className="settings-textarea mcp-textarea"
                      value={envText}
                      onChange={ev => setEnvText(ev.target.value)}
                      placeholder={'{"API_KEY":"..."}'}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="settings-field">
                    <label className="settings-field-label">{t('settings.mcp.url')}</label>
                    <input
                      className="settings-input"
                      value={url}
                      onChange={ev => setUrl(ev.target.value)}
                      placeholder="https://example.com/mcp"
                    />
                  </div>
                  <div className="settings-field">
                    <label className="settings-field-label">{t('settings.mcp.headers')}</label>
                    <textarea
                      className="settings-textarea mcp-textarea"
                      value={headersText}
                      onChange={ev => setHeadersText(ev.target.value)}
                      placeholder={'{"Authorization":"Bearer ..."}'}
                    />
                  </div>
                </>
              )}

              <div className="mcp-form-footer">
                <button className="agent-delete-cancel" onClick={() => setModalOpen(false)} disabled={saving}>
                  {t('settings.agent.deleteCancel')}
                </button>
                <button className="settings-save-btn-sm mcp-add-btn" onClick={addServer} disabled={saving}>
                  {saving ? '...' : (editingServerName ? t('settings.mcp.update') : t('settings.mcp.add'))}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
