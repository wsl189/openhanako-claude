import React, { useMemo, useState } from 'react';
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
const MANAGED_EXTERNAL_MCP_TOOLS: Array<{
  name: string;
  serverName: string;
  prefix: string;
  labelKey: string;
  label?: string;
}> = [
  {
    name: 'claude_in_chrome',
    serverName: 'claude_in_chrome',
    prefix: 'mcp__claude_in_chrome__*',
    labelKey: 'toolDef.claudeInChrome.label',
  },
  {
    name: 'minimax_mcp_web_search',
    serverName: 'MiniMax',
    prefix: 'mcp__MiniMax__web_search',
    labelKey: 'toolDef.minimaxMcpWebSearch.label',
  },
  {
    name: 'minimax_mcp_understand_image',
    serverName: 'MiniMax',
    prefix: 'mcp__MiniMax__understand_image',
    labelKey: 'toolDef.minimaxMcpUnderstandImage.label',
  },
];

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

function serverSummary(server: ExternalMcpServer): string {
  const type = server.type || (server.url ? 'sse' : 'stdio');
  if (type === 'stdio') {
    const args = Array.isArray(server.args) && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
    return `${server.command || ''}${args}`.trim();
  }
  return server.url || '';
}

export function McpTab() {
  const store = useSettingsStore();
  const { settingsConfig, showToast } = store;
  const servers = useMemo(() => {
    const raw = settingsConfig?.mcp?.external_servers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, ExternalMcpServer>;
  }, [settingsConfig]);
  const serverEntries = Object.entries(servers)
    .filter(([, value]) => value && typeof value === 'object')
    .sort(([a], [b]) => a.localeCompare(b));
  const toolCatalogCustom = Array.isArray(settingsConfig?._toolCatalog?.custom)
    ? settingsConfig._toolCatalog.custom.map(String)
    : [];
  const customEnabled: string[] = Array.isArray(settingsConfig?.tools?.custom_enabled)
    ? settingsConfig.tools.custom_enabled.map(String)
    : [];
  const managedMcpEntries = MANAGED_EXTERNAL_MCP_TOOLS
    .filter(tool => toolCatalogCustom.includes(tool.name) && customEnabled.includes(tool.name));

  const [name, setName] = useState('');
  const [type, setType] = useState<McpServerType>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    kind: 'external' | 'managed';
    name: string;
    label: string;
  } | null>(null);

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

  async function patchAgentConfig(partial: Record<string, any>) {
    const agentId = store.getSettingsAgentId();
    if (!agentId) throw new Error('agent not found');
    const res = await hanaFetch(`/api/agents/${agentId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
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
      await patchMcp({ [key]: next });
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      setEnvText('');
      setHeadersText('');
      showToast(t('settings.saved'), 'success');
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
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    } finally {
      setDeletingName(null);
    }
  }

  async function deleteManagedServer(toolName: string) {
    try {
      setDeletingName(toolName);
      const nextCustomEnabled = customEnabled.filter((name: string) => name !== toolName);
      await patchAgentConfig({ tools: { custom_enabled: nextCustomEnabled } });
      showToast(t('settings.mcp.deleted'), 'success');
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
    if (target.kind === 'managed') {
      await deleteManagedServer(target.name);
    } else {
      await deleteServer(target.name);
    }
  }

  return (
    <div className="settings-tab-content active" data-tab="mcp">
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.mcp.title')}</h2>
        <p className="settings-hint">{t('settings.mcp.desc')}</p>

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
            <button className="settings-save-btn-sm mcp-add-btn" onClick={addServer} disabled={saving}>
              {saving ? '...' : t('settings.mcp.add')}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.mcp.added')}</h2>
        {managedMcpEntries.length + serverEntries.length === 0 ? (
          <div className="pin-empty">{t('settings.mcp.empty')}</div>
        ) : (
          <div className="mcp-server-list">
            {managedMcpEntries.map((tool) => {
              const label = tool.label || t(tool.labelKey);
              return (
                <div className="mcp-server-item" key={`managed-${tool.name}`}>
                  <div className="mcp-server-main">
                    <div className="mcp-server-head">
                      <span className="mcp-server-name">{label === tool.labelKey ? tool.serverName : label}</span>
                      <span className="mcp-server-type builtin">
                        {t('settings.mcp.builtinMcp')}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {serverEntries.map(([serverName, server]) => (
              <div className="mcp-server-item" key={serverName}>
                <div className="mcp-server-main">
                  <div className="mcp-server-head">
                    <span className="mcp-server-name">{serverName}</span>
                    <span className={`mcp-server-type${server.disabled ? ' disabled' : ''}`}>
                      {server.disabled ? t('settings.mcp.statusDisabled') : (server.type || 'stdio')}
                    </span>
                  </div>
                </div>
                <button
                  className="provider-item-action delete"
                  onClick={() => setPendingDelete({
                    kind: 'external',
                    name: serverName,
                    label: serverName,
                  })}
                  disabled={deletingName === serverName}
                  title={t('settings.mcp.delete')}
                >
                  {deletingName === serverName ? '...' : 'x'}
                </button>
              </div>
            ))}
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
    </div>
  );
}
