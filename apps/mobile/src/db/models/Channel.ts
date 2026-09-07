import { Model } from '@nozbe/watermelondb';
import { field, children } from '@nozbe/watermelondb/decorators';
import type { Associations } from '@nozbe/watermelondb/Model';

export class Channel extends Model {
  static table = 'channels';

  static associations: Associations = {
    messages: { type: 'has_many', foreignKey: 'channel_id' },
  };

  @field('remote_id') remoteId!: string;
  @field('team_id') teamId!: string;
  @field('channel_type') channelType!: string;
  @field('name') name!: string | undefined;
  @field('description') description!: string | undefined;
  @field('last_message_at') lastMessageAt!: number | undefined;
  @field('can_post') canPost!: boolean;
  @field('synced_at') syncedAt!: number | undefined;
}
