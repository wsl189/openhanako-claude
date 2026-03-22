import type { DeskFile } from '../types';

export interface DeskSkillInfo {
  name: string;
  enabled: boolean;
  description?: string;
  baseDir?: string;
  filePath?: string;
  readonly?: boolean;
  source?: string;
}

export interface DeskSlice {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskJianContent: string | null;
  deskSkills: DeskSkillInfo[];
  agentSkillsOpen: boolean;
  setAgentSkillsOpen: (open: boolean) => void;
  toggleAgentSkillsOpen: () => void;
  setDeskFiles: (files: DeskFile[]) => void;
  setDeskBasePath: (path: string) => void;
  setDeskCurrentPath: (path: string) => void;
  setDeskJianContent: (content: string | null) => void;
  setDeskSkills: (skills: DeskSkillInfo[]) => void;
}

export const createDeskSlice = (
  set: (partial: Partial<DeskSlice>) => void,
  get?: () => DeskSlice,
): DeskSlice => ({
  deskFiles: [],
  deskBasePath: '',
  deskCurrentPath: '',
  deskJianContent: null,
  deskSkills: [],
  agentSkillsOpen: false,
  setAgentSkillsOpen: (open) => set({ agentSkillsOpen: open }),
  toggleAgentSkillsOpen: () => set({ agentSkillsOpen: !get?.().agentSkillsOpen }),
  setDeskFiles: (files) => set({ deskFiles: files }),
  setDeskBasePath: (path) => set({ deskBasePath: path }),
  setDeskCurrentPath: (path) => set({ deskCurrentPath: path }),
  setDeskJianContent: (content) => set({ deskJianContent: content }),
  setDeskSkills: (skills) => set({ deskSkills: skills }),
});
