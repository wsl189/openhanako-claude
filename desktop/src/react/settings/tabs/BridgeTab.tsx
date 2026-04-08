import React, { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { KeyInput } from '../widgets/KeyInput';
import { Toggle } from '../widgets/Toggle';

interface BridgeBotStatus {
  id: string;
  name: string;
  configured?: boolean;
  enabled?: boolean;
  status?: string;
  error?: string | null;
  tokenMasked?: string;
  appID?: string;
  appId?: string;
  appSecretMasked?: string;
  agentId?: string | null;
  agentName?: string | null;
}

interface BridgeStatus {
  telegram?: {
    bots?: BridgeBotStatus[];
  };
  feishu?: {
    bots?: BridgeBotStatus[];
  };
  qq?: {
    bots?: BridgeBotStatus[];
  };
}

type BridgePlatform = 'telegram' | 'feishu' | 'qq';

type CardResultTone = 'ok' | 'fail' | 'info';

interface CardResult {
  tone: CardResultTone;
  text: string;
}

interface BotDraft {
  id: string;
  name: string;
  appID: string;
  appSecret: string;
  appSecretMasked?: string;
  agentId: string;
  enabled: boolean;
}

interface AgentItem {
  id: string;
  name: string;
}

const PLATFORMS: BridgePlatform[] = ['telegram', 'feishu', 'qq'];

function makeCardKey(platform: BridgePlatform, botId: string) {
  return `${platform}:${botId || 'new'}`;
}

function BridgeStatusDot({ status }: { status?: string }) {
  let cls = 'bridge-status-dot';
  if (status === 'connected') cls += ' bridge-dot-ok';
  else if (status === 'error') cls += ' bridge-dot-err';
  else cls += ' bridge-dot-off';
  return <span className={cls} />;
}

function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: AgentItem[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = agents.find((a) => a.id === value) || agents[0];

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="bridge-agent-select" ref={rootRef}>
      <button
        type="button"
        className="bridge-agent-select-trigger"
        disabled={agents.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected?.name || 'No Agent'}</span>
        <span className="bridge-agent-select-caret">⌄</span>
      </button>
      {open && agents.length > 0 && (
        <div className="bridge-agent-select-menu">
          {agents.map((a) => (
            <button
              type="button"
              key={a.id}
              className={`bridge-agent-select-option${a.id === selected?.id ? ' selected' : ''}`}
              onClick={() => {
                onChange(a.id);
                setOpen(false);
              }}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BridgeTab() {
  const store = useSettingsStore();
  const { showToast } = store;
  const agents = (store.agents || []) as AgentItem[];

  const [tgBots, setTgBots] = useState<BridgeBotStatus[]>([]);
  const [fsBots, setFsBots] = useState<BridgeBotStatus[]>([]);
  const [qqBots, setQqBots] = useState<BridgeBotStatus[]>([]);

  const [newDrafts, setNewDrafts] = useState<Record<BridgePlatform, BotDraft | null>>({
    telegram: null,
    feishu: null,
    qq: null,
  });
  const [expandedIds, setExpandedIds] = useState<Record<BridgePlatform, string | null>>({
    telegram: null,
    feishu: null,
    qq: null,
  });
  const [editDrafts, setEditDrafts] = useState<Record<string, BotDraft>>({});
  const [cardResults, setCardResults] = useState<Record<string, CardResult | undefined>>({});
  const [cardSaving, setCardSaving] = useState<Record<string, boolean>>({});

  const platformName = (platform: BridgePlatform) => {
    if (platform === 'telegram') return t('settings.bridge.telegram');
    if (platform === 'feishu') return t('settings.bridge.feishu');
    return t('settings.bridge.qq');
  };

  const platformHint = (platform: BridgePlatform) => {
    if (platform === 'telegram') return t('settings.bridge.telegramHint');
    if (platform === 'feishu') return t('settings.bridge.feishuHint');
    return t('settings.bridge.qqHint');
  };

  const defaultBotName = (platform: BridgePlatform) => `${platformName(platform)} Bot`;
  const defaultAgentId = agents[0]?.id || '';

  const getAgentName = (agentId?: string | null, fallback?: string | null) => {
    if (fallback) return fallback;
    if (!agentId) return t('settings.bridge.unboundAgent');
    const hit = agents.find((a) => a.id === agentId);
    return hit?.name || agentId;
  };

  const toDraft = (platform: BridgePlatform, bot: BridgeBotStatus): BotDraft => ({
    id: bot.id || '',
    name: (bot.name || defaultBotName(platform)).trim(),
    appID: bot.appID || bot.appId || '',
    appSecret: '',
    appSecretMasked: bot.appSecretMasked || bot.tokenMasked || '',
    agentId: bot.agentId || defaultAgentId,
    enabled: bot.enabled !== false,
  });

  const makeNewDraft = (platform: BridgePlatform): BotDraft => ({
    id: '',
    name: defaultBotName(platform),
    appID: '',
    appSecret: '',
    appSecretMasked: '',
    agentId: defaultAgentId,
    enabled: true,
  });

  const botsByPlatform = (platform: BridgePlatform): BridgeBotStatus[] => {
    if (platform === 'telegram') return tgBots;
    if (platform === 'feishu') return fsBots;
    return qqBots;
  };

  const loadStatus = async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = (await res.json()) as BridgeStatus;

      setTgBots((data.telegram?.bots || []) as BridgeBotStatus[]);
      setFsBots((data.feishu?.bots || []) as BridgeBotStatus[]);
      setQqBots((data.qq?.bots || []) as BridgeBotStatus[]);
    } catch (err) {
      console.error('[bridge] load status failed:', err);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const setDraftField = (
    platform: BridgePlatform,
    target: 'new' | string,
    updater: (draft: BotDraft) => BotDraft,
  ) => {
    if (target === 'new') {
      setNewDrafts((prev) => {
        const current = prev[platform];
        if (!current) return prev;
        return { ...prev, [platform]: updater(current) };
      });
      return;
    }
    const key = makeCardKey(platform, target);
    setEditDrafts((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return { ...prev, [key]: updater(current) };
    });
  };

  const clearCardState = (platform: BridgePlatform, target: 'new' | string) => {
    const key = makeCardKey(platform, target === 'new' ? '' : target);
    setCardResults((prev) => ({ ...prev, [key]: undefined }));
    setCardSaving((prev) => ({ ...prev, [key]: false }));
  };

  const openNewCard = (platform: BridgePlatform) => {
    setExpandedIds((prev) => ({ ...prev, [platform]: null }));
    setNewDrafts((prev) => ({ ...prev, [platform]: makeNewDraft(platform) }));
    clearCardState(platform, 'new');
  };

  const closeNewCard = (platform: BridgePlatform) => {
    setNewDrafts((prev) => ({ ...prev, [platform]: null }));
    clearCardState(platform, 'new');
  };

  const toggleEditCard = (platform: BridgePlatform, bot: BridgeBotStatus) => {
    const botId = bot.id || '';
    const key = makeCardKey(platform, botId);
    setNewDrafts((prev) => ({ ...prev, [platform]: null }));
    setExpandedIds((prev) => ({
      ...prev,
      [platform]: prev[platform] === botId ? null : botId,
    }));
    setEditDrafts((prev) => ({
      ...prev,
      [key]: toDraft(platform, bot),
    }));
    clearCardState(platform, botId);
  };

  const closeEditCard = (platform: BridgePlatform, botId: string) => {
    const key = makeCardKey(platform, botId);
    setExpandedIds((prev) => ({ ...prev, [platform]: null }));
    setEditDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    clearCardState(platform, botId);
  };

  const testPlatform = async (platform: BridgePlatform, credentials: any) => {
    const res = await hanaFetch('/api/bridge/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, credentials }),
    });
    return res.json();
  };

  const runDraftTest = async (platform: BridgePlatform, draft: BotDraft): Promise<CardResult> => {
    try {
      if (platform === 'telegram') {
        const token = draft.appSecret.trim();
        if (!token) return { tone: 'fail', text: t('settings.bridge.noToken') };
        const data = await testPlatform('telegram', { token });
        if (data.ok) {
          const suffix = data.info?.username ? ` @${data.info.username}` : '';
          return { tone: 'ok', text: t('settings.bridge.testOk') + suffix };
        }
        return { tone: 'fail', text: t('settings.bridge.testFail') + ': ' + (data.error || '') };
      }

      const appID = draft.appID.trim();
      const appSecret = draft.appSecret.trim();
      if (!appID || !appSecret) return { tone: 'fail', text: t('settings.bridge.noCredentials') };

      if (platform === 'feishu') {
        const data = await testPlatform('feishu', { appId: appID, appSecret });
        if (data.ok) return { tone: 'ok', text: t('settings.bridge.testOk') };
        return { tone: 'fail', text: t('settings.bridge.testFail') + ': ' + (data.error || '') };
      }

      const data = await testPlatform('qq', { appID, appSecret });
      if (data.ok) return { tone: 'ok', text: t('settings.bridge.testOk') };
      return { tone: 'fail', text: t('settings.bridge.testFail') + ': ' + (data.error || '') };
    } catch (err: any) {
      return { tone: 'fail', text: t('settings.bridge.testFail') + ': ' + err.message };
    }
  };

  const persistMultiBot = async (platform: BridgePlatform, draft: BotDraft) => {
    const payload = platform === 'telegram'
      ? {
          id: draft.id || null,
          name: (draft.name || '').trim() || defaultBotName('telegram'),
          token: draft.appSecret.trim() || undefined,
          enabled: draft.enabled !== false,
          agentId: draft.agentId || null,
        }
      : platform === 'qq'
        ? {
          id: draft.id || null,
          name: (draft.name || '').trim() || defaultBotName('qq'),
          appID: draft.appID.trim() || undefined,
          appSecret: draft.appSecret.trim() || undefined,
          enabled: draft.enabled !== false,
          agentId: draft.agentId || null,
        }
        : {
          id: draft.id || null,
          name: (draft.name || '').trim() || defaultBotName('feishu'),
          appId: draft.appID.trim() || undefined,
          appSecret: draft.appSecret.trim() || undefined,
          enabled: draft.enabled !== false,
          agentId: draft.agentId || null,
        };

    const res = await hanaFetch('/api/bridge/bot-upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, bot: payload }),
    });
    return res.json();
  };

  const validateDraft = (platform: BridgePlatform, draft: BotDraft): string | null => {
    const hasSecretInput = !!draft.appSecret.trim();
    const hasSavedSecret = !!draft.appSecretMasked;
    if (platform === 'telegram') {
      if (!hasSecretInput && !hasSavedSecret) return t('settings.bridge.noToken');
      return null;
    }
    if (!draft.appID.trim()) {
      return t('settings.bridge.noCredentials');
    }
    if (!hasSecretInput && !hasSavedSecret) {
      return t('settings.bridge.noCredentials');
    }
    return null;
  };

  const saveDraftWithTest = async (
    platform: BridgePlatform,
    target: 'new' | string,
    draft: BotDraft,
    closeCard: () => void,
  ) => {
    const isNew = target === 'new';
    const hasNewSecret = !!draft.appSecret.trim();
    const normalizedDraft = draft.agentId
      ? draft
      : { ...draft, agentId: defaultAgentId };
    const key = makeCardKey(platform, target === 'new' ? '' : target);
    const validationError = validateDraft(platform, normalizedDraft);
    if (validationError) {
      setCardResults((prev) => ({ ...prev, [key]: { tone: 'fail', text: validationError } }));
      return;
    }

    setCardSaving((prev) => ({ ...prev, [key]: true }));
    setCardResults((prev) => ({ ...prev, [key]: undefined }));

    try {
      const shouldTest = isNew || hasNewSecret;
      if (shouldTest) {
        const testRes = await runDraftTest(platform, normalizedDraft);
        setCardResults((prev) => ({ ...prev, [key]: testRes }));
        if (testRes.tone !== 'ok') return;
      }

      await persistMultiBot(platform, normalizedDraft);
      await loadStatus();
      closeCard();
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      const fail = { tone: 'fail' as CardResultTone, text: t('settings.saveFailed') + ': ' + err.message };
      setCardResults((prev) => ({ ...prev, [key]: fail }));
      showToast(fail.text, 'error');
    } finally {
      setCardSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  const deleteBot = async (platform: BridgePlatform, botId: string) => {
    await hanaFetch('/api/bridge/bot-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, botId }),
    });
  };

  const toggleBotEnabled = async (platform: BridgePlatform, bot: BridgeBotStatus, on: boolean) => {
    try {
      const draft = toDraft(platform, bot);
      draft.enabled = on;
      await persistMultiBot(platform, draft);

      await loadStatus();
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const renderConfigCard = (
    platform: BridgePlatform,
    target: 'new' | string,
    draft: BotDraft,
    onChange: (updater: (d: BotDraft) => BotDraft) => void,
    onCancel: () => void,
    onDelete?: () => void,
  ) => {
    const key = makeCardKey(platform, target === 'new' ? '' : target);
    const result = cardResults[key];
    const saving = !!cardSaving[key];
    const selectedAgentId = draft.agentId || defaultAgentId;

    return (
      <div className="bridge-unified-card">
        <div className="bridge-unified-form-row">
          <label className="bridge-unified-form-label">{t('settings.bridge.botName')}</label>
          <div className="bridge-unified-form-input">
            <input
              className="settings-input"
              type="text"
              value={draft.name}
              placeholder={t('settings.bridge.botNamePlaceholder')}
              onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
        </div>

        <div className="bridge-unified-form-row">
          <label className="bridge-unified-form-label">{t('settings.bridge.qqAppId')}</label>
          <div className="bridge-unified-form-input">
            <input
              className="settings-input"
              type="text"
              value={draft.appID}
              onChange={(e) => onChange((d) => ({ ...d, appID: e.target.value }))}
              placeholder={platform === 'telegram' ? `${t('settings.bridge.qqAppId')} (Optional)` : ''}
            />
          </div>
        </div>

        <div className="bridge-unified-form-row">
          <label className="bridge-unified-form-label">{platform === 'telegram' ? `${t('settings.bridge.qqAppSecret')} / Bot Token` : t('settings.bridge.qqAppSecret')}</label>
          <div className="bridge-unified-form-input">
            <KeyInput
              value={draft.appSecret}
              onChange={(v) => onChange((d) => ({ ...d, appSecret: v }))}
              placeholder=""
            />
            {draft.appSecretMasked && !draft.appSecret && (
              <div className="bridge-unified-secret-hint">{t('settings.bridge.secretKeepHint')}</div>
            )}
          </div>
        </div>

        <div className="bridge-unified-form-row">
          <label className="bridge-unified-form-label">Agent</label>
          <div className="bridge-unified-form-input">
            <AgentSelect
              agents={agents}
              value={selectedAgentId}
              onChange={(id) => onChange((d) => ({ ...d, agentId: id }))}
            />
          </div>
        </div>

        <div className="bridge-unified-card-footer">
          <div className="bridge-unified-card-actions">
            {onDelete && (
              <button
                className="bridge-delete-btn"
                onClick={onDelete}
                disabled={saving}
              >
                {t('settings.bridge.deleteBot')}
              </button>
            )}
            <button
              className="bridge-save-btn"
              onClick={onCancel}
              disabled={saving}
            >
              {t('common.cancel')}
            </button>
            <button
              className="bridge-save-btn bridge-save-btn-primary"
              onClick={() => saveDraftWithTest(platform, target, draft, onCancel)}
              disabled={saving}
            >
              {saving ? '...' : t('settings.save')}
            </button>
          </div>
        </div>

        {result && (
          <div className={`bridge-unified-test-result ${result.tone}`}>
            {result.text}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="settings-tab-content active" data-tab="bridge">
      <div className="bridge-help-link-row">
        <span
          className="bridge-help-link"
          onClick={() => window.dispatchEvent(new Event('hana-show-bridge-tutorial'))}
        >
          {t('settings.bridge.howTo')}
        </span>
      </div>

      {PLATFORMS.map((platform) => {
        const bots = botsByPlatform(platform);
        const newDraft = newDrafts[platform];
        const expandedId = expandedIds[platform];

        return (
          <section className="settings-section bridge-unified-section" key={platform}>
            <div className="bridge-unified-head">
              <div className="bridge-unified-divider">
                <span>{platformName(platform)}</span>
              </div>
              <div className="bridge-unified-add-row">
                <button
                  className="bridge-add-inline-btn"
                  title={t('settings.bridge.addBot')}
                  aria-label={t('settings.bridge.addBot')}
                  onClick={() => openNewCard(platform)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="bridge-unified-list">
              {bots.length === 0 && !newDraft && (
                <div className="bridge-bot-empty">{t('settings.bridge.noBots')}</div>
              )}

              {bots.map((bot) => {
                const botId = bot.id || '';
                const cardKey = makeCardKey(platform, botId);
                const opened = expandedId === botId;
                const editDraft = editDrafts[cardKey] || toDraft(platform, bot);

                return (
                  <div key={`${platform}:${botId}`} className="bridge-unified-item">
                    <div className="bridge-unified-summary">
                      <button
                        className="bridge-unified-summary-main"
                        onClick={() => toggleEditCard(platform, bot)}
                      >
                        <BridgeStatusDot status={bot.status} />
                        <div className="bridge-unified-summary-meta">
                          <span className="bridge-unified-summary-name">{bot.name || defaultBotName(platform)}</span>
                          <span className="bridge-unified-summary-agent">
                            {getAgentName(bot.agentId, bot.agentName)}
                          </span>
                        </div>
                      </button>
                      <Toggle
                        on={!!bot.enabled}
                        onChange={(on) => toggleBotEnabled(platform, bot, on)}
                      />
                    </div>

                    {opened && renderConfigCard(
                      platform,
                      botId,
                      editDraft,
                      (updater) => setDraftField(platform, botId, updater),
                      () => closeEditCard(platform, botId),
                      async () => {
                        try {
                          await deleteBot(platform, botId);
                          closeEditCard(platform, botId);
                          await loadStatus();
                          showToast(t('settings.saved'), 'success');
                        } catch (err: any) {
                          showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
                        }
                      },
                    )}
                  </div>
                );
              })}

              {newDraft && renderConfigCard(
                platform,
                'new',
                newDraft,
                (updater) => setDraftField(platform, 'new', updater),
                () => closeNewCard(platform),
              )}
            </div>

            <span className="settings-field-hint">{platformHint(platform)}</span>
          </section>
        );
      })}
    </div>
  );
}
