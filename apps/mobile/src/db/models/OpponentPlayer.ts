import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

/**
 * Local mirror of an opponent_players row — a player on the opposing team,
 * scoped to an opponent_team (games carry opponent_team_id).
 *
 * These exist so opponent plate appearances can be attributed to a name
 * rather than an anonymous stand-in. A scorer can create one mid-game with no
 * signal; RLS lets any coach on the game's team insert directly, so no server
 * action is involved.
 *
 * Locally created rows must set `_raw.id` to the same client-generated UUID as
 * remote_id so the post-push echo pull merges by id instead of duplicating.
 */
export class OpponentPlayer extends Model {
  static table = 'opponent_players';

  @field('remote_id') remoteId!: string;
  @field('opponent_team_id') opponentTeamId!: string;
  @field('first_name') firstName!: string;
  @field('last_name') lastName!: string;
  /** Text on the server, not a number — opponent jerseys arrive as "07", "00". */
  @field('jersey_number') jerseyNumber!: string | undefined;
  @field('primary_position') primaryPosition!: string | undefined;
  @field('is_active') isActive!: boolean;
  @field('updated_at') updatedAt!: number;
  @field('synced_at') syncedAt!: number | undefined;

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`.trim();
  }
}
