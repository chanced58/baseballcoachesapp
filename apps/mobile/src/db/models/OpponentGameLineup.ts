import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

/**
 * Local mirror of an opponent_game_lineups row — the opposing team's batting
 * order for one game.
 *
 * The server table has only created_at, so the sync engine cannot pull it by
 * timestamp window like the other mutable tables; it refreshes the whole
 * lineup for the games it pulled instead. `updated_at` here is device-local
 * bookkeeping for that reconciliation, not a mirror of a server column.
 *
 * Locally created rows must set `_raw.id` to the same client-generated UUID as
 * remote_id so the post-push echo pull merges by id instead of duplicating.
 */
export class OpponentGameLineup extends Model {
  static table = 'opponent_game_lineups';

  @field('remote_id') remoteId!: string;
  @field('game_remote_id') gameRemoteId!: string;
  @field('opponent_player_remote_id') opponentPlayerRemoteId!: string;
  @field('batting_order') battingOrder!: number | undefined;
  @field('starting_position') startingPosition!: string | undefined;
  @field('is_starter') isStarter!: boolean;
  @field('updated_at') updatedAt!: number;
  @field('synced_at') syncedAt!: number | undefined;
}
