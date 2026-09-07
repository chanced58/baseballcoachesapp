import { Model } from '@nozbe/watermelondb';
import { field, relation } from '@nozbe/watermelondb/decorators';
import type { Associations } from '@nozbe/watermelondb/Model';
import type { GameEventPayload } from '@baseball/shared';

export class GameEvent extends Model {
  static table = 'game_events';

  static associations: Associations = {
    games: { type: 'belongs_to', key: 'game_id' },
  };

  @field('remote_id') remoteId!: string;
  @field('game_id') gameId!: string;
  @field('game_remote_id') gameRemoteId!: string;
  @field('sequence_number') sequenceNumber!: number;
  @field('event_type') eventType!: string;
  @field('inning') inning!: number;
  @field('is_top_of_inning') isTopOfInning!: boolean;
  @field('payload') payloadRaw!: string;
  @field('occurred_at') occurredAt!: number;
  @field('created_by') createdBy!: string;
  @field('device_id') deviceId!: string;
  @field('synced_at') syncedAt!: number | undefined;

  get payload(): GameEventPayload {
    try {
      return JSON.parse(this.payloadRaw);
    } catch {
      return {};
    }
  }
}
