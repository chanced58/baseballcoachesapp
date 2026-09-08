import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  TextInput,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useGameState } from '../../../../src/features/scoring/use-game-state';
import { useRecordEvent } from '../../../../src/features/scoring/use-record-event';
import { ScoreBoard } from '../../../../src/features/scoring/ScoreBoard';
import { CountDisplay } from '../../../../src/features/scoring/CountDisplay';
import { BaserunnerDisplay } from '../../../../src/features/scoring/BaserunnerDisplay';
import { PitchInput } from '../../../../src/features/scoring/PitchInput';
import { GuestPlayerModal } from '../../../../src/features/scoring/GuestPlayerModal';
import { useDefensiveLineup } from '../../../../src/features/scoring/use-defensive-lineup';
import { LoadingSpinner } from '@baseball/ui';
import { Q } from '@nozbe/watermelondb';
import { EventType, PitchOutcome, HitType, HitTrajectory, AdvanceReason, type PitchType, weAreHome, getMaxBattingOrder, isMidGameExtensionAllowed, isDroppedThirdStrikeAllowed, evaluateGameEnd, shouldEndHalfForRunCap, ghostRunnerBaseForHalf, applyLineupSubstitutions, deriveDueBatter, attributePlayersForHalf, OUTS_PER_INNING, getPitchComplianceStatus, FIELDING_POSITION_NUMBERS, formatFieldingSequence } from '@baseball/shared';
import type { PitchThrownPayload, HitPayload, OutPayload, DroppedThirdStrikePayload, DroppedThirdStrikeOutcome, BaserunnerMovePayload, PickoffPayload, ScorePayload, EventVoidedPayload, SubstitutionPayload, PitchingChangePayload, BattingSlot, HalfAttribution } from '@baseball/shared';
import { SubstitutionType } from '@baseball/shared';
import { useLeagueContext } from '../../../../src/lib/league-settings';
import { database } from '../../../../src/db';
import type { GameEvent as WdbGameEvent } from '../../../../src/db/models/GameEvent';
import type { Game } from '../../../../src/db/models/Game';
import type { Player } from '../../../../src/db/models/Player';
import type { BattedOutType, RosterPlayer, RunnerOutcome } from '../../../../src/features/scoring/PitchInput';
import { useSyncContext } from '../../../../src/providers/SyncProvider';
import { addLineupRow, createLocalGuest } from '../../../../src/features/lineup/local-guest';
import { useGameLineups } from '../../../../src/features/lineup/use-game-lineups';
import { useOpponentLineup, type OpponentBatter } from '../../../../src/features/lineup/use-opponent-lineup';
import {
  addNewOpponentBatter,
  addOpponentBatterFromRoster,
  opponentDisplayName,
} from '../../../../src/features/lineup/opponent-lineup';

/**
 * Live game scoring screen — the core feature of the mobile app.
 * Works completely offline. All events written to WatermelonDB first,
 * then synced to Supabase in the background.
 */
export default function ScoringScreen() {
  const { gameId, teamId: teamIdParam = '', opponentName = 'Opponent', teamName = 'Home' } =
    useLocalSearchParams<{
      gameId: string;
      teamId: string;
      opponentName: string;
      teamName: string;
    }>();

  const router = useRouter();

  // Resolve the Game row from the local DB — the games list only passes the
  // game id, so team identity (roster, league settings) and home/away must
  // come from the synced games mirror, not route params.
  const [game, setGame] = useState<Game | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const matches = await database
          .get<Game>('games')
          .query(Q.where('remote_id', gameId))
          .fetch();
        if (!cancelled) setGame(matches[0] ?? null);
      } catch (err) {
        console.warn(`Score game lookup failed game=${gameId}:`, err);
      }
    })();
    return () => { cancelled = true; };
  }, [gameId]);
  const teamId = game?.teamId ?? (teamIdParam as string);
  const isHome = game ? weAreHome(game.locationType, game.neutralHomeTeam ?? null) : true;
  // ScoreBoard maps teamName→homeScore and opponentName→awayScore, so the
  // labels must be the actual home/away teams, not our-team/opponent — for a
  // road game those are swapped.
  const homeLabel = isHome ? (teamName as string) : (opponentName as string);
  const awayLabel = isHome ? (opponentName as string) : (teamName as string);

  // Tablet-width layouts put game state and the input surface side by side
  // instead of stacking them, so a scorer on a dugout iPad can see the count,
  // baserunners and due batter while recording the play. Keyed off width
  // rather than device type so it also follows rotation and split view.
  const { width: windowWidth } = useWindowDimensions();
  const isWide = windowWidth >= 768;

  const { gameState, lineScore, events, loading } = useGameState(gameId, teamId);
  const { recordEvent } = useRecordEvent(gameId);
  const { isSyncing, lastSyncError, isOffline, pendingEventsCount, triggerSync } = useSyncContext();
  const { settings: leagueSettings, leagueId, pitchRule } = useLeagueContext(teamId);
  const maxBatters = getMaxBattingOrder(leagueSettings);
  const midGameExtensionAllowed = isMidGameExtensionAllowed(leagueSettings);

  // League-rule advisories — mercy / run cap / regulation complete. These
  // surface banners; the coach still confirms via the existing End Game /
  // Inning Change controls.
  const gameEndDecision = gameState && lineScore
    ? evaluateGameEnd(
        leagueSettings,
        lineScore,
        gameState.inning,
        gameState.isTopOfInning,
        gameState.outs,
      )
    : null;
  const runCapReached = gameState && lineScore
    ? shouldEndHalfForRunCap(
        leagueSettings,
        lineScore,
        gameState.inning,
        gameState.isTopOfInning,
      )
    : false;
  const ghostRunnerBase = gameState
    ? ghostRunnerBaseForHalf(
        leagueSettings,
        gameState.inning,
        gameState.outs,
        gameState.runnersOnBase,
      )
    : null;

  // Roster for substitution + pitching-change pickers.
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      const players = await database
        .get<Player>('players')
        .query(Q.where('team_id', teamId), Q.where('is_active', true), Q.sortBy('last_name', Q.asc))
        .fetch();
      if (cancelled) return;
      setRoster(
        players.map((p) => ({
          id: p.remoteId,
          name: p.fullName,
          jerseyNumber: p.jerseyNumber,
          firstName: p.firstName,
          lastName: p.lastName,
          primaryPosition: p.primaryPosition ?? null,
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  // currentPitcherId is derived from GAME_START / PITCHING_CHANGE /
  // PITCH_THROWN events. When unset, emitted events carry undefined for
  // those fields (the payload types are optional) and stats modules skip
  // the event rather than attribute to a fake player. Scorer establishes
  // the starting values via the "Set Lineup" modal below.
  const currentPitcherId = gameState?.currentPitcherId ?? undefined;
  const defensiveLineup = useDefensiveLineup(gameId, roster);
  const [showLineupModal, setShowLineupModal] = useState(false);

  // The current batting order, observed reactively from the local WatermelonDB
  // game_lineups mirror (synced both ways with Supabase). Drives the due-batter
  // rotation, and the Add Batter flow uses it to know (a) which players are
  // already in the order and (b) the current max batting_order so the new
  // batter lands at end+1.
  const { rows: observedLineupRows, loaded: lineupLoaded } = useGameLineups(gameId);
  const lineupRows = useMemo(
    () =>
      observedLineupRows.map((row) => ({
        player_id: row.playerRemoteId,
        batting_order: row.battingOrder ?? null,
      })),
    [observedLineupRows],
  );

  // ─── Due batter ──────────────────────────────────────────────────────────
  // Our batting order with in-game SUBSTITUTION events (pinch hitters,
  // lineup extensions) folded in, cycled by our team's completed PAs — the
  // same index-based derivation the web ScoringBoard uses.
  const battingSlots = useMemo<BattingSlot[]>(
    () =>
      applyLineupSubstitutions(
        observedLineupRows
          .filter((row) => row.battingOrder != null)
          .map((row) => ({ playerId: row.playerRemoteId, battingOrder: row.battingOrder! })),
        events,
      ),
    [observedLineupRows, events],
  );
  const ourTeamPAs = gameState
    ? (isHome ? gameState.completedBottomHalfPAs : gameState.completedTopHalfPAs)
    : 0;
  const dueBatter = deriveDueBatter(battingSlots, ourTeamPAs);

  // Per-PA manual override — the scorer can point the rotation at a
  // different batter (lineup drifted, skipped batter). Cleared when the PA
  // completes; a mid-PA inning change (3rd out on the bases) keeps both the
  // PA count and the override, matching the batter carrying over.
  const [batterOverrideId, setBatterOverrideId] = useState<string | null>(null);
  useEffect(() => {
    setBatterOverrideId(null);
  }, [ourTeamPAs]);

  const weBat = gameState ? (isHome ? !gameState.isTopOfInning : gameState.isTopOfInning) : false;

  // ─── The opposing side ───────────────────────────────────────────────────
  // Their roster and batting order, mirrored locally so a scorer keeping the
  // other team's book keeps working with no signal. Without this every
  // opponent plate appearance is anonymous: nothing to attribute a hit to,
  // and nothing to show the coach about who is coming up.
  const { roster: opponentRoster, slots: opponentSlots } = useOpponentLineup(
    gameId,
    game?.opponentTeamId,
  );
  // Their completed PAs are the other half's — the mirror of ourTeamPAs.
  const opponentPAs = gameState
    ? (isHome ? gameState.completedTopHalfPAs : gameState.completedBottomHalfPAs)
    : 0;
  const opponentDueBatter = deriveDueBatter(
    opponentSlots.map((s) => ({ playerId: s.playerId, battingOrder: s.battingOrder })),
    opponentPAs,
  );
  const [opponentBatterOverrideId, setOpponentBatterOverrideId] = useState<string | null>(null);
  useEffect(() => {
    setOpponentBatterOverrideId(null);
  }, [opponentPAs]);
  const opponentBatterId =
    opponentBatterOverrideId ?? opponentDueBatter?.playerId ?? gameState?.currentBatterId ?? null;
  const opponentNameById = useMemo(
    () => new Map(opponentSlots.map((s) => [s.playerId, s.name])),
    [opponentSlots],
  );
  const [showOpponentBatterPicker, setShowOpponentBatterPicker] = useState(false);
  const [showAddOpponentBatter, setShowAddOpponentBatter] = useState(false);
  const [showAddOurBatter, setShowAddOurBatter] = useState(false);
  const [caughtStealingFor, setCaughtStealingFor] =
    useState<{ base: 1 | 2 | 3; runnerId: string; name: string } | null>(null);

  /**
   * Add someone to the opposing order mid-game, either from their known
   * roster or as a brand-new name. Both write locally first; the sync engine
   * pushes the player before the lineup row so the FK holds.
   */
  async function handleAddOpponentBatter(input:
    | { kind: 'roster'; opponentPlayerId: string }
    | { kind: 'new'; firstName: string; lastName: string; jerseyNumber: string }
  ): Promise<string | null> {
    const result =
      input.kind === 'roster'
        ? await addOpponentBatterFromRoster({
            gameRemoteId: gameId,
            opponentPlayerRemoteId: input.opponentPlayerId,
            maxBatters,
          })
        : game?.opponentTeamId
          ? await addNewOpponentBatter({
              gameRemoteId: gameId,
              opponentTeamId: game.opponentTeamId,
              firstName: input.firstName,
              lastName: input.lastName,
              jerseyNumber: input.jerseyNumber,
              maxBatters,
            })
          : ({ ok: false, message: 'This game has no opponent team on file.' } as const);

    if (!result.ok) return result.message;
    setShowAddOpponentBatter(false);
    // Sync opportunistically — a failure here is invisible and harmless, the
    // rows are already durable locally and the next cycle will carry them.
    triggerSync().catch(() => {});
    return null;
  }

  /**
   * Add someone to OUR order mid-game: a rostered player who wasn't in the
   * pre-game lineup, or a late arrival who isn't on the roster at all.
   *
   * The second path creates a guest-only identity, the same shape the guest
   * picker produces. It is offered whatever the league's guests.allowed
   * setting says: that flag governs whether outside players may appear in a
   * league's games, and a coach standing at a field with a player in front of
   * them needs to record what actually happened either way. countTowardStats
   * still follows the league default, so the rule keeps its effect on the
   * numbers.
   */
  async function handleAddOurBatter(input:
    | { kind: 'roster'; opponentPlayerId: string }
    | { kind: 'new'; firstName: string; lastName: string; jerseyNumber: string }
  ): Promise<string | null> {
    if (input.kind === 'roster') {
      await handleAddBatter(input.opponentPlayerId);
      setShowAddOurBatter(false);
      return null;
    }

    const jersey = input.jerseyNumber.trim();
    const result = await createLocalGuest({
      gameRemoteId: gameId,
      leagueId: leagueId ?? null,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      jerseyNumber: jersey ? Number(jersey) : null,
      countTowardStats: leagueSettings.guests.countTowardStatsDefault,
      maxBatters,
    });
    if (!result.ok) return result.message;
    setShowAddOurBatter(false);
    triggerSync().catch(() => {});
    return null;
  }

  // Who follows the batter at the plate, in whichever order is batting —
  // one PA past the current hitter, and past a manual override too, so
  // pointing the rotation at someone else moves on-deck with it.
  //
  // Falls back to our own due batter when the opponent is up and we have no
  // order for them: nobody is at our plate then, so the due batter already IS
  // who leads off our next turn and the slot after them would skip a hitter.
  const nextBatter = useMemo(() => {
    const slots = weBat
      ? battingSlots
      : opponentSlots.map((s) => ({ playerId: s.playerId, battingOrder: s.battingOrder }));
    const overrideId = weBat ? batterOverrideId : opponentBatterOverrideId;
    const current = weBat ? dueBatter : opponentDueBatter;

    if (slots.length === 0) return weBat ? null : dueBatter;

    const overrideIndex = overrideId
      ? [...slots]
          .sort((a, b) => a.battingOrder - b.battingOrder)
          .findIndex((slot) => slot.playerId === overrideId)
      : -1;
    const currentIndex = overrideIndex >= 0 ? overrideIndex : current?.index ?? -1;
    if (currentIndex < 0) return null;
    return deriveDueBatter(slots, currentIndex + 1);
  }, [
    weBat, battingSlots, opponentSlots, batterOverrideId,
    opponentBatterOverrideId, dueBatter, opponentDueBatter,
  ]);
  /**
   * Name for a next-up slot. The id came from whichever order is batting, so
   * try the opponent's names first and fall back to ours — the two id spaces
   * are disjoint (players vs opponent_players), so a hit is unambiguous.
   */
  const nextBatterName = (playerId: string) =>
    opponentNameById.get(playerId) ?? batterName(playerId);
  // Effective batter for our offensive half: manual override → lineup-derived
  // due batter → engine state (GAME_START leadoff when no lineup is set).
  const ourBatterId = batterOverrideId ?? dueBatter?.playerId ?? gameState?.currentBatterId ?? null;
  /** Whoever is actually at the plate right now, either side. */
  const currentPlateBatterId = weBat ? ourBatterId : opponentBatterId;
  const battingOrderTitle = weBat
    ? `${teamName} batting order`
    : `${opponentName} batting order`;
  const onDeckBatterId =
    nextBatter && nextBatter.playerId !== currentPlateBatterId
      ? nextBatter.playerId
      : null;


  // Our current pitcher, derived from the event stream so it persists across
  // innings — gameState.currentPitcherId is reset to null by INNING_CHANGE, so
  // relying on it would drop pitcher attribution (and pitch counts) from the
  // second defensive inning on. GAME_START seeds our starter; our own
  // PITCHING_CHANGE events update it.
  const ourPitcherId = useMemo(() => {
    let pid: string | null = null;
    for (const ev of events) {
      if (ev.eventType === EventType.GAME_START) {
        const p = ev.payload as { homeLineupPitcherId?: string; awayLineupPitcherId?: string };
        pid = (isHome ? p.homeLineupPitcherId : p.awayLineupPitcherId) ?? pid;
      } else if (ev.eventType === EventType.PITCHING_CHANGE) {
        const p = ev.payload as { newPitcherId?: string; isOpponentChange?: boolean };
        if (!p.isOpponentChange && p.newPitcherId) pid = p.newPitcherId;
      }
    }
    return pid;
  }, [events, isHome]);

  // Every platform player id we can safely attribute events to: our roster
  // plus everyone in the lineup (guests included). Ids outside this set are
  // opponent players (or stale leaks) and must go in opponent* fields.
  const ourPlayerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of roster) ids.add(p.id);
    for (const row of observedLineupRows) ids.add(row.playerRemoteId);
    return ids;
  }, [roster, observedLineupRows]);

  // Half-aware batter/pitcher payload attribution. Replaces the old fixed
  // batterId/pitcherId spread, which mis-filed opponent ids under batterId
  // during the opponent's offensive half.
  const halfAttribution: HalfAttribution = gameState
    ? attributePlayersForHalf({
        weAreHome: isHome,
        isTopOfInning: gameState.isTopOfInning,
        ourBatterId,
        ourPitcherId,
        statePitcherId: gameState.currentPitcherId,
        // Prefer the batter derived from the opponent's own order over
        // gameState.currentBatterId. The latter is only ever set by a
        // previous PITCH_THROWN, so for an opponent half it is null until
        // someone has already batted anonymously — which is exactly the gap
        // that left their runners without an identity.
        stateBatterId: opponentBatterId ?? gameState.currentBatterId,
        ourPlayerIds,
      })
    : {};
  // Pitcher-only subset for baserunning payloads (pickoffs, runner outs).
  const pitcherAttribution = {
    ...(halfAttribution.pitcherId ? { pitcherId: halfAttribution.pitcherId } : {}),
    ...(halfAttribution.opponentPitcherId
      ? { opponentPitcherId: halfAttribution.opponentPitcherId }
      : {}),
  };

  // Display names for the "Now batting" strip + batter picker: roster names
  // win; ad-hoc guests fall back to their lineup display name.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of observedLineupRows) {
      if (row.guestDisplayName) m.set(row.playerRemoteId, row.guestDisplayName);
    }
    for (const p of roster) m.set(p.id, p.name);
    return m;
  }, [roster, observedLineupRows]);
  const [showBatterPicker, setShowBatterPicker] = useState(false);

  // League-pool guests (and any other lineup player outside the roster whose
  // row carries no display name) still have a local players row — resolve
  // their names so the batter strip/picker never shows "Unknown".
  const [extraNames, setExtraNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const missing = battingSlots
      .map((s) => s.playerId)
      .filter((id) => !nameById.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const players = await database
        .get<Player>('players')
        .query(Q.where('remote_id', Q.oneOf(missing)))
        .fetch();
      if (cancelled) return;
      setExtraNames((prev) => ({
        ...prev,
        ...Object.fromEntries(players.map((p) => [p.remoteId, p.fullName])),
      }));
    })();
    return () => { cancelled = true; };
  }, [battingSlots, nameById]);
  const batterName = (id: string) => nameById.get(id) ?? extraNames[id] ?? 'Unknown batter';

  /**
   * The batting team's order, whichever side that is — the card the scorer
   * reads between pitches to see who is up, who follows, and who is due an
   * inning from now. Positions come from the lineup row (a mid-game move is
   * reflected) and fall back to the player's usual spot.
   */
  const battingOrderView = useMemo<BattingOrderRow[]>(() => {
    if (!weBat) {
      return opponentSlots.map((slot) => ({
        playerId: slot.playerId,
        battingOrder: slot.battingOrder,
        name: slot.name,
        position: slot.startingPosition ?? null,
      }));
    }
    const positionByPlayer = new Map(
      observedLineupRows.map((row) => [row.playerRemoteId, row.startingPosition ?? null]),
    );
    const rosterById = new Map(roster.map((p) => [p.id, p]));
    return [...battingSlots]
      .sort((a, b) => a.battingOrder - b.battingOrder)
      .map((slot) => {
        const player = rosterById.get(slot.playerId);
        const name = batterName(slot.playerId);
        return {
          playerId: slot.playerId,
          battingOrder: slot.battingOrder,
          name: player?.jerseyNumber != null ? `#${player.jerseyNumber} ${name}` : name,
          position:
            positionByPlayer.get(slot.playerId) ?? player?.primaryPosition ?? null,
        };
      });
  }, [weBat, opponentSlots, battingSlots, observedLineupRows, roster, nameById, extraNames]);

  const gameStarted = useMemo(
    () => events.some((e) => e.eventType === EventType.GAME_START),
    [events],
  );

  // What this game is tracking, chosen by the scorer at start and carried on
  // the GAME_START payload. Same keys and `!== false` defaulting as the web
  // scorer (see score/page.tsx) so a game started on either client reads the
  // same on the other, and games started before the toggles existed keep the
  // old always-on behavior.
  const scoringConfig = useMemo(() => {
    const startEvent = events.find((e) => e.eventType === EventType.GAME_START);
    const gsp = (startEvent?.payload ?? {}) as Record<string, unknown>;
    return {
      pitchType: gsp.pitchTypeEnabled !== false,
      pitchLocation: gsp.pitchLocationEnabled !== false,
    };
  }, [events]);

  // ─── Pitch-count compliance ─────────────────────────────────────────────
  // Cumulative game total for the pitcher of record (the old label called
  // this "Pitches (this AB)" but currentPitcherPitchCount was always the
  // game total). Compliance thresholds come from the league's default rule.
  //
  // On defense the pitcher of record is ours (from ourPitcherId, which
  // survives inning changes); on offense it's the opponent's. The compliance
  // chip is shown only for our own pitcher — applying our league's rule to
  // the opponent's pitcher would be meaningless.
  const gameDateIso = game ? new Date(game.scheduledAt).toISOString() : new Date().toISOString();
  const displayPitcherId = weBat
    ? (gameState?.currentPitcherId ?? null)
    : (ourPitcherId ?? gameState?.currentPitcherId ?? null);
  const currentPitchTotal =
    gameState && displayPitcherId
      ? gameState.pitcherPitchCounts[displayPitcherId] ?? 0
      : gameState?.currentPitcherPitchCount ?? 0;
  const pitchStatus =
    pitchRule && displayPitcherId && ourPlayerIds.has(displayPitcherId)
      ? getPitchComplianceStatus(displayPitcherId, currentPitchTotal, pitchRule, gameDateIso)
      : null;
  const currentStrikeTotal =
    gameState && displayPitcherId ? gameState.pitcherStrikeCounts[displayPitcherId] ?? 0 : 0;

  // Game totals for the staff currently on the mound — the current pitcher's
  // own line plus everyone who preceded them for that team. Summed over the
  // side displayPitcherId belongs to, so a relief appearance reads against
  // the team's workload rather than against both teams' pitches combined.
  const staffTotals = useMemo(() => {
    if (!gameState) return { pitches: 0, strikes: 0 };
    const displayPitcherIsOurs = displayPitcherId ? ourPlayerIds.has(displayPitcherId) : !weBat;
    let pitches = 0;
    let strikes = 0;
    for (const [pitcherId, count] of Object.entries(gameState.pitcherPitchCounts)) {
      if (ourPlayerIds.has(pitcherId) !== displayPitcherIsOurs) continue;
      pitches += count;
      strikes += gameState.pitcherStrikeCounts[pitcherId] ?? 0;
    }
    return { pitches, strikes };
  }, [gameState, displayPitcherId, ourPlayerIds, weBat]);

  // Per-roster-player pitch totals + compliance level for the pitching-change
  // picker, so the coach sees who is near/over their limit before choosing.
  const pitcherBadges = useMemo(() => {
    if (!gameState) return {};
    const badges: Record<string, { count: number; level: 'ok' | 'warning' | 'danger' | 'over' }> = {};
    for (const p of roster) {
      const count = gameState.pitcherPitchCounts[p.id] ?? 0;
      let level: 'ok' | 'warning' | 'danger' | 'over' = 'ok';
      if (pitchRule) {
        const s = getPitchComplianceStatus(p.id, count, pitchRule, gameDateIso);
        level = s.isOverLimit ? 'over' : s.isAtLimit ? 'danger' : s.isAtWarning ? 'warning' : 'ok';
      }
      badges[p.id] = { count, level };
    }
    return badges;
  }, [gameState, roster, pitchRule, gameDateIso]);

  // Dropped-third-strike modal — opened either by the manual button in
  // PitchInput, or automatically by handlePitch when a 3rd-strike pitch is
  // recorded with D3K eligibility (first base empty or two outs).
  const [showD3KModal, setShowD3KModal] = useState(false);
  // Guest-player modal — open via the small button on the score screen,
  // gated on the league's guests.allowed flag.
  const [showGuestModal, setShowGuestModal] = useState(false);

  async function handlePitch(
    outcome: PitchOutcome,
    pitchType?: PitchType,
    zoneLocation?: number,
  ) {
    if (!gameState) return;
    const payload: PitchThrownPayload = {
      ...halfAttribution,
      outcome,
      ...(pitchType ? { pitchType } : {}),
      // 0 is a meaningful value here (outside the zone), so check for
      // undefined rather than truthiness.
      ...(zoneLocation !== undefined ? { zoneLocation } : {}),
    };
    await recordEvent(
      EventType.PITCH_THROWN,
      gameState.inning,
      gameState.isTopOfInning,
      payload,
    );

    // HBP is a two-event pair (mirrors the web ScoringBoard): the pitch
    // records the delivery; the HIT_BY_PITCH event places the batter on
    // first and force-advances runners in deriveGameState + stats.
    if (outcome === PitchOutcome.HIT_BY_PITCH) {
      await recordEvent(EventType.HIT_BY_PITCH, gameState.inning, gameState.isTopOfInning, {
        ...halfAttribution,
      });
      return;
    }

    // Auto-complete walks and strikeouts from pitch progression so the scorer
    // doesn't need to tap a separate button. gameState here is the pre-pitch
    // value; +1 reflects the increment this pitch will produce.
    if (outcome === PitchOutcome.BALL && gameState.balls + 1 >= 4) {
      await handleWalk();
      return;
    }
    const isStrikePitch =
      outcome === PitchOutcome.SWINGING_STRIKE ||
      outcome === PitchOutcome.CALLED_STRIKE ||
      outcome === PitchOutcome.FOUL_TIP;
    if (isStrikePitch && gameState.strikes + 1 >= 3) {
      // Per OBR 5.05(a)(2): D3K only applies when first base is unoccupied
      // or there are two outs. Otherwise the batter is out regardless. Some
      // youth leagues disable the rule entirely (settings.rules.droppedThirdStrike).
      const eligible =
        isDroppedThirdStrikeAllowed(leagueSettings) &&
        (gameState.outs === 2 || !gameState.runnersOnBase.first);
      if (eligible) {
        setShowD3KModal(true);
      } else {
        await handleStrikeout();
      }
    }
  }

  async function handleHit(hitType: HitType) {
    if (!gameState) return;
    const payload: HitPayload = {
      ...halfAttribution,
      hitType,
    };
    await recordEvent(EventType.HIT, gameState.inning, gameState.isTopOfInning, payload);
  }

  // Records the HIT plus any linked BASERUNNER_OUT / BASERUNNER_ADVANCE
  // events (via relatedEventId) so the engine + stats correctly suppress
  // default scoring for held or thrown-out runners and so the play feed
  // shows e.g. "Double (Runner thrown out at 3B)".
  async function handleHitWithRunnerOutcomes(hitType: HitType, outcomes: RunnerOutcome[]) {
    if (!gameState) return;
    const payload: HitPayload = {
      ...halfAttribution,
      hitType,
    };
    const hitId = await recordEvent(
      EventType.HIT,
      gameState.inning,
      gameState.isTopOfInning,
      payload,
    );
    for (const outcome of outcomes) {
      if (outcome.kind === 'auto') continue;
      if (outcome.kind === 'thrown_out') {
        await recordEvent(EventType.BASERUNNER_OUT, gameState.inning, gameState.isTopOfInning, {
          runnerId: outcome.runnerId,
          fromBase: outcome.fromBase,
          ...pitcherAttribution,
          relatedEventId: hitId,
          reason: AdvanceReason.ON_PLAY,
        });
      } else {
        // 'held' — runner stops short of the default advance.
        await recordEvent(EventType.BASERUNNER_ADVANCE, gameState.inning, gameState.isTopOfInning, {
          runnerId: outcome.runnerId,
          fromBase: outcome.fromBase,
          toBase: outcome.toBase,
          reason: AdvanceReason.ON_PLAY,
          relatedEventId: hitId,
        });
      }
    }
  }

  async function handleOut(outType: BattedOutType) {
    if (!gameState) return;
    const trajectory: HitTrajectory | undefined =
      outType === 'groundout' ? HitTrajectory.GROUND_BALL
      : outType === 'flyout' ? HitTrajectory.FLY_BALL
      : outType === 'lineout' ? HitTrajectory.LINE_DRIVE
      : outType === 'popout' ? HitTrajectory.FLY_BALL
      : undefined;
    const payload: OutPayload = {
      ...halfAttribution,
      outType,
      ...(trajectory ? { trajectory } : {}),
    };
    await recordEvent(EventType.OUT, gameState.inning, gameState.isTopOfInning, payload);
  }

  async function handleWalk() {
    if (!gameState) return;
    await recordEvent(EventType.WALK, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
    });
  }

  async function handleStrikeout() {
    if (!gameState) return;
    const payload: OutPayload = {
      ...halfAttribution,
      outType: 'strikeout',
    };
    await recordEvent(EventType.STRIKEOUT, gameState.inning, gameState.isTopOfInning, payload);
  }

  async function handleError(errorBy: number) {
    if (!gameState) return;
    await recordEvent(EventType.FIELD_ERROR, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
      errorBy,
    });
  }

  async function handleCatcherInterference() {
    if (!gameState) return;
    await recordEvent(EventType.CATCHER_INTERFERENCE, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
    });
  }

  async function handleSacrificeFly() {
    if (!gameState) return;
    await recordEvent(EventType.SACRIFICE_FLY, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
    });
  }

  async function handleSacrificeBunt() {
    if (!gameState) return;
    await recordEvent(EventType.SACRIFICE_BUNT, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
    });
  }

  // Sacrifice path that came from the Out modal — the scorer first picked
  // a trajectory, then upgraded it to a sacrifice. We carry the trajectory
  // on the payload so the play preserves the context the scorer already
  // identified (e.g. flyout → sac fly retains FLY_BALL).
  function trajectoryForOutType(outType: BattedOutType): HitTrajectory | undefined {
    return outType === 'groundout' ? HitTrajectory.GROUND_BALL
      : outType === 'flyout' ? HitTrajectory.FLY_BALL
      : outType === 'lineout' ? HitTrajectory.LINE_DRIVE
      : outType === 'popout' ? HitTrajectory.FLY_BALL
      : undefined;
  }

  async function handleSacrificeFlyFromOut(outType: BattedOutType) {
    if (!gameState) return;
    const trajectory = trajectoryForOutType(outType);
    await recordEvent(EventType.SACRIFICE_FLY, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
      ...(trajectory ? { trajectory } : {}),
    });
  }

  async function handleSacrificeBuntFromOut(outType: BattedOutType) {
    if (!gameState) return;
    const trajectory = trajectoryForOutType(outType);
    await recordEvent(EventType.SACRIFICE_BUNT, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
      ...(trajectory ? { trajectory } : {}),
    });
  }

  async function handleStolenBase(fromBase: 1 | 2 | 3, runnerId: string) {
    if (!gameState) return;
    const toBase = (fromBase + 1) as 2 | 3 | 4;
    const payload: BaserunnerMovePayload = { runnerId, fromBase, toBase };
    await recordEvent(EventType.STOLEN_BASE, gameState.inning, gameState.isTopOfInning, payload);
    if (toBase === 4) {
      const scorePayload: ScorePayload = { scoringPlayerId: runnerId, rbis: 0 };
      await recordEvent(EventType.SCORE, gameState.inning, gameState.isTopOfInning, scorePayload);
    }
  }

  /**
   * Opens the fielding-sequence prompt rather than recording immediately.
   *
   * A caught stealing is a putout and is scored like one — 2-6, 2-4, 2-5 —
   * and the sequence is what a coach reads back later to see how the play
   * went. Both entry points (the runners panel and the base-tap sheet) come
   * through here, so the two cannot drift apart.
   */
  function handleCaughtStealing(fromBase: 1 | 2 | 3, runnerId: string) {
    setCaughtStealingFor({ base: fromBase, runnerId, name: runnerName(runnerId) });
  }

  async function recordCaughtStealing(
    fromBase: 1 | 2 | 3,
    runnerId: string,
    fieldingSequence: number[],
  ) {
    if (!gameState) return;
    const toBase = (fromBase + 1) as 2 | 3 | 4;
    const payload: BaserunnerMovePayload = {
      runnerId,
      fromBase,
      toBase,
      // Omitted rather than sent empty when the scorer skipped it: an absent
      // sequence means "not recorded", which an empty array would blur.
      ...(fieldingSequence.length > 0 ? { fieldingSequence } : {}),
    };
    await recordEvent(EventType.CAUGHT_STEALING, gameState.inning, gameState.isTopOfInning, payload);
    setCaughtStealingFor(null);
  }

  async function advanceAllRunnersOneBase(reason: AdvanceReason) {
    if (!gameState) return;
    // Advance runner on 3rd first (they score), then 2nd, then 1st,
    // in that order so the replay engine sees consistent base state.
    const runners: Array<{ runnerId: string; fromBase: 1 | 2 | 3 }> = [];
    if (gameState.runnersOnBase.third)  runners.push({ runnerId: gameState.runnersOnBase.third,  fromBase: 3 });
    if (gameState.runnersOnBase.second) runners.push({ runnerId: gameState.runnersOnBase.second, fromBase: 2 });
    if (gameState.runnersOnBase.first)  runners.push({ runnerId: gameState.runnersOnBase.first,  fromBase: 1 });
    for (const r of runners) {
      const toBase = (r.fromBase + 1) as 2 | 3 | 4;
      const advancePayload: BaserunnerMovePayload = {
        runnerId: r.runnerId,
        fromBase: r.fromBase,
        toBase,
        reason,
      };
      await recordEvent(EventType.BASERUNNER_ADVANCE, gameState.inning, gameState.isTopOfInning, advancePayload);
      if (toBase === 4) {
        const scorePayload: ScorePayload = { scoringPlayerId: r.runnerId, rbis: 0 };
        await recordEvent(EventType.SCORE, gameState.inning, gameState.isTopOfInning, scorePayload);
      }
    }
  }

  async function handleWildPitch() {
    if (!gameState) return;
    // Record the wild pitch as a thrown ball so pitch count, count state,
    // and the pitcher's wildPitches stat all update (pitching-stats.ts:288).
    const pitchPayload: PitchThrownPayload = {
      ...halfAttribution,
      outcome: PitchOutcome.BALL,
      isWildPitch: true,
    };
    await recordEvent(EventType.PITCH_THROWN, gameState.inning, gameState.isTopOfInning, pitchPayload);
    await advanceAllRunnersOneBase(AdvanceReason.WILD_PITCH);
  }

  async function handlePassedBall() {
    if (!gameState) return;
    // PB is a catcher misplay — pitch is thrown cleanly and catcher fails
    // to handle it. Flag the pitch so downstream consumers can distinguish
    // the underlying pitch from the mishandling that followed.
    const pitchPayload: PitchThrownPayload = {
      ...halfAttribution,
      outcome: PitchOutcome.BALL,
      isPassedBall: true,
    };
    await recordEvent(EventType.PITCH_THROWN, gameState.inning, gameState.isTopOfInning, pitchPayload);
    await advanceAllRunnersOneBase(AdvanceReason.PASSED_BALL);
  }

  async function handleFieldersChoice(runnerId: string, fromBase: 1 | 2 | 3) {
    if (!gameState) return;
    // OBR: forced runner is retired first, then batter reaches 1st without
    // being credited as a hit. deriveGameState and the stats modules
    // handle the pair via BASERUNNER_OUT removing the runner and
    // HIT(fieldersChoice=true) advancing any remaining runners.
    await recordEvent(EventType.BASERUNNER_OUT, gameState.inning, gameState.isTopOfInning, {
      runnerId,
      fromBase,
      ...pitcherAttribution,
    });
    const hitPayload: HitPayload = {
      ...halfAttribution,
      hitType: HitType.SINGLE,
      fieldersChoice: true,
    };
    await recordEvent(EventType.HIT, gameState.inning, gameState.isTopOfInning, hitPayload);
  }

  // Runner thrown out advancing during a play (e.g., on a hit, sac fly,
  // wild pitch). Standalone BASERUNNER_OUT — the play itself is recorded
  // separately. game-state.ts removes the runner from the base and
  // increments outs; stats modules count it as an out without crediting CS.
  async function handleRunnerOut(runnerId: string, fromBase: 1 | 2 | 3) {
    if (!gameState) return;
    await recordEvent(EventType.BASERUNNER_OUT, gameState.inning, gameState.isTopOfInning, {
      runnerId,
      fromBase,
      ...pitcherAttribution,
    });
  }

  async function handleStartGame(
    pitcherId: string,
    batterId: string,
    tracking: { pitchType: boolean; pitchLocation: boolean },
  ) {
    if (!gameState) return;
    // `isHome` is derived from the async-resolved Game row and defaults to
    // true before it loads. Block starting until the row is present so a road
    // game can't seed the home* lineup slots by mistake.
    if (!game) {
      console.warn(`handleStartGame: game row not loaded yet game=${gameId}`);
      Alert.alert('Game still loading', 'Try again once the local game record has loaded.');
      return;
    }
    // Which team are we scoring? `isHome` comes from the resolved Game row's
    // locationType / neutralHomeTeam so road games seed the away* lineup
    // slots instead of misattributing to home*.
    const payload = {
      ...(isHome
        ? { homeLineupPitcherId: pitcherId, homeLeadoffBatterId: batterId }
        : { awayLineupPitcherId: pitcherId, awayLeadoffBatterId: batterId }),
      // Same keys the web scorer writes, so either client can read the other's
      // games. Read back via scoringConfig above.
      pitchTypeEnabled: tracking.pitchType,
      pitchLocationEnabled: tracking.pitchLocation,
    };
    try {
      await recordEvent(EventType.GAME_START, gameState.inning, gameState.isTopOfInning, payload);
    } catch (err) {
      // Without this the modal just sat there with no explanation — the
      // scorer has no way to tell a failed start from an unresponsive tap.
      console.warn(`handleStartGame: recording GAME_START failed game=${gameId}:`, err);
      Alert.alert(
        "Couldn't start the game",
        'The starting lineup was not saved. Check your connection and try again.',
      );
      return;
    }
    // Reflect the transition locally right away (list badge); the server
    // flips via fn_start_game in the sync engine's lifecycle scan.
    if (game && game.status === 'scheduled') {
      try {
        await database.write(async () => {
          await game.update((g) => {
            g.status = 'in_progress';
          });
        });
      } catch (err) {
        console.warn(`Start Game local status write failed game=${gameId}:`, err);
      }
    }
    setShowLineupModal(false);
  }

  // ─── Inning advancement ─────────────────────────────────────────────────
  // deriveGameState never auto-flips the half at 3 outs — the scorer
  // confirms via the 3-outs prompt (or the End Inning control for early
  // switches like a run cap or time limit). Empty payload matches web.
  const nextHalfLabel = gameState
    ? gameState.isTopOfInning
      ? `Bottom ${gameState.inning}`
      : `Top ${gameState.inning + 1}`
    : '';

  async function handleInningChange() {
    if (!gameState) return;
    await recordEvent(EventType.INNING_CHANGE, gameState.inning, gameState.isTopOfInning, {});
  }

  function confirmInningChange() {
    if (!gameState) return;
    Alert.alert(
      'End half-inning?',
      `Switch sides and start the ${nextHalfLabel} with ${gameState.outs} out${gameState.outs === 1 ? '' : 's'} recorded.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch sides', onPress: () => { handleInningChange().catch(console.warn); } },
      ],
    );
  }

  // ─── End game ───────────────────────────────────────────────────────────
  // Works fully offline: records GAME_END + marks the local games row
  // completed. Server-side finalization (status/scores, dual-scorekeeper
  // reconciliation, league snapshots) runs via the sync engine's lifecycle
  // scan once connectivity returns — no web visit needed.
  async function handleEndGame() {
    if (!gameState || !lineScore) return;
    await recordEvent(EventType.GAME_END, gameState.inning, gameState.isTopOfInning, {
      homeScore: lineScore.homeRuns,
      awayScore: lineScore.awayRuns,
    });
    if (game) {
      try {
        await database.write(async () => {
          await game.update((g) => {
            g.status = 'completed';
            g.homeScore = lineScore.homeRuns;
            g.awayScore = lineScore.awayRuns;
          });
        });
      } catch (err) {
        // The GAME_END event is authoritative (score screen keys off
        // gameState.isFinal); a stale list badge self-heals after finalize.
        console.warn(`End Game local status write failed game=${gameId}:`, err);
      }
    }
    triggerSync().catch(console.warn);
  }

  function confirmEndGame() {
    if (!gameState || !lineScore) return;
    Alert.alert(
      'End game?',
      `Final score ${lineScore.homeRuns}–${lineScore.awayRuns}. The result finalizes automatically when the device is back online.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End Game', style: 'destructive', onPress: () => { handleEndGame().catch(console.warn); } },
      ],
    );
  }

  async function handlePitchingChange(newPitcherId: string) {
    if (!gameState) return;
    const payload: PitchingChangePayload = {
      newPitcherId,
      outgoingPitcherId: currentPitcherId,
    };
    await recordEvent(EventType.PITCHING_CHANGE, gameState.inning, gameState.isTopOfInning, payload);
  }

  async function handlePinchHitter(newBatterId: string) {
    if (!gameState) return;
    const payload: SubstitutionPayload = {
      inPlayerId: newBatterId,
      // Replace the effective batter (due-batter derivation / override), so
      // applyLineupSubstitutions folds the sub into the right lineup slot.
      outPlayerId: ourBatterId ?? undefined,
      substitutionType: SubstitutionType.PINCH_HITTER,
    };
    await recordEvent(EventType.SUBSTITUTION, gameState.inning, gameState.isTopOfInning, payload);
  }

  async function handleDefensiveSub(outPlayerId: string, inPlayerId: string, newPosition?: string) {
    if (!gameState) return;
    const payload: SubstitutionPayload = {
      inPlayerId,
      outPlayerId,
      substitutionType: SubstitutionType.DEFENSIVE,
      ...(newPosition ? { newPosition } : {}),
    };
    await recordEvent(EventType.SUBSTITUTION, gameState.inning, gameState.isTopOfInning, payload);
  }

  async function handlePositionChange(playerId: string, newPosition: string) {
    if (!gameState) return;
    // Position change keeps the same player on the field; we model it as a
    // SUBSTITUTION with substitutionType=position_change. inPlayerId is the
    // same player (no roster change), so we mirror the convention used by the
    // web ScoringBoard: inPlayerId === outPlayerId === the moving player.
    const payload: SubstitutionPayload = {
      inPlayerId: playerId,
      outPlayerId: playerId,
      substitutionType: SubstitutionType.POSITION_CHANGE,
      newPosition,
    };
    await recordEvent(EventType.SUBSTITUTION, gameState.inning, gameState.isTopOfInning, payload);
  }

  /**
   * Add a batter to the END of the order mid-game. Late arrival, courtesy
   * player, or "everyone bats" lineup extension. The new slot lands at
   * (current max batting_order) + 1; we emit a SUBSTITUTION event for live
   * replay AND create a local game_lineups row so MaxPreps export, season
   * stats, and post-game queries pick the new batter up once it syncs.
   */
  async function handleAddBatter(newBatterId: string) {
    if (!gameState) return;
    // Don't add anyone until the lineup observation has fired — computing
    // currentMax=0 against an unloaded lineup would collide with the real
    // slot-1 occupant.
    if (!lineupLoaded) return;

    // Build the set of player ids already in the BATTING ORDER (bench rows
    // with a null order — e.g. a non-batting pitcher under DH rules — stay
    // addable), including pending in-game LINEUP_EXTENSION events that
    // haven't been reflected in the local rows yet (defense-in-depth against
    // picker filter bypass / two rapid taps).
    const activePlayerIds = new Set(
      lineupRows.filter((row) => row.batting_order != null).map((row) => row.player_id),
    );

    // Compute current max from both the DB snapshot AND any in-game
    // SUBSTITUTION events that already extended the lineup but haven't yet
    // been reflected in lineupRows.
    let currentMax = lineupRows.reduce(
      (max, l) => (l.batting_order ?? 0) > max ? (l.batting_order ?? 0) : max,
      0,
    );
    const eventsCollection = database.get<WdbGameEvent>('game_events');
    const recent = await eventsCollection
      .query(Q.where('game_remote_id', gameId), Q.sortBy('sequence_number', Q.asc))
      .fetch();
    for (const evt of recent) {
      if (evt.eventType !== EventType.SUBSTITUTION) continue;
      const p = evt.payload as Partial<SubstitutionPayload> | undefined;
      if (!p) continue;
      if (p.substitutionType === SubstitutionType.LINEUP_EXTENSION && p.inPlayerId) {
        activePlayerIds.add(p.inPlayerId);
      }
      if (!p.outPlayerId && typeof p.battingOrderPosition === 'number') {
        if (p.battingOrderPosition > currentMax) currentMax = p.battingOrderPosition;
      }
    }

    // DB check constraint caps batting_order at 30 and the league cap may be
    // tighter. Bail before emitting an event that the persistence layer would
    // reject; the SUBSTITUTION would still land in the event log and diverge
    // replay from the DB state.
    if (activePlayerIds.has(newBatterId) || currentMax >= maxBatters) return;

    const battingOrderPosition = currentMax + 1;

    const payload: SubstitutionPayload = {
      inPlayerId: newBatterId,
      substitutionType: SubstitutionType.LINEUP_EXTENSION,
      battingOrderPosition,
    };
    await recordEvent(EventType.SUBSTITUTION, gameState.inning, gameState.isTopOfInning, payload);

    // Persist the new batter to the local game_lineups mirror so post-game
    // consumers (MaxPreps export, season-stat rollups) see them alongside the
    // pre-game starters once the sync engine pushes it. A player may already
    // have a bench row (null batting order — e.g. a non-batting pitcher);
    // unique(game_id, player_id) forbids a second row, so that row is UPDATED
    // into the order instead. Offline-first like everything else on this
    // screen; the SUBSTITUTION event above remains the authoritative source
    // for live state and the shared stats derivers.
    try {
      const existingRow = observedLineupRows.find((row) => row.playerRemoteId === newBatterId);
      if (existingRow) {
        await database.write(async () => {
          await existingRow.update((r) => {
            r.battingOrder = battingOrderPosition;
            r.updatedAt = Date.now();
          });
        });
      } else {
        await addLineupRow({
          gameRemoteId: gameId,
          playerRemoteId: newBatterId,
          battingOrder: battingOrderPosition,
          isStarter: false,
          isGuest: false,
          countTowardStats: true,
        });
      }
    } catch (err) {
      // The SUBSTITUTION event above already keeps live play correct; log
      // with context so a missing post-game lineup row can be traced.
      console.warn(
        `Add Batter lineup row write failed game=${gameId} player=${newBatterId}:`,
        err,
      );
    }
    triggerSync().catch(console.warn);
  }

  // Only scan this far back when searching for an event to void. Typical
  // scorer Undo use lives within the last few events; a 64-event trailing
  // window covers well over an inning of activity while keeping the query
  // bounded. If no undoable event is found in the window, the button is a
  // no-op (rather than scanning thousands of events from earlier innings).
  const UNDO_WINDOW = 64;

  async function handleUndo() {
    if (!gameState) return;
    const eventsCollection = database.get<WdbGameEvent>('game_events');
    const recent = await eventsCollection
      .query(
        Q.where('game_remote_id', gameId),
        Q.sortBy('sequence_number', Q.desc),
        Q.take(UNDO_WINDOW),
      )
      .fetch();

    // Build the set of event IDs targeted by any EVENT_VOIDED in the
    // window so we skip already-voided events on the walk-back. We do
    // NOT attempt to handle "un-undo" (voiding a void to restore the
    // original) here because event-filters.ts doesn't add EVENT_VOIDED
    // rows to the replay accumulator, so voiding a void is a no-op at
    // replay time — treating it as a restore here would make the scorer
    // see different state than the stats modules.
    const voidedIds = new Set<string>();
    for (const e of recent) {
      if (e.eventType === EventType.EVENT_VOIDED) {
        const payload = e.payload as { voidedEventId?: string };
        if (payload.voidedEventId) voidedIds.add(payload.voidedEventId);
      }
    }

    // Already sorted descending, so iterate forward to find the most
    // recent non-correction, non-voided event.
    for (const e of recent) {
      if (e.eventType === EventType.EVENT_VOIDED) continue;
      if (e.eventType === EventType.PITCH_REVERTED) continue;
      if (voidedIds.has(e.remoteId)) continue;
      // Cascade-undo: when voiding a parent play, also void any linked
      // outcome events (BASERUNNER_OUT / BASERUNNER_ADVANCE with
      // relatedEventId === parent.id) so a single Undo tap retires the
      // full multi-event play (e.g. "Double + R1 thrown out at 3B").
      const linked = recent.filter((other) => {
        if (other.remoteId === e.remoteId) return false;
        if (voidedIds.has(other.remoteId)) return false;
        if (
          other.eventType !== EventType.BASERUNNER_OUT &&
          other.eventType !== EventType.BASERUNNER_ADVANCE
        ) return false;
        const p = other.payload as { relatedEventId?: string };
        return p.relatedEventId === e.remoteId;
      });
      for (const child of linked) {
        const childPayload: EventVoidedPayload = {
          voidedEventId: child.remoteId,
          voidedSequenceNumber: child.sequenceNumber,
        };
        await recordEvent(EventType.EVENT_VOIDED, gameState.inning, gameState.isTopOfInning, childPayload);
      }
      const payload: EventVoidedPayload = {
        voidedEventId: e.remoteId,
        voidedSequenceNumber: e.sequenceNumber,
      };
      await recordEvent(EventType.EVENT_VOIDED, gameState.inning, gameState.isTopOfInning, payload);
      return;
    }
  }

  async function handlePinchRunner(fromBase: 1 | 2 | 3, outRunnerId: string, inRunnerId: string) {
    if (!gameState) return;
    const payload: SubstitutionPayload = {
      inPlayerId: inRunnerId,
      outPlayerId: outRunnerId,
      substitutionType: SubstitutionType.PINCH_RUNNER,
      runnerBase: fromBase,
    };
    await recordEvent(EventType.SUBSTITUTION, gameState.inning, gameState.isTopOfInning, payload);
  }

  // Courtesy runner (LL/HS): pinch-runs for the catcher/pitcher without burning
  // a regular substitution. Gated on the league setting; wired into
  // BaserunnerDisplay only when enabled.
  async function handleCourtesyRunner(fromBase: 1 | 2 | 3, outRunnerId: string, inRunnerId: string) {
    if (!gameState) return;
    const payload: SubstitutionPayload = {
      inPlayerId: inRunnerId,
      outPlayerId: outRunnerId,
      substitutionType: SubstitutionType.COURTESY_RUNNER,
      runnerBase: fromBase,
    };
    await recordEvent(EventType.SUBSTITUTION, gameState.inning, gameState.isTopOfInning, payload);
  }

  async function handlePickoffOut(fromBase: 1 | 2 | 3, runnerId: string) {
    await handlePickoff(fromBase, runnerId, 'out');
  }

  /**
   * A pickoff throw has three results worth recording, and only one of them
   * retires the runner.
   *
   * 'error' is written as a safe pickoff plus a linked BASERUNNER_ADVANCE
   * rather than a new PickoffPayload outcome. The runner genuinely was safe —
   * the throw did not retire him — and the advance then runs through the
   * same path as every other error advance, including scoring from third.
   * Five separate consumers branch on a pickoff's outcome (the engine, the
   * line score, pitching stats, the history tree and the live ticker); a new
   * value there would have to be taught to all of them, and any one missed
   * would put the derived state quietly out of step with the engine.
   */
  async function handlePickoff(
    fromBase: 1 | 2 | 3,
    runnerId: string,
    outcome: 'safe' | 'out' | 'error',
  ) {
    if (!gameState) return;
    const payload: PickoffPayload = {
      runnerId,
      base: fromBase,
      ...pitcherAttribution,
      outcome: outcome === 'out' ? 'out' : 'safe',
    };
    const pickoffEventId = await recordEvent(
      EventType.PICKOFF_ATTEMPT,
      gameState.inning,
      gameState.isTopOfInning,
      payload,
    );

    if (outcome !== 'error') return;

    const toBase = (fromBase + 1) as 2 | 3 | 4;
    const advance: BaserunnerMovePayload = {
      runnerId,
      fromBase,
      toBase,
      reason: AdvanceReason.ERROR,
      relatedEventId: pickoffEventId,
    };
    await recordEvent(
      EventType.BASERUNNER_ADVANCE,
      gameState.inning,
      gameState.isTopOfInning,
      advance,
    );
    if (toBase === 4) {
      const scorePayload: ScorePayload = { scoringPlayerId: runnerId, rbis: 0 };
      await recordEvent(EventType.SCORE, gameState.inning, gameState.isTopOfInning, scorePayload);
    }
  }

  async function handleBalk() {
    if (!gameState) return;
    await recordEvent(EventType.BALK, gameState.inning, gameState.isTopOfInning, {
      ...pitcherAttribution,
    });
    // Per OBR 6.02(a) all runners advance one base on a balk. The BALK
    // replay handler shifts r1→r2, r2→r3; the runner previously on
    // third scores via a SCORE event (OBR 9.04(b)(5): no RBI on a balk).
    const thirdRunner = gameState.runnersOnBase.third;
    if (thirdRunner) {
      const scorePayload: ScorePayload = { scoringPlayerId: thirdRunner, rbis: 0 };
      await recordEvent(EventType.SCORE, gameState.inning, gameState.isTopOfInning, scorePayload);
    }
  }

  async function handleDoublePlay(runnerOut: { runnerId: string; base: 1 | 2 | 3 } | null) {
    if (!gameState) return;
    await recordEvent(EventType.DOUBLE_PLAY, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
      ...(runnerOut ? { runnerOutId: runnerOut.runnerId, runnerOutBase: runnerOut.base } : {}),
    });
  }

  async function handleTriplePlay() {
    if (!gameState) return;
    await recordEvent(EventType.TRIPLE_PLAY, gameState.inning, gameState.isTopOfInning, {
      ...halfAttribution,
    });
  }

  async function handleRunnerAdvance(fromBase: 1 | 2 | 3, runnerId: string, reason: AdvanceReason) {
    if (!gameState) return;
    const toBase = (fromBase + 1) as 2 | 3 | 4;
    const payload: BaserunnerMovePayload = { runnerId, fromBase, toBase, reason };
    await recordEvent(EventType.BASERUNNER_ADVANCE, gameState.inning, gameState.isTopOfInning, payload);
    if (toBase === 4) {
      const scorePayload: ScorePayload = { scoringPlayerId: runnerId, rbis: 0 };
      await recordEvent(EventType.SCORE, gameState.inning, gameState.isTopOfInning, scorePayload);
    }
  }

  async function handleDroppedThirdStrike(details: {
    outcome: DroppedThirdStrikeOutcome;
    fieldingSequence?: number[];
    errorBy?: number;
    isWildPitch?: boolean;
  }) {
    if (!gameState) return;
    const payload: DroppedThirdStrikePayload = {
      ...halfAttribution,
      outcome: details.outcome,
      fieldingSequence: details.fieldingSequence,
      errorBy: details.errorBy,
      isWildPitch: details.isWildPitch,
    };
    await recordEvent(EventType.DROPPED_THIRD_STRIKE, gameState.inning, gameState.isTopOfInning, payload);
  }

  // Runners currently on base — passed to PitchInput for the FC picker.
  // Memoised on the three runner IDs so a new array identity only
  // propagates when the underlying state actually changes; otherwise
  // PitchInput gets the same reference across re-renders.
  const firstRunner = gameState?.runnersOnBase.first ?? null;
  const secondRunner = gameState?.runnersOnBase.second ?? null;
  const thirdRunner = gameState?.runnersOnBase.third ?? null;
  const runnersOnBase = useMemo<{ base: 1 | 2 | 3; runnerId: string }[]>(() => {
    const out: { base: 1 | 2 | 3; runnerId: string }[] = [];
    if (firstRunner)  out.push({ base: 1, runnerId: firstRunner });
    if (secondRunner) out.push({ base: 2, runnerId: secondRunner });
    if (thirdRunner)  out.push({ base: 3, runnerId: thirdRunner });
    return out;
  }, [firstRunner, secondRunner, thirdRunner]);

  // ─── Naming the runners ──────────────────────────────────────────────────
  // A runner id is one of ours, one of the opponent's, or — for an opponent
  // half scored without their order entered — a stand-in the engine minted to
  // hold the base. The two id spaces are disjoint, so trying each in turn is
  // unambiguous; the stand-in matches nothing and stays deliberately unnamed
  // rather than borrowing someone else's name.
  const runnerIdentity = useMemo(() => {
    const m = new Map<string, { name: string; short: string }>();
    for (const p of roster) {
      m.set(p.id, {
        name: p.jerseyNumber != null ? `#${p.jerseyNumber} ${p.name}` : p.name,
        short: p.jerseyNumber != null ? String(p.jerseyNumber) : initialsOf(p.name),
      });
    }
    for (const s of opponentSlots) {
      m.set(s.playerId, {
        name: s.name,
        short: s.jerseyNumber || String(s.battingOrder),
      });
    }
    return m;
  }, [roster, opponentSlots]);

  const runnerName = (id: string) =>
    runnerIdentity.get(id)?.name ?? nameById.get(id) ?? extraNames[id] ?? 'Unnamed runner';
  const runnerShortLabel = (id: string) => {
    const known = runnerIdentity.get(id)?.short;
    if (known) return known;
    const fallback = nameById.get(id) ?? extraNames[id];
    return fallback ? initialsOf(fallback) : '•';
  };
  const namedRunners = useMemo(
    () =>
      // Lead runner first: that is the one a coach decides about.
      [...runnersOnBase]
        .sort((a, b) => b.base - a.base)
        .map((r) => ({ ...r, name: runnerName(r.runnerId) })),
    [runnersOnBase, runnerIdentity, nameById, extraNames],
  );

  if (loading || !gameState) {
    return <LoadingSpinner fullScreen />;
  }

  // Read-only Final view — event-sourced (gameState.isFinal from GAME_END)
  // with the pulled games row as a fallback for games completed elsewhere.
  if (gameState.isFinal || game?.status === 'completed') {
    const inningCount = lineScore
      ? Math.max(lineScore.awayRunsByInning.length, lineScore.homeRunsByInning.length)
      : 0;
    const lineRow = (
      label: string,
      runsByInning: number[],
      runs: number,
      hits: number,
      errors: number,
      isLast: boolean,
    ) => (
      <View className={`flex-row ${isLast ? '' : 'border-b border-gray-100'}`}>
        <Text className="w-24 px-2 py-1.5 text-xs font-semibold text-gray-700" numberOfLines={1}>
          {label}
        </Text>
        {Array.from({ length: inningCount }, (_, i) => (
          <Text key={i} className="w-8 py-1.5 text-center text-xs text-gray-600">
            {runsByInning[i] ?? '-'}
          </Text>
        ))}
        <Text className="w-8 py-1.5 text-center text-xs font-bold text-gray-900">{runs}</Text>
        <Text className="w-8 py-1.5 text-center text-xs text-gray-600">{hits}</Text>
        <Text className="w-8 py-1.5 text-center text-xs text-gray-600">{errors}</Text>
      </View>
    );

    return (
      <View className="flex-1 bg-white">
        <Stack.Screen options={{ title: `vs ${opponentName}`, headerShown: true }} />
        <ScoreBoard
          gameState={gameState}
          opponentName={awayLabel}
          teamName={homeLabel}
        />
        <View className="items-center pt-6 pb-2">
          <View className="px-3 py-1 rounded-full bg-gray-900">
            <Text className="text-white text-xs font-bold uppercase tracking-wide">Final</Text>
          </View>
          {pendingEventsCount > 0 && (
            <Text className="text-amber-600 text-xs mt-2">
              Result finalizes automatically when the device is back online.
            </Text>
          )}
        </View>
        {lineScore && (
          <View className="mx-4 mt-3 border border-gray-200 rounded-xl overflow-hidden">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                <View className="flex-row bg-gray-50 border-b border-gray-200">
                  <Text className="w-24 px-2 py-1.5 text-xs font-semibold text-gray-400" />
                  {Array.from({ length: inningCount }, (_, i) => (
                    <Text key={i} className="w-8 py-1.5 text-center text-xs font-semibold text-gray-500">
                      {i + 1}
                    </Text>
                  ))}
                  <Text className="w-8 py-1.5 text-center text-xs font-semibold text-gray-500">R</Text>
                  <Text className="w-8 py-1.5 text-center text-xs font-semibold text-gray-500">H</Text>
                  <Text className="w-8 py-1.5 text-center text-xs font-semibold text-gray-500">E</Text>
                </View>
                {lineRow(awayLabel, lineScore.awayRunsByInning, lineScore.awayRuns, lineScore.awayHits, lineScore.awayErrors, false)}
                {lineRow(homeLabel, lineScore.homeRunsByInning, lineScore.homeRuns, lineScore.homeHits, lineScore.homeErrors, true)}
              </View>
            </ScrollView>
          </View>
        )}
        <Text className="text-gray-400 text-xs text-center mt-4 px-6">
          Full box score and player stats are on the web dashboard.
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-white">
      <Stack.Screen options={{ title: `vs ${opponentName}`, headerShown: true }} />

      {/* Top: scoreboard — spans the full width above both panes so the score
          line reads across the whole screen instead of being boxed into the
          left column. */}
      <ScoreBoard
        gameState={gameState}
        opponentName={awayLabel}
        teamName={homeLabel}
      />

      <PaneRow isWide={isWide}>
      <BookPane isWide={isWide}>

      {/* Book toolbar. These were floating over the pane on absolute
          positioning, which put them on top of the count once this column
          started with it — they are ordinary controls, so they sit in the
          flow like ordinary controls. */}
      <View className="flex-row items-center gap-2 px-4 pt-2">
        <TouchableOpacity
          onPress={() =>
            router.push({ pathname: '/(tabs)/games/[gameId]/lineup', params: { gameId } })
          }
          className="px-3 py-1.5 rounded-full bg-gray-100 border border-gray-200"
        >
          <Text className="text-xs font-semibold text-gray-700">Full lineup</Text>
        </TouchableOpacity>
        {leagueSettings.guests.allowed && (
          <TouchableOpacity
            onPress={() => setShowGuestModal(true)}
            className="px-3 py-1.5 rounded-full bg-emerald-100 border border-emerald-200"
          >
            <Text className="text-xs font-semibold text-emerald-800">+ Guest</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* League-rule advisories (mercy / run cap / regulation complete) */}
      {gameEndDecision && !gameState.isFinal && (
        <View className="mx-4 mt-2 p-3 bg-amber-50 border border-amber-300 rounded-lg flex-row items-center">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-amber-900">End game?</Text>
            <Text className="text-xs text-amber-800 mt-0.5">{gameEndDecision.message}</Text>
          </View>
          <TouchableOpacity
            onPress={confirmEndGame}
            className="ml-2 px-3 py-1.5 rounded-full bg-amber-600"
          >
            <Text className="text-xs font-semibold text-white">End Game</Text>
          </TouchableOpacity>
        </View>
      )}
      {runCapReached && (
        <View className="mx-4 mt-2 p-3 bg-blue-50 border border-blue-300 rounded-lg flex-row items-center">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-blue-900">Run cap reached</Text>
            <Text className="text-xs text-blue-800 mt-0.5">
              This half-inning ends at the league run cap.
            </Text>
          </View>
          <TouchableOpacity
            onPress={confirmInningChange}
            className="ml-2 px-3 py-1.5 rounded-full bg-blue-600"
          >
            <Text className="text-xs font-semibold text-white">Switch sides</Text>
          </TouchableOpacity>
        </View>
      )}
      {ghostRunnerBase && (
        <View className="mx-4 mt-2 p-3 bg-purple-50 border border-purple-300 rounded-lg">
          <Text className="text-sm font-semibold text-purple-900">Ghost runner</Text>
          <Text className="text-xs text-purple-800 mt-0.5">
            Place a runner on {ghostRunnerBase === 1 ? '1st' : ghostRunnerBase === 2 ? '2nd' : '3rd'} via Substitution → Pinch Runner.
          </Text>
        </View>
      )}

      {/* Middle: count + baserunners */}
      <CountDisplay gameState={gameState} />
      {/* Pitch counts live in the input pane — the scorer watches them while
          calling pitches, not while reading the count. */}
      <View className="flex-row items-center justify-between px-5 py-3 border-b border-gray-100">
        <BaserunnerDisplay
          gameState={gameState}
          onRecordStolenBase={handleStolenBase}
          onRecordCaughtStealing={handleCaughtStealing}
          onRecordAdvance={handleRunnerAdvance}
          onRecordPickoffOut={handlePickoffOut}
          onRecordPinchRunner={handlePinchRunner}
          onRecordCourtesyRunner={
            leagueSettings.substitutions.courtesyRunnerForCatcherPitcher
              ? handleCourtesyRunner
              : undefined
          }
          roster={roster}
          runnerShortLabel={runnerShortLabel}
          runnerName={runnerName}
        />
        {/* Offline is a normal state for field scoring, so it reads as
            information, not a fault. A red warning is reserved for a sync
            that actually failed while connected — otherwise the scorer
            learns to ignore the one signal that should mean something. */}
        {isSyncing ? (
          <Text className="text-xs text-blue-500">Syncing…</Text>
        ) : isOffline ? (
          <Text className="text-xs text-slate-500">
            Offline{pendingEventsCount > 0 ? ` · ${pendingEventsCount} saved` : ' · saved on device'}
          </Text>
        ) : lastSyncError ? (
          <Text className="text-xs text-red-600">⚠ Sync failed</Text>
        ) : pendingEventsCount > 0 ? (
          <Text className="text-xs text-amber-600">{pendingEventsCount} unsynced</Text>
        ) : null}
      </View>

      {/* Pre-game lineup prompt. Keyed off ourPitcherId, not
          gameState.currentPitcherId: INNING_CHANGE resets the latter to null,
          so this used to reappear at the top of every half-inning of a game
          that had been under way for an hour. */}
      {ourPitcherId === null && (
        <TouchableOpacity
          className="mx-4 mt-2 p-3 bg-amber-50 border border-amber-300 rounded-lg flex-row items-center"
          onPress={() => setShowLineupModal(true)}
        >
          <Text className="flex-1 text-sm text-amber-900">
            <Text className="font-semibold">Set starting lineup</Text>
            <Text> — tap to pick your starting pitcher and leadoff batter.</Text>
          </Text>
          <Text className="text-amber-900 font-semibold">Set</Text>
        </TouchableOpacity>
      )}

      <LineupSetupModal
        visible={showLineupModal}
        roster={roster}
        // Prefill from the saved lineup: slot 1 leads off; the player whose
        // starting position is pitcher takes the mound.
        initialBatterId={deriveDueBatter(battingSlots, 0)?.playerId ?? null}
        initialPitcherId={
          observedLineupRows.find((row) => row.startingPosition === 'pitcher')?.playerRemoteId ?? null
        }
        onCancel={() => setShowLineupModal(false)}
        onSubmit={handleStartGame}
      />

      <GuestPlayerModal
        visible={showGuestModal}
        gameId={gameId}
        teamId={teamId}
        leagueId={leagueId}
        defaultCountTowardStats={leagueSettings.guests.countTowardStatsDefault}
        maxBatters={maxBatters}
        onClose={() => setShowGuestModal(false)}
      />


      {/* Next up — on deck while we bat, leading off our next half while the
          opponent does. Named for what it is in each case so the scorer
          doesn't have to work out which. */}
      {gameStarted && battingOrderView.length > 0 && (
        <BattingOrderCard
          title={battingOrderTitle}
          rows={battingOrderView}
          currentBatterId={currentPlateBatterId}
          onDeckBatterId={onDeckBatterId}
          accent={weBat ? 'ours' : 'theirs'}
          headerRight={
            <View className="flex-row items-center gap-2">
              {(weBat ? battingSlots.length > 0 : opponentSlots.length > 0) && (
                <TouchableOpacity
                  onPress={() =>
                    weBat ? setShowBatterPicker(true) : setShowOpponentBatterPicker(true)
                  }
                  className={`px-3 py-1 rounded-full ${weBat ? 'bg-emerald-600' : 'bg-slate-600'}`}
                >
                  <Text className="text-xs font-semibold text-white">Change</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() =>
                  weBat ? setShowAddOurBatter(true) : setShowAddOpponentBatter(true)
                }
                className={`px-3 py-1 rounded-full ${weBat ? 'bg-emerald-100' : 'bg-slate-200'}`}
              >
                <Text
                  className={`text-xs font-semibold ${weBat ? 'text-emerald-800' : 'text-slate-700'}`}
                >
                  + Batter
                </Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
      {/* An empty order still needs its Add control — the batter buttons live
          in the card header, and the opponent's book starts empty, so without
          this there is no way to enter the first one. */}
      {gameStarted && battingOrderView.length === 0 && (
        <View className="flex-row items-center px-4 py-2 border-t border-gray-100">
          <Text className="flex-1 text-sm text-gray-500" numberOfLines={1}>
            No {weBat ? 'batting order' : `${opponentName} order`} set
          </Text>
          <TouchableOpacity
            onPress={() =>
              weBat ? setShowAddOurBatter(true) : setShowAddOpponentBatter(true)
            }
            className={`px-3 py-1 rounded-full ${weBat ? 'bg-emerald-100' : 'bg-slate-200'}`}
          >
            <Text
              className={`text-xs font-semibold ${weBat ? 'text-emerald-800' : 'text-slate-700'}`}
            >
              + Batter
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {gameStarted && battingOrderView.length === 0 && nextBatter
        && nextBatter.playerId !== currentPlateBatterId && (
        <View className="flex-row items-center px-4 py-2 border-t border-gray-100">
          <Text className="text-xs text-gray-500 w-20">Up next</Text>
          <Text className="flex-1 text-sm text-gray-900" numberOfLines={1}>
            <Text className="font-semibold">{nextBatterName(nextBatter.playerId)}</Text>
            <Text className="text-xs text-gray-500">{'  '}slot {nextBatter.battingOrder}</Text>
          </Text>
        </View>
      )}

      <BatterPickerModal
        visible={showBatterPicker}
        slots={battingSlots}
        batterName={batterName}
        dueBatterId={dueBatter?.playerId ?? null}
        selectedId={ourBatterId}
        onSelect={(playerId) => {
          setBatterOverrideId(playerId);
          setShowBatterPicker(false);
        }}
        onCancel={() => setShowBatterPicker(false)}
      />

      <OpponentBatterPickerModal
        visible={showOpponentBatterPicker}
        slots={opponentSlots}
        dueBatterId={opponentDueBatter?.playerId ?? null}
        selectedId={opponentBatterId}
        onSelect={(playerId) => {
          setOpponentBatterOverrideId(playerId);
          setShowOpponentBatterPicker(false);
        }}
        onCancel={() => setShowOpponentBatterPicker(false)}
      />

      <AddBatterModal
        visible={showAddOpponentBatter}
        title={`Add ${opponentName} batter`}
        rosterLabel="ON THEIR ROSTER"
        roster={opponentRoster
          .filter((p) => !opponentNameById.has(p.remoteId))
          .map((p) => ({ id: p.remoteId, name: opponentDisplayName(p) }))}
        onSubmit={handleAddOpponentBatter}
        onCancel={() => setShowAddOpponentBatter(false)}
      />

      <CaughtStealingModal
        runner={caughtStealingFor}
        onRecord={(sequence) => {
          if (caughtStealingFor) {
            recordCaughtStealing(
              caughtStealingFor.base,
              caughtStealingFor.runnerId,
              sequence,
            ).catch(console.warn);
          }
        }}
        onCancel={() => setCaughtStealingFor(null)}
      />

      <AddBatterModal
        visible={showAddOurBatter}
        title="Add batter"
        rosterLabel="ON YOUR ROSTER"
        roster={roster
          .filter((p) => !battingSlots.some((slot) => slot.playerId === p.id))
          .map((p) => ({
            id: p.id,
            name: p.jerseyNumber != null ? `#${p.jerseyNumber} ${p.name}` : p.name,
          }))}
        onSubmit={handleAddOurBatter}
        onCancel={() => setShowAddOurBatter(false)}
      />

      </BookPane>
      <ActionPane isWide={isWide}>

      {gameStarted && (
        <RunnersPanel
          runners={namedRunners}
          onSteal={handleStolenBase}
          onCaught={handleCaughtStealing}
          onAdvance={handleRunnerAdvance}
          onPickoff={handlePickoff}
        />
      )}

      {gameStarted && (
        <PitchCountStrip
          pitcherLabel={
            displayPitcherId
              ? ourPlayerIds.has(displayPitcherId)
                ? batterName(displayPitcherId)
                : 'Opponent pitcher'
              : 'No pitcher set'
          }
          pitches={currentPitchTotal}
          strikes={currentStrikeTotal}
          staffPitches={staffTotals.pitches}
          staffStrikes={staffTotals.strikes}
          status={pitchStatus}
        />
      )}

      {/* Bottom: 3-outs prompt or pitch / outcome input. deriveGameState
          holds the half open until an explicit INNING_CHANGE, so at 3 outs
          the input surface is replaced by the switch-sides prompt. */}
      {gameState.outs >= OUTS_PER_INNING ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-2xl font-bold text-gray-900 mb-1">3 outs</Text>
          <Text className="text-sm text-gray-500 mb-5">
            {gameState.isTopOfInning ? 'Top' : 'Bottom'} {gameState.inning} is over.
          </Text>
          {/* When the league rules say the game can end here (regulation
              complete, mercy), ending the game leads; otherwise the next
              half leads and End Game stays available as the secondary. */}
          {gameEndDecision ? (
            <>
              <TouchableOpacity
                onPress={confirmEndGame}
                className="w-full bg-amber-600 rounded-2xl py-4 items-center"
              >
                <Text className="text-white text-lg font-bold">End Game — {lineScore ? `${lineScore.homeRuns}–${lineScore.awayRuns}` : 'Final'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { handleInningChange().catch(console.warn); }}
                className="w-full bg-blue-600 rounded-2xl py-3 items-center mt-3"
              >
                <Text className="text-white text-base font-bold">Start {nextHalfLabel} ▸</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                onPress={() => { handleInningChange().catch(console.warn); }}
                className="w-full bg-blue-600 rounded-2xl py-4 items-center"
              >
                <Text className="text-white text-lg font-bold">Start {nextHalfLabel} ▸</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={confirmEndGame} className="mt-3 px-4 py-2">
                <Text className="text-gray-600 text-sm font-semibold">End Game</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity onPress={() => { handleUndo().catch(console.warn); }} className="mt-2 px-4 py-2">
            <Text className="text-gray-500 text-sm">Undo last event</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <PitchInput
        onRecordPitch={handlePitch}
        trackPitchType={scoringConfig.pitchType}
        trackPitchLocation={scoringConfig.pitchLocation}
        onRecordHit={handleHit}
        onRecordHitWithRunnerOutcomes={handleHitWithRunnerOutcomes}
        onRecordOut={handleOut}
        onRecordStrikeout={handleStrikeout}
        onRecordError={handleError}
        onRecordCatcherInterference={handleCatcherInterference}
        onRecordSacFly={handleSacrificeFly}
        onRecordSacBunt={handleSacrificeBunt}
        onRecordSacFlyFromOut={handleSacrificeFlyFromOut}
        onRecordSacBuntFromOut={handleSacrificeBuntFromOut}
        onRecordFieldersChoice={handleFieldersChoice}
        onRecordRunnerOut={handleRunnerOut}
        onRecordWildPitch={handleWildPitch}
        onRecordPassedBall={handlePassedBall}
        onRecordBalk={handleBalk}
        onRecordDoublePlay={handleDoublePlay}
        onRecordTriplePlay={handleTriplePlay}
        onRecordPitchingChange={handlePitchingChange}
        onRecordPinchHitter={handlePinchHitter}
        onRecordDefensiveSub={handleDefensiveSub}
        onRecordPositionChange={handlePositionChange}
        onRecordAddBatter={midGameExtensionAllowed ? handleAddBatter : undefined}
        activeBattingOrderPlayerIds={lineupRows
          .filter((l) => l.batting_order != null)
          .map((l) => l.player_id)}
        defensiveLineup={defensiveLineup}
        roster={roster}
        pitcherBadges={pitcherBadges}
        onUndoLastEvent={handleUndo}
        runnersOnBase={runnersOnBase}
        onRecordDroppedThirdStrike={handleDroppedThirdStrike}
        d3kModalOpen={showD3KModal}
        setD3KModalOpen={setShowD3KModal}
      />
      )}

      {/* Secondary actions sit under the input surface: reached a few times
          a game, so they belong with the other taps but below the ones made
          every pitch. */}
      {gameStarted && !gameState.isFinal && gameState.outs < OUTS_PER_INNING && (
        <View className="flex-row items-center gap-2 px-4 py-2 border-t border-gray-100">
          <TouchableOpacity
            onPress={confirmInningChange}
            className="px-3 py-1.5 rounded-full bg-gray-100 border border-gray-200"
          >
            <Text className="text-xs font-semibold text-gray-700">End Inning ▸</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={confirmEndGame}
            className={`px-3 py-1.5 rounded-full border ${
              gameEndDecision ? 'bg-amber-100 border-amber-300' : 'bg-gray-100 border-gray-200'
            }`}
          >
            <Text className={`text-xs font-semibold ${gameEndDecision ? 'text-amber-800' : 'text-gray-700'}`}>
              End Game
            </Text>
          </TouchableOpacity>
        </View>
      )}
      </ActionPane>
      </PaneRow>
    </View>
  );
}

/**
 * Side-by-side on tablets, stacked on phones. Split out as components rather
 * than inline ternaries so the two panes stay readable — conditionally
 * wrapping a block in JSX needs matched tags on both sides.
 */
function PaneRow({ isWide, children }: { isWide: boolean; children: ReactNode }) {
  return (
    <View className="flex-1" style={isWide ? { flexDirection: 'row' } : undefined}>
      {children}
    </View>
  );
}

/**
 * The book — everything the scorer READS: the count, the bases, the order.
 *
 * The screen had drifted into three columns with the same fact in two of
 * them (who is at the plate was both a "Now batting" line and a highlighted
 * lineup row). One reading column and one tapping column is fewer places to
 * look, and it lets each fact live exactly once.
 *
 * The flex lives on a plain View and the ScrollView fills it. An uneven flex
 * set directly on a ScrollView is not honoured — it collapses towards its
 * content — which is why earlier splits only ever worked at 1:1.
 */
function BookPane({ isWide, children }: { isWide: boolean; children: ReactNode }) {
  if (!isWide) return <>{children}</>;
  return (
    <View className="border-r border-gray-200 bg-white" style={{ flex: 5 }}>
      <ScrollView style={{ flex: 1 }}>{children}</ScrollView>
    </View>
  );
}

/**
 * The action surface — everything the scorer TAPS. Never scrolls, so the
 * buttons are always where they were last time. Given the larger share:
 * it is touched dozens of times an inning, the book is read.
 */
function ActionPane({ isWide, children }: { isWide: boolean; children: ReactNode }) {
  if (!isWide) return <>{children}</>;
  return <View style={{ flex: 7 }}>{children}</View>;
}

/** Pitches / strikes / strike% for one line of the strip. */
function CountGroup({
  label,
  pitches,
  strikes,
  emphasis,
}: {
  label: string;
  pitches: number;
  strikes: number;
  emphasis?: boolean;
}) {
  // Percentage of nothing is nothing to report — an em dash beats "0%" or NaN
  // before the first pitch.
  const pct = pitches > 0 ? Math.round((strikes / pitches) * 100) : null;
  return (
    <View className="flex-1">
      <Text className="text-[11px] text-gray-500" numberOfLines={1}>
        {label}
      </Text>
      <View className="flex-row items-baseline gap-1.5 mt-0.5">
        <Text className={emphasis ? 'text-2xl font-bold text-gray-900' : 'text-lg font-semibold text-gray-700'}>
          {pitches}
        </Text>
        <Text className="text-[11px] text-gray-500">P</Text>
        <Text className={emphasis ? 'text-lg font-semibold text-gray-700' : 'text-base font-semibold text-gray-600'}>
          {strikes}
        </Text>
        <Text className="text-[11px] text-gray-500">S</Text>
        <Text className="text-[11px] text-gray-400">{pct === null ? '—' : `${pct}%`}</Text>
      </View>
    </View>
  );
}

/**
 * Pitch and strike totals, sitting above the action surface: the pitcher on
 * the mound and the staff behind them. This is the number a coach acts on
 * mid-inning — whether to warm someone up — so it lives where the eye already
 * is between pitches rather than across the screen in the context pane.
 */
function PitchCountStrip({
  pitcherLabel,
  pitches,
  strikes,
  staffPitches,
  staffStrikes,
  status,
}: {
  pitcherLabel: string;
  pitches: number;
  strikes: number;
  staffPitches: number;
  staffStrikes: number;
  status: { isOverLimit: boolean; isAtLimit: boolean; isAtWarning: boolean; maxAllowed: number } | null;
}) {
  const flagged = status !== null && (status.isOverLimit || status.isAtLimit || status.isAtWarning);
  return (
    <View className="flex-row items-center gap-3 px-4 py-2.5 border-b border-gray-200 bg-gray-50">
      <CountGroup label={pitcherLabel} pitches={pitches} strikes={strikes} emphasis />
      <View className="w-px self-stretch bg-gray-200" />
      <CountGroup label="All pitchers · game" pitches={staffPitches} strikes={staffStrikes} />
      {flagged && status && (
        <View
          className={`px-2.5 py-1 rounded-full ${
            status.isOverLimit ? 'bg-red-600' : status.isAtLimit ? 'bg-red-100' : 'bg-amber-100'
          }`}
        >
          <Text
            className={`text-xs font-semibold ${
              status.isOverLimit ? 'text-white' : status.isAtLimit ? 'text-red-700' : 'text-amber-700'
            }`}
          >
            {status.isOverLimit
              ? `Over limit (${status.maxAllowed})`
              : `${pitches}/${status.maxAllowed}`}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Batting-order picker for the per-PA override — lists the effective order
 * (subs folded in), highlights who is due up, and lets the scorer point the
 * rotation at a different batter when the lineup has drifted.
 */
function BatterPickerModal({
  visible,
  slots,
  batterName,
  dueBatterId,
  selectedId,
  onSelect,
  onCancel,
}: {
  visible: boolean;
  slots: BattingSlot[];
  batterName: (id: string) => string;
  dueBatterId: string | null;
  selectedId: string | null;
  onSelect: (playerId: string) => void;
  onCancel: () => void;
}) {
  const sorted = [...slots].sort((a, b) => a.battingOrder - b.battingOrder);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '75%' }}>
          <Text className="text-lg font-bold text-gray-900 mb-1">Now Batting</Text>
          <Text className="text-sm text-gray-500 mb-4">
            Pick who is at the plate. The rotation resumes from this batter
            after the plate appearance completes.
          </Text>
          <ScrollView className="max-h-96">
            <View className="gap-2">
              {sorted.map((slot) => {
                const isSelected = slot.playerId === selectedId;
                const isDue = slot.playerId === dueBatterId;
                return (
                  <TouchableOpacity
                    key={`${slot.battingOrder}-${slot.playerId}`}
                    className={`flex-row items-center rounded-xl px-4 py-3 border ${
                      isSelected ? 'bg-emerald-600 border-emerald-700' : 'bg-white border-gray-300'
                    }`}
                    onPress={() => onSelect(slot.playerId)}
                  >
                    <Text className={`w-8 font-bold ${isSelected ? 'text-white' : 'text-gray-400'}`}>
                      {slot.battingOrder}
                    </Text>
                    <Text className={`flex-1 font-semibold ${isSelected ? 'text-white' : 'text-gray-900'}`}>
                      {batterName(slot.playerId)}
                    </Text>
                    {isDue && (
                      <Text className={`text-xs font-semibold ${isSelected ? 'text-emerald-100' : 'text-emerald-700'}`}>
                        due up
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <TouchableOpacity
            className="mt-4 rounded-xl px-5 py-3 bg-gray-100 items-center"
            onPress={onCancel}
          >
            <Text className="text-gray-700 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** "Griffin Baldwin" -> "GB"; the fallback when we have no jersey number. */
function initialsOf(name: string): string {
  const parts = name.replace(/^#\S+\s*/, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '\u2022';
  return parts.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

/** One runner action — a quiet pill, since a row of these sits under a name. */
function RunnerAction({
  label,
  tone,
  onPress,
}: {
  label: string;
  tone: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity className={`px-2.5 py-1.5 rounded-lg border ${tone}`} onPress={onPress}>
      <Text className="text-[11px] font-semibold">{label}</Text>
    </TouchableOpacity>
  );
}

const BASE_ABBREV: Record<1 | 2 | 3, string> = { 1: '1B', 2: '2B', 3: '3B' };

/**
 * Who is on base and what can happen to them, in one place.
 *
 * These plays were reachable only by tapping a base in the diamond or opening
 * the Runners sheet — two drills for the events that happen while the scorer
 * is already watching a pitch. With someone aboard the choices are few and
 * known, so they are laid out rather than hidden.
 *
 * The rarer per-runner plays (pinch runner, courtesy runner) stay behind the
 * base tap: they are substitutions, not pitches, and are not worth the room.
 */
function RunnersPanel({
  runners,
  onSteal,
  onCaught,
  onAdvance,
  onPickoff,
}: {
  runners: Array<{ base: 1 | 2 | 3; runnerId: string; name: string }>;
  onSteal: (base: 1 | 2 | 3, runnerId: string) => void;
  onCaught: (base: 1 | 2 | 3, runnerId: string) => void;
  onAdvance: (base: 1 | 2 | 3, runnerId: string, reason: AdvanceReason) => void;
  onPickoff: (base: 1 | 2 | 3, runnerId: string, outcome: PickoffOutcome) => void;
}) {
  const [pickoffFor, setPickoffFor] =
    useState<{ base: 1 | 2 | 3; runnerId: string; name: string } | null>(null);
  if (runners.length === 0) return null;
  return (
    <View className="px-4 py-2 border-b border-gray-200 bg-white">
      <Text className="text-[11px] font-semibold text-gray-500 mb-1.5">ON BASE</Text>
      <View className="gap-1.5">
        {runners.map((r) => (
          <View key={`${r.base}-${r.runnerId}`} className="flex-row items-center gap-1.5">
            <View className="w-8 py-1 rounded-md bg-amber-100 items-center">
              <Text className="text-[11px] font-bold text-amber-800">{BASE_ABBREV[r.base]}</Text>
            </View>
            <Text className="flex-1 text-[13px] text-gray-900" numberOfLines={1}>
              {r.name}
            </Text>
            <RunnerAction
              label="Steal"
              tone="bg-sky-50 border-sky-200"
              onPress={() => onSteal(r.base, r.runnerId)}
            />
            <RunnerAction
              label="Caught"
              tone="bg-rose-50 border-rose-200"
              onPress={() => onCaught(r.base, r.runnerId)}
            />
            <RunnerAction
              label="Wild pitch"
              tone="bg-amber-50 border-amber-200"
              onPress={() => onAdvance(r.base, r.runnerId, AdvanceReason.WILD_PITCH)}
            />
            <RunnerAction
              label="Passed ball"
              tone="bg-yellow-50 border-yellow-200"
              onPress={() => onAdvance(r.base, r.runnerId, AdvanceReason.PASSED_BALL)}
            />
            <RunnerAction
              label="Pickoff"
              tone="bg-slate-100 border-slate-300"
              onPress={() => setPickoffFor(r)}
            />
          </View>
        ))}
      </View>

      <PickoffOutcomeModal
        runner={pickoffFor}
        onPick={(outcome) => {
          if (pickoffFor) onPickoff(pickoffFor.base, pickoffFor.runnerId, outcome);
          setPickoffFor(null);
        }}
        onCancel={() => setPickoffFor(null)}
      />
    </View>
  );
}

/**
 * Standard notations for a caught stealing, by the base being stolen.
 * Offered as one tap because they cover nearly every one that happens; the
 * grid underneath handles the rest.
 */
const CS_PRESETS: Record<1 | 2 | 3, { seq: number[]; hint: string }[]> = {
  1: [
    { seq: [2, 4], hint: 'C to 2B' },
    { seq: [2, 6], hint: 'C to SS' },
  ],
  2: [
    { seq: [2, 5], hint: 'C to 3B' },
    { seq: [2, 6], hint: 'C to SS' },
  ],
  3: [
    { seq: [2], hint: 'C unassisted' },
    { seq: [1, 2], hint: 'P to C' },
  ],
};

const STOLEN_BASE_LABEL: Record<1 | 2 | 3, string> = { 1: '2nd', 2: '3rd', 3: 'home' };

/**
 * How the caught stealing was turned — 2-6, 2-4, 2-5.
 *
 * The sequence is optional: a scorer who only saw the out should not be
 * blocked from recording it, and an absent sequence reads as "not recorded"
 * rather than as a claim about the play.
 */
function CaughtStealingModal({
  runner,
  onRecord,
  onCancel,
}: {
  runner: { base: 1 | 2 | 3; runnerId: string; name: string } | null;
  onRecord: (sequence: number[]) => void;
  onCancel: () => void;
}) {
  const [sequence, setSequence] = useState<number[]>([]);

  useEffect(() => {
    if (runner) setSequence([]);
  }, [runner]);

  if (!runner) return null;
  const presets = CS_PRESETS[runner.base];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '90%' }}>
          <Text className="text-lg font-bold text-gray-900 mb-1">
            Caught stealing {STOLEN_BASE_LABEL[runner.base]}
          </Text>
          <Text className="text-sm text-gray-500 mb-4">
            {runner.name} — who made the play?
          </Text>

          <View className="flex-row items-center mb-4">
            <Text className="text-xs text-gray-500 w-16">Sequence</Text>
            <Text className="flex-1 text-2xl font-bold text-gray-900">
              {sequence.length > 0 ? formatFieldingSequence(sequence) : '—'}
            </Text>
            {sequence.length > 0 && (
              <TouchableOpacity
                onPress={() => setSequence((prev) => prev.slice(0, -1))}
                className="px-3 py-1.5 rounded-full bg-gray-100 border border-gray-200"
              >
                <Text className="text-xs font-semibold text-gray-700">Undo</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView style={{ maxHeight: 400 }}>
            <Text className="text-[11px] font-semibold text-gray-500 mb-2">COMMON</Text>
            <View className="flex-row gap-2 mb-5">
              {presets.map((preset) => (
                <TouchableOpacity
                  key={preset.seq.join('-')}
                  onPress={() => setSequence(preset.seq)}
                  className="px-4 py-2.5 rounded-xl bg-white border border-sky-300"
                >
                  <Text className="text-base font-bold text-sky-900">
                    {formatFieldingSequence(preset.seq)}
                  </Text>
                  <Text className="text-[11px] text-gray-500">{preset.hint}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text className="text-[11px] font-semibold text-gray-500 mb-2">
              OR TAP FIELDERS IN ORDER
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {FIELDING_POSITION_NUMBERS.map((pos) => (
                <TouchableOpacity
                  key={pos.number}
                  onPress={() => setSequence((prev) => [...prev, pos.number])}
                  className="rounded-xl bg-white border border-gray-300 px-3 py-2.5 items-center"
                  style={{ width: 84 }}
                >
                  <Text className="text-base font-bold text-gray-900">{pos.number}</Text>
                  <Text className="text-[11px] text-gray-500">{pos.abbr}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <TouchableOpacity
            onPress={() => onRecord(sequence)}
            className="mt-5 rounded-xl py-4 items-center bg-rose-600"
          >
            <Text className="text-white font-bold text-base">
              Record out{sequence.length > 0 ? ` — ${formatFieldingSequence(sequence)}` : ''}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity className="mt-2 py-3 items-center" onPress={onCancel}>
            <Text className="text-gray-500 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export type PickoffOutcome = 'safe' | 'out' | 'error';

/**
 * How the pickoff throw ended. Three results, and only one retires the
 * runner — a throw that gets away moves him up instead, which is the
 * opposite outcome and was previously unrecordable.
 */
function PickoffOutcomeModal({
  runner,
  onPick,
  onCancel,
}: {
  runner: { base: 1 | 2 | 3; runnerId: string; name: string } | null;
  onPick: (outcome: PickoffOutcome) => void;
  onCancel: () => void;
}) {
  // Only meaningful from 1st or 2nd; a runner on 3rd scores, handled below.
  const nextBase =
    runner && runner.base < 3 ? BASE_ABBREV[(runner.base + 1) as 2 | 3] : '';
  return (
    <Modal visible={!!runner} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
          <Text className="text-lg font-bold text-gray-900 mb-1">
            Pickoff at {runner ? BASE_ABBREV[runner.base] : ''}
          </Text>
          <Text className="text-sm text-gray-500 mb-4">
            {runner ? runner.name : ''} — how did the throw end?
          </Text>
          <View className="gap-3">
            <PickoffChoice
              label="Safe"
              sub="Runner gets back. Nothing changes."
              tone="bg-white border-slate-300"
              textTone="text-slate-800"
              onPress={() => onPick('safe')}
            />
            <PickoffChoice
              label="Out"
              sub="Runner is picked off."
              tone="bg-white border-rose-300"
              textTone="text-rose-800"
              onPress={() => onPick('out')}
            />
            <PickoffChoice
              label="Attempted, error"
              sub={
                runner?.base === 3
                  ? 'Throw gets away. Runner scores, charged as an error.'
                  : `Throw gets away. Runner takes ${nextBase}, charged as an error.`
              }
              tone="bg-white border-amber-300"
              textTone="text-amber-800"
              onPress={() => onPick('error')}
            />
          </View>
          <TouchableOpacity className="mt-4 py-3 items-center" onPress={onCancel}>
            <Text className="text-gray-500 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function PickoffChoice({
  label,
  sub,
  tone,
  textTone,
  onPress,
}: {
  label: string;
  sub: string;
  tone: string;
  textTone: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity className={`rounded-xl border px-5 py-4 ${tone}`} onPress={onPress}>
      <Text className={`font-semibold text-base ${textTone}`}>{label}</Text>
      <Text className="text-gray-500 text-xs mt-0.5">{sub}</Text>
    </TouchableOpacity>
  );
}

interface BattingOrderRow {
  playerId: string;
  battingOrder: number;
  name: string;
  /** player_position enum value, or null when the slot has no position. */
  position: string | null;
}

/** Scorecard abbreviations for the player_position enum. */
const POSITION_ABBREV: Record<string, string> = {
  pitcher: 'P',
  catcher: 'C',
  first_base: '1B',
  second_base: '2B',
  third_base: '3B',
  shortstop: 'SS',
  left_field: 'LF',
  center_field: 'CF',
  right_field: 'RF',
  designated_hitter: 'DH',
  infield: 'IF',
  outfield: 'OF',
  utility: 'UT',
};

/**
 * The batting team's order, at a glance.
 *
 * A scorer tracks two things between pitches: who is up, and how far the
 * order is from turning over. Both are position in a list, so the list is
 * the display — the batter at the plate and the hitter on deck are marked
 * in place rather than pulled out into separate readouts.
 */
function BattingOrderCard({
  title,
  rows,
  currentBatterId,
  onDeckBatterId,
  accent,
  headerRight,
}: {
  title: string;
  rows: BattingOrderRow[];
  currentBatterId: string | null;
  onDeckBatterId: string | null;
  accent: 'ours' | 'theirs';
  /** Controls for the batter at the plate, shown beside the title. */
  headerRight?: ReactNode;
}) {
  if (rows.length === 0) return null;
  // Our half and theirs read as two different cards, so the eye can tell
  // which book it is looking at without reading the header.
  const atBatRow = accent === 'ours' ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-100 border-slate-300';
  const atBatText = accent === 'ours' ? 'text-emerald-900' : 'text-slate-900';
  const slotText = accent === 'ours' ? 'text-emerald-700' : 'text-slate-600';
  return (
    <View className="px-4 pt-2 pb-1 border-t border-gray-100">
      <View className="flex-row items-center mb-1">
        <Text
          className="flex-1 text-[11px] font-semibold text-gray-500"
          numberOfLines={1}
        >
          {title}
        </Text>
        {headerRight}
      </View>
      {/* No row gap and tight padding: a ten-deep order has to fit the pane
          without scrolling, or the scorer loses the bottom of the lineup at
          exactly the moment the order turns over. */}
      <View>
        {rows.map((row) => {
          const isAtBat = row.playerId === currentBatterId;
          const isOnDeck = !isAtBat && row.playerId === onDeckBatterId;
          return (
            <View
              key={`${row.battingOrder}-${row.playerId}`}
              className={`flex-row items-center rounded-md px-2 py-0.5 border ${
                isAtBat ? atBatRow : 'bg-transparent border-transparent'
              }`}
            >
              <Text
                className={`w-6 text-xs font-bold ${isAtBat ? slotText : 'text-gray-400'}`}
              >
                {row.battingOrder}
              </Text>
              <Text
                className={`flex-1 text-[13px] ${
                  isAtBat ? `font-bold ${atBatText}` : 'text-gray-800'
                }`}
                numberOfLines={1}
              >
                {row.name}
              </Text>
              {row.position && (
                <Text className="w-7 text-[11px] text-gray-400 text-right">
                  {POSITION_ABBREV[row.position] ?? ''}
                </Text>
              )}
              <Text className={`w-16 text-[10px] font-semibold text-right ${slotText}`}>
                {isAtBat ? 'AT BAT' : isOnDeck ? 'on deck' : ''}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Same rotation override as our own order, for the opposing lineup. Their
 * batting order drifts more than ours — the scorer is reading it off a
 * shouted announcement — so pointing at the right hitter matters.
 */
function OpponentBatterPickerModal({
  visible,
  slots,
  dueBatterId,
  selectedId,
  onSelect,
  onCancel,
}: {
  visible: boolean;
  slots: OpponentBatter[];
  dueBatterId: string | null;
  selectedId: string | null;
  onSelect: (playerId: string) => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '75%' }}>
          <Text className="text-lg font-bold text-gray-900 mb-1">Opponent at the plate</Text>
          <Text className="text-sm text-gray-500 mb-4">
            Pick who is batting. The rotation resumes from this batter after
            the plate appearance completes.
          </Text>
          <ScrollView className="max-h-96">
            <View className="gap-2">
              {slots.map((slot) => {
                const isSelected = slot.playerId === selectedId;
                const isDue = slot.playerId === dueBatterId;
                return (
                  <TouchableOpacity
                    key={slot.playerId}
                    className={`flex-row items-center rounded-xl px-4 py-3 border ${
                      isSelected ? 'bg-slate-600 border-slate-700' : 'bg-white border-gray-300'
                    }`}
                    onPress={() => onSelect(slot.playerId)}
                  >
                    <Text className={`w-8 font-bold ${isSelected ? 'text-white' : 'text-gray-400'}`}>
                      {slot.battingOrder}
                    </Text>
                    <Text className={`flex-1 font-semibold ${isSelected ? 'text-white' : 'text-gray-900'}`}>
                      {slot.name}
                    </Text>
                    {isDue && (
                      <Text className={`text-xs font-semibold ${isSelected ? 'text-slate-100' : 'text-slate-600'}`}>
                        due up
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <TouchableOpacity
            className="mt-4 rounded-xl px-5 py-3 bg-gray-100 items-center"
            onPress={onCancel}
          >
            <Text className="text-gray-700 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Add a batter to an order mid-game — either side's.
 *
 * Two ways in, because a scorer meets a new batter two ways: someone already
 * on a tracked roster, or a name and number read off a shirt. The second is
 * the common one at the field, so it is not hidden behind the first.
 */
function AddBatterModal({
  visible,
  title,
  rosterLabel,
  roster,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  rosterLabel: string;
  roster: Array<{ id: string; name: string }>;
  onSubmit: (
    input:
      | { kind: 'roster'; opponentPlayerId: string }
      | { kind: 'new'; firstName: string; lastName: string; jerseyNumber: string },
  ) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [jersey, setJersey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Clear between openings so a previous entry (or error) never bleeds into
  // the next batter the scorer adds.
  useEffect(() => {
    if (!visible) return;
    setFirstName('');
    setLastName('');
    setJersey('');
    setError(null);
    setBusy(false);
  }, [visible]);

  async function run(
    input:
      | { kind: 'roster'; opponentPlayerId: string }
      | { kind: 'new'; firstName: string; lastName: string; jerseyNumber: string },
  ) {
    if (busy) return;
    setBusy(true);
    setError(await onSubmit(input));
    setBusy(false);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '85%' }}>
          <Text className="text-lg font-bold text-gray-900 mb-1">{title}</Text>
          <Text className="text-sm text-gray-500 mb-4">
            Goes to the end of their order. Saves on the device — it reaches
            the server whenever you have signal.
          </Text>

          {error && (
            <View className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
              <Text className="text-sm text-red-700">{error}</Text>
            </View>
          )}

          <ScrollView className="max-h-96">
            <Text className="text-xs font-semibold text-gray-500 mb-2">NEW BATTER</Text>
            <View className="flex-row gap-2">
              <TextInput
                value={jersey}
                onChangeText={setJersey}
                placeholder="##"
                keyboardType="number-pad"
                className="w-16 rounded-xl border border-gray-300 px-3 py-3 text-base text-gray-900"
              />
              <TextInput
                value={firstName}
                onChangeText={setFirstName}
                placeholder="First"
                autoCapitalize="words"
                className="flex-1 rounded-xl border border-gray-300 px-3 py-3 text-base text-gray-900"
              />
              <TextInput
                value={lastName}
                onChangeText={setLastName}
                placeholder="Last"
                autoCapitalize="words"
                className="flex-1 rounded-xl border border-gray-300 px-3 py-3 text-base text-gray-900"
              />
            </View>
            <TouchableOpacity
              disabled={busy}
              onPress={() => run({ kind: 'new', firstName, lastName, jerseyNumber: jersey })}
              className={`mt-3 rounded-xl py-3 items-center ${busy ? 'bg-slate-300' : 'bg-slate-700'}`}
            >
              <Text className="text-white font-semibold">Add to order</Text>
            </TouchableOpacity>
            <Text className="text-xs text-gray-400 mt-2">
              A jersey number on its own is enough — you can add the name later.
            </Text>

            {roster.length > 0 && (
              <>
                <Text className="text-xs font-semibold text-gray-500 mt-6 mb-2">
                  {rosterLabel}
                </Text>
                <View className="gap-2">
                  {roster.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      disabled={busy}
                      className="rounded-xl px-4 py-3 bg-white border border-slate-300"
                      onPress={() => run({ kind: 'roster', opponentPlayerId: p.id })}
                    >
                      <Text className="text-slate-800 font-semibold text-base">{p.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </ScrollView>

          <TouchableOpacity
            className="mt-4 rounded-xl px-5 py-3 bg-gray-100 items-center"
            onPress={onCancel}
          >
            <Text className="text-gray-700 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Checkbox-style row for the Start Game "what to track" step. */
function TrackingToggle({
  label,
  hint,
  value,
  onToggle,
}: {
  label: string;
  hint: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      className={`flex-row items-center rounded-xl px-4 py-3 border ${
        value ? 'bg-emerald-50 border-emerald-500' : 'bg-white border-gray-300'
      }`}
      onPress={onToggle}
    >
      <View
        className={`w-6 h-6 rounded-md items-center justify-center mr-3 border ${
          value ? 'bg-emerald-600 border-emerald-700' : 'bg-white border-gray-400'
        }`}
      >
        {value ? <Text className="text-white text-xs font-bold">✓</Text> : null}
      </View>
      <View className="flex-1">
        <Text className="text-gray-900 font-semibold">{label}</Text>
        <Text className="text-gray-500 text-xs mt-0.5">{hint}</Text>
      </View>
    </TouchableOpacity>
  );
}

function LineupSetupModal({
  visible,
  roster,
  initialPitcherId = null,
  initialBatterId = null,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  roster: RosterPlayer[];
  /** Prefill from the saved lineup (position = pitcher / batting slot 1). */
  initialPitcherId?: string | null;
  initialBatterId?: string | null;
  onCancel: () => void;
  onSubmit: (
    pitcherId: string,
    batterId: string,
    tracking: { pitchType: boolean; pitchLocation: boolean },
  ) => void;
}) {
  const [pitcherId, setPitcherId] = useState<string | null>(null);
  const [batterId, setBatterId] = useState<string | null>(null);
  const [step, setStep] = useState<'pitcher' | 'batter' | 'tracking'>('pitcher');
  const [trackPitchType, setTrackPitchType] = useState(true);
  const [trackPitchLocation, setTrackPitchLocation] = useState(false);

  useEffect(() => {
    if (visible) {
      setPitcherId(initialPitcherId);
      setBatterId(initialBatterId);
      setStep('pitcher');
      setTrackPitchType(true);
      setTrackPitchLocation(false);
    }
  }, [visible, initialPitcherId, initialBatterId]);

  const onPitcherStep = step === 'pitcher';
  const onBatterStep = step === 'batter';
  const onTrackingStep = step === 'tracking';
  const selectedId = onPitcherStep ? pitcherId : batterId;
  // The tracking step is always satisfiable — tracking nothing is a valid choice.
  const canAdvance = onTrackingStep || selectedId !== null;
  const stepNumber = onPitcherStep ? 1 : onBatterStep ? 2 : 3;
  const label = (p: RosterPlayer) =>
    `${p.jerseyNumber !== undefined ? `#${p.jerseyNumber} ` : ''}${p.name}`;
  const pitcher = roster.find((p) => p.id === pitcherId);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl" style={{ maxHeight: '85%' }}>
          {/* Header — fixed height */}
          <View className="px-5 pt-5 pb-3">
            <Text className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Step {stepNumber} of 3
            </Text>
            <Text className="text-xl font-bold text-gray-900">
              {onPitcherStep
                ? "Who's pitching?"
                : onBatterStep
                  ? "Who's batting first?"
                  : 'What do you want to track?'}
            </Text>
            {!onPitcherStep && pitcher ? (
              <Text className="text-sm text-gray-500 mt-1">
                Pitcher: {label(pitcher)}
              </Text>
            ) : null}
          </View>

          {/* Roster — the only part that scrolls. flexShrink:1 is required:
              React Native defaults flexShrink to 0, so without it this grows
              past the sheet's maxHeight and pushes the footer off-screen. */}
          {onTrackingStep ? (
            <ScrollView className="px-5" style={{ flexShrink: 1 }}>
              <Text className="text-sm text-gray-500 mb-4">
                Anything you turn off is hidden while scoring, so the buttons
                stay out of your way. You can still record the game without it.
              </Text>
              <View className="gap-2 pb-2">
                <TrackingToggle
                  label="Pitch type"
                  hint="FB, CB, SL… tagged on each pitch"
                  value={trackPitchType}
                  onToggle={() => setTrackPitchType((v) => !v)}
                />
                <TrackingToggle
                  label="Pitch location"
                  hint="Where it crossed the zone, on a 3×3 grid"
                  value={trackPitchLocation}
                  onToggle={() => setTrackPitchLocation((v) => !v)}
                />
              </View>
            </ScrollView>
          ) : roster.length === 0 ? (
            <Text className="text-gray-500 text-sm px-5 py-4">
              No players loaded. Sync the roster first.
            </Text>
          ) : (
            <ScrollView className="px-5" style={{ flexShrink: 1 }}>
              <View className="gap-2 pb-2">
                {roster.map((p) => {
                  const isSelected = selectedId === p.id;
                  const selectedClass = onPitcherStep
                    ? 'bg-blue-600 border-blue-700'
                    : 'bg-green-600 border-green-700';
                  return (
                    <TouchableOpacity
                      key={p.id}
                      className={`flex-row items-center justify-between rounded-xl px-4 py-3 border ${
                        isSelected ? selectedClass : 'bg-white border-gray-300'
                      }`}
                      onPress={() =>
                        onPitcherStep ? setPitcherId(p.id) : setBatterId(p.id)
                      }
                    >
                      <Text
                        className={
                          isSelected
                            ? 'text-white font-semibold'
                            : 'text-gray-900 font-semibold'
                        }
                      >
                        {label(p)}
                      </Text>
                      {isSelected ? (
                        <Text className="text-white font-bold">✓</Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          )}

          {/* Footer — fixed, always reachable */}
          <View className="flex-row gap-3 px-5 pt-3 pb-8 border-t border-gray-200">
            <TouchableOpacity
              className="flex-1 rounded-xl px-5 py-3 bg-gray-100 items-center"
              onPress={() => {
                if (onPitcherStep) onCancel();
                else if (onBatterStep) setStep('pitcher');
                else setStep('batter');
              }}
            >
              <Text className="text-gray-700 font-semibold">
                {onPitcherStep ? 'Cancel' : 'Back'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className={`flex-1 rounded-xl px-5 py-3 items-center ${
                canAdvance ? 'bg-emerald-600' : 'bg-emerald-300'
              }`}
              disabled={!canAdvance}
              onPress={() => {
                if (!canAdvance) return;
                if (onPitcherStep) {
                  setStep('batter');
                } else if (onBatterStep) {
                  setStep('tracking');
                } else if (pitcherId && batterId) {
                  onSubmit(pitcherId, batterId, {
                    pitchType: trackPitchType,
                    pitchLocation: trackPitchLocation,
                  });
                }
              }}
            >
              <Text className="text-white font-semibold">
                {onTrackingStep ? 'Start Game' : 'Next'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
