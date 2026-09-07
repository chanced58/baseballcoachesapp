import { EventType, type GameEvent, type PitchThrownPayload, type HitPayload, type SubstitutionPayload, type PitchingChangePayload, type BaserunnerMovePayload, type PickoffPayload, type RundownPayload, type DroppedThirdStrikePayload } from '../types/game-event';
import type { LiveGameState } from '../types/game';
import { BALLS_FOR_WALK, STRIKES_FOR_STRIKEOUT, OUTS_PER_INNING } from '../constants/baseball';

/**
 * Per-runner outcome overrides for a single parent play (HIT, etc.). Built
 * from any BASERUNNER_OUT / BASERUNNER_ADVANCE events whose payload carries
 * `relatedEventId` pointing back to the parent. The parent handler consults
 * this to skip default auto-advance and run-scoring for runners whose
 * outcome on the play is explicitly captured by a linked event.
 */
interface RunnerOverrides {
  outRunnerIds: Set<string>;
  advancedRunnerIds: Set<string>;
}

/**
 * Replay-order filter for correction events, in the camelCase GameEvent
 * domain (counterpart of applyPitchReverted in event-filters.ts, which
 * operates on snake_case DB rows). PITCH_REVERTED trims the accumulated
 * stream back to a sequence number; EVENT_VOIDED removes its target event
 * (matched by id, falling back to voidedSequenceNumber). The correction
 * markers themselves never reach the replay loop.
 */
export function filterVoidedAndRevertedEvents(events: GameEvent[]): GameEvent[] {
  const result: GameEvent[] = [];
  for (const event of events) {
    if (event.eventType === EventType.PITCH_REVERTED) {
      const p = event.payload as { revertToSequenceNumber?: number };
      if (typeof p.revertToSequenceNumber === 'number') {
        const keepUntilSeq = p.revertToSequenceNumber;
        // Filter the accumulated result (not the original array) so that
        // earlier corrections are respected — mirrors applyPitchReverted.
        result.splice(0, result.length, ...result.filter((r) => r.sequenceNumber <= keepUntilSeq));
      }
    } else if (event.eventType === EventType.EVENT_VOIDED) {
      const p = event.payload as { voidedEventId?: string; voidedSequenceNumber?: number };
      let idx = p.voidedEventId ? result.findIndex((r) => r.id === p.voidedEventId) : -1;
      if (idx === -1 && typeof p.voidedSequenceNumber === 'number') {
        idx = result.findIndex((r) => r.sequenceNumber === p.voidedSequenceNumber);
      }
      if (idx !== -1) result.splice(idx, 1);
    } else {
      result.push(event);
    }
  }
  return result;
}

/**
 * Derives the current live game state by replaying a sorted array of GameEvents.
 * This is a pure function — same inputs always produce the same output.
 * Events must be sorted by sequenceNumber ascending before calling.
 * EVENT_VOIDED / PITCH_REVERTED corrections are applied internally, so
 * callers may pass the raw event stream (pre-filtered input is also fine —
 * the filter is idempotent).
 */
export function deriveGameState(
  gameId: string,
  events: GameEvent[],
  // Home/away is derived from isTopOfInning, not the team id — kept for a
  // stable call signature across web/mobile callers.
  _homeTeamId: string,
): LiveGameState {
  const activeEvents = filterVoidedAndRevertedEvents(events);
  const runnerOverridesByParentId = buildRunnerOverrideMap(activeEvents);
  const state: LiveGameState = {
    gameId,
    inning: 1,
    isTopOfInning: true,
    outs: 0,
    balls: 0,
    strikes: 0,
    homeScore: 0,
    awayScore: 0,
    runnersOnBase: { first: null, second: null, third: null },
    currentBatterId: null,
    currentPitcherId: null,
    currentPitcherPitchCount: 0,
    completedTopHalfPAs: 0,
    completedBottomHalfPAs: 0,
    homeLeadoffBatterId: null,
    awayLeadoffBatterId: null,
    isFinal: false,
    pitcherPitchCounts: {},
  };

  // Alias — mutated by PITCH_THROWN below; exposed on the returned state so
  // consumers (pitch-count compliance UI) can read every pitcher's total.
  const pitcherCounts = state.pitcherPitchCounts;

  for (const event of activeEvents) {
    switch (event.eventType) {
      case EventType.GAME_START: {
        const p = event.payload as {
          homeLineupPitcherId?: string;
          awayLineupPitcherId?: string;
          homeLeadoffBatterId?: string;
          awayLeadoffBatterId?: string;
        };
        state.currentPitcherId = state.isTopOfInning
          ? p.homeLineupPitcherId ?? null
          : p.awayLineupPitcherId ?? null;
        // Cache both leadoffs so INNING_CHANGE can restore the right one when
        // a half-inning starts with no current batter (e.g. home-team scorer
        // entered only the home leadoff via the LineupSetupModal).
        state.homeLeadoffBatterId = p.homeLeadoffBatterId ?? null;
        state.awayLeadoffBatterId = p.awayLeadoffBatterId ?? null;
        // Top of first: away team bats, so the away leadoff is current.
        // Bottom of first (or when replay starts mid-inning): home leadoff.
        state.currentBatterId = state.isTopOfInning
          ? state.awayLeadoffBatterId
          : state.homeLeadoffBatterId;
        break;
      }

      case EventType.PITCH_THROWN: {
        const p = event.payload as PitchThrownPayload;
        const pitcherId = p.pitcherId ?? p.opponentPitcherId ?? null;
        const batterId  = p.batterId  ?? p.opponentBatterId  ?? null;
        state.currentPitcherId = pitcherId;
        state.currentBatterId  = batterId;
        if (pitcherId) {
          pitcherCounts[pitcherId] = (pitcherCounts[pitcherId] ?? 0) + 1;
          state.currentPitcherPitchCount = pitcherCounts[pitcherId];
        }

        switch (p.outcome) {
          case 'called_strike':
          case 'swinging_strike':
          case 'foul_tip':
            if (state.strikes < STRIKES_FOR_STRIKEOUT - 1) state.strikes++;
            break;
          case 'foul':
            if (state.strikes < STRIKES_FOR_STRIKEOUT - 1) state.strikes++;
            break;
          case 'ball':
          case 'intentional_ball':
            state.balls++;
            break;
          case 'hit_by_pitch':
            // Batter advances to first; handled by HIT_BY_PITCH event
            state.balls = 0;
            state.strikes = 0;
            break;
          case 'in_play':
            // Outcome determined by subsequent HIT / OUT / etc. event
            break;
        }
        break;
      }

      case EventType.WALK:
      case EventType.HIT_BY_PITCH:
      case EventType.CATCHER_INTERFERENCE: {
        // Per OBR 9.04(a)(2), bases-loaded walk / HBP / catcher interference
        // force in a run. Same state transition in all three cases: batter
        // reaches first, runners advance when forced.
        // Prefer the payload's batter/opponentBatter id over currentBatterId:
        // currentBatterId is only updated by PITCH_THROWN, so between PAs it
        // may still point at the previous batter if the scorer jumps
        // straight to a walk/HBP/CI (or if events arrive out of order
        // via corrections).
        const p = event.payload as { batterId?: string; opponentBatterId?: string };
        const batterId = baserunnerIdentity(p, state.currentBatterId, event.id);
        const walkBasesLoaded = !!(
          state.runnersOnBase.first &&
          state.runnersOnBase.second &&
          state.runnersOnBase.third
        );
        state.runnersOnBase = forceAdvanceRunners(state.runnersOnBase, batterId);
        if (walkBasesLoaded) addRuns(state, 1, state.isTopOfInning);
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.HIT: {
        const p = event.payload as HitPayload;
        const bases = hitTypeToBases(p.hitType);
        // Place the payload's batter on base, not state.currentBatterId:
        // currentBatterId only updates on PITCH_THROWN, so a HIT recorded
        // without a preceding pitch (quick entry) would otherwise strand the
        // stale previous batter's id on the bag. Mirrors the WALK handler.
        const hitBatterId = baserunnerIdentity(p, state.currentBatterId, event.id);
        // Guard runner advancement / run scoring when the inning is already
        // over (e.g. a fielder's choice whose preceding BASERUNNER_OUT was
        // the 3rd out). The batter still completes a PA + AB, so incrementPA
        // runs unconditionally — mirrors the SACRIFICE_FLY shape above.
        if (state.outs < OUTS_PER_INNING) {
          // Runners with a linked BASERUNNER_OUT / BASERUNNER_ADVANCE event
          // (same parent id) are excluded from default scoring + advancement;
          // the linked event handles them. Lets the scorer record "R2 held at
          // 3B on a double" or "R1 thrown out at 3B advancing" without
          // double-counting runs or stranding the runner on a default base.
          const overrides = runnerOverridesByParentId.get(event.id);
          const r1 = state.runnersOnBase.first;
          const r2 = state.runnersOnBase.second;
          const r3 = state.runnersOnBase.third;
          if (bases === 4) {
            let runs = 1; // batter
            if (r1 && !isRunnerOverridden(r1, overrides)) runs++;
            if (r2 && !isRunnerOverridden(r2, overrides)) runs++;
            if (r3 && !isRunnerOverridden(r3, overrides)) runs++;
            addRuns(state, runs, state.isTopOfInning);
            state.runnersOnBase = { first: null, second: null, third: null };
          } else {
            // Count runners who reach home on this hit before advancing the base state.
            // Runner on 3rd always scores on any hit (3+bases >= 4 for all single/double/triple).
            // Runner on 2nd scores on a double or triple (2+bases >= 4).
            // Runner on 1st scores only on a triple (1+bases >= 4).
            let runs = 0;
            if (r3 && !isRunnerOverridden(r3, overrides))                    runs++;
            if (r2 && 2 + bases >= 4 && !isRunnerOverridden(r2, overrides))  runs++;
            if (r1 && 1 + bases >= 4 && !isRunnerOverridden(r1, overrides))  runs++;
            if (runs > 0) addRuns(state, runs, state.isTopOfInning);
            state.runnersOnBase = advanceRunnersWithOverrides(
              state.runnersOnBase, hitBatterId, bases, overrides,
            );
          }
        }
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.SCORE: {
        // Each SCORE event represents exactly 1 run scored (rbis tracks RBI credit,
        // which may be 0 for balks/wild pitches, but the run still counts).
        // No run can score after the 3rd out of a half-inning.
        if (state.outs < OUTS_PER_INNING) {
          addRuns(state, 1, state.isTopOfInning);
        }
        break;
      }

      case EventType.FIELD_ERROR: {
        // Batter reaches base on the error — force-advance any runners already
        // on base (same logic as a walk) and place batter on first.
        // If bases were loaded, the runner on third is forced home.
        const p = event.payload as { batterId?: string; opponentBatterId?: string };
        const errorBatterId = baserunnerIdentity(p, state.currentBatterId, event.id);
        const errorBasesLoaded = !!(
          state.runnersOnBase.first &&
          state.runnersOnBase.second &&
          state.runnersOnBase.third
        );
        state.runnersOnBase = forceAdvanceRunners(state.runnersOnBase, errorBatterId);
        if (errorBasesLoaded) addRuns(state, 1, state.isTopOfInning);
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.OUT:
      case EventType.STRIKEOUT: {
        state.outs++;
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.DROPPED_THIRD_STRIKE: {
        const p = event.payload as DroppedThirdStrikePayload;
        if (p.outcome === 'thrown_out') {
          state.outs++;
        } else {
          // Batter reaches first — force-advance runners
          const d3kBatterId = baserunnerIdentity(p, state.currentBatterId, event.id);
          const basesLoaded = !!(
            state.runnersOnBase.first &&
            state.runnersOnBase.second &&
            state.runnersOnBase.third
          );
          state.runnersOnBase = forceAdvanceRunners(state.runnersOnBase, d3kBatterId);
          if (basesLoaded) addRuns(state, 1, state.isTopOfInning);
        }
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.SACRIFICE_BUNT: {
        // Per OBR 9.08(a): a sac bunt's purpose is to advance one or more
        // runners at the cost of the batter's out. The common pattern is
        // every runner advances one base (squeeze play scores the runner
        // from third). Uncommon double-advances require manual
        // BASERUNNER_ADVANCE events.
        state.outs++;
        if (state.runnersOnBase.third && state.outs < OUTS_PER_INNING) {
          addRuns(state, 1, state.isTopOfInning);
        }
        state.runnersOnBase = {
          third: state.runnersOnBase.second,
          second: state.runnersOnBase.first,
          first: null,
        };
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.SACRIFICE_FLY: {
        state.outs++;
        // Runner on 3rd scores on sac fly (if fewer than 3 outs)
        if (state.runnersOnBase.third && state.outs < OUTS_PER_INNING) {
          addRuns(state, 1, state.isTopOfInning);
          state.runnersOnBase = { ...state.runnersOnBase, third: null };
        }
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.DOUBLE_PLAY: {
        // Batter is the first out and the forced runner (usually from 1st
        // on a standard 6-4-3 GIDP) is the second. When the scorer has
        // captured runnerOutBase on the payload, clear that specific
        // runner from base state; otherwise just bump the out counter
        // (legacy events may have no runner attribution).
        state.outs = Math.min(state.outs + 2, OUTS_PER_INNING);
        const p = event.payload as { runnerOutBase?: 1 | 2 | 3 };
        if (p.runnerOutBase === 1) state.runnersOnBase = { ...state.runnersOnBase, first: null };
        else if (p.runnerOutBase === 2) state.runnersOnBase = { ...state.runnersOnBase, second: null };
        else if (p.runnerOutBase === 3) state.runnersOnBase = { ...state.runnersOnBase, third: null };
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.TRIPLE_PLAY: {
        state.outs = Math.min(state.outs + 3, OUTS_PER_INNING);
        state.balls = 0;
        state.strikes = 0;
        incrementPA(state);
        break;
      }

      case EventType.INNING_CHANGE: {
        state.outs = 0;
        state.balls = 0;
        state.strikes = 0;
        state.runnersOnBase = { first: null, second: null, third: null };
        // Clear stale pitcher — the next PITCH_THROWN or PITCHING_CHANGE
        // will set the correct pitcher for the new half-inning.
        state.currentPitcherId = null;
        state.currentPitcherPitchCount = 0;
        if (state.isTopOfInning) {
          state.isTopOfInning = false;
        } else {
          state.isTopOfInning = true;
          state.inning++;
        }
        // Reset the current batter to the new offensive team's cached
        // leadoff (may be null if that team's leadoff was never recorded —
        // e.g. mobile home-team scorer who didn't enter the opponent's
        // lineup). This both fixes the original bug (Huskies-at-home stats
        // blank because home leadoff never reaches currentBatterId) and
        // prevents the prior half-inning's last batter from leaking into
        // the next half-inning, which would mis-attribute opponent
        // at-bats to a real player on the other team. The scorer is
        // expected to advance the lineup mid-inning via the Pinch Hitter
        // flow until a real batting-order screen exists.
        state.currentBatterId = state.isTopOfInning
          ? state.awayLeadoffBatterId
          : state.homeLeadoffBatterId;
        break;
      }

      case EventType.PITCHING_CHANGE: {
        const p = event.payload as PitchingChangePayload;
        state.currentPitcherId = p.newPitcherId;
        state.currentPitcherPitchCount = pitcherCounts[p.newPitcherId] ?? 0;
        break;
      }

      case EventType.SUBSTITUTION: {
        const p = event.payload as SubstitutionPayload;
        if (p.outPlayerId !== undefined && state.currentBatterId === p.outPlayerId) {
          state.currentBatterId = p.inPlayerId;
        }
        // Update runners if substituted player is on base. outPlayerId is
        // optional (e.g. when replacing a not-yet-identified runner), in
        // which case fall back to runnerBase to locate the slot to replace.
        const { runnersOnBase } = state;
        if (p.outPlayerId !== undefined) {
          if (runnersOnBase.first === p.outPlayerId) runnersOnBase.first = p.inPlayerId;
          if (runnersOnBase.second === p.outPlayerId) runnersOnBase.second = p.inPlayerId;
          if (runnersOnBase.third === p.outPlayerId) runnersOnBase.third = p.inPlayerId;
        } else if (p.runnerBase) {
          if (p.runnerBase === 1) runnersOnBase.first = p.inPlayerId;
          else if (p.runnerBase === 2) runnersOnBase.second = p.inPlayerId;
          else if (p.runnerBase === 3) runnersOnBase.third = p.inPlayerId;
        }
        break;
      }

      case EventType.STOLEN_BASE:
      case EventType.BASERUNNER_ADVANCE: {
        const p = event.payload as unknown as BaserunnerMovePayload;
        const runners = { ...state.runnersOnBase };
        // Remove from old base — only if the runner is still there. A linked
        // outcome event firing after a HIT may have a `fromBase` reflecting
        // the runner's pre-play position; the HIT case has already cleared
        // that slot (or placed the batter there), so clearing blindly would
        // wipe out an unrelated runner.
        if (p.fromBase === 1 && runners.first === p.runnerId) runners.first  = null;
        else if (p.fromBase === 2 && runners.second === p.runnerId) runners.second = null;
        else if (p.fromBase === 3 && runners.third === p.runnerId) runners.third  = null;
        // Place on new base (toBase 4 = scored; cleared from diamond, SCORE event adds the run)
        if (p.toBase === 2) runners.second = p.runnerId;
        else if (p.toBase === 3) runners.third  = p.runnerId;
        state.runnersOnBase = runners;
        break;
      }

      case EventType.BASERUNNER_OUT: {
        // A specific runner is called out (e.g., on a fielder's choice).
        // The batter's PA is handled by a subsequent HIT event, so do NOT
        // reset balls/strikes or increment PA here.
        const p = event.payload as Record<string, unknown>;
        const runnerId = p.runnerId as string;
        const runners = { ...state.runnersOnBase };
        if (runners.first  === runnerId) runners.first  = null;
        else if (runners.second === runnerId) runners.second = null;
        else if (runners.third  === runnerId) runners.third  = null;
        state.runnersOnBase = runners;
        state.outs++;
        break;
      }

      case EventType.CAUGHT_STEALING: {
        const p = event.payload as unknown as BaserunnerMovePayload;
        const runners = { ...state.runnersOnBase };
        if (p.fromBase === 1) runners.first  = null;
        else if (p.fromBase === 2) runners.second = null;
        else if (p.fromBase === 3) runners.third  = null;
        state.runnersOnBase = runners;
        state.outs++;
        state.balls = 0;
        state.strikes = 0;
        break;
      }

      case EventType.PICKOFF_ATTEMPT: {
        const p = event.payload as unknown as PickoffPayload;
        if (p.outcome === 'out') {
          const runners = { ...state.runnersOnBase };
          if (p.base === 1) runners.first  = null;
          else if (p.base === 2) runners.second = null;
          else if (p.base === 3) runners.third  = null;
          state.runnersOnBase = runners;
          state.outs++;
        }
        // outcome === 'safe' — no state change
        break;
      }

      case EventType.RUNDOWN: {
        const p = event.payload as unknown as RundownPayload;
        const runners = { ...state.runnersOnBase };
        // Remove runner from starting base
        if (p.startBase === 1) runners.first  = null;
        else if (p.startBase === 2) runners.second = null;
        else if (p.startBase === 3) runners.third  = null;

        if (p.outcome === 'out') {
          state.outs++;
        } else if (p.outcome === 'safe') {
          // safeAtBase is required by the discriminated union when outcome === 'safe'
          if (p.safeAtBase === 1) runners.first  = p.runnerId;
          else if (p.safeAtBase === 2) runners.second = p.runnerId;
          else if (p.safeAtBase === 3) runners.third  = p.runnerId;
        }
        state.runnersOnBase = runners;
        break;
      }

      case EventType.BALK: {
        // All runners advance one base; runner on 3rd scores via subsequent SCORE event
        const runners = { ...state.runnersOnBase };
        runners.third  = runners.second;
        runners.second = runners.first;
        runners.first  = null;
        state.runnersOnBase = runners;
        break;
      }

      case EventType.GAME_END: {
        // Marks the game final. Scores/runners are left untouched — the
        // event's payload scores are advisory (the server re-derives finals
        // from the full log when completing the game).
        state.isFinal = true;
        break;
      }
    }
  }

  return state;
}

/**
 * Who to put on the bases for this plate appearance.
 *
 * Opponent halves frequently have no batter id: a scorer keeping their own
 * team's book has no opponent roster, and entering the opponent lineup is
 * optional. Falling through to null meant the batter was never placed on a
 * base — the runner simply vanished, and every run they would later have
 * scored was lost, so a string of opponent hits left the score at 0.
 *
 * The event id is a stable stand-in: it replays identically, is unique per
 * plate appearance (so three anonymous runners can be on base at once), and
 * cannot collide with a real player id. It identifies a runner only — stats
 * attribution still reads the payload's batter fields, which stay empty, so
 * nothing is mis-credited to a named player.
 */
function baserunnerIdentity(
  payload: { batterId?: string; opponentBatterId?: string },
  currentBatterId: string | null,
  eventId: string,
): string {
  return payload.batterId ?? payload.opponentBatterId ?? currentBatterId ?? eventId;
}

function hitTypeToBases(hitType: string): number {
  switch (hitType) {
    case 'single': return 1;
    case 'double': return 2;
    case 'triple': return 3;
    case 'home_run': return 4;
    default: return 1;
  }
}

function advanceRunners(
  runners: LiveGameState['runnersOnBase'],
  batterId: string | null,
  bases: number,
): LiveGameState['runnersOnBase'] {
  // All runners advance the same number of bases as the batter (standard hit model).
  // Runners who reach home plate are cleared here; runs are counted by the HIT case before calling this.
  const result: LiveGameState['runnersOnBase'] = { first: null, second: null, third: null };

  if (runners.second) {
    const dest = 2 + bases;
    if (dest === 3) result.third = runners.second;
    // dest >= 4: runner scores, stays null in result
  }
  if (runners.first) {
    const dest = 1 + bases;
    if (dest === 2) result.second = runners.first;
    else if (dest === 3) result.third = runners.first;
    // dest >= 4: runner scores, stays null in result
  }

  // Place batter at the correct base
  if (bases === 1) result.first = batterId;
  else if (bases === 2) result.second = batterId;
  else if (bases === 3) result.third = batterId;
  // bases === 4 (home run) is handled separately in the HIT case

  return result;
}

function isRunnerOverridden(runnerId: string, overrides: RunnerOverrides | undefined): boolean {
  if (!overrides) return false;
  return overrides.outRunnerIds.has(runnerId) || overrides.advancedRunnerIds.has(runnerId);
}

function advanceRunnersWithOverrides(
  runners: LiveGameState['runnersOnBase'],
  batterId: string | null,
  bases: number,
  overrides: RunnerOverrides | undefined,
): LiveGameState['runnersOnBase'] {
  // Fast path when nothing on the play diverges from the default advance.
  if (!overrides || (overrides.outRunnerIds.size === 0 && overrides.advancedRunnerIds.size === 0)) {
    return advanceRunners(runners, batterId, bases);
  }
  const result: LiveGameState['runnersOnBase'] = { first: null, second: null, third: null };
  // Skip overridden runners — the linked BASERUNNER_OUT removes them and
  // bumps outs, or the linked BASERUNNER_ADVANCE places them at toBase.
  if (runners.second && !isRunnerOverridden(runners.second, overrides)) {
    const dest = 2 + bases;
    if (dest === 3) result.third = runners.second;
  }
  if (runners.first && !isRunnerOverridden(runners.first, overrides)) {
    const dest = 1 + bases;
    if (dest === 2) result.second = runners.first;
    else if (dest === 3) result.third = runners.first;
  }
  if (bases === 1) result.first = batterId;
  else if (bases === 2) result.second = batterId;
  else if (bases === 3) result.third = batterId;
  return result;
}

function buildRunnerOverrideMap(events: GameEvent[]): Map<string, RunnerOverrides> {
  const map = new Map<string, RunnerOverrides>();
  for (const event of events) {
    if (
      event.eventType !== EventType.BASERUNNER_OUT &&
      event.eventType !== EventType.BASERUNNER_ADVANCE
    ) continue;
    const p = event.payload as Partial<BaserunnerMovePayload>;
    if (!p.relatedEventId || !p.runnerId) continue;
    let entry = map.get(p.relatedEventId);
    if (!entry) {
      entry = { outRunnerIds: new Set(), advancedRunnerIds: new Set() };
      map.set(p.relatedEventId, entry);
    }
    if (event.eventType === EventType.BASERUNNER_OUT) {
      entry.outRunnerIds.add(p.runnerId);
    } else {
      entry.advancedRunnerIds.add(p.runnerId);
    }
  }
  return map;
}

function forceAdvanceRunners(
  runners: LiveGameState['runnersOnBase'],
  batterId: string | null,
): LiveGameState['runnersOnBase'] {
  // Walk / HBP: only runners forced by the batter taking first base advance.
  // A runner is forced only if every base between them and home is occupied.
  const updated = { ...runners };
  if (updated.first && updated.second && updated.third) {
    // runner on 3rd scores (run counted by caller)
    updated.third = updated.second;
    updated.second = updated.first;
    updated.first = batterId;
  } else if (updated.first && updated.second) {
    updated.third = updated.second;
    updated.second = updated.first;
    updated.first = batterId;
  } else if (updated.first) {
    updated.second = updated.first;
    updated.first = batterId;
  } else {
    updated.first = batterId;
  }
  return updated;
}

function incrementPA(state: LiveGameState): void {
  if (state.isTopOfInning) {
    state.completedTopHalfPAs++;
  } else {
    state.completedBottomHalfPAs++;
  }
}

function addRuns(state: LiveGameState, runs: number, isOffensiveTeamTop: boolean): void {
  if (isOffensiveTeamTop) {
    state.awayScore += runs;
  } else {
    state.homeScore += runs;
  }
}
