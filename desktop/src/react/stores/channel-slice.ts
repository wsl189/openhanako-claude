import type { Channel, ChannelMessage } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';

export interface ChannelSlice {
  channels: Channel[];
  currentChannel: string | null;
  channelWelcomeSelectedId: string | null;
  channelMessages: ChannelMessage[];
  channelMembers: string[];
  channelAgentActivity: Record<string, Record<string, boolean>>;
  channelTotalUnread: number;
  channelHeaderName: string;
  channelHeaderMembersText: string;
  channelInfoName: string;
  channelAnnouncement: string;
  channelPreviewInfoName: string;
  channelPreviewMembers: string[];
  channelPreviewAnnouncement: string;
  channelIsDM: boolean;
  setChannels: (channels: Channel[]) => void;
  setCurrentChannel: (channel: string | null) => void;
  setChannelWelcomeSelectedId: (channelId: string | null) => void;
  setChannelMessages: (messages: ChannelMessage[]) => void;
  setChannelTotalUnread: (count: number) => void;
  setChannelAnnouncement: (announcement: string) => void;
  loadChannels: () => Promise<void>;
  loadChannelPreview: (channelId: string) => Promise<void>;
  openChannel: (channelId: string, isDM?: boolean) => Promise<void>;
  saveChannelAnnouncement: (announcement: string) => Promise<boolean>;
  sendChannelMessage: (text: string) => Promise<void>;
  resetChannelContext: () => Promise<void>;
  clearChannelMessages: () => Promise<void>;
  stopChannelReplies: () => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  createChannel: (name: string, members: string[], intro?: string) => Promise<string | null>;
}

type Get = () => ChannelSlice & Record<string, any>;

export const createChannelSlice = (
  set: (partial: Partial<ChannelSlice> | ((s: ChannelSlice) => Partial<ChannelSlice>)) => void,
  get?: Get,
): ChannelSlice => ({
  channels: [],
  currentChannel: null,
  channelWelcomeSelectedId: null,
  channelMessages: [],
  channelMembers: [],
  channelAgentActivity: {},
  channelTotalUnread: 0,
  channelHeaderName: '',
  channelHeaderMembersText: '',
  channelInfoName: '',
  channelAnnouncement: '',
  channelPreviewInfoName: '',
  channelPreviewMembers: [],
  channelPreviewAnnouncement: '',
  channelIsDM: false,
  setChannels: (channels) => set({ channels }),
  setCurrentChannel: (channel) => set({ currentChannel: channel }),
  setChannelWelcomeSelectedId: (channelId) => set({ channelWelcomeSelectedId: channelId }),
  setChannelMessages: (messages) => set({ channelMessages: messages }),
  setChannelTotalUnread: (count) => set({ channelTotalUnread: count }),
  setChannelAnnouncement: (announcement) => set({ channelAnnouncement: announcement }),

  loadChannels: async () => {
    const s = get!();
    if (!s.serverPort) return;
    try {
      const [chRes, dmRes] = await Promise.all([
        hanaFetch('/api/channels'),
        hanaFetch('/api/dm'),
      ]);

      const chData = chRes.ok ? await chRes.json() : { channels: [] };
      const dmData = dmRes.ok ? await dmRes.json() : { dms: [] };

      const channels: Channel[] = (chData.channels || []).map((ch: any) => ({
        ...ch,
        isDM: false,
      }));

      const dms: Channel[] = (dmData.dms || []).map((dm: any) => ({
        id: `dm:${dm.peerId}`,
        name: dm.peerName || dm.peerId,
        members: [dm.peerId],
        lastMessage: dm.lastMessage || '',
        lastSender: dm.lastSender || '',
        lastTimestamp: dm.lastTimestamp || '',
        newMessageCount: 0,
        messageCount: dm.messageCount || 0,
        isDM: true,
        peerId: dm.peerId,
        peerName: dm.peerName,
      }));

      const allChannels = [...channels, ...dms];
      const totalUnread = allChannels.reduce((sum, ch) => sum + (ch.newMessageCount || 0), 0);
      const groupIds = allChannels.filter((ch) => !ch.isDM).map((ch) => ch.id);
      const nextWelcomeSelectedId = groupIds.includes(s.channelWelcomeSelectedId || '')
        ? s.channelWelcomeSelectedId
        : (groupIds[0] || null);
      set({
        channels: allChannels,
        channelTotalUnread: totalUnread,
        channelWelcomeSelectedId: nextWelcomeSelectedId,
      });
    } catch (err) {
      console.error('[channels] load failed:', err);
    }
  },

  loadChannelPreview: async (channelId: string) => {
    const s = get!();
    if (!channelId) return;
    const ch = s.channels.find((c: Channel) => c.id === channelId);
    if (!ch || ch.isDM) return;

    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // 防止异步请求回写过期选择
      if (get!().channelWelcomeSelectedId !== channelId) return;

      set({
        channelPreviewInfoName: data.name || channelId,
        channelPreviewMembers: Array.isArray(data.members) ? data.members : [],
        channelPreviewAnnouncement: String(data.announcement || ''),
      });
    } catch (err) {
      console.error('[channels] preview load failed:', err);
    }
  },

  openChannel: async (channelId: string, isDM?: boolean) => {
    const s = get!();
    const ch = s.channels.find((c: Channel) => c.id === channelId);
    const isThisDM = isDM ?? ch?.isDM ?? false;
    const t = (window as any).t;

    set({
      currentChannel: channelId,
      ...(isThisDM ? {} : { channelWelcomeSelectedId: channelId }),
    });

    try {
      if (isThisDM) {
        const peerId = ch?.peerId || channelId.replace('dm:', '');
        const res = await hanaFetch(`/api/dm/${encodeURIComponent(peerId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        set({
          channelMessages: data.messages || [],
          channelMembers: [peerId],
          channelHeaderName: data.peerName || peerId,
          channelHeaderMembersText: '',
          channelIsDM: true,
          channelInfoName: data.peerName || peerId,
          channelAnnouncement: '',
        });
      } else {
        const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const members = data.members || [];
        const displayMembers = [s.userName || 'user', ...members];
        set({
          channelMessages: data.messages || [],
          channelMembers: members,
          channelHeaderName: data.name || channelId,
          channelHeaderMembersText: `${displayMembers.length} ${t('channel.membersCount')}`,
          channelIsDM: false,
          channelInfoName: data.name || channelId,
          channelAnnouncement: String(data.announcement || ''),
          channelPreviewInfoName: data.name || channelId,
          channelPreviewMembers: members,
          channelPreviewAnnouncement: String(data.announcement || ''),
        });

        // Mark as read
        const msgs = data.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg) {
          hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timestamp: lastMsg.timestamp }),
          }).catch(() => {});

          if (ch) {
            const newTotal = Math.max(0, s.channelTotalUnread - (ch.newMessageCount || 0));
            const updatedChannels = s.channels.map((c: Channel) =>
              c.id === channelId ? { ...c, newMessageCount: 0 } : c,
            );
            set({ channelTotalUnread: newTotal, channels: updatedChannels });
          }
        }
      }
    } catch (err) {
      console.error('[channels] open failed:', err);
    }
  },

  saveChannelAnnouncement: async (announcement: string) => {
    const s = get!();
    if (!s.currentChannel || s.channelIsDM) return false;
    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/announcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ announcement }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ channelAnnouncement: String(data.announcement || '') });
      return true;
    } catch (err) {
      console.error('[channels] save announcement failed:', err);
      return false;
    }
  },

  sendChannelMessage: async (text: string) => {
    const s = get!();
    if (!text.trim() || !s.currentChannel) return;

    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok && data.timestamp) {
        set({
          channelMessages: [...s.channelMessages, {
            sender: s.userName || 'user',
            timestamp: data.timestamp,
            body: text,
          }],
        });
      }
    } catch (err) {
      console.error('[channels] send failed:', err);
    }
  },

  resetChannelContext: async () => {
    const s = get!();
    if (!s.currentChannel || s.channelIsDM) return;

    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/new`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.ok || !data?.timestamp) throw new Error(data?.error || 'new session failed');

      set({
        channelMessages: [...s.channelMessages, {
          sender: 'system',
          timestamp: data.timestamp,
          body: '',
          isContextReset: true,
        }],
        channelAgentActivity: {
          ...s.channelAgentActivity,
          [s.currentChannel]: {},
        },
      });
    } catch (err) {
      console.error('[channels] new session failed:', err);
      throw err;
    }
  },

  clearChannelMessages: async () => {
    const s = get!();
    if (!s.currentChannel || s.channelIsDM) return;

    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/reset`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'reset failed');

      set({
        channelMessages: [],
        channelAgentActivity: {
          ...s.channelAgentActivity,
          [s.currentChannel]: {},
        },
      });
      await get!().loadChannels();
    } catch (err) {
      console.error('[channels] reset failed:', err);
      throw err;
    }
  },

  stopChannelReplies: async () => {
    const s = get!();
    if (!s.currentChannel || s.channelIsDM) return;

    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/stop`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'stop failed');

      set({
        channelAgentActivity: {
          ...s.channelAgentActivity,
          [s.currentChannel]: {},
        },
      });
    } catch (err) {
      console.error('[channels] stop failed:', err);
      throw err;
    }
  },

  deleteChannel: async (channelId: string) => {
    const s = get!();
    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok) {
        if (s.currentChannel === channelId) {
          set({
            currentChannel: null,
            channelMessages: [],
            channelHeaderName: '',
            channelHeaderMembersText: '',
            channelAnnouncement: '',
            channelIsDM: false,
          });
        }
        // Reload channels
        await get!().loadChannels();
      } else {
        console.error('[channels] delete failed:', data.error);
      }
    } catch (err) {
      console.error('[channels] delete failed:', err);
    }
  },

  createChannel: async (name: string, members: string[], intro?: string) => {
    try {
      const res = await hanaFetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          members,
          intro: intro || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      await get!().loadChannels();
      if (data.id) {
        await get!().openChannel(data.id);
      }
      return data.id || null;
    } catch (err: any) {
      console.error('[channels] create failed:', err);
      throw err;
    }
  },
});
