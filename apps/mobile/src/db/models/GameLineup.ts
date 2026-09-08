import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

/**
 * Local mirror of a game_lineups row. Mutable and synced both ways:
 * pulled incrementally by updated_at, pushed per-game as a whole-lineup
 * replace (see sync/lineup-sync.ts for the conflict policy).
 *
 * Locally created rows must set `_raw.id` to the same client-generated UUID
 * as remote_id so the post-push echo pull merges by id instead of duplicating.
 */
export class GameLineup extends Model {
  static table = 'game_lineups';

  @field('remote_id') remoteId!: string;
  @field('game_remote_id') gameRemoteId!: string;
  @field('player_remote_id') playerRemoteId!: string;
  @field('batting_order') battingOrder!: number | undefined;
  @field('starting_position') startingPosition!: string | undefined;
  @field('is_starter') isStarter!: boolean;
  @field('is_guest') isGuest!: boolean;
  @field('guest_display_name') guestDisplayName!: string | undefined;
  @field('count_toward_stats') countTowardStats!: boolean;
  @field('updated_at') updatedAt!: number;
  @field('synced_at') syncedAt!: number | undefined;
}
