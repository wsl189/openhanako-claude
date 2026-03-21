import { create } from 'zustand';
import { createConnectionSlice, type ConnectionSlice } from './connection-slice';
import { createSessionSlice, type SessionSlice } from './session-slice';
import { createStreamingSlice, type StreamingSlice } from './streaming-slice';
import { createUiSlice, type UiSlice } from './ui-slice';
import { createAgentSlice, type AgentSlice } from './agent-slice';
import { createChannelSlice, type ChannelSlice } from './channel-slice';
import { createDeskSlice, type DeskSlice } from './desk-slice';
import { createModelSlice, type ModelSlice } from './model-slice';
import { createMiscSlice, type MiscSlice } from './misc-slice';
import { createInputSlice, type InputSlice } from './input-slice';
import { createChatSlice, type ChatSlice } from './chat-slice';
import { createToastSlice, type ToastSlice } from './toast-slice';

export type StoreState = ConnectionSlice &
  SessionSlice &
  StreamingSlice &
  UiSlice &
  AgentSlice &
  ChannelSlice &
  DeskSlice &
  ModelSlice &
  MiscSlice &
  InputSlice &
  ChatSlice &
  ToastSlice;

export const useStore = create<StoreState>()((set, _get, _api) => ({
  ...createConnectionSlice(set),
  ...createSessionSlice(set),
  ...createStreamingSlice(set),
  ...createUiSlice(set),
  ...createAgentSlice(set),
  ...createChannelSlice(set as any, _get as any),
  ...createDeskSlice(set, _get as any),
  ...createModelSlice(set),
  ...createMiscSlice(set),
  ...createInputSlice(set),
  ...createChatSlice(set as any, _get as any),
  ...createToastSlice(set as any),
}));

// Re-export slice types
export type {
  ConnectionSlice,
  SessionSlice,
  StreamingSlice,
  UiSlice,
  AgentSlice,
  ChannelSlice,
  DeskSlice,
  ModelSlice,
  MiscSlice,
  InputSlice,
  ChatSlice,
  ToastSlice,
};
