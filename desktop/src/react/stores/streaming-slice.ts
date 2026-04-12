export interface StreamingSlice {
  /** 焦点 session 是否在 streaming（向后兼容） */
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;
  /** 所有正在 streaming 的 session path 集合 */
  streamingSessions: string[];
  /** 每个 streaming session 的开始时间戳（ms） */
  streamingSinceByPath: Record<string, number>;
  addStreamingSession: (path: string) => void;
  removeStreamingSession: (path: string) => void;
  markStreamingStart: (path: string, since?: number) => void;
  markStreamingEnd: (path: string) => void;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => void
): StreamingSlice => ({
  isStreaming: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  streamingSessions: [],
  streamingSinceByPath: {},
  addStreamingSession: (path) => set((s) => ({
    streamingSessions: s.streamingSessions.includes(path)
      ? s.streamingSessions
      : [...s.streamingSessions, path],
  })),
  removeStreamingSession: (path) => set((s) => ({
    streamingSessions: s.streamingSessions.filter(p => p !== path),
  })),
  markStreamingStart: (path, since = Date.now()) => set((s) => ({
    streamingSessions: s.streamingSessions.includes(path)
      ? s.streamingSessions
      : [...s.streamingSessions, path],
    streamingSinceByPath: {
      ...s.streamingSinceByPath,
      [path]: s.streamingSinceByPath[path] ?? since,
    },
  })),
  markStreamingEnd: (path) => set((s) => {
    const { [path]: _removed, ...rest } = s.streamingSinceByPath || {};
    return {
      streamingSessions: s.streamingSessions.filter((p) => p !== path),
      streamingSinceByPath: rest,
    };
  }),
});
