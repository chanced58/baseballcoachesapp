import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Q } from '@nozbe/watermelondb';
import withObservables from '@nozbe/with-observables';
import { weAreHome } from '@baseball/shared';
import { useAuth } from '../../src/providers/AuthProvider';
import { useSyncContext } from '../../src/providers/SyncProvider';
import { useRole } from '../../src/providers/RoleProvider';
import { useGameState } from '../../src/features/scoring/use-game-state';
import { database } from '../../src/db';
import type { Game } from '../../src/db/models/Game';

/**
 * Resume control for a game being scored right now.
 *
 * A scorer who backs out mid-game — to check a message, or because the app
 * was killed — otherwise has to remember which game they were on and dig it
 * out of the games list. This puts it first on the home screen, where it is
 * the only thing they are likely to want.
 *
 * The score comes from replaying the local event log rather than from the
 * games mirror's home_score/away_score columns: those are written server-side
 * at finalisation, so mid-game they still read 0-0 while the real score has
 * moved on.
 */
function LiveGameCard({ game }: { game: Game }) {
  const { activeTeam } = useRole();
  const { gameState } = useGameState(game.remoteId, game.teamId);

  const isHome = weAreHome(game.locationType, game.neutralHomeTeam ?? null);
  const opponentName = game.opponentName || 'TBD';
  const teamName = activeTeam?.teamName ?? 'Home';
  const ourScore = gameState ? (isHome ? gameState.homeScore : gameState.awayScore) : null;
  const theirScore = gameState ? (isHome ? gameState.awayScore : gameState.homeScore) : null;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Game in progress against ${opponentName}. Resume scoring.`}
      className="bg-white rounded-xl border-2 border-red-200 p-5 mb-3"
      onPress={() =>
        router.push({
          pathname: '/(tabs)/games/[gameId]/score',
          params: {
            gameId: game.remoteId,
            teamId: game.teamId,
            opponentName,
            teamName,
          },
        })
      }
    >
      <View className="flex-row items-center mb-1.5">
        <View className="w-2 h-2 rounded-full bg-red-500 mr-2" />
        <Text className="text-[11px] font-bold text-red-700 tracking-wide">
          GAME IN PROGRESS
        </Text>
      </View>

      <Text className="text-lg font-semibold text-gray-900">vs {opponentName}</Text>

      {gameState ? (
        <Text className="text-gray-500 text-sm mt-0.5">
          <Text className="font-semibold text-gray-900">
            {ourScore}–{theirScore}
          </Text>
          <Text>
            {'  ·  '}
            {gameState.isTopOfInning ? 'Top' : 'Bot'} {gameState.inning} · {gameState.outs} out
          </Text>
        </Text>
      ) : (
        <Text className="text-gray-500 text-sm mt-0.5">Tap to resume scoring</Text>
      )}
    </TouchableOpacity>
  );
}

const LiveGames = withObservables([], () => ({
  games: database
    .get<Game>('games')
    .query(Q.where('status', 'in_progress'), Q.sortBy('scheduled_at', Q.asc))
    .observe(),
}))(({ games }: { games: Game[] }) => (
  <>
    {games.map((game) => (
      <LiveGameCard key={game.id} game={game} />
    ))}
  </>
));

export default function HomeScreen() {
  const { user, signOut } = useAuth();
  const { isSyncing } = useSyncContext();

  return (
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-5 pt-6 pb-4">
        <Text className="text-2xl font-bold text-gray-900">Dashboard</Text>
        <Text className="text-gray-500 text-sm mt-1">{user?.email}</Text>
      </View>

      {isSyncing && (
        <View className="mx-5 mb-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2">
          <Text className="text-blue-700 text-sm">Syncing...</Text>
        </View>
      )}

      <View className="px-5 space-y-3">
        {/* Renders nothing when no game is live, so the home screen keeps its
            usual shape the rest of the time. */}
        <LiveGames />

        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 p-5"
          onPress={() => router.push('/(tabs)/games')}
        >
          <Text className="text-lg font-semibold text-gray-900 mb-1">Today's Games</Text>
          <Text className="text-gray-500 text-sm">View schedule and score a game</Text>
        </TouchableOpacity>

        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 p-5"
          onPress={() => router.push('/(tabs)/schedule')}
        >
          <Text className="text-lg font-semibold text-gray-900 mb-1">Schedule</Text>
          <Text className="text-gray-500 text-sm">Upcoming games and RSVPs</Text>
        </TouchableOpacity>

        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 p-5"
          onPress={() => router.push('/(tabs)/practices')}
        >
          <Text className="text-lg font-semibold text-gray-900 mb-1">Practices</Text>
          <Text className="text-gray-500 text-sm">Upcoming practices and attendance</Text>
        </TouchableOpacity>

        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 p-5"
          onPress={() => router.push('/(tabs)/roster')}
        >
          <Text className="text-lg font-semibold text-gray-900 mb-1">Roster</Text>
          <Text className="text-gray-500 text-sm">Players and pitch counts</Text>
        </TouchableOpacity>

        <TouchableOpacity
          className="bg-white rounded-xl border border-gray-200 p-5"
          onPress={() => router.push('/(tabs)/messages')}
        >
          <Text className="text-lg font-semibold text-gray-900 mb-1">Messages</Text>
          <Text className="text-gray-500 text-sm">Team channels and announcements</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        className="mx-5 mt-8 mb-6 py-3 rounded-xl border border-gray-300 items-center"
        onPress={signOut}
      >
        <Text className="text-gray-600 font-medium">Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
