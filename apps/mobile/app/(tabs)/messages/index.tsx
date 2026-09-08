import { View, Text, FlatList, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Q } from '@nozbe/watermelondb';
import withObservables from '@nozbe/with-observables';
import { database } from '../../../src/db';
import type { Channel } from '../../../src/db/models/Channel';
import { formatTime } from '@baseball/shared';

interface ChannelListProps {
  channels: Channel[];
}

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  announcement: '📢',
  topic: '💬',
  direct: '👤',
};

function ChannelList({ channels }: ChannelListProps) {
  if (channels.length === 0) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-gray-400 text-base">No channels yet.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={channels}
      keyExtractor={(c) => c.id}
      contentContainerStyle={{ padding: 16 }}
      renderItem={({ item: channel }) => (
        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 px-4 py-3.5 mb-2 flex-row items-center"
          onPress={() =>
            router.push({
              pathname: '/(tabs)/messages/[channelId]',
              params: { channelId: channel.remoteId },
            })
          }
        >
          <Text className="text-2xl mr-3">
            {CHANNEL_TYPE_LABELS[channel.channelType] ?? '💬'}
          </Text>
          <View className="flex-1">
            <Text className="font-semibold text-gray-900">
              {channel.name ?? 'Direct Message'}
            </Text>
            {channel.description && (
              <Text className="text-gray-500 text-sm" numberOfLines={1}>
                {channel.description}
              </Text>
            )}
          </View>
          {!channel.canPost && (
            <Text className="text-xs text-gray-400 ml-2">Read-only</Text>
          )}
        </TouchableOpacity>
      )}
    />
  );
}

const ChannelListEnhanced = withObservables([], () => ({
  channels: database
    .get<Channel>('channels')
    .query(Q.sortBy('channel_type', Q.asc))
    .observe(),
}))((props: { channels: Channel[] }) => <ChannelList channels={props.channels} />);

export default function MessagesScreen() {
  return (
    <View className="flex-1 bg-gray-50">
      <ChannelListEnhanced />
    </View>
  );
}
