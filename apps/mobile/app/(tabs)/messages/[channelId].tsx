import { View, Text, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useState, useRef } from 'react';
import { randomUUID } from 'expo-crypto';
import { map } from 'rxjs';
import { Q } from '@nozbe/watermelondb';
import withObservables from '@nozbe/with-observables';
import { database } from '../../../src/db';
import type { Message } from '../../../src/db/models/Message';
import type { Channel } from '../../../src/db/models/Channel';
import { useAuth } from '../../../src/providers/AuthProvider';
import { getSupabaseClient } from '../../../src/lib/supabase';
import { formatTime } from '@baseball/shared';

interface MessageThreadProps {
  messages: Message[];
  channel: Channel | undefined;
}

function MessageThread({ messages, channel }: MessageThreadProps) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const canPost = channel?.canPost ?? false;

  async function handleSend() {
    const body = text.trim();
    if (!body || !channel || !user || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase.from('messages').insert({
        channel_id: channel.remoteId,
        sender_id: user.id,
        body,
      });
      if (error) throw error;
      setText('');
    } catch (err) {
      console.warn('Message send failed; queueing offline message', err);
      await database.write(async () => {
        // Assign the decorated (camelCase) properties — raw column names set
        // on a Model are silently discarded and the queued row would be
        // written blank. See the note in use-record-event.ts.
        await database.get<Message>('messages').create((record: Message) => {
          const messageId = randomUUID();
          record._raw.id = messageId;
          record.remoteId = messageId;
          record.channelId = '';
          record.channelRemoteId = channel.remoteId;
          record.senderId = user.id;
          // Display-only until the pull replaces this row with the server
          // version, which carries the real name from user_profiles. Writing
          // the email here would keep an identifier in the local database for
          // every message queued offline, and show it where every other
          // message shows a name.
          record.senderName = 'You';
          record.body = body;
          record.parentId = undefined;
          record.isPinned = false;
          record.createdAt = Date.now();
          record.syncedAt = undefined;
        });
      });
      setText('');
      Alert.alert('Queued for sync', 'Your message will send when you reconnect.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-gray-50"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Stack.Screen options={{ title: channel?.name ?? 'Channel', headerShown: true }} />

      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        inverted
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item: message }) => {
          const isOwn = message.senderId === user?.id;
          return (
            <View className={`mb-3 max-w-xs ${isOwn ? 'self-end' : 'self-start'}`}>
              {!isOwn && (
                <Text className="text-xs text-gray-500 mb-0.5 ml-1">
                  {message.senderName ?? 'Unknown'}
                </Text>
              )}
              <View
                className={`rounded-2xl px-4 py-2.5 ${
                  isOwn ? 'bg-brand-700 rounded-br-sm' : 'bg-white border border-gray-200 rounded-bl-sm'
                }`}
              >
                <Text className={isOwn ? 'text-white' : 'text-gray-900'}>{message.body}</Text>
              </View>
              <Text className="text-xs text-gray-400 mt-0.5 mx-1">
                {formatTime(new Date(message.createdAt))}
              </Text>
            </View>
          );
        }}
      />

      {canPost ? (
        <View className="bg-white border-t border-gray-200 px-4 py-3 flex-row items-end gap-3">
          <TextInput
            className="flex-1 bg-gray-100 rounded-2xl px-4 py-2.5 text-gray-900 max-h-24"
            placeholder="Type a message..."
            value={text}
            onChangeText={setText}
            multiline
          />
          <TouchableOpacity
            className={`bg-brand-700 w-10 h-10 rounded-full items-center justify-center ${
              !text.trim() || sending ? 'opacity-40' : ''
            }`}
            onPress={handleSend}
            disabled={!text.trim() || sending}
            accessibilityLabel="Send message"
          >
            <Text className="text-white font-bold">→</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View className="bg-gray-100 border-t border-gray-200 px-4 py-3">
          <Text className="text-gray-400 text-sm text-center">Read-only channel</Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const EnhancedMessageThread = withObservables(
  ['channelRemoteId'],
  ({ channelRemoteId }: { channelRemoteId: string }) => ({
    messages: database
      .get<Message>('messages')
      .query(
        Q.where('channel_remote_id', channelRemoteId),
        Q.sortBy('created_at', Q.desc),
        Q.take(100),
      )
      .observe(),
    channel: database
      .get<Channel>('channels')
      .query(Q.where('remote_id', channelRemoteId))
      .observe()
      .pipe(map((channels: Channel[]) => channels[0])),
  }),
)((props: { messages: Message[]; channel: Channel | undefined }) => (
  <MessageThread messages={props.messages} channel={props.channel} />
));

export default function ChannelScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  return <EnhancedMessageThread channelRemoteId={channelId} />;
}
