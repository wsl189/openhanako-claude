import type { Activity, Artifact } from '../types';

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
}

export const createMiscSlice = (
  set: (partial: Partial<MiscSlice>) => void
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
});
