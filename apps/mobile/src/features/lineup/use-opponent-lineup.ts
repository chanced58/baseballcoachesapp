import { useEffect, useMemo, useState } from 'react';
import { Q } from '@nozbe/watermelondb';
import { database } from '../../db';
import { OpponentGameLineup } from '../../db/models/OpponentGameLineup';
import { OpponentPlayer } from '../../db/models/OpponentPlayer';
import { opponentDisplayName } from './opponent-lineup';

export interface OpponentBatter {
  /** opponent_players.id — what lands in an event's opponentBatterId. */
  playerId: string;
  battingOrder: number;
  name: string;
  jerseyNumber?: string;
  /** player_position enum value, e.g. 'first_base'. */
  startingPosition?: string;
}

/**
 * The opposing team's roster and batting order for one game, observed from
 * the local mirrors so both survive a dead signal at the field.
 *
 * `roster` is every player on the opponent team; `slots` is only those in
 * this game's order, sorted, and is what the due-batter rotation runs on.
 */
export function useOpponentLineup(
  gameRemoteId: string,
  opponentTeamId: string | undefined,
): {
  roster: OpponentPlayer[];
  slots: OpponentBatter[];
  loaded: boolean;
} {
  const [lineupRows, setLineupRows] = useState<OpponentGameLineup[]>([]);
  const [roster, setRoster] = useState<OpponentPlayer[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    const subscription = database
      .get<OpponentGameLineup>('opponent_game_lineups')
      .query(Q.where('game_remote_id', gameRemoteId))
      .observe()
      .subscribe({
        next: (rows) => {
          setLineupRows(rows);
          setLoaded(true);
        },
        error: (err) => {
          console.warn(`[use-opponent-lineup] lineup observe failed game=${gameRemoteId}:`, err);
          setLoaded(true);
        },
      });
    return () => subscription.unsubscribe();
  }, [gameRemoteId]);

  useEffect(() => {
    if (!opponentTeamId) {
      setRoster([]);
      return;
    }
    const subscription = database
      .get<OpponentPlayer>('opponent_players')
      .query(Q.where('opponent_team_id', opponentTeamId), Q.where('is_active', true))
      .observe()
      .subscribe({
        next: setRoster,
        error: (err) => {
          console.warn(`[use-opponent-lineup] roster observe failed team=${opponentTeamId}:`, err);
        },
      });
    return () => subscription.unsubscribe();
  }, [opponentTeamId]);

  const slots = useMemo<OpponentBatter[]>(() => {
    const byId = new Map(roster.map((p) => [p.remoteId, p]));
    return lineupRows
      .filter((row) => row.battingOrder != null)
      .map((row) => {
        const player = byId.get(row.opponentPlayerRemoteId);
        return {
          playerId: row.opponentPlayerRemoteId,
          battingOrder: row.battingOrder!,
          // A row can outrun its player for one render — the lineup query
          // and the roster query settle independently — so fall back to the
          // slot rather than rendering a blank name.
          name: player
            ? opponentDisplayName(player)
            : `Batter ${row.battingOrder}`,
          jerseyNumber: player?.jerseyNumber,
          startingPosition: row.startingPosition ?? player?.primaryPosition,
        };
      })
      .sort((a, b) => a.battingOrder - b.battingOrder);
  }, [lineupRows, roster]);

  return { roster, slots, loaded };
}
