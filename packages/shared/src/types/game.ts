import { PlayerPosition } from './player';

export enum GameStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  POSTPONED = 'postponed',
}

export enum GameLocationType {
  HOME = 'home',
  AWAY = 'away',
  NEUTRAL = 'neutral',
}

export interface Game {
  id: string;
  seasonId: string;
  teamId: string;
  /** NULL means TBD — game scheduled before the opponent is known (e.g. playoff bracket). */
  opponentName: string | null;
  /** Optional FK to a structured opponent_teams record. */
  opponentTeamId?: string;
  scheduledAt: string;
  locationType: GameLocationType;
  /** When location_type is 'neutral', which team is designated home: 'us' or 'opponent'. */
  neutralHomeTeam?: string | null;
  venueName?: string;
  status: GameStatus;
  homeScore: number;
  awayScore: number;
  currentInning: number;
  isTopOfInning: boolean;
  outs: number;
  notes?: string;
  startedAt?: string;
  completedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Returns true when our team is the designated home team.
 * For neutral-site games, checks the neutralHomeTeam field (defaults to 'us' if not set).
 */
export function weAreHome(
  locationType: string,
  neutralHomeTeam?: string | null,
): boolean {
  if (locationType === 'home') return true;
  if (locationType === 'away') return false;
  // neutral — default to 'us' if not specified
  return neutralHomeTeam !== 'opponent';
}

export interface GameLineup {
  id: string;
  gameId: string;
  playerId: string;
  /** NULL for pitchers who do not bat (DH rule). */
  battingOrder: number | null;
  startingPosition?: PlayerPosition;
  isStarter: boolean;
  createdAt: string;
  /** TRUE when the slot is filled by a guest player (not on the home team roster). */
  isGuest?: boolean;
  /** Display name for ad-hoc named guests without a players.id FK. */
  guestDisplayName?: string | null;
  /** When isGuest=true, whether the appearance accumulates in the player's home stat line. */
  countTowardStats?: boolean;
}

/**
 * Registry row tying a player (rostered or guest) to a league for the
 * all-time appearance pool used by the guest-player picker.
 */
export interface LeaguePlayer {
  leagueId: string;
  playerId: string;
  firstSeenAt: string;
}

/** Derived in-memory game state computed from replaying GameEvents */
export interface LiveGameState {
  gameId: string;
  inning: number;
  isTopOfInning: boolean;
  outs: number;
  balls: number;
  strikes: number;
  homeScore: number;
  awayScore: number;
  runnersOnBase: {
    first: string | null;   // playerId or null
    second: string | null;
    third: string | null;
  };
  currentBatterId: string | null;
  currentPitcherId: string | null;
  currentPitcherPitchCount: number;
  /** Total completed plate appearances in top-half innings (cumulative across all innings). */
  completedTopHalfPAs: number;
  /** Total completed plate appearances in bottom-half innings (cumulative across all innings). */
  completedBottomHalfPAs: number;
  /** Cached from GAME_START so INNING_CHANGE can restore the leadoff when a half-inning starts with no batter set. */
  homeLeadoffBatterId: string | null;
  awayLeadoffBatterId: string | null;
  /** True once a GAME_END event has been replayed (and not voided). */
  isFinal: boolean;
  /** Cumulative pitch totals per pitcher id (platform + opponent ids as recorded). */
  pitcherPitchCounts: Record<string, number>;
  /**
   * Cumulative strikes thrown per pitcher id, scored the conventional way:
   * every pitch that is not a ball, an intentional ball, or a hit batsman —
   * so called and swinging strikes, fouls, foul tips, and balls put in play
   * all count. Pairs with pitcherPitchCounts to give strike percentage.
   */
  pitcherStrikeCounts: Record<string, number>;
}
