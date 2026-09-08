import { Model } from '@nozbe/watermelondb';
import { field, children } from '@nozbe/watermelondb/decorators';
import type { Associations } from '@nozbe/watermelondb/Model';
import type { GameEvent } from './GameEvent';

export class Game extends Model {
  static table = 'games';

  static associations: Associations = {
    game_events: { type: 'has_many', foreignKey: 'game_id' },
  };

  @field('remote_id') remoteId!: string;
  @field('season_id') seasonId!: string;
  @field('team_id') teamId!: string;
  @field('opponent_name') opponentName!: string;
  /** Set when the opponent is a tracked opponent_teams row — the key to their roster. */
  @field('opponent_team_id') opponentTeamId!: string | undefined;
  @field('scheduled_at') scheduledAt!: number;
  @field('location_type') locationType!: string;
  @field('neutral_home_team') neutralHomeTeam!: string | undefined;
  @field('venue_name') venueName!: string | undefined;
  @field('status') status!: string;
  @field('home_score') homeScore!: number;
  @field('away_score') awayScore!: number;
  @field('current_inning') currentInning!: number;
  @field('is_top_of_inning') isTopOfInning!: boolean;
  @field('outs') outs!: number;
  @field('synced_at') syncedAt!: number | undefined;

  @children('game_events') events!: import('@nozbe/watermelondb').Query<InstanceType<typeof GameEvent>>;
}
