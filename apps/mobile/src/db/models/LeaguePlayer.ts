import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

/**
 * Local mirror of a league_players registry row (every player who has
 * appeared in the league — seeds the offline guest picker).
 *
 * The record id is the flattened composite server PK: `${leagueId}:${playerId}`.
 * Pull mapping and local creation must both use this form so upsert echoes
 * merge by id instead of duplicating.
 */
export class LeaguePlayer extends Model {
  static table = 'league_players';

  @field('league_id') leagueId!: string;
  @field('player_remote_id') playerRemoteId!: string;
  @field('registered_at') registeredAt!: number;
  @field('synced_at') syncedAt!: number | undefined;
}

export function leaguePlayerRecordId(leagueId: string, playerRemoteId: string): string {
  return `${leagueId}:${playerRemoteId}`;
}
