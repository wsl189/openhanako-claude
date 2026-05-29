import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch, hanaUrl, yuanFallbackAvatar } from '../api';
import {
  t,
  autoSaveConfig,
  addPinnedMark,
  updatePinnedMark,
  archivePinnedMark,
  normalizeModelRef,
  resolveProviderForModel,
} from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { browseAgent, loadSettingsConfig, loadAgents } from '../actions';
import { formatSessionDate } from '../../utils/format';

import kongBannerUrl from '../../../assets/kong-banner.jpg';

const platform = (window as any).platform;
const REQUIRED_BUILTINS: string[] = [];
const OPTIONAL_BUILTINS = [
  'Task',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListMcpResourcesTool',
  'NotebookEdit',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'Write',
];
const AGENT_CARD_NAME_MAX_UNITS = 4;
const HEARTBEAT_MINUTES_MIN = 1;
const HEARTBEAT_MINUTES_MAX = 120;
const BUILTIN_CLAUDE_DISPLAY_NAMES: Record<string, string> = {
  Task: 'Task',
  AskUserQuestion: 'AskUserQuestion',
  Bash: 'Bash',
  Edit: 'Edit',
  EnterPlanMode: 'EnterPlanMode',
  EnterWorktree: 'EnterWorktree',
  ExitPlanMode: 'ExitPlanMode',
  ExitWorktree: 'ExitWorktree',
  Glob: 'Glob',
  Grep: 'Grep',
  ListMcpResourcesTool: 'ListMcpResourcesTool',
  NotebookEdit: 'NotebookEdit',
  Read: 'Read',
  ReadMcpResourceTool: 'ReadMcpResourceTool',
  RemoteTrigger: 'RemoteTrigger',
  Skill: 'Skill',
  TaskOutput: 'TaskOutput',
  TaskStop: 'TaskStop',
  TodoWrite: 'TodoWrite',
  WebFetch: 'WebFetch',
  Write: 'Write',
  read: 'Read',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Glob',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
};
const BUILTIN_TOOL_HINT_KEYS: Record<string, string> = {
  read: 'settings.agent.builtinReadLabel',
  grep: 'settings.agent.builtinGrepLabel',
  find: 'settings.agent.builtinFindLabel',
  ls: 'settings.agent.builtinLsLabel',
  write: 'settings.agent.builtinWriteLabel',
  edit: 'settings.agent.builtinEditLabel',
  bash: 'settings.agent.builtinBashLabel',
};
const BUILTIN_TOOL_DESC_KEYS: Record<string, string> = {
  Task: 'settings.agent.builtinTaskDesc',
  AskUserQuestion: 'settings.agent.builtinAskUserQuestionDesc',
  Bash: 'settings.agent.builtinBashDesc',
  Edit: 'settings.agent.builtinEditDesc',
  EnterPlanMode: 'settings.agent.builtinEnterPlanModeDesc',
  EnterWorktree: 'settings.agent.builtinEnterWorktreeDesc',
  ExitPlanMode: 'settings.agent.builtinExitPlanModeDesc',
  ExitWorktree: 'settings.agent.builtinExitWorktreeDesc',
  Glob: 'settings.agent.builtinFindDesc',
  Grep: 'settings.agent.builtinGrepDesc',
  ListMcpResourcesTool: 'settings.agent.builtinListMcpResourcesDesc',
  NotebookEdit: 'settings.agent.builtinNotebookEditDesc',
  Read: 'settings.agent.builtinReadDesc',
  ReadMcpResourceTool: 'settings.agent.builtinReadMcpResourceDesc',
  RemoteTrigger: 'settings.agent.builtinRemoteTriggerDesc',
  Skill: 'settings.agent.builtinSkillDesc',
  TaskOutput: 'settings.agent.builtinTaskOutputDesc',
  TaskStop: 'settings.agent.builtinTaskStopDesc',
  TodoWrite: 'settings.agent.builtinTodoWriteDesc',
  WebFetch: 'settings.agent.builtinWebFetchDesc',
  Write: 'settings.agent.builtinWriteDesc',
  read: 'settings.agent.builtinReadDesc',
  grep: 'settings.agent.builtinGrepDesc',
  find: 'settings.agent.builtinFindDesc',
  ls: 'settings.agent.builtinLsDesc',
  write: 'settings.agent.builtinWriteDesc',
  edit: 'settings.agent.builtinEditDesc',
  bash: 'settings.agent.builtinBashDesc',
};
const CUSTOM_TOOL_HINT_KEYS: Record<string, string> = {
  browser: 'toolDef.browser.label',
  search_memory: 'error.memorySearchLabel',
  pin_memory: 'toolDef.pinnedMemory.pinLabel',
  unpin_memory: 'toolDef.pinnedMemory.unpinLabel',
  recall_experience: 'toolDef.experience.recallLabel',
  record_experience: 'toolDef.experience.recordLabel',
  setup_settings: 'toolDef.setupSettings.label',
  cron: 'toolDef.cron.label',
  notify: 'toolDef.notify.label',
  present_files: 'toolDef.outputFile.label',
  create_artifact: 'toolDef.artifact.label',
  channel: 'toolDef.channel.label',
  ask_agent: 'toolDef.askAgent.label',
  describe_images: 'toolDef.describeImages.label',
  generate_images: 'toolDef.generateImages.label',
  pdf2md: 'toolDef.pdf2md.label',
};
const CUSTOM_TOOL_DESC_KEYS: Record<string, string> = {
  browser: 'toolDef.browser.description',
  search_memory: 'error.memorySearchDesc',
  pin_memory: 'toolDef.pinnedMemory.pinDescription',
  unpin_memory: 'toolDef.pinnedMemory.unpinDescription',
  recall_experience: 'toolDef.experience.recallDescription',
  record_experience: 'toolDef.experience.recordDescription',
  setup_settings: 'toolDef.setupSettings.description',
  cron: 'toolDef.cron.description',
  notify: 'toolDef.notify.description',
  present_files: 'toolDef.outputFile.description',
  create_artifact: 'toolDef.artifact.description',
  channel: 'toolDef.channel.description',
  ask_agent: 'toolDef.askAgent.description',
  describe_images: 'toolDef.describeImages.description',
  generate_images: 'toolDef.generateImages.description',
  pdf2md: 'toolDef.pdf2md.description',
};
const HIDDEN_CUSTOM_TOOL_NAMES = new Set([
  'minimax_mcp_web_search',
  'minimax_mcp_understand_image',
]);

function getBuiltinDisplayName(name: string): string {
  return BUILTIN_CLAUDE_DISPLAY_NAMES[name] || name;
}

function normalizeBuiltinName(name: string): string {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (OPTIONAL_BUILTINS.includes(raw) || REQUIRED_BUILTINS.includes(raw)) return raw;
  return BUILTIN_CLAUDE_DISPLAY_NAMES[raw] || raw;
}

interface ArchivedSession {
  path: string;
  title: string | null;
  firstMessage: string;
  modified: string | null;
  messageCount: number;
  cwd: string | null;
  agentId: string;
}

function truncateAgentCardName(name: string, maxUnits = AGENT_CARD_NAME_MAX_UNITS): string {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const chars = Array.from(raw);
  let units = 0;
  let cut = chars.length;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const w = /^[\u0000-\u007F]$/.test(ch) ? 0.5 : 1;
    if (units + w > maxUnits) {
      cut = i;
      break;
    }
    units += w;
  }
  return cut < chars.length ? `${chars.slice(0, cut).join('')}...` : raw;
}

export function AgentTab() {
  const store = useSettingsStore();
  const {
    agents, currentAgentId, settingsConfig, currentPins,
    pendingFavorites, pendingDefaultModel, showToast,
    globalModelsConfig, memoryStatus, memorySummary,
  } = store;

  // 记忆系统需要 utility 模型才能工作
  const hasUtilityModel = !!globalModelsConfig?.models?.utility;
  const settingsAgentId = store.getSettingsAgentId();
  const selectedAgentId = store.settingsAgentId;

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [ishiki, setIshiki] = useState('');
  const [agentWorkspace, setAgentWorkspace] = useState('');
  const [builtinEnabled, setBuiltinEnabled] = useState<string[]>([...REQUIRED_BUILTINS, ...OPTIONAL_BUILTINS]);
  const [customEnabled, setCustomEnabled] = useState<string[]>([]);
  const [builtinExpanded, setBuiltinExpanded] = useState(false);
  const [externalMcpExpanded, setExternalMcpExpanded] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSession[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedBusyPath, setArchivedBusyPath] = useState<string | null>(null);
  const [hbIntervalInput, setHbIntervalInput] = useState('17');
  const hbIntervalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toolCatalog = (() => {
    const raw = settingsConfig?._toolCatalog || {};
    const builtinRequired = Array.isArray(raw.builtin_required) ? raw.builtin_required.map(String) : REQUIRED_BUILTINS;
    const builtinOptional = Array.isArray(raw.builtin_optional) ? raw.builtin_optional.map(String) : OPTIONAL_BUILTINS;
    const custom = Array.isArray(raw.custom) ? raw.custom.map(String) : [];
    return { builtinRequired, builtinOptional, custom };
  })();
  const visibleCustomTools = toolCatalog.custom.filter((name: string) => !HIDDEN_CUSTOM_TOOL_NAMES.has(name));
  const externalMcpServers = (() => {
    const raw = settingsConfig?.mcp?.external_servers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {} as Record<string, any>;
    return raw as Record<string, any>;
  })();
  const externalMcpEntries = Object.entries(externalMcpServers)
    .filter(([, server]) => server && typeof server === 'object')
    .sort(([a], [b]) => a.localeCompare(b));
  const disabledExternalMcpServers = new Set<string>(
    Array.isArray(settingsConfig?.mcp?.disabled_servers)
      ? settingsConfig.mcp.disabled_servers.map((name: string) => String(name || '').trim()).filter(Boolean)
      : [],
  );
  const mergedBuiltinToolCount = toolCatalog.builtinRequired.length
    + toolCatalog.builtinOptional.length
    + visibleCustomTools.length;

  useEffect(() => {
    if (settingsConfig) {
      setAgentName(settingsConfig.agent?.name || '');
      setIdentity(settingsConfig._identity || '');
      setIshiki(settingsConfig._ishiki || '');
      setAgentWorkspace(settingsConfig.desk?.home_folder || '');
      const cfgBuiltin = Array.isArray(settingsConfig.tools?.builtin_enabled)
        ? settingsConfig.tools.builtin_enabled.map((name: string) => normalizeBuiltinName(String(name)))
        : [...toolCatalog.builtinRequired, ...toolCatalog.builtinOptional];
      const nextBuiltin = Array.from(new Set([
        ...toolCatalog.builtinRequired,
        ...cfgBuiltin.filter((n: string) => toolCatalog.builtinOptional.includes(n)),
      ]));
      setBuiltinEnabled(nextBuiltin);
      const cfgCustom = Array.isArray(settingsConfig.tools?.custom_enabled)
        ? settingsConfig.tools.custom_enabled.map(String)
        : [...toolCatalog.custom];
      setCustomEnabled(cfgCustom.filter((n: string) => toolCatalog.custom.includes(n)));
      setHbIntervalInput(String(settingsConfig.desk?.heartbeat_interval ?? 17));
    }
  }, [settingsConfig]);

  useEffect(() => {
    return () => {
      if (hbIntervalSaveTimerRef.current) clearTimeout(hbIntervalSaveTimerRef.current);
    };
  }, []);

  const normalizeHeartbeatInterval = (value: string | number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 17;
    return Math.max(HEARTBEAT_MINUTES_MIN, Math.min(HEARTBEAT_MINUTES_MAX, Math.floor(parsed)));
  };

  const saveHeartbeatInterval = async (raw: string | number) => {
    const interval = normalizeHeartbeatInterval(raw);
    setHbIntervalInput(String(interval));
    await autoSaveConfig({ desk: { heartbeat_interval: interval } }, { silent: true });
  };

  const queueHeartbeatIntervalAutoSave = (nextValue: string) => {
    if (hbIntervalSaveTimerRef.current) clearTimeout(hbIntervalSaveTimerRef.current);
    if (!nextValue) return;
    hbIntervalSaveTimerRef.current = setTimeout(() => {
      void saveHeartbeatInterval(nextValue);
    }, 450);
  };

  const getToolHint = (name: string, group: 'builtin' | 'custom') => {
    const descKey = group === 'builtin' ? BUILTIN_TOOL_DESC_KEYS[name] : CUSTOM_TOOL_DESC_KEYS[name];
    const displayName = group === 'builtin' ? getBuiltinDisplayName(name) : name;
    if (descKey) {
      const resolvedDesc = t(descKey);
      if (resolvedDesc !== descKey) {
        return group === 'builtin' && displayName !== name
          ? `${displayName} · ${resolvedDesc}`
          : resolvedDesc;
      }
    }
    const labelKey = group === 'builtin' ? BUILTIN_TOOL_HINT_KEYS[name] : CUSTOM_TOOL_HINT_KEYS[name];
    if (labelKey) {
      const resolvedLabel = t(labelKey);
      if (resolvedLabel !== labelKey) {
        return group === 'builtin' && displayName !== name
          ? `${displayName} · ${resolvedLabel}`
          : resolvedLabel;
      }
    }
    const fallback = t('settings.agent.toolDescFallback');
    if (fallback === 'settings.agent.toolDescFallback') return displayName;
    return group === 'builtin' && displayName !== name
      ? `${displayName} · ${fallback}`
      : fallback;
  };

  // 仅在“明确选中了其他助手”时，才显示删除等仅针对非当前助手的操作。
  const currentYuan = settingsConfig?.agent?.yuan || 'hanako';

  // Agent 对话模型
  const currentModel = normalizeModelRef(settingsConfig?.models?.chat) || pendingDefaultModel || '';
  const favoriteModelIds = [...pendingFavorites]
    .map((mid) => normalizeModelRef(mid))
    .filter(Boolean);
  const modelOptions = favoriteModelIds.map(mid => ({ value: mid, label: mid }));
  if (currentModel && !favoriteModelIds.includes(currentModel)) {
    modelOptions.unshift({ value: currentModel, label: currentModel });
  }

  const memoryEnabled = settingsConfig?.memory?.enabled !== false;
  const needsUtilityModel = memoryStatus?.needsUtilityModel ?? !hasUtilityModel;
  const addPin = async () => {
    const val = pinInput.trim();
    if (!val) return;
    try {
      await addPinnedMark(val);
      setPinInput('');
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const pickAgentWorkspace = async () => {
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    setAgentWorkspace(folder);
    await autoSaveConfig({ desk: { home_folder: folder } });
    const agentId = store.getSettingsAgentId();
    if (agentId === currentAgentId) {
      platform?.settingsChanged?.('agent-updated', { agentId, homeFolder: folder });
    }
  };

  const clearAgentWorkspace = async () => {
    setAgentWorkspace('');
    await autoSaveConfig({ desk: { home_folder: '' } });
    const agentId = store.getSettingsAgentId();
    if (agentId === currentAgentId) {
      platform?.settingsChanged?.('agent-updated', { agentId, homeFolder: '' });
    }
  };

  const setBuiltinEnabledAndSave = async (name: string, enabled: boolean) => {
    if (toolCatalog.builtinRequired.includes(name)) return;
    const optionalSelected = builtinEnabled.filter(n => toolCatalog.builtinOptional.includes(n));
    const nextOptional = enabled
      ? Array.from(new Set([...optionalSelected, name]))
      : optionalSelected.filter(n => n !== name);
    const next = Array.from(new Set([...toolCatalog.builtinRequired, ...nextOptional]));
    setBuiltinEnabled(next);
    await autoSaveConfig({ tools: { builtin_enabled: next } }, { silent: true });
  };

  const setAllMergedBuiltinEnabledAndSave = async (enabled: boolean) => {
    const nextBuiltin = enabled
      ? Array.from(new Set([...toolCatalog.builtinRequired, ...toolCatalog.builtinOptional]))
      : [...toolCatalog.builtinRequired];
    const nextCustom = enabled
      ? Array.from(new Set([...customEnabled, ...visibleCustomTools]))
      : customEnabled.filter(name => !visibleCustomTools.includes(name));
    setBuiltinEnabled(nextBuiltin);
    setCustomEnabled(nextCustom);
    await autoSaveConfig({
      tools: {
        builtin_enabled: nextBuiltin,
        custom_enabled: nextCustom,
      },
    }, { silent: true });
  };

  const setCustomEnabledAndSave = async (name: string, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...customEnabled, name]))
      : customEnabled.filter(n => n !== name);
    setCustomEnabled(next);
    await autoSaveConfig({ tools: { custom_enabled: next } }, { silent: true });
  };

  const setAllExternalMcpEnabledAndSave = async (enabled: boolean) => {
    const externalNames = externalMcpEntries.map(([name]) => name);
    const nextDisabled = new Set<string>(Array.from(disabledExternalMcpServers));
    for (const name of externalNames) {
      if (enabled) nextDisabled.delete(name);
      else nextDisabled.add(name);
    }
    await autoSaveConfig({
      mcp: { disabled_servers: Array.from(nextDisabled).sort((a, b) => a.localeCompare(b)) },
    }, { silent: true });
  };

  const setExternalMcpEnabledAndSave = async (name: string, enabled: boolean) => {
    const nextDisabled = new Set<string>(Array.from(disabledExternalMcpServers));
    if (enabled) nextDisabled.delete(name);
    else nextDisabled.add(name);
    await autoSaveConfig({
      mcp: { disabled_servers: Array.from(nextDisabled).sort((a, b) => a.localeCompare(b)) },
    }, { silent: true });
  };

  const savePin = async (id: string, patch: { text: string }) => {
    try {
      await updatePinnedMark(id, patch);
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
      throw err;
    }
  };

  const deletePin = async (id: string) => {
    try {
      await archivePinnedMark(id);
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
      throw err;
    }
  };

  const saveAgent = async () => {
    try {
      const agentId = store.getSettingsAgentId()!;
      const agentBase = `/api/agents/${agentId}`;
      const isActive = agentId === currentAgentId;

      const configPartial: Record<string, any> = {};
      if (agentName && agentName !== (settingsConfig?.agent?.name || '')) {
        configPartial.agent = { name: agentName };
      }

      const identityChanged = identity !== (settingsConfig?._identity || '');
      const ishikiChanged = ishiki !== (settingsConfig?._ishiki || '');

      if (!Object.keys(configPartial).length && !identityChanged && !ishikiChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const requests: Promise<Response>[] = [];
      if (Object.keys(configPartial).length) {
        requests.push(hanaFetch(`${agentBase}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configPartial),
        }));
      }
      if (identityChanged) {
        requests.push(hanaFetch(`${agentBase}/identity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: identity }),
        }));
      }
      if (ishikiChanged) {
        requests.push(hanaFetch(`${agentBase}/ishiki`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: ishiki }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      if (isActive && configPartial?.agent?.name) {
        store.set({ agentName: configPartial.agent.name });
        platform?.settingsChanged?.('agent-updated', {
          agentName: configPartial.agent.name,
          agentId,
        });
      }
      await loadSettingsConfig();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const loadArchivedSessionsForAgent = async (agentId?: string | null) => {
    const targetAgentId = (agentId || store.getSettingsAgentId() || '').trim();
    if (!targetAgentId) {
      setArchivedSessions([]);
      return;
    }
    setArchivedLoading(true);
    try {
      const res = await hanaFetch(`/api/sessions/archived?agentId=${encodeURIComponent(targetAgentId)}`);
      const data = await res.json();
      setArchivedSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setArchivedSessions([]);
    } finally {
      setArchivedLoading(false);
    }
  };

  useEffect(() => {
    void loadArchivedSessionsForAgent(settingsAgentId);
  }, [settingsAgentId, currentAgentId]);

  useEffect(() => {
    const onSessionsChanged = (evt: Event) => {
      const payload = (evt as CustomEvent<any>)?.detail || {};
      const changedAgentId = String(payload.agentId || '').trim();
      if (changedAgentId && settingsAgentId && changedAgentId !== settingsAgentId) return;
      if (payload.kind === 'delete-archived' && payload.path) {
        setArchivedSessions((prev) => prev.filter((session) => session.path !== payload.path));
        return;
      }
      void loadSettingsConfig();
      void loadArchivedSessionsForAgent(settingsAgentId);
    };
    window.addEventListener('hana-sessions-changed', onSessionsChanged as EventListener);
    return () => {
      window.removeEventListener('hana-sessions-changed', onSessionsChanged as EventListener);
    };
  }, [settingsAgentId]);

  const restoreArchivedSession = async (sessionPath: string) => {
    setArchivedBusyPath(sessionPath);
    try {
      const restoreRes = await hanaFetch('/api/sessions/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sessionPath }),
      });
      const restoreData = await restoreRes.json();
      if (restoreData.error || !restoreData.path) {
        throw new Error(restoreData.error || 'restore failed');
      }

      const switchRes = await hanaFetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: restoreData.path }),
      });
      const switchData = await switchRes.json();
      if (switchData.error) {
        throw new Error(switchData.error);
      }

      platform?.settingsChanged?.('sessions-changed', {
        kind: 'restore',
        agentId: settingsAgentId || '',
        path: sessionPath,
        switchPath: restoreData.path,
      });
      showToast(t('settings.archivedSessions.restoreSuccess'), 'success');
      await loadArchivedSessionsForAgent(settingsAgentId);
    } catch (err: any) {
      showToast(`${t('settings.archivedSessions.restoreFailed')}: ${err.message}`, 'error');
    } finally {
      setArchivedBusyPath(null);
    }
  };

  const deleteArchivedSession = async (sessionPath: string) => {
    setArchivedBusyPath(sessionPath);
    try {
      const res = await hanaFetch('/api/sessions/delete-archived', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sessionPath }),
      });
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      platform?.settingsChanged?.('sessions-changed', {
        kind: 'delete-archived',
        agentId: settingsAgentId || '',
        path: sessionPath,
      });
      setArchivedSessions((prev) => prev.filter((session) => session.path !== sessionPath));
      showToast(t('settings.archivedSessions.deleteSuccess'), 'success');
    } catch (err: any) {
      showToast(`${t('settings.archivedSessions.deleteFailed')}: ${err.message}`, 'error');
    } finally {
      setArchivedBusyPath(null);
    }
  };

  const allBuiltinEnabled = toolCatalog.builtinOptional.every((name: string) => builtinEnabled.includes(name));
  const allMergedBuiltinEnabled = allBuiltinEnabled
    && visibleCustomTools.every((name: string) => customEnabled.includes(name));
  const allExternalMcpEnabled = externalMcpEntries.length > 0
    && externalMcpEntries.every(([name, server]) => !disabledExternalMcpServers.has(name)
      && server.disabled !== true
      && server.enabled !== false);

  return (
    <div className="settings-tab-content active" data-tab="agent">
      {/* Agent 卡片堆叠 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.agent.title')}</h2>
        <AgentCardStack
          agents={agents}
          selectedId={selectedAgentId}
          currentAgentId={currentAgentId}
          onSelect={(id) => browseAgent(id)}
          onAvatarClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp';
            input.addEventListener('change', () => {
              if (input.files?.[0]) {
                window.dispatchEvent(new CustomEvent('hana-open-cropper', {
                  detail: { role: 'agent', file: input.files[0] },
                }));
              }
            });
            input.click();
          }}
        >
          <div className="agent-stack-actions">
            <button
              className="agent-add-btn"
              title={t('settings.agent.addAgent')}
              onClick={() => window.dispatchEvent(new Event('hana-show-agent-create'))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            {agents.length >= 2 && !!selectedAgentId && (
              <button
                className="agent-delete-btn"
                title={t('settings.agent.deleteBtn')}
                onClick={() => window.dispatchEvent(new Event('hana-show-agent-delete'))}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </div>
        </AgentCardStack>

        <div className="settings-field settings-field-center">
          <span className="settings-field-hint">{t('settings.agent.agentNameHint')}</span>
          <input
            className="settings-input"
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          />
        </div>
      </section>

      {/* 关于 Ta */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.about.title')}</h2>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.yuan')}</label>
          <span className="settings-field-hint">{t('settings.agent.yuanHint')}</span>
          <YuanSelector
            currentYuan={currentYuan}
            onChange={async (key) => {
              const agentId = store.getSettingsAgentId()!;
              try {
                await hanaFetch(`/api/agents/${agentId}/config`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ agent: { yuan: key } }),
                });
                if (agentId === currentAgentId) store.set({ agentYuan: key });
                platform?.settingsChanged?.('agent-updated', { agentId, yuan: key });
                await loadSettingsConfig();
                await loadAgents();
              } catch (err) {
                console.error('[yuan] switch failed:', err);
              }
            }}
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.identity')}</label>
          <textarea
            className="settings-textarea"
            rows={3}
            spellCheck={false}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <span className="settings-field-hint">{t('settings.agent.identityHint')}</span>
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.ishiki')}</label>
          <textarea
            className="settings-textarea"
            rows={10}
            spellCheck={false}
            value={ishiki}
            onChange={(e) => setIshiki(e.target.value)}
          />
          <span className="settings-field-hint">{t('settings.agent.ishikiHint')}</span>
        </div>
        <div className="agent-basic-divider">
          <span>{t('settings.agent.basicConfig')}</span>
        </div>
        <div className="settings-row agent-basic-row">
          <div className="settings-field settings-field-half">
            <label className="settings-field-label">{t('settings.agent.chatModel')}</label>
            <SelectWidget
              options={modelOptions}
              value={currentModel}
              onChange={async (modelId) => {
                store.set({ pendingDefaultModel: modelId });
                const partial: Record<string, any> = { models: { chat: modelId } };
                const provider = resolveProviderForModel(modelId);
                if (provider) partial.api = { provider };
                await autoSaveConfig(partial, { refreshModels: true });
              }}
              placeholder={t('settings.api.selectModel')}
            />
            <span className="settings-field-hint">{t('settings.agent.chatModelHint')}</span>
          </div>
          <div className="settings-field agent-heartbeat-field">
            <label className="settings-field-label">{t('settings.work.heartbeatInterval')}</label>
            <div className="settings-input-group">
              <input
                type="number"
                className="settings-input small"
                min={HEARTBEAT_MINUTES_MIN}
                max={HEARTBEAT_MINUTES_MAX}
                value={hbIntervalInput}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === '' || /^\d+$/.test(next)) {
                    setHbIntervalInput(next);
                    queueHeartbeatIntervalAutoSave(next);
                  }
                }}
                onBlur={() => {
                  if (hbIntervalSaveTimerRef.current) clearTimeout(hbIntervalSaveTimerRef.current);
                  const fallback = settingsConfig?.desk?.heartbeat_interval ?? 17;
                  void saveHeartbeatInterval(hbIntervalInput || String(fallback));
                }}
              />
              <span className="settings-input-unit">{t('settings.work.heartbeatUnit')}</span>
            </div>
            <span className="settings-field-hint">{t('settings.work.heartbeatDesc')}</span>
          </div>
        </div>
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.agent.workspace')}</label>
          <span className="settings-field-hint">{t('settings.agent.workspaceHint')}</span>
          <div className="settings-folder-picker">
            <input
              type="text"
              className="settings-input settings-folder-input"
              readOnly
              value={agentWorkspace}
              placeholder={t('settings.agent.workspacePlaceholder')}
              onClick={pickAgentWorkspace}
            />
            <button className="settings-folder-browse" onClick={pickAgentWorkspace}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            {agentWorkspace && (
              <button
                className="settings-folder-clear"
                onClick={clearAgentWorkspace}
                title={t('settings.agent.workspaceClear')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <h3 className="settings-subsection-title">{t('settings.agent.toolsTitle')}</h3>
            <span className="settings-subsection-hint">{t('settings.agent.toolsHint')}</span>
          </div>
          <div className="agent-tool-block">
            <button
              className="agent-tool-collapse"
              onClick={() => {
                setBuiltinExpanded(v => !v);
              }}
            >
              <span className="settings-field-label">{t('settings.agent.builtinTools')}</span>
              <span className="agent-tool-collapse-meta">
                {builtinExpanded ? t('settings.agent.toolsCollapse') : t('settings.agent.toolsExpand')}
                {' · '}
                {mergedBuiltinToolCount}
              </span>
            </button>
            {builtinExpanded && (
              <div className="agent-tool-list">
                <div className="agent-tool-bulk-row">
                  <span className="agent-tool-bulk-label">{t('settings.agent.toolsSelectAll')}</span>
                  <button
                    className={`hana-toggle mini${allMergedBuiltinEnabled ? ' on' : ''}`}
                    onClick={() => setAllMergedBuiltinEnabledAndSave(!allMergedBuiltinEnabled)}
                    title={t('settings.agent.toolsSelectAll')}
                  />
                </div>
                {[...toolCatalog.builtinRequired, ...toolCatalog.builtinOptional].map((name) => {
                  const enabled = builtinEnabled.includes(name) || toolCatalog.builtinRequired.includes(name);
                  const locked = toolCatalog.builtinRequired.includes(name);
                  const displayName = getBuiltinDisplayName(name);
                  return (
                    <div
                      className="agent-tool-item"
                      key={name}
                    >
                      <div className="agent-tool-row">
                        <code>{displayName}</code>
                        <div
                          className="agent-tool-toggle-wrap"
                        >
                          <button
                            className={`hana-toggle mini${enabled ? ' on' : ''}${locked ? ' disabled' : ''}`}
                            onClick={() => !locked && setBuiltinEnabledAndSave(name, !enabled)}
                            disabled={locked}
                            title={locked ? t('settings.agent.builtinLocked') : undefined}
                          />
                          <div className="agent-tool-tooltip">
                            {getToolHint(name, 'builtin')}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {visibleCustomTools.map((name: string) => {
                  const enabled = customEnabled.includes(name);
                  return (
                    <div
                      className="agent-tool-item"
                      key={`custom:${name}`}
                    >
                      <div className="agent-tool-row">
                        <code>{name}</code>
                        <div
                          className="agent-tool-toggle-wrap"
                        >
                          <button
                            className={`hana-toggle mini${enabled ? ' on' : ''}`}
                            onClick={() => setCustomEnabledAndSave(name, !enabled)}
                          />
                          <div className="agent-tool-tooltip">
                            {getToolHint(name, 'custom')}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="agent-tool-block">
            <button
              className="agent-tool-collapse"
              onClick={() => {
                setExternalMcpExpanded(v => !v);
              }}
            >
              <span className="settings-field-label">{t('settings.agent.externalMcpTools')}</span>
                <span className="agent-tool-collapse-meta">
                  {externalMcpExpanded ? t('settings.agent.toolsCollapse') : t('settings.agent.toolsExpand')}
                  {' · '}
                  {externalMcpEntries.length}
                </span>
              </button>
            {externalMcpExpanded && (
              <div className="agent-tool-list">
                {externalMcpEntries.length === 0 ? (
                  <div className="pin-empty">{t('settings.agent.externalMcpEmpty')}</div>
                ) : (
                  <>
                  <div className="agent-tool-bulk-row">
                    <span className="agent-tool-bulk-label">{t('settings.agent.toolsSelectAll')}</span>
                    <button
                      className={`hana-toggle mini${allExternalMcpEnabled ? ' on' : ''}`}
                      onClick={() => setAllExternalMcpEnabledAndSave(!allExternalMcpEnabled)}
                      title={t('settings.agent.toolsSelectAll')}
                    />
                  </div>
                  {externalMcpEntries.map(([name, server]) => {
                    const enabled = !disabledExternalMcpServers.has(name)
                      && server.disabled !== true
                      && server.enabled !== false;
                    const type = server.type || (server.url ? 'sse' : 'stdio');
                    return (
                      <div
                        className="agent-tool-item"
                        key={name}
                      >
                        <div className="agent-tool-row">
                          <code>{name}</code>
                          <div
                            className="agent-tool-toggle-wrap"
                          >
                            <button
                              className={`hana-toggle mini${enabled ? ' on' : ''}`}
                              onClick={() => setExternalMcpEnabledAndSave(name, !enabled)}
                            />
                            <div className="agent-tool-tooltip">
                              {t('settings.agent.externalMcpHint').replace('{type}', type).replace('{prefix}', `mcp__${name}__*`)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── 记忆 ── */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.memory.sectionTitle')}</h2>

        <div className="settings-subsection">
          <div className="settings-section-header">
            <div className="memory-runtime-header">
              <h3 className="settings-subsection-title">{t('settings.memory.title')}</h3>
              <span className="memory-runtime-status">
                {memoryEnabled
                  ? t('settings.memory.runtimeEnabledHint')
                  : t('settings.memory.runtimeDisabledHint')}
              </span>
            </div>
            <button
              className={`hana-toggle${memoryEnabled ? ' on' : ''}`}
              onClick={() => autoSaveConfig({ memory: { enabled: !memoryEnabled } })}
            />
          </div>
          {needsUtilityModel && (
            <p className="settings-hint" style={{ opacity: 0.6, marginTop: 4 }}>{t('settings.memory.needsUtilityModel')}</p>
          )}
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <h3 className="settings-subsection-title">{t('settings.pins.title')}</h3>
            <span className="settings-subsection-hint">{t('settings.pins.hint')}</span>
          </div>
          <div className="pin-list">
            {currentPins.map((pin, index) => (
              <PinItem key={pin.id} index={index + 1} pin={pin} onSave={savePin} onDelete={deletePin} />
            ))}
          </div>
          <div className="pin-add-row">
            <input
              className="settings-input pin-add-input"
              type="text"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addPin(); } }}
              placeholder={t('settings.pins.addPlaceholder')}
            />
            <button className="pin-add-btn" onClick={() => { void addPin(); }}>+</button>
          </div>
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <h3 className="settings-subsection-title">{t('settings.memory.compiled')}</h3>
            <span className="settings-subsection-hint">{t('settings.memory.compiledHint')}</span>
          </div>
          <button
            className="memory-action-btn compiled-view-btn"
            onClick={() => window.dispatchEvent(new Event('hana-view-compiled-memory'))}
          >
            {t('settings.memory.compiledView')}
          </button>
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <h3 className="settings-subsection-title">{t('settings.memory.library')}</h3>
            <span className="settings-subsection-hint">{t('settings.memory.libraryHint')}</span>
          </div>
          <div className="memory-actions-row memory-actions-spaced">
            <button
              className="memory-action-btn"
              onClick={() => window.dispatchEvent(new Event('hana-view-memories'))}
            >
              {t('settings.memory.actions.view')}
            </button>
            <button
              className="memory-action-btn danger"
              onClick={() => window.dispatchEvent(new Event('hana-show-clear-confirm'))}
            >
              {t('settings.memory.actions.clear')}
            </button>
            <MemoryMoreDropdown />
          </div>
        </div>

      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.archivedSessions.sectionTitle')}</h2>
        {archivedLoading ? (
          <div className="pin-empty">{t('settings.archivedSessions.loading')}</div>
        ) : archivedSessions.length === 0 ? (
          <div className="pin-empty">{t('settings.archivedSessions.empty')}</div>
        ) : (
          <div className="archived-session-list">
            {archivedSessions.map((session) => {
              const workspaceText = session.cwd || t('settings.archivedSessions.workspaceEmpty');
              const meta = session.modified
                ? `${workspaceText} · ${formatSessionDate(session.modified)}`
                : workspaceText;
              const busy = archivedBusyPath === session.path;
              return (
                <div key={session.path} className="archived-session-item">
                  <div className="archived-session-content">
                    <div className="archived-session-title">
                      {session.title || session.firstMessage || t('session.untitled')}
                    </div>
                    <div className="archived-session-workspace" title={workspaceText}>{meta}</div>
                  </div>
                  <div className="archived-session-actions">
                    <button
                      className="archived-session-restore"
                      title={t('settings.archivedSessions.restoreTitle')}
                      aria-label={t('settings.archivedSessions.restoreTitle')}
                      disabled={busy}
                      onClick={() => restoreArchivedSession(session.path)}
                    >
                      ↩
                    </button>
                    <button
                      className="archived-session-delete"
                      title={t('settings.archivedSessions.deleteTitle')}
                      disabled={busy}
                      onClick={() => deleteArchivedSession(session.path)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="settings-section-footer">
        <button className="settings-save-btn-sm" onClick={saveAgent}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}

function PinItem({
  index,
  pin,
  onSave,
  onDelete,
}: {
  index: number;
  pin: { id: string; text: string };
  onSave: (id: string, patch: { text: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(pin.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setEditVal(pin.text);
  }, [pin.text]);

  const save = async () => {
    const val = editVal.trim();
    if (val && val !== pin.text) {
      await onSave(pin.id, { text: val });
    } else if (!val) {
      await onDelete(pin.id);
    }
    setEditing(false);
  };

  return (
    <div className="pin-item">
      {editing ? (
        <input
          ref={inputRef}
          className="settings-input pin-edit-input"
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={() => { void save(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="pin-item-text" title={pin.text}>
          {`${index}、${pin.text}`}
        </span>
      )}
      <div className="pin-item-actions">
        <button
          className="pin-item-action"
          title={t('settings.pins.edit')}
          onClick={() => {
            setEditVal(pin.text);
            setEditing(true);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
        </button>
        <button
          className="pin-item-action delete"
          title={t('toolDef.pinnedMemory.unpinLabel')}
          aria-label={t('toolDef.pinnedMemory.unpinLabel')}
          onClick={() => { void onDelete(pin.id); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function YuanSelector({ currentYuan, onChange }: { currentYuan: string; onChange: (key: string) => void }) {
  const types = t('yuan.types') || {};
  const entries = Object.entries(types) as [string, any][];
  const hIdx = entries.findIndex(([k]) => k === 'hanako');
  if (hIdx >= 0 && entries.length >= 3) {
    const [h] = entries.splice(hIdx, 1);
    entries.splice(1, 0, h);
  }

  const chips = entries.filter(([k]) => k !== 'kong');
  const kongMeta = (types as any).kong;

  return (
    <div className="yuan-selector">
      <div className="yuan-chips">
        {chips.map(([key, meta]) => (
          <button
            key={key}
            className={`yuan-chip${key === currentYuan ? ' selected' : ''}`}
            type="button"
            onClick={() => { if (key !== currentYuan) onChange(key); }}
          >
            <img
              className="yuan-chip-avatar"
              src={`assets/${meta.avatar || 'Hanako.png'}`}
              draggable={false}
            />
            <div className="yuan-chip-info">
              <span className="yuan-chip-name">{key}</span>
              <span className="yuan-chip-desc">{meta.label || ''}</span>
            </div>
          </button>
        ))}
      </div>
      {kongMeta && (
        <button
          className={`yuan-kong-banner${currentYuan === 'kong' ? ' selected' : ''}`}
          type="button"
          style={{ backgroundImage: `url(${kongBannerUrl})` }}
          onClick={() => { if (currentYuan !== 'kong') onChange('kong'); }}
        >
          <span className="yuan-kong-name">空</span>
          <span className="yuan-kong-desc">{kongMeta.label || ''}</span>
        </button>
      )}
    </div>
  );
}

function AgentCardStack({ agents, selectedId, currentAgentId, onSelect, onAvatarClick, children }: {
  agents: any[];
  selectedId: string | null;
  currentAgentId: string | null;
  onSelect: (id: string) => void;
  onAvatarClick: () => void;
  children?: React.ReactNode;
}) {
  const cardsRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const n = agents.length;
  const wrapLayout = n > 7;
  const stepTight = n > 1 ? Math.min(4, 16 / (n - 1)) : 0;
  const spreadStep = 62;
  const spreadOffset = -(n - 1) * spreadStep / 2;
  const spreadWidth = Math.max(240, (n - 1) * spreadStep + 72);
  const ts = Date.now();

  // 原生 DOM 事件挂载拖拽（完全绕过 React 合成事件）
  useEffect(() => {
    if (wrapLayout) return;
    const container = cardsRef.current;
    if (!container) return;

    const handlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];

    const cards = [...container.children] as HTMLElement[];
    cards.forEach((card, dragIdx) => {
      const handler = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!container.matches(':hover')) return;

        e.preventDefault();
        card.setPointerCapture(e.pointerId);

        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        let dropIdx = dragIdx;

        const allCards = [...container.children] as HTMLElement[];
        const positions = allCards.map(c => parseFloat(c.style.getPropertyValue('--tx-spread')) || 0);
        const origTx = positions[dragIdx];

        const onMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

          if (!moved) {
            moved = true;
            card.classList.add('dragging');
            card.dataset.wasDragged = '1';
          }

          card.style.transform = `rotate(0deg) translateX(${origTx + dx}px) translateY(-4px)`;

          const currentPos = origTx + dx;
          let newIdx = dragIdx;
          for (let j = 0; j < positions.length; j++) {
            if (j === dragIdx) continue;
            if (dragIdx < j && currentPos > positions[j] - 15) newIdx = j;
            if (dragIdx > j && currentPos < positions[j] + 15) newIdx = Math.min(newIdx, j);
          }

          allCards.forEach((c, ci) => {
            if (c === card) return;
            if (ci >= Math.min(dragIdx, newIdx) && ci <= Math.max(dragIdx, newIdx) && newIdx !== dragIdx) {
              const shift = dragIdx < newIdx ? -spreadStep : spreadStep;
              c.style.transform = `rotate(0deg) translateX(${positions[ci] + shift}px)`;
            } else {
              c.style.transform = `rotate(0deg) translateX(${positions[ci]}px)`;
            }
            c.style.transition = 'transform 0.2s var(--ease-out)';
          });

          dropIdx = newIdx;
        };

        const onUp = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.classList.remove('dragging');

          allCards.forEach(c => { c.style.transform = ''; c.style.transition = ''; });

          if (!moved) return;

          if (dropIdx !== dragIdx) {
            const currentAgents = agentsRef.current;
            const reordered = [...currentAgents];
            const [movedAgent] = reordered.splice(dragIdx, 1);
            reordered.splice(dropIdx, 0, movedAgent);
            useSettingsStore.setState({ agents: reordered });
            hanaFetch('/api/agents/order', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered.map(a => a.id) }),
            }).catch(err => {
              console.error('[agent-reorder] failed:', err);
              loadAgents();
            });
          }
        };

        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerup', onUp);
      };

      card.addEventListener('pointerdown', handler);
      handlers.push([card, handler]);
    });

    return () => {
      handlers.forEach(([el, fn]) => el.removeEventListener('pointerdown', fn));
    };
  }, [agents, spreadStep, wrapLayout]);

  return (
    <div
      className="agent-card-stack"
      style={{ '--cards-spread-width': spreadWidth } as React.CSSProperties}
    >
      <div className={`agent-cards${wrapLayout ? ' wrapped' : ''}`} ref={cardsRef}>
        {agents.map((agent, i) => {
          const rotTight = i * stepTight;
          const txSpread = spreadOffset + i * spreadStep;
          const z = n - i;
          const isSelected = agent.id === selectedId;
          const cardStyle = wrapLayout
            ? undefined
            : ({
                '--rot-tight': `${rotTight}deg`,
                '--tx-spread': `${txSpread}px`,
                '--z': z,
                zIndex: z,
              } as React.CSSProperties);

          return (
            <div
              key={agent.id}
              className={`agent-card${isSelected ? ' selected' : ''}`}
              data-agent-id={agent.id}
              data-index={i}
              style={cardStyle}
              onClick={(e) => {
                const card = e.currentTarget as HTMLElement;
                if (card.dataset.wasDragged) { delete card.dataset.wasDragged; return; }
                if (isSelected) onAvatarClick();
                else onSelect(agent.id);
              }}
            >
              <div className="agent-card-inner">
                <img
                  className="agent-card-avatar"
                  draggable={false}
                  src={hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`)}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = yuanFallbackAvatar(agent.yuan);
                  }}
                />
                {isSelected && (
                  <div className="agent-card-overlay">
                    <span>{t('settings.agent.changeAvatar')}</span>
                  </div>
                )}
              </div>
              <span className="agent-card-name" title={agent.name}>
                {truncateAgentCardName(agent.name)}
              </span>
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}

function MemoryMoreDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const store = useSettingsStore();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const exportMemories = async () => {
    setOpen(false);
    try {
      const aid = store.getSettingsAgentId();
      const res = await hanaFetch(`/api/memory/export?agentId=${aid}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hana-memories-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      store.showToast(t('settings.memory.actions.exportSuccess'), 'success');
    } catch (err: any) {
      store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const importMemories = async () => {
    setOpen(false);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        if (!json || typeof json !== 'object') {
          store.showToast(t('settings.memory.actions.invalidFile'), 'error');
          return;
        }
        store.showToast(t('settings.memory.actions.importing'), 'success');
        const aid = store.getSettingsAgentId();
        const res = await hanaFetch(`/api/memory/import?agentId=${aid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const importedCount = Number(data.importedFacts || 0)
          + Number(data.importedEvidence || 0)
          + Number(data.importedEpisodes || 0)
          + Number(data.importedPlaybooks || 0)
          + Number(data.importedMarks || 0)
          + (data.queuedProfileImport ? 1 : 0);
        const msg = t('settings.memory.actions.importSuccess').replace('{count}', String(importedCount));
        store.showToast(msg, 'success');
        await loadSettingsConfig();
        window.dispatchEvent(new Event('hana-memory-updated'));
      } catch (err: any) {
        store.showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
      }
    });
    input.click();
  };

  const openInsights = () => {
    setOpen(false);
    window.dispatchEvent(new Event('hana-view-memory-insights'));
  };

  return (
    <div className={`memory-action-dropdown${open ? ' open' : ''}`} ref={ref}>
      <button className="memory-action-btn secondary" onClick={() => setOpen(!open)}>
        <span>{t('settings.memory.actions.more')}</span>
        <svg className="memory-more-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className="memory-more-popup">
        <button className="memory-more-option" onClick={openInsights}>
          {t('settings.memory.actions.insights')}
        </button>
        <button className="memory-more-option" onClick={exportMemories}>
          {t('settings.memory.actions.export')}
        </button>
        <button
          className="memory-more-option"
          onClick={importMemories}
        >
          {t('settings.memory.actions.import')}
        </button>
      </div>
    </div>
  );
}
