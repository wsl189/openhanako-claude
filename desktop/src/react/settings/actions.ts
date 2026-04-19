/**
 * Settings shared actions — extracted from SettingsApp to avoid circular imports
 */
import { useSettingsStore } from './store';
import { hanaFetch, hanaUrl } from './api';
import { normalizeFavoriteRefs, normalizeModelRef } from './helpers';

export async function loadAgents() {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const agents = data.agents || [];
    const idSet = new Set(agents.map((a: any) => a.id));
    let currentAgentId = store.currentAgentId;
    if (!currentAgentId || !idSet.has(currentAgentId)) {
      const currentFromServer = agents.find((a: any) => a.isCurrent)?.id || null;
      const hanakoId = agents.find((a: any) => a.id === 'hanako')?.id || null;
      currentAgentId = currentFromServer || hanakoId || agents[0]?.id || null;
    }
    const currentAgent = agents.find((a: any) => a.id === currentAgentId);
    store.set({
      agents,
      currentAgentId,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

export async function loadAvatars() {
  const ts = Date.now();
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/health');
    const data = await res.json();
    const avatars = data.avatars || {};
    for (const role of ['agent', 'user']) {
      if (avatars[role]) {
        const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
        if (role === 'agent') store.set({ agentAvatarUrl: url });
        else store.set({ userAvatarUrl: url });
      } else {
        if (role === 'agent') store.set({ agentAvatarUrl: null });
        else store.set({ userAvatarUrl: null });
      }
    }
  } catch {}
}

export async function loadSettingsConfig() {
  const store = useSettingsStore.getState();
  try {
    const agentId = store.getSettingsAgentId();
    const agentBase = `/api/agents/${agentId}`;
    const [configRes, identityRes, ishikiRes, userProfileRes, pinnedRes, globalModelsRes, experienceRes] =
      await Promise.all([
        hanaFetch(`${agentBase}/config`),
        hanaFetch(`${agentBase}/identity`),
        hanaFetch(`${agentBase}/ishiki`),
        hanaFetch('/api/user-profile'),
        hanaFetch(`${agentBase}/pinned`),
        hanaFetch('/api/preferences/models'),
        hanaFetch(`${agentBase}/experience`),
      ]);

    const config = await configRes.json();
    const globalModels = await globalModelsRes.json();
    const identityData = await identityRes.json();
    config._identity = identityData.content || '';
    const ishikiData = await ishikiRes.json();
    config._ishiki = ishikiData.content || '';
    const userProfileData = await userProfileRes.json();
    config._userProfile = userProfileData.content || '';
    const pinnedData = await pinnedRes.json();
    const experienceData = await experienceRes.json();
    config._experience = experienceData.content || '';

    // favorites：兼容旧格式（如 { id, provider }）
    const fallbackFavorites = normalizeFavoriteRefs(config.models?.favorites);
    try {
      const favRes = await hanaFetch('/api/favorites');
      const favData = await favRes.json();
      store.set({ pendingFavorites: new Set(normalizeFavoriteRefs(favData.favorites)) });
    } catch {
      store.set({ pendingFavorites: new Set(fallbackFavorites) });
    }

    store.set({
      settingsConfig: config,
      globalModelsConfig: globalModels,
      homeFolder: config.desk?.home_folder || null,
      currentPins: Array.isArray(pinnedData.pins) ? pinnedData.pins.map((x: any) => String(x ?? '')).filter(Boolean) : [],
      pendingDefaultModel: normalizeModelRef(config.models?.chat),
    });
  } catch (err) {
    console.error('[settings] load failed:', err);
  }
}

export async function browseAgent(agentId: string) {
  useSettingsStore.setState({ settingsAgentId: agentId });
  await loadSettingsConfig();
  await loadAgents();
}
