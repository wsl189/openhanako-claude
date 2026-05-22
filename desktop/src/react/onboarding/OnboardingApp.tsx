/**
 * OnboardingApp.tsx — React 化的引导向导
 *
 * 6 步引导：欢迎 → 名字 → API 供应商 → 模型选择 → 主题 → 功能介绍
 * 独立 BrowserWindow，通过 HTTP 与已启动的 Server 通信。
 */

import { useState, useEffect, useRef, useCallback } from 'react';

/* ── 全局声明（由 HTML <script> 加载的 lib/*.js 暴露） ── */
declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;
declare function setTheme(name: string): void;

interface HanaApi {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  getSplashInfo(): Promise<{ locale?: string; agentName?: string }>;
  getAvatarPath(type: string): Promise<string | null>;
  onboardingComplete(): Promise<void>;
}
declare const window: Window & { hana: HanaApi };

// ── 常量 ──

const AGENT_ID = 'hanako';
const TOTAL_STEPS = 6;

const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en',    label: 'English' },
] as const;

interface ProviderPreset {
  value: string;
  label: string;
  labelZh?: string;
  url: string;
  api: string;
  local?: boolean;
  custom?: boolean;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: 'ollama',      label: 'Ollama (Local)',       labelZh: 'Ollama (本地)',       url: 'http://localhost:11434/v1', api: 'openai-completions', local: true },
  { value: 'dashscope',   label: 'DashScope (Qwen)',     url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
  { value: 'openai',      label: 'OpenAI',               url: 'https://api.openai.com/v1', api: 'openai-completions' },
  { value: 'deepseek',    label: 'DeepSeek',             url: 'https://api.deepseek.com/anthropic', api: 'anthropic-messages' },
  { value: 'volcengine',  label: 'Volcengine (Doubao)',   labelZh: 'Volcengine (豆包)',   url: 'https://ark.cn-beijing.volces.com/api/v3', api: 'openai-completions' },
  { value: 'moonshot',    label: 'Moonshot (Kimi)',      url: 'https://api.moonshot.cn/anthropic', api: 'anthropic-messages' },
  { value: 'zhipu',       label: 'Zhipu (GLM)',          url: 'https://open.bigmodel.cn/api/anthropic', api: 'anthropic-messages' },
  { value: 'siliconflow', label: 'SiliconFlow',          url: 'https://api.siliconflow.cn/v1', api: 'openai-completions' },
  { value: 'groq',        label: 'Groq',                 url: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  { value: 'mistral',     label: 'Mistral',              url: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  { value: 'minimax',     label: 'MiniMax',              url: 'https://api.minimaxi.com/anthropic', api: 'anthropic-messages' },
  { value: '_custom',     label: '',                     url: '',  api: 'openai-completions', custom: true },
];

const OB_THEMES = [
  'warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma',
  'contemplation',
] as const;

function themeKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── SVG Icons ──

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const MemoryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v0m0 8c0-2 1.5-2.5 1.5-4.5a1.5 1.5 0 10-3 0C10.5 13.5 12 14 12 16z" />
  </svg>
);

const SkillsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

const WorkspaceIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
);

const JianIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

// ── Props ──

interface OnboardingAppProps {
  preview: boolean;
  skipToTutorial: boolean;
}

// ── Component ──

export function OnboardingApp({ preview, skipToTutorial }: OnboardingAppProps) {
  // ── Server connection ──
  const [serverPort, setServerPort] = useState<string | null>(null);
  const [serverToken, setServerToken] = useState<string | null>(null);

  // ── Step navigation ──
  const [step, setStep] = useState(skipToTutorial ? 5 : 0);
  const [stepKey, setStepKey] = useState(0); // for re-triggering animation

  // ── Agent info ──
  const [agentName, setAgentName] = useState('Hanako');
  const [avatarSrc, setAvatarSrc] = useState('assets/Hanako.png');

  // ── Step 0: locale ──
  const [locale, setLocale] = useState('zh-CN');
  const [i18nReady, setI18nReady] = useState(false);

  // ── Step 1: name ──
  const [userName, setUserName] = useState('');

  // ── Step 2: provider ──
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerApi, setProviderApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [isLocalProvider, setIsLocalProvider] = useState(false);
  const [connectionTested, setConnectionTested] = useState(false);
  const [testStatus, setTestStatus] = useState<{ type: '' | 'loading' | 'success' | 'error'; text: string }>({ type: '', text: '' });
  const [showKey, setShowKey] = useState(false);

  // ── Step 2: custom provider fields ──
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customApi, setCustomApi] = useState('openai-completions');

  // ── Step 3: model ──
  const [fetchedModels, setFetchedModels] = useState<{ id: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [modelLoading, setModelLoading] = useState('');
  const [selectedUtility, setSelectedUtility] = useState('');
  const [selectedUtilityLarge, setSelectedUtilityLarge] = useState('');

  // ── Step 4: theme ──
  const [activeTheme, setActiveTheme] = useState(() => localStorage.getItem('hana-theme') || 'auto');

  // ── Step 5: finishing ──
  const [finishing, setFinishing] = useState(false);

  // ── Toast ──
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Models loaded tracker ──
  const modelsLoadedFor = useRef('');

  // ── hanaFetch ──
  const hanaFetch = useCallback((path: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (serverToken) headers['Authorization'] = `Bearer ${serverToken}`;
    return fetch(`http://127.0.0.1:${serverPort}${path}`, { ...opts, headers });
  }, [serverPort, serverToken]);

  // ── Toast helper ──
  const showError = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 3000);
  }, []);

  // ── Step navigation ──
  const goToStep = useCallback((index: number) => {
    if (index < 0 || index >= TOTAL_STEPS) return;
    setStepKey(k => k + 1);
    setStep(index);
  }, []);

  // ── Init ──
  useEffect(() => {
    (async () => {
      try {
        const port = await window.hana.getServerPort();
        const token = await window.hana.getServerToken();
        setServerPort(port);
        setServerToken(token);

        const splashInfo = await window.hana.getSplashInfo();
        const loc = splashInfo?.locale || 'zh-CN';
        const name = splashInfo?.agentName || 'Hanako';

        setLocale(loc);
        setAgentName(name);

        await i18n.load(loc);
        i18n.defaultName = name;
        setI18nReady(true);

        // Load avatar
        try {
          const localPath = await window.hana.getAvatarPath('agent');
          if (localPath) setAvatarSrc(`file://${encodeURI(localPath)}`);
        } catch { /* ignore */ }
      } catch (err) {
        console.error('[onboarding] init failed:', err);
      }
    })();
  }, []);

  // ── Locale change handler ──
  const changeLocale = useCallback(async (loc: string) => {
    if (locale === loc) return;
    setLocale(loc);
    await i18n.load(loc);
    // Force re-render by bumping i18nReady
    setI18nReady(false);
    requestAnimationFrame(() => setI18nReady(true));
  }, [locale]);

  // ── Provider preset selection ──
  const selectPreset = useCallback((preset: ProviderPreset) => {
    setSelectedPreset(preset.value);
    setConnectionTested(false);
    setTestStatus({ type: '', text: '' });

    if (preset.custom) {
      setProviderName(customName.trim().toLowerCase().replace(/\s+/g, '-'));
      setProviderUrl(customUrl.trim());
      setProviderApi(customApi);
      setIsLocalProvider(false);
    } else {
      setProviderName(preset.value);
      setProviderUrl(preset.url);
      setProviderApi(preset.api);
      setIsLocalProvider(!!preset.local);
      if (preset.local) setApiKey('');
    }
  }, [customName, customUrl, customApi]);

  // ── Custom provider input sync ──
  const onCustomInput = useCallback((name: string, url: string, api: string) => {
    setCustomName(name);
    setCustomUrl(url);
    setCustomApi(api);
    if (selectedPreset === '_custom') {
      setProviderName(name.trim().toLowerCase().replace(/\s+/g, '-'));
      setProviderUrl(url.trim());
      setProviderApi(api);
      setConnectionTested(false);
      setTestStatus({ type: '', text: '' });
    }
  }, [selectedPreset]);

  // ── API key input ──
  const onApiKeyInput = useCallback((val: string) => {
    const cleaned = val.replace(/[^\x20-\x7E]/g, '').trim();
    setApiKey(cleaned);
    setConnectionTested(false);
    setTestStatus({ type: '', text: '' });
  }, []);

  // ── Provider button states ──
  const hasKey = !!apiKey || isLocalProvider;
  const hasProvider = !!providerName;
  const hasUrl = !!providerUrl;
  const testBtnDisabled = preview ? false : !(hasProvider && hasUrl && hasKey);
  const providerNextDisabled = preview ? false : !(hasProvider && hasUrl && hasKey && connectionTested);

  // ── Test connection ──
  const testConnection = useCallback(async () => {
    if (preview) {
      setTestStatus({ type: 'success', text: t('onboarding.provider.testSuccess') });
      return;
    }
    setTestStatus({ type: 'loading', text: t('onboarding.provider.testing') });
    try {
      const res = await hanaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: providerUrl,
          api: providerApi,
          api_key: apiKey,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus({ type: 'success', text: t('onboarding.provider.testSuccess') });
        setConnectionTested(true);
      } else {
        setTestStatus({ type: 'error', text: t('onboarding.provider.testFailed') });
        setConnectionTested(false);
      }
    } catch (err: any) {
      setTestStatus({ type: 'error', text: err.message });
      setConnectionTested(false);
    }
  }, [preview, hanaFetch, providerUrl, providerApi, apiKey]);

  // ── Save provider ──
  const saveProvider = useCallback(async () => {
    await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api: { provider: providerName },
        providers: {
          [providerName]: {
            base_url: providerUrl,
            api_key: apiKey,
            api: providerApi,
          },
        },
      }),
    });
  }, [hanaFetch, providerName, providerUrl, apiKey, providerApi]);

  // ── Load models ──
  const loadModels = useCallback(async () => {
    if (preview) {
      setFetchedModels([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }]);
      setModelLoading('');
      return;
    }
    if (modelsLoadedFor.current === providerName) return;

    setModelLoading(t('onboarding.model.loading'));
    try {
      const res = await hanaFetch('/api/providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: providerName,
          base_url: providerUrl,
          api: providerApi,
          api_key: apiKey,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setModelLoading(data.error);
        return;
      }
      const models = data.models || [];
      setFetchedModels(models);
      setSelectedModel('');
      setSelectedUtility('');
      setSelectedUtilityLarge('');
      modelsLoadedFor.current = providerName;
      setModelLoading('');
    } catch (err: any) {
      setModelLoading(err.message);
    }
  }, [preview, hanaFetch, providerName, providerUrl, providerApi, apiKey]);

  // ── Load models when entering step 3 ──
  useEffect(() => {
    if (step === 3) loadModels();
  }, [step, loadModels]);

  // ── Save model ──
  const saveModel = useCallback(async () => {
    const toModelRef = (modelId: string) => {
      const id = String(modelId || '').trim();
      if (!id) return '';
      return providerName ? `${providerName}/${id}` : id;
    };

    // Save model list to provider first, then set chat model.
    // Fresh install 时若先写 chat，运行时可用模型列表可能还没刷新，导致首轮会话拿不到模型对象。
    const modelIds = fetchedModels.map(m => m.id);
    await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: { [providerName]: { models: modelIds } },
      }),
    });

    // Save chat model
    await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: { chat: toModelRef(selectedModel) } }),
    });

    // Save favorites
    const favs = [toModelRef(selectedModel)].filter(Boolean);
    const utilityRef = toModelRef(selectedUtility);
    const utilityLargeRef = toModelRef(selectedUtilityLarge);
    if (utilityRef && !favs.includes(utilityRef)) favs.push(utilityRef);
    if (utilityLargeRef && !favs.includes(utilityLargeRef)) favs.push(utilityLargeRef);
    await hanaFetch('/api/favorites', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites: favs }),
    });

    // Save utility models to global preferences
    if (selectedUtility || selectedUtilityLarge) {
      const utilityModels: Record<string, string> = {};
      if (utilityRef) utilityModels.utility = utilityRef;
      if (utilityLargeRef) utilityModels.utility_large = utilityLargeRef;
      await hanaFetch('/api/preferences/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: utilityModels }),
      });
    }
  }, [hanaFetch, selectedModel, fetchedModels, providerName, selectedUtility, selectedUtilityLarge]);

  // ── Filtered models ──
  const filteredModels = modelSearch
    ? fetchedModels.filter(m => m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : fetchedModels;

  // ── Step handlers ──

  const onWelcomeNext = useCallback(async () => {
    if (!preview) {
      try {
        await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
      } catch (err) {
        console.error('[onboarding] save locale failed:', err);
      }
    }
    goToStep(1);
  }, [preview, hanaFetch, locale, goToStep]);

  const onNameNext = useCallback(async () => {
    if (preview) { goToStep(2); return; }
    const trimmed = userName.trim();
    if (!trimmed) return;
    try {
      await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: { name: trimmed } }),
      });
      goToStep(2);
    } catch (err) {
      console.error('[onboarding] save name failed:', err);
      showError(t('onboarding.provider.testFailed'));
    }
  }, [preview, hanaFetch, userName, goToStep, showError]);

  const onProviderNext = useCallback(async () => {
    if (preview) { goToStep(3); return; }
    if (!connectionTested) return;
    try {
      await saveProvider();
      goToStep(3);
    } catch (err) {
      console.error('[onboarding] save provider failed:', err);
      showError(t('onboarding.provider.testFailed'));
    }
  }, [preview, connectionTested, saveProvider, goToStep, showError]);

  const onModelNext = useCallback(async () => {
    if (preview) { goToStep(4); return; }
    if (!selectedModel) return;
    try {
      await saveModel();
      goToStep(4);
    } catch (err) {
      console.error('[onboarding] save model failed:', err);
      showError(t('onboarding.provider.testFailed'));
    }
  }, [preview, selectedModel, saveModel, goToStep, showError]);

  const onFinish = useCallback(async () => {
    if (preview) { window.close(); return; }
    setFinishing(true);
    try {
      await window.hana.onboardingComplete();
    } catch (err) {
      console.error('[onboarding] complete failed:', err);
      showError(t('onboarding.provider.testFailed'));
      setFinishing(false);
    }
  }, [preview, showError]);

  // ── Wait for i18n before rendering ──
  if (!i18nReady) return null;

  const isZh = i18n.locale?.startsWith('zh');

  return (
    <div className="onboarding">
      {/* Progress dots */}
      <div className="onboarding-progress">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={`onboarding-dot${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}
          />
        ))}
      </div>

      {/* Step 0: Welcome */}
      {step === 0 && (
        <StepContainer key={`step-0-${stepKey}`}>
          <img className="onboarding-avatar" src={avatarSrc} draggable={false} alt="" />
          <h1 className="onboarding-title">{t('onboarding.welcome.title')}</h1>
          <Multiline className="onboarding-subtitle" text={t('onboarding.welcome.subtitle')} />
          <div className="ob-locale-picker">
            {LOCALES.map(loc => (
              <button
                key={loc.value}
                className={`ob-locale-btn${locale === loc.value ? ' active' : ''}`}
                onClick={() => changeLocale(loc.value)}
              >
                <span>{loc.label}</span>
              </button>
            ))}
          </div>
          <div className="onboarding-actions">
            <button className="ob-btn ob-btn-primary" onClick={onWelcomeNext}>
              {t('onboarding.welcome.next')}
            </button>
          </div>
        </StepContainer>
      )}

      {/* Step 1: Name */}
      {step === 1 && (
        <StepContainer key={`step-1-${stepKey}`}>
          <h1 className="onboarding-title">{t('onboarding.name.title')}</h1>
          <p className="onboarding-subtitle">{t('onboarding.name.subtitle')}</p>
          <input
            className="ob-input"
            type="text"
            style={{ textAlign: 'center', maxWidth: 260 }}
            placeholder={t('onboarding.name.placeholder')}
            value={userName}
            onChange={e => setUserName(e.target.value)}
            autoComplete="off"
          />
          <div className="onboarding-actions">
            <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(0)}>
              {t('onboarding.name.back')}
            </button>
            <button
              className="ob-btn ob-btn-primary"
              disabled={!preview && !userName.trim()}
              onClick={onNameNext}
            >
              {t('onboarding.name.next')}
            </button>
          </div>
        </StepContainer>
      )}

      {/* Step 2: Provider */}
      {step === 2 && (
        <StepContainer key={`step-2-${stepKey}`}>
          <h1 className="onboarding-title">{t('onboarding.provider.title')}</h1>
          <Multiline className="onboarding-subtitle" text={t('onboarding.provider.subtitle')} />

          <div className="provider-grid">
            {PROVIDER_PRESETS.map(preset => (
              <div
                key={preset.value}
                className={`provider-card${selectedPreset === preset.value ? ' selected' : ''}`}
                onClick={() => selectPreset(preset)}
              >
                {preset.custom
                  ? t('onboarding.provider.custom')
                  : (isZh && 'labelZh' in preset && preset.labelZh ? preset.labelZh : preset.label)
                }
              </div>
            ))}
          </div>

          {/* Custom provider fields */}
          {selectedPreset === '_custom' && (
            <div className="custom-provider-row">
              <div className="custom-provider-fields">
                <div className="custom-field">
                  <span className="ob-field-label">{t('onboarding.provider.customName')}</span>
                  <input
                    className="ob-input"
                    type="text"
                    placeholder={t('onboarding.provider.customNamePlaceholder')}
                    value={customName}
                    onChange={e => onCustomInput(e.target.value, customUrl, customApi)}
                    autoComplete="off"
                  />
                </div>
                <div className="custom-field">
                  <span className="ob-field-label">{t('onboarding.provider.customUrl')}</span>
                  <input
                    className="ob-input"
                    type="text"
                    placeholder={t('onboarding.provider.customUrlPlaceholder')}
                    value={customUrl}
                    onChange={e => onCustomInput(customName, e.target.value, customApi)}
                    autoComplete="off"
                  />
                </div>
                <div className="custom-field">
                  <select
                    className="ob-input"
                    value={customApi}
                    onChange={e => onCustomInput(customName, customUrl, e.target.value)}
                  >
                    <option value="openai-completions">OpenAI Compatible</option>
                    <option value="anthropic-messages">Anthropic Messages</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* API Key */}
          {!isLocalProvider && (
            <>
              <span className="ob-field-label">{t('onboarding.provider.keyLabel')}</span>
              <div className="ob-key-row">
                <input
                  className="ob-input"
                  type={showKey ? 'text' : 'password'}
                  placeholder={t('onboarding.provider.keyPlaceholder')}
                  value={apiKey}
                  onChange={e => onApiKeyInput(e.target.value)}
                  autoComplete="off"
                />
                <button className="ob-key-toggle" onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </>
          )}

          {/* Test connection */}
          <div className="ob-test-row">
            <button
              className="ob-test-btn"
              disabled={testBtnDisabled}
              onClick={testConnection}
            >
              {t('onboarding.provider.test')}
            </button>
            {testStatus.text && (
              <span className={`ob-status ${testStatus.type}`}>{testStatus.text}</span>
            )}
          </div>

          <div className="onboarding-actions">
            <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(1)}>
              {t('onboarding.provider.back')}
            </button>
            <button
              className="ob-btn ob-btn-primary"
              disabled={providerNextDisabled}
              onClick={onProviderNext}
            >
              {t('onboarding.provider.next')}
            </button>
          </div>
        </StepContainer>
      )}

      {/* Step 3: Model */}
      {step === 3 && (
        <StepContainer key={`step-3-${stepKey}`}>
          <h1 className="onboarding-title">{t('onboarding.model.title')}</h1>
          <p className="onboarding-subtitle">{t('onboarding.model.subtitle')}</p>

          <input
            className="ob-input ob-model-search"
            type="text"
            placeholder={t('onboarding.model.searchPlaceholder')}
            value={modelSearch}
            onChange={e => setModelSearch(e.target.value)}
            autoComplete="off"
          />

          <div className="model-list">
            {modelLoading ? (
              <div className="model-empty">{modelLoading}</div>
            ) : filteredModels.length === 0 ? (
              <div className="model-empty">{t('onboarding.model.empty')}</div>
            ) : (
              filteredModels.map(model => (
                <div
                  key={model.id}
                  className={`model-item${selectedModel === model.id ? ' selected' : ''}`}
                  onClick={() => setSelectedModel(model.id)}
                >
                  {model.id}
                </div>
              ))
            )}
          </div>

          {/* Utility model selectors */}
          <div className="ob-utility-section">
            <div className="ob-utility-block">
              <div className="ob-utility-header">
                <span className="ob-utility-title">{t('onboarding.model.utility')}</span>
                <span className="ob-utility-hint">{t('onboarding.model.utilityHint')}</span>
              </div>
              <SdwSelect
                models={fetchedModels}
                value={selectedUtility}
                onChange={setSelectedUtility}
              />
            </div>
            <div className="ob-utility-block">
              <div className="ob-utility-header">
                <span className="ob-utility-title">{t('onboarding.model.utilityLarge')}</span>
                <span className="ob-utility-hint">{t('onboarding.model.utilityLargeHint')}</span>
              </div>
              <SdwSelect
                models={fetchedModels}
                value={selectedUtilityLarge}
                onChange={setSelectedUtilityLarge}
              />
            </div>
          </div>

          <div className="onboarding-actions">
            <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(2)}>
              {t('onboarding.model.back')}
            </button>
            <button
              className="ob-btn ob-btn-primary"
              disabled={!preview && !selectedModel}
              onClick={onModelNext}
            >
              {t('onboarding.model.next')}
            </button>
          </div>
        </StepContainer>
      )}

      {/* Step 4: Theme */}
      {step === 4 && (
        <StepContainer key={`step-4-${stepKey}`}>
          <h1 className="onboarding-title">{t('onboarding.theme.title')}</h1>
          <p className="onboarding-subtitle">{t('onboarding.theme.subtitle')}</p>

          <div className="theme-options">
            {OB_THEMES.map(theme => {
              const key = themeKey(theme);
              return (
                <button
                  key={theme}
                  className={`theme-card${activeTheme === theme ? ' active' : ''}`}
                  data-theme={theme}
                  onClick={() => {
                    setActiveTheme(theme);
                    setTheme(theme);
                  }}
                >
                  <div className="theme-card-name">{t(`settings.appearance.${key}`)}</div>
                  <div className="theme-card-mode">{t(`settings.appearance.${key}Mode`)}</div>
                </button>
              );
            })}
          </div>

          <div className="onboarding-actions">
            <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(3)}>
              {t('onboarding.theme.back')}
            </button>
            <button className="ob-btn ob-btn-primary" onClick={() => goToStep(5)}>
              {t('onboarding.theme.next')}
            </button>
          </div>
        </StepContainer>
      )}

      {/* Step 5: Tutorial */}
      {step === 5 && (
        <StepContainer key={`step-5-${stepKey}`}>
          <h1 className="onboarding-title">{t('onboarding.tutorial.title')}</h1>

          <div className="tutorial-cards">
            <TutorialCard
              icon={<MemoryIcon />}
              title={t('onboarding.tutorial.memory.title')}
              desc={t('onboarding.tutorial.memory.desc')}
            />
            <TutorialCard
              icon={<SkillsIcon />}
              title={t('onboarding.tutorial.skills.title')}
              desc={t('onboarding.tutorial.skills.desc')}
            />
            <TutorialCard
              icon={<WorkspaceIcon />}
              title={t('onboarding.tutorial.workspace.title')}
              desc={t('onboarding.tutorial.workspace.desc')}
            />
            <TutorialCard
              icon={<JianIcon />}
              title={t('onboarding.tutorial.jian.title')}
              desc={t('onboarding.tutorial.jian.desc')}
            />
          </div>

          <button className="ob-finish-btn" disabled={finishing} onClick={onFinish}>
            {t('onboarding.tutorial.finish')}
          </button>
        </StepContainer>
      )}

      {/* Error toast */}
      {toastMsg && (
        <div
          style={{
            position: 'fixed',
            bottom: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--coral, #c66)',
            color: '#fff',
            padding: '8px 20px',
            borderRadius: 8,
            fontSize: '0.82rem',
            zIndex: 999,
          }}
        >
          {toastMsg}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

/** Step container with fade-in animation */
function StepContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-step active" style={{ animation: 'obFadeIn 0.3s ease-out' }}>
      {children}
    </div>
  );
}

/** Renders text with \n as <br /> */
function Multiline({ className, text }: { className?: string; text: string }) {
  const parts = text.split('\n');
  return (
    <p className={className}>
      {parts.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {line}
        </span>
      ))}
    </p>
  );
}

/** Tutorial card */
function TutorialCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="tutorial-card">
      <div className="tutorial-card-header">
        <span className="tutorial-card-icon">{icon}</span>
        <span className="tutorial-card-title">{title}</span>
      </div>
      <Multiline className="tutorial-card-desc" text={desc} />
    </div>
  );
}

/** Custom SDW dropdown (matches the .sdw CSS in styles.css) */
function SdwSelect({
  models,
  value,
  onChange,
}: {
  models: { id: string }[];
  value: string;
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div className={`sdw${open ? ' open' : ''}`} ref={containerRef}>
      <button type="button" className="sdw-trigger" onClick={() => setOpen(!open)}>
        <span className={`sdw-value${value ? '' : ' sdw-placeholder'}`}>
          {value || '\u2014'}
        </span>
        <span className="sdw-arrow">{'\u25BE'}</span>
      </button>
      <div className="sdw-popup">
        {models.map(m => (
          <button
            key={m.id}
            type="button"
            className={`sdw-option${value === m.id ? ' selected' : ''}`}
            onClick={() => {
              onChange(m.id);
              setOpen(false);
            }}
          >
            {m.id}
          </button>
        ))}
      </div>
    </div>
  );
}
