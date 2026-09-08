import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Q } from '@nozbe/watermelondb';
import {
  DB_TO_POSITION,
  LINEUP_POSITIONS,
  POSITION_TO_DB,
  getLineupSlotCap,
  getMaxBattingOrder,
} from '@baseball/shared';
import { LoadingSpinner } from '@baseball/ui';
import { database } from '../../../../src/db';
import type { Game } from '../../../../src/db/models/Game';
import type { GameLineup } from '../../../../src/db/models/GameLineup';
import type { Player } from '../../../../src/db/models/Player';
import { GuestPlayerModal } from '../../../../src/features/scoring/GuestPlayerModal';
import { prepareLineupRow, removeLineupRow } from '../../../../src/features/lineup/local-guest';
import { useGameLineups } from '../../../../src/features/lineup/use-game-lineups';
import { useLeagueContext } from '../../../../src/lib/league-settings';
import { useSyncContext } from '../../../../src/providers/SyncProvider';

interface Assignment {
  /** 1-based batting slot, or null for Bench. */
  order: number | null;
  /** UI position abbreviation (LINEUP_POSITIONS), or null for unassigned. */
  position: string | null;
}

const EDITABLE_STATUSES = new Set(['scheduled', 'in_progress']);

export default function LineupScreen() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  const { triggerSync, isSyncing, lastSyncError } = useSyncContext();

  // Resolve the game from the local DB — the route only carries the game id.
  const [game, setGame] = useState<Game | null>(null);
  const [gameLoaded, setGameLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const matches = await database
          .get<Game>('games')
          .query(Q.where('remote_id', gameId))
          .fetch();
        if (cancelled) return;
        setGame(matches[0] ?? null);
      } catch (err) {
        console.warn(`Lineup game lookup failed game=${gameId}:`, err);
      } finally {
        // Always resolve the loading state so the "not synced" fallback can
        // render instead of spinning forever on a lookup failure.
        if (!cancelled) setGameLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  const teamId = game?.teamId;
  const { settings: leagueSettings, leagueId } = useLeagueContext(teamId);
  const maxBatters = getMaxBattingOrder(leagueSettings);
  const editable = game != null && EDITABLE_STATUSES.has(game.status);

  // Active roster, observed reactively.
  const [roster, setRoster] = useState<Player[]>([]);
  useEffect(() => {
    if (!teamId) return;
    const subscription = database
      .get<Player>('players')
      .query(Q.where('team_id', teamId), Q.where('is_active', true), Q.sortBy('last_name', Q.asc))
      .observe()
      .subscribe(setRoster);
    return () => subscription.unsubscribe();
  }, [teamId]);

  // Current lineup rows, observed reactively.
  const { rows: lineupRows, loaded: lineupLoaded } = useGameLineups(gameId);

  // Names for guest rows whose identity lives outside the team roster.
  const guestRows = useMemo(() => lineupRows.filter((row) => row.isGuest), [lineupRows]);
  const [guestNames, setGuestNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const missing = guestRows
      .filter((row) => !row.guestDisplayName)
      .map((row) => row.playerRemoteId);
    if (missing.length === 0) {
      setGuestNames({});
      return;
    }
    let cancelled = false;
    (async () => {
      const players = await database
        .get<Player>('players')
        .query(Q.where('remote_id', Q.oneOf(missing)))
        .fetch();
      if (cancelled) return;
      setGuestNames(Object.fromEntries(players.map((p) => [p.remoteId, p.fullName])));
    })();
    return () => {
      cancelled = true;
    };
  }, [guestRows]);

  // Editor state, seeded from the observed lineup. Re-seeds whenever the
  // underlying rows change (background sync pulling a web edit, server-wins
  // snapshot) as long as the coach has no unsaved edits — unsaved edits are
  // never clobbered.
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [editorDirty, setEditorDirty] = useState(false);
  useEffect(() => {
    if (editorDirty || !lineupLoaded || roster.length === 0) return;
    const byPlayer = new Map(
      lineupRows.filter((row) => !row.isGuest).map((row) => [row.playerRemoteId, row]),
    );
    const seeded: Record<string, Assignment> = {};
    for (const player of roster) {
      const row = byPlayer.get(player.remoteId);
      seeded[player.remoteId] = {
        order: row?.battingOrder ?? null,
        position: row?.startingPosition
          ? DB_TO_POSITION[row.startingPosition] ?? null
          : null,
      };
    }
    setAssignments(seeded);
  }, [editorDirty, lineupLoaded, lineupRows, roster]);

  const [picker, setPicker] = useState<{ playerId: string; field: 'order' | 'position' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);

  // Same slot cap rule as the web builder.
  const orderCap = getLineupSlotCap(roster.length, maxBatters);
  const orderOptions = useMemo(
    () => Array.from({ length: orderCap }, (_, i) => i + 1),
    [orderCap],
  );

  // Lookup maps for the slot picker — avoids re-scanning assignments and the
  // roster for every option row on every render.
  const playerBySlot = useMemo(() => {
    const map = new Map<number, string>();
    for (const [playerId, assignment] of Object.entries(assignments)) {
      if (assignment.order !== null) map.set(assignment.order, playerId);
    }
    return map;
  }, [assignments]);
  const rosterById = useMemo(
    () => new Map(roster.map((p) => [p.remoteId, p])),
    [roster],
  );

  function setAssignment(playerId: string, patch: Partial<Assignment>) {
    setAssignments((prev) => {
      const current = prev[playerId] ?? { order: null, position: null };
      return { ...prev, [playerId]: { ...current, ...patch } };
    });
    setEditorDirty(true);
    setNotice(null);
  }

  async function handleSave() {
    if (!editable) return;
    setError(null);

    // Same semantics as the web saveLineupAction: batters get their slot and
    // position; benched players are dropped except pitchers, kept with a null
    // batting order so pitch-count tracking survives a DH lineup. isStarter
    // is preserved from the row being replaced so a mid-game Add Batter
    // (is_starter=false) isn't converted into a starter by a later save.
    const isStarterByPlayer = new Map(
      lineupRows
        .filter((row) => !row.isGuest)
        .map((row) => [row.playerRemoteId, row.isStarter]),
    );
    const entries: {
      playerId: string;
      order: number | null;
      positionDb: string | null;
      isStarter: boolean;
    }[] = [];
    for (const player of roster) {
      const assignment = assignments[player.remoteId];
      if (!assignment) continue;
      const positionDb = assignment.position ? POSITION_TO_DB[assignment.position] ?? null : null;
      const isStarter = isStarterByPlayer.get(player.remoteId) ?? true;
      if (assignment.order === null) {
        if (positionDb === 'pitcher') {
          entries.push({ playerId: player.remoteId, order: null, positionDb, isStarter });
        }
        continue;
      }
      entries.push({ playerId: player.remoteId, order: assignment.order, positionDb, isStarter });
    }

    const orders = entries.map((e) => e.order).filter((o): o is number => o !== null);
    if (new Set(orders).size !== orders.length) {
      setError('Duplicate batting order positions. Each spot can only be assigned once.');
      return;
    }
    // Guests keep their slots across saves (managed individually below), so
    // the main order must not collide with them.
    const guestSlots = new Set(
      guestRows.map((row) => row.battingOrder).filter((o): o is number => o != null),
    );
    const guestCollision = orders.find((o) => guestSlots.has(o));
    if (guestCollision !== undefined) {
      setError(`Slot ${guestCollision} is taken by a guest. Remove the guest or pick another slot.`);
      return;
    }

    setSaving(true);
    try {
      await database.write(async () => {
        const collection = database.get<GameLineup>('game_lineups');
        const existing = await collection
          .query(Q.where('game_remote_id', gameId), Q.where('is_guest', false))
          .fetch();
        // Touch updated_at before the soft delete so a save whose net effect
        // is only removals still counts as a fresh edit in the LWW guard.
        const now = Date.now();
        for (const row of existing) {
          await row.update((r) => {
            r.updatedAt = now;
          });
          await row.markAsDeleted();
        }
        await database.batch(
          ...entries.map((entry) =>
            prepareLineupRow({
              gameRemoteId: gameId,
              playerRemoteId: entry.playerId,
              battingOrder: entry.order,
              startingPosition: entry.positionDb,
              isStarter: entry.isStarter,
              isGuest: false,
              countTowardStats: true,
            }),
          ),
        );
      });
      setEditorDirty(false);
      triggerSync().catch(console.warn);
      setNotice('Lineup saved. Syncs automatically when online.');
    } catch (err) {
      console.warn(`Lineup save failed game=${gameId}:`, err);
      setError('Could not save the lineup on this device. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveGuest(row: GameLineup) {
    if (!editable) return;
    try {
      await removeLineupRow(row);
    } catch (err) {
      console.warn(`Guest removal failed game=${gameId} lineupRow=${row.id}:`, err);
      setError('Could not remove the guest. Try again.');
      return;
    }
    triggerSync().catch(console.warn);
  }

  if (!gameLoaded) {
    return <LoadingSpinner fullScreen />;
  }

  if (!game) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-6">
        <Stack.Screen options={{ title: 'Lineup', headerShown: true }} />
        <Text className="text-gray-500 text-center">
          This game hasn't synced to this device yet. Connect to the internet
          and pull to refresh the games list.
        </Text>
      </View>
    );
  }

  const pickerPlayer = picker ? roster.find((p) => p.remoteId === picker.playerId) : null;

  return (
    <View className="flex-1 bg-white">
      <Stack.Screen
        options={{ title: `Lineup vs ${game.opponentName || 'TBD'}`, headerShown: true }}
      />

      {!editable && (
        <View className="mx-4 mt-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <Text className="text-sm text-gray-600">
            This game is {game.status} — the lineup is read-only.
          </Text>
        </View>
      )}

      {error && (
        <View className="mx-4 mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <Text className="text-sm text-red-700">{error}</Text>
        </View>
      )}
      {notice && !error && (
        <View className="mx-4 mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <Text className="text-sm text-emerald-800">{notice}</Text>
        </View>
      )}
      {lastSyncError && (
        <View className="mx-4 mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg">
          <Text className="text-xs text-amber-800">
            ⚠ Last sync failed — changes are saved on this device and will retry.
          </Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {roster.length === 0 ? (
          <Text className="text-gray-400 text-center mt-8">
            No players on this roster yet. Sync the roster first.
          </Text>
        ) : (
          roster.map((player) => {
            const assignment = assignments[player.remoteId] ?? { order: null, position: null };
            return (
              <View
                key={player.remoteId}
                className="flex-row items-center justify-between border-b border-gray-100 py-2.5"
              >
                <View className="flex-1 pr-2">
                  <Text className="text-sm font-medium text-gray-900">{player.fullName}</Text>
                  {player.jerseyNumber != null && (
                    <Text className="text-xs text-gray-400">#{player.jerseyNumber}</Text>
                  )}
                </View>
                <TouchableOpacity
                  disabled={!editable}
                  onPress={() => setPicker({ playerId: player.remoteId, field: 'order' })}
                  className={`w-16 mr-2 rounded-lg border px-2 py-1.5 items-center ${
                    assignment.order !== null
                      ? 'bg-emerald-50 border-emerald-300'
                      : 'bg-gray-50 border-gray-200'
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      assignment.order !== null ? 'text-emerald-800' : 'text-gray-500'
                    }`}
                  >
                    {assignment.order !== null ? String(assignment.order) : 'Bench'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={!editable}
                  onPress={() => setPicker({ playerId: player.remoteId, field: 'position' })}
                  className={`w-16 rounded-lg border px-2 py-1.5 items-center ${
                    assignment.position
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-gray-50 border-gray-200'
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      assignment.position ? 'text-blue-800' : 'text-gray-500'
                    }`}
                  >
                    {assignment.position ?? '—'}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })
        )}

        {/* Guests — managed row-by-row, preserved by Save (like the web builder) */}
        <View className="mt-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-sm font-bold text-gray-900">Guests</Text>
            {leagueSettings.guests.allowed && editable && (
              <TouchableOpacity
                onPress={() => setShowGuestModal(true)}
                className="px-3 py-1.5 rounded-full bg-emerald-700"
              >
                <Text className="text-xs font-semibold text-white">+ Guest</Text>
              </TouchableOpacity>
            )}
          </View>
          {guestRows.length === 0 ? (
            <Text className="text-xs text-gray-400">
              {leagueSettings.guests.allowed
                ? 'No guests in this lineup.'
                : 'Guest players are disabled by the league.'}
            </Text>
          ) : (
            guestRows.map((row) => (
              <View
                key={row.id}
                className="flex-row items-center justify-between border-b border-gray-100 py-2.5"
              >
                <View className="flex-1 pr-2">
                  <Text className="text-sm font-medium text-gray-900">
                    {row.guestDisplayName ?? guestNames[row.playerRemoteId] ?? 'Guest'}
                  </Text>
                  <Text className="text-xs text-gray-400">
                    Slot {row.battingOrder ?? '—'}
                    {row.countTowardStats ? '' : ' • not counted in stats'}
                  </Text>
                </View>
                {editable && (
                  <TouchableOpacity
                    onPress={() => handleRemoveGuest(row)}
                    className="px-3 py-1.5 rounded-lg bg-red-50 border border-red-200"
                  >
                    <Text className="text-xs font-semibold text-red-700">Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {editable && (
        <View className="px-4 pb-6 pt-2 border-t border-gray-100 bg-white">
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving || roster.length === 0}
            className={`rounded-xl px-5 py-3.5 items-center ${
              saving || roster.length === 0 ? 'bg-emerald-300' : 'bg-emerald-600'
            }`}
          >
            <Text className="text-white font-semibold">
              {saving ? 'Saving…' : isSyncing ? 'Save Lineup (syncing…)' : 'Save Lineup'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Slot / position picker */}
      <Modal
        visible={picker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <TouchableOpacity
          className="flex-1 justify-end bg-black/50"
          activeOpacity={1}
          onPress={() => setPicker(null)}
        >
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '70%' }}>
            <Text className="text-base font-bold text-gray-900 mb-3">
              {picker?.field === 'order' ? 'Batting slot' : 'Position'}
              {pickerPlayer ? ` — ${pickerPlayer.fullName}` : ''}
            </Text>
            <ScrollView>
              {picker?.field === 'order' ? (
                <>
                  <PickerRow
                    label="Bench"
                    onPress={() => {
                      setAssignment(picker.playerId, { order: null });
                      setPicker(null);
                    }}
                  />
                  {orderOptions.map((option) => {
                    const takenByPlayerId = playerBySlot.get(option);
                    const takenBy =
                      takenByPlayerId && takenByPlayerId !== picker.playerId
                        ? takenByPlayerId
                        : undefined;
                    const takenName = takenBy ? rosterById.get(takenBy)?.lastName : undefined;
                    return (
                      <PickerRow
                        key={option}
                        label={`${option}${takenName ? `  (${takenName})` : ''}`}
                        onPress={() => {
                          // Taking an occupied slot benches the previous occupant,
                          // mirroring how a coach reshuffles on paper.
                          if (takenBy) setAssignment(takenBy, { order: null });
                          setAssignment(picker.playerId, { order: option });
                          setPicker(null);
                        }}
                      />
                    );
                  })}
                </>
              ) : (
                <>
                  <PickerRow
                    label="— (no position)"
                    onPress={() => {
                      if (picker) setAssignment(picker.playerId, { position: null });
                      setPicker(null);
                    }}
                  />
                  {LINEUP_POSITIONS.map((position) => (
                    <PickerRow
                      key={position}
                      label={position}
                      onPress={() => {
                        if (picker) setAssignment(picker.playerId, { position });
                        setPicker(null);
                      }}
                    />
                  ))}
                </>
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {teamId && (
        <GuestPlayerModal
          visible={showGuestModal}
          gameId={gameId}
          teamId={teamId}
          leagueId={leagueId}
          defaultCountTowardStats={leagueSettings.guests.countTowardStatsDefault}
          maxBatters={maxBatters}
          onClose={() => setShowGuestModal(false)}
        />
      )}
    </View>
  );
}

function PickerRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} className="border-b border-gray-100 py-3">
      <Text className="text-sm text-gray-900">{label}</Text>
    </TouchableOpacity>
  );
}
