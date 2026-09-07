import { Model } from '@nozbe/watermelondb';
import { field, relation } from '@nozbe/watermelondb/decorators';
import type { Associations } from '@nozbe/watermelondb/Model';

export class Message extends Model {
  static table = 'messages';

  static associations: Associations = {
    channels: { type: 'belongs_to', key: 'channel_id' },
  };

  @field('remote_id') remoteId!: string;
  @field('channel_id') channelId!: string;
  @field('channel_remote_id') channelRemoteId!: string;
  @field('sender_id') senderId!: string;
  @field('sender_name') senderName!: string | undefined;
  @field('body') body!: string;
  @field('parent_id') parentId!: string | undefined;
  @field('is_pinned') isPinned!: boolean;
  @field('created_at') createdAt!: number;
  @field('synced_at') syncedAt!: number | undefined;
}
