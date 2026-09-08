import { useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Q } from '@nozbe/watermelondb';
import withObservables from '@nozbe/with-observables';
import { database } from '../../../src/db';
import type { Game } from '../../../src/db/models/Game';
import { formatDate, formatTime, type GameRsvpStatus } from '@baseball/shared';
import { useRole } from '../../../src/providers/RoleProvider';
import { useGameRsvps } from '../../../src/features/rsvp/useGameRsvps';

interface GamesListProps {
  games: Game[];
}

const RSVP_OPTIONS: { status: GameRsvpStatus; label: string; activeClass: string }[] = [
  { status: 'attending', label: 'Going', activeClass: 'bg-green-600 border-green-600' },
  { status: 'maybe', label: 'Maybe', activeClass: 'bg-amber-500 border-amber-500' },
  { status: 'not_attending', label: 'Out', activeClass: 'bg-gray-700 border-gray-700' },
];

function GamesList({ games }: GamesListProps) {
  const { activeTeam } = useRole();
  const scheduledGameIds = useMemo(
    () => games.filter((g) => g.status === 'scheduled').map((g) => g.remoteId),
    [games],
  );
  const {
    myPlayers,
    rsvpByKey,
    savingKeys,
    setRsvp,
    error: rsvpError,
  } = useGameRsvps(scheduledGameIds);

  if (games.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-gray-400 text-lg text-center">No games scheduled.</Text>
        <Text className="text-gray-400 text-sm text-center mt-1">
          Games are added by coaches on the web dashboard.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={games}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={
        rsvpError ? (
          <View className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
            <Text className="text-xs text-red-700">{rsvpError}</Text>
          </View>
        ) : null
      }
      renderItem={({ item: game }) => (
        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 p-4 mb-3"
          onPress={() => {
            // Scheduled games open in the pre-game state (start the game at
            // the field), live games in the scoring surface, and completed
            // games in the read-only Final view.
            if (['scheduled', 'in_progress', 'completed'].includes(game.status)) {
              router.push({
                pathname: '/(tabs)/games/[gameId]/score',
                params: {
                  gameId: game.remoteId,
                  teamId: game.teamId,
                  opponentName: game.opponentName || 'TBD',
                },
              });
            }
          }}
        >
          <View className="flex-row justify-between items-start mb-1">
            <Text className="font-semibold text-gray-900 text-base">vs {game.opponentName || 'TBD'}</Text>
            <StatusBadge status={game.status} />
          </View>
          <Text className="text-gray-500 text-sm">
            {formatDate(new Date(game.scheduledAt))} at {formatTime(new Date(game.scheduledAt))}
          </Text>
          {game.venueName && (
            <Text className="text-gray-400 text-xs mt-0.5">{game.venueName}</Text>
          )}
          {game.status === 'in_progress' && (
            <View className="mt-2 flex-row items-center gap-2">
              <View className="w-2 h-2 rounded-full bg-red-500" />
              <Text className="text-red-600 text-sm font-medium">
                {game.homeScore}–{game.awayScore} • Inning {game.currentInning}
              </Text>
            </View>
          )}
          {game.status === 'completed' && (
            <View className="mt-2 flex-row items-center gap-2">
              <Text className="text-gray-700 text-sm font-medium">
                {game.homeScore}–{game.awayScore} • Final
              </Text>
            </View>
          )}
          {game.status !== 'cancelled' && (
            <TouchableOpacity
              onPress={() =>
                router.push({
                  pathname: '/(tabs)/games/[gameId]/lineup',
                  params: { gameId: game.remoteId },
                })
              }
              className="mt-3 self-start px-3 py-1.5 rounded-full bg-gray-100 border border-gray-200"
            >
              <Text className="text-xs font-semibold text-gray-700">Lineup</Text>
            </TouchableOpacity>
          )}

          {game.status === 'scheduled' && activeTeam?.isCoach && (
            <TouchableOpacity
              onPress={() =>
                router.push({
                  pathname: '/(tabs)/games/[gameId]/attendance',
                  params: { gameId: game.remoteId },
                })
              }
              className="mt-2 self-start px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200"
            >
              <Text className="text-xs font-semibold text-blue-700">RSVPs →</Text>
            </TouchableOpacity>
          )}

          {game.status === 'scheduled' && !activeTeam?.isCoach && myPlayers.length > 0 && (
            <View className="mt-3 gap-1.5">
              {myPlayers.map((player) => {
                const key = `${game.remoteId}:${player.playerId}`;
                const status = rsvpByKey.get(key);
                const isSaving = savingKeys.has(key);
                return (
                  <View key={player.playerId} className="flex-row items-center justify-between">
                    {myPlayers.length > 1 && (
                      <Text className="text-xs text-gray-500 mr-2" numberOfLines={1}>
                        {player.playerName.split(' ')[0]}
                      </Text>
                    )}
                    <View className="flex-row gap-1.5">
                      {RSVP_OPTIONS.map((opt) => (
                        <TouchableOpacity
                          key={opt.status}
                          accessibilityRole="button"
                          accessibilityState={{ selected: status === opt.status, busy: isSaving }}
                          accessibilityLabel={`${player.playerName}: ${opt.label}`}
                          disabled={isSaving}
                          onPress={() => setRsvp(game.remoteId, player.playerId, opt.status)}
                          className={`px-2.5 py-1 rounded-full border ${
                            isSaving ? 'opacity-50' : ''
                          } ${status === opt.status ? opt.activeClass : 'bg-white border-gray-200'}`}
                        >
                          <Text
                            className={`text-xs font-semibold ${
                              status === opt.status ? 'text-white' : 'text-gray-600'
                            }`}
                          >
                            {opt.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </TouchableOpacity>
      )}
    />
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    scheduled: 'bg-blue-100 text-blue-700',
    in_progress: 'bg-red-100 text-red-700',
    completed: 'bg-gray-100 text-gray-600',
    cancelled: 'bg-gray-100 text-gray-400',
    postponed: 'bg-yellow-100 text-yellow-700',
  };
  const labels: Record<string, string> = {
    scheduled: 'Scheduled',
    in_progress: 'Live',
    completed: 'Final',
    cancelled: 'Cancelled',
    postponed: 'Postponed',
  };

  return (
    <View className={`px-2 py-0.5 rounded-full ${styles[status] ?? 'bg-gray-100'}`}>
      <Text className="text-xs font-medium">{labels[status] ?? status}</Text>
    </View>
  );
}

// Connect to WatermelonDB observable
const GamesListEnhanced = withObservables([], () => ({
  games: database
    .get<Game>('games')
    .query(Q.sortBy('scheduled_at', Q.asc))
    .observe(),
}))((GamesListobs: { games: Game[] }) => <GamesList games={GamesListobs.games} />);

export default function GamesScreen() {
  return (
    <View className="flex-1 bg-gray-50">
      <GamesListEnhanced />
    </View>
  );
}
