import type { Channel, ChannelMessage } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';

export interface ChannelSlice {
  channels: Channel[];
  currentChannel: string | null;
  channelMessages: ChannelMessage[];
  channelMembers: string[];
  channelTotalUnread: number;
  channelsEnabled: boolean;
  channelHeaderName: string;
  channelHeaderMembersText: string;
  channelInfoName: string;
  channelIsDM: boolean;
  setChannels: (channels: Channel[]) => void;
  setCurrentChannel: (channel: string | null) => void;
  setChannelMessages: (messages: ChannelMessage[]) => void;
  setChannelTotalUnread: (count: number) => void;
  setChannelsEnabled: (enabled: boolean) => void;
  loadChannels: () => Promise<void>;
  openChannel: (channelId: string, isDM?: boolean) => Promise<void>;
  sendChannelMessage: (text: string) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  toggleChannelsEnabled: () => Promise<boolean>;
  createChannel: (name: string, members: string[], intro?: string) => Promise<string | null>;
}

type Get = () => ChannelSlice & Record<string, any>;

export const createChannelSlice = (
  set: (partial: Partial<ChannelSlice> | ((s: ChannelSlice) => Partial<ChannelSlice>)) => void,
  get?: Get,
): ChannelSlice => ({
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelMembers: [],
  channelTotalUnread: 0,
  channelsEnabled: (() => { try { return localStorage.getItem('hana-channels-enabled') === 'true'; } catch { return false; } })(),
  channelHeaderName: '',
  channelHeaderMembersText: '',
  channelInfoName: '',
  channelIsDM: false,
  setChannels: (channels) => set({ channels }),
  setCurrentChannel: (channel) => set({ currentChannel: channel }),
  setChannelMessages: (messages) => set({ channelMessages: messages }),
  setChannelTotalUnread: (count) => set({ channelTotalUnread: count }),
  setChannelsEnabled: (enabled) => {
    localStorage.setItem('hana-channels-enabled', String(enabled));
    set({ channelsEnabled: enabled });
  },

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
      set({ channels: allChannels, channelTotalUnread: totalUnread });
    } catch (err) {
      console.error('[channels] load failed:', err);
    }
  },

  openChannel: async (channelId: string, isDM?: boolean) => {
    const s = get!();
    const ch = s.channels.find((c: Channel) => c.id === channelId);
    const isThisDM = isDM ?? ch?.isDM ?? false;
    const t = (window as any).t;

    set({ currentChannel: channelId });

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
          channelHeaderName: `# ${data.name || channelId}`,
          channelHeaderMembersText: `${displayMembers.length} ${t('channel.membersCount')}`,
          channelIsDM: false,
          channelInfoName: data.name || channelId,
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

  toggleChannelsEnabled: async () => {
    const s = get!();
    const newEnabled = !s.channelsEnabled;
    localStorage.setItem('hana-channels-enabled', String(newEnabled));
    set({ channelsEnabled: newEnabled });

    if (newEnabled) {
      await get!().loadChannels();
    }

    try {
      await hanaFetch('/api/channels/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled }),
      });
    } catch (err) {
      console.error('[channels] toggle backend failed:', err);
    }

    return newEnabled;
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
