import type { Activity, Artifact } from '../types';

export const PENDING_INPUT_SESSION_KEY = '__pending_new_session__';
export const NO_SESSION_INPUT_KEY = '__no_session__';

export function resolveInputSessionKey(sessionPath: string | null | undefined, pendingNewSession: boolean): string {
  if (sessionPath) return sessionPath;
  if (pendingNewSession) return PENDING_INPUT_SESSION_KEY;
  return NO_SESSION_INPUT_KEY;
}

export interface AskUserPromptQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type PendingInputPrompt =
  | {
      kind: 'ask_user';
      confirmId: string;
      questions: AskUserPromptQuestion[];
      createdAt: number;
    }
  | {
      kind: 'plan_mode';
      confirmId: string;
      phase: 'enter' | 'exit';
      prompt?: string;
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
      createdAt: number;
    };

export interface MiscSlice {
  activities: Activity[];
  artifacts: Artifact[];
  currentArtifactId: string | null;
  editorDetached: boolean;
  browserRunning: boolean;
  browserSessionPath: string | null;
  browserToolActive: boolean;
  browserToolSessionPath: string | null;
  browserUrl: string | null;
  browserThumbnail: string | null;
  homeFolder: string | null;
  selectedFolder: string | null;
  cwdHistory: string[];
  /** Context usage — token count for the current session */
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** Whether a compaction is currently in progress */
  compacting: boolean;
  /** Automation job count for badge */
  automationCount: number;
  /** Bridge dot: at least one platform connected */
  bridgeDotConnected: boolean;
  pendingInputPromptsBySession: Record<string, PendingInputPrompt[]>;
  setActivities: (activities: Activity[]) => void;
  setArtifacts: (artifacts: Artifact[]) => void;
  setCurrentArtifactId: (id: string | null) => void;
  setEditorDetached: (detached: boolean) => void;
  setBrowserRunning: (running: boolean) => void;
  setBrowserSessionPath: (sessionPath: string | null) => void;
  setBrowserToolActive: (active: boolean) => void;
  setBrowserToolSessionPath: (sessionPath: string | null) => void;
  setBrowserUrl: (url: string | null) => void;
  setBrowserThumbnail: (thumbnail: string | null) => void;
  setHomeFolder: (folder: string | null) => void;
  setSelectedFolder: (folder: string | null) => void;
  setCwdHistory: (history: string[]) => void;
  enqueuePendingInputPrompt: (sessionKey: string, prompt: PendingInputPrompt) => void;
  removePendingInputPrompt: (confirmId: string, sessionKey?: string | null) => void;
}

export const createMiscSlice = (
  set: (partial: Partial<MiscSlice> | ((state: MiscSlice) => Partial<MiscSlice>)) => void
): MiscSlice => ({
  activities: [],
  artifacts: [],
  currentArtifactId: null,
  editorDetached: false,
  browserRunning: false,
  browserSessionPath: null,
  browserToolActive: false,
  browserToolSessionPath: null,
  browserUrl: null,
  browserThumbnail: null,
  homeFolder: null,
  selectedFolder: null,
  cwdHistory: [],
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  compacting: false,
  automationCount: 0,
  bridgeDotConnected: false,
  pendingInputPromptsBySession: {},
  setActivities: (activities) => set({ activities }),
  setArtifacts: (artifacts) => set({ artifacts }),
  setCurrentArtifactId: (id) => set({ currentArtifactId: id }),
  setEditorDetached: (detached) => set({ editorDetached: detached }),
  setBrowserRunning: (running) => set({ browserRunning: running }),
  setBrowserSessionPath: (browserSessionPath) => set({ browserSessionPath }),
  setBrowserToolActive: (browserToolActive) => set({ browserToolActive }),
  setBrowserToolSessionPath: (browserToolSessionPath) => set({ browserToolSessionPath }),
  setBrowserUrl: (url) => set({ browserUrl: url }),
  setBrowserThumbnail: (thumbnail) => set({ browserThumbnail: thumbnail }),
  setHomeFolder: (folder) => set({ homeFolder: folder }),
  setSelectedFolder: (folder) => set({ selectedFolder: folder }),
  setCwdHistory: (history) => set({ cwdHistory: history }),
  enqueuePendingInputPrompt: (sessionKey, prompt) => set((state) => {
    const currentList = state.pendingInputPromptsBySession[sessionKey] || [];
    const deduped = currentList.filter((item) => item.confirmId !== prompt.confirmId);
    return {
      pendingInputPromptsBySession: {
        ...state.pendingInputPromptsBySession,
        [sessionKey]: [...deduped, prompt],
      },
    };
  }),
  removePendingInputPrompt: (confirmId, sessionKey) => set((state) => {
    const bySession = state.pendingInputPromptsBySession;
    const keys = sessionKey ? [sessionKey] : Object.keys(bySession);
    if (keys.length === 0) return {};

    let changed = false;
    const nextBySession: Record<string, PendingInputPrompt[]> = { ...bySession };
    for (const key of keys) {
      const list = bySession[key];
      if (!list || list.length === 0) continue;
      const nextList = list.filter((item) => item.confirmId !== confirmId);
      if (nextList.length === list.length) continue;
      changed = true;
      if (nextList.length > 0) nextBySession[key] = nextList;
      else delete nextBySession[key];
    }
    return changed ? { pendingInputPromptsBySession: nextBySession } : {};
  }),
});
