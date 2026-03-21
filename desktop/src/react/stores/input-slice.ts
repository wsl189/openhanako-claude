export interface AttachedFile {
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface InputSlice {
  attachedFiles: AttachedFile[];
  deskContextAttached: boolean;
  docContextAttached: boolean;
  inputFocusTrigger: number;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean) => void;
  toggleDocContext: () => void;
  requestInputFocus: () => void;
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void
): InputSlice => ({
  attachedFiles: [],
  deskContextAttached: false,
  docContextAttached: false,
  inputFocusTrigger: 0,
  addAttachedFile: (file) =>
    set((s) => ({ attachedFiles: [...s.attachedFiles, file] })),
  removeAttachedFile: (index) =>
    set((s) => ({ attachedFiles: s.attachedFiles.filter((_, i) => i !== index) })),
  setAttachedFiles: (files) => set({ attachedFiles: files }),
  clearAttachedFiles: () => set({ attachedFiles: [] }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: (attached) => set({ docContextAttached: attached }),
  toggleDocContext: () =>
    set((s) => ({ docContextAttached: !s.docContextAttached })),
  requestInputFocus: () =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1 })),
});
