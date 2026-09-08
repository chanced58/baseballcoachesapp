import { randomUUID } from 'expo-crypto';
import { Q } from '@nozbe/watermelondb';
import { database } from '../../db';
import { OpponentGameLineup } from '../../db/models/OpponentGameLineup';
import { OpponentPlayer } from '../../db/models/OpponentPlayer';

/**
 * Offline-first writes for the opposing team's roster and batting order.
 *
 * A scorer keeping the other side's book learns their lineup at the plate,
 * not before the game, so every path here has to work with no signal. Rows
 * land in WatermelonDB and reach Supabase through the sync engine, which
 * pushes opponent_players before opponent_game_lineups to satisfy the FK.
 *
 * RLS lets any coach on the game's team insert both tables directly, so
 * unlike the web flow there is no server action in the path.
 */

export type AddOpponentBatterResult =
  | { ok: true; opponentPlayerId: string; battingOrder: number }
  | { ok: false; message: string };

/**
 * Next free slot at the end of the opponent's order.
 *
 * MUST be called inside an active database.write() — it reads the current
 * rows and the caller writes based on the answer, so a concurrent add
 * between the two would hand out the same slot twice.
 */
async function nextOpponentBattingOrder(gameRemoteId: string): Promise<number> {
  const rows = await database
    .get<OpponentGameLineup>('opponent_game_lineups')
    .query(Q.where('game_remote_id', gameRemoteId))
    .fetch();
  return rows.reduce((max, r) => Math.max(max, r.battingOrder ?? 0), 0) + 1;
}

/**
 * Put an existing opponent player into the order.
 *
 * Idempotent on the player: a batter already in the order keeps their slot
 * rather than being appended twice, which matches the server's
 * unique(game_id, opponent_player_id).
 */
export async function addOpponentBatterFromRoster(args: {
  gameRemoteId: string;
  opponentPlayerRemoteId: string;
  startingPosition?: string | null;
  maxBatters: number;
}): Promise<AddOpponentBatterResult> {
  const { gameRemoteId, opponentPlayerRemoteId, startingPosition, maxBatters } = args;
  let result: AddOpponentBatterResult = { ok: false, message: 'Could not add batter.' };

  await database.write(async () => {
    const collection = database.get<OpponentGameLineup>('opponent_game_lineups');
    const existing = await collection
      .query(
        Q.where('game_remote_id', gameRemoteId),
        Q.where('opponent_player_remote_id', opponentPlayerRemoteId),
      )
      .fetch();
    if (existing.length > 0) {
      result = {
        ok: true,
        opponentPlayerId: opponentPlayerRemoteId,
        battingOrder: existing[0].battingOrder ?? 0,
      };
      return;
    }

    const battingOrder = await nextOpponentBattingOrder(gameRemoteId);
    if (battingOrder > maxBatters) {
      result = { ok: false, message: `The order is full at ${maxBatters} batters.` };
      return;
    }

    await collection.create((r) => {
      const rowId = randomUUID();
      r._raw.id = rowId;
      r.remoteId = rowId;
      r.gameRemoteId = gameRemoteId;
      r.opponentPlayerRemoteId = opponentPlayerRemoteId;
      r.battingOrder = battingOrder;
      r.startingPosition = startingPosition ?? undefined;
      // Anyone entered after the game starts is a substitute, not a starter.
      r.isStarter = false;
      r.updatedAt = Date.now();
      r.syncedAt = undefined;
    });

    result = { ok: true, opponentPlayerId: opponentPlayerRemoteId, battingOrder };
  });

  return result;
}

/**
 * Create a player who isn't on the opponent's roster yet and bat them.
 *
 * The common case at the field: a name and a jersey read off the back of a
 * shirt. Both rows are written in one transaction so the lineup can never
 * reference a player that failed to save.
 */
export async function addNewOpponentBatter(args: {
  gameRemoteId: string;
  opponentTeamId: string;
  firstName: string;
  lastName: string;
  jerseyNumber?: string | null;
  startingPosition?: string | null;
  maxBatters: number;
}): Promise<AddOpponentBatterResult> {
  const {
    gameRemoteId, opponentTeamId, firstName, lastName,
    jerseyNumber, startingPosition, maxBatters,
  } = args;

  const first = firstName.trim();
  const last = lastName.trim();
  const jersey = jerseyNumber?.trim() ?? '';
  // A jersey number alone is enough — it is the common case at the field, and
  // opponentDisplayName has a branch for exactly that. The guard used to
  // ignore jerseyNumber and reject those entries.
  if (!first && !last && !jersey) {
    return { ok: false, message: 'Enter a name or a jersey number.' };
  }

  let result: AddOpponentBatterResult = { ok: false, message: 'Could not add batter.' };

  await database.write(async () => {
    const battingOrder = await nextOpponentBattingOrder(gameRemoteId);
    if (battingOrder > maxBatters) {
      result = { ok: false, message: `The order is full at ${maxBatters} batters.` };
      return;
    }

    const playerId = randomUUID();
    const lineupId = randomUUID();

    await database.batch(
      database.get<OpponentPlayer>('opponent_players').prepareCreate((r) => {
        r._raw.id = playerId;
        r.remoteId = playerId;
        r.opponentTeamId = opponentTeamId;
        // first_name and last_name are NOT NULL server-side. A scorer who
        // only caught a jersey number still needs the batter tracked, so an
        // absent half becomes an empty string rather than blocking the add.
        r.firstName = first;
        r.lastName = last;
        r.jerseyNumber = jersey || undefined;
        r.primaryPosition = startingPosition ?? undefined;
        r.isActive = true;
        r.updatedAt = Date.now();
        r.syncedAt = undefined;
      }),
      database.get<OpponentGameLineup>('opponent_game_lineups').prepareCreate((r) => {
        r._raw.id = lineupId;
        r.remoteId = lineupId;
        r.gameRemoteId = gameRemoteId;
        r.opponentPlayerRemoteId = playerId;
        r.battingOrder = battingOrder;
        r.startingPosition = startingPosition ?? undefined;
        r.isStarter = false;
        r.updatedAt = Date.now();
        r.syncedAt = undefined;
      }),
    );

    result = { ok: true, opponentPlayerId: playerId, battingOrder };
  });

  return result;
}

/** Display name for an opponent batter, jersey-only entries included. */
export function opponentDisplayName(
  player: { firstName: string; lastName: string; jerseyNumber?: string },
): string {
  const name = `${player.firstName} ${player.lastName}`.trim();
  if (name) return player.jerseyNumber ? `#${player.jerseyNumber} ${name}` : name;
  return player.jerseyNumber ? `#${player.jerseyNumber}` : 'Unnamed batter';
}
