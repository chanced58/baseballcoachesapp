import { EventType, HitType, HitTrajectory, type GameEvent, type HitPayload, type OutPayload } from '../types/game-event';
import { OUTS_PER_INNING } from '../constants/baseball';
import type { BattingStats } from '../types/batting';

/**
 * A batted ball is a "Hard Hit Ball" when:
 *   - Hit type is home_run (ball cleared the fence), OR
 *   - Trajectory is line_drive (hard straight contact), OR
 *   - Trajectory is fly_ball AND sprayY > 0.733 (deep outfield; 0.733 = 110/150 radius boundary)
 */
const DEEP_OF_SPRAY_Y_THRESHOLD = 0.733;

function isHardHit(hitType: string | undefined, trajectory: string | undefined, sprayY: number | undefined): boolean {
  if (hitType === HitType.HOME_RUN) return true;
  if (trajectory === HitTrajectory.LINE_DRIVE) return true;
  if (trajectory === HitTrajectory.FLY_BALL && typeof sprayY === 'number' && sprayY > DEEP_OF_SPRAY_Y_THRESHOLD) return true;
  return false;
}

/**
 * The literal string stamped into `batterId` payload fields by pre-a071a02
 * scoring sessions when no active batter was selected. Exported so every
 * consumer (batting-stats, opponent-batting-stats, any future scorer UI)
 * references the same symbolic name rather than repeating the string.
 */
export const UNKNOWN_BATTER_STUB = 'unknown-batter';

// The stub is truthy, so a plain `if (!batterId) continue` guard lets it
// through; stats then accumulate against a phantom player whose ID isn't in
// any roster, and the downstream `teamPlayerIds.has(s.playerId)` filter in
// the stats and compliance pages silently drops the entire row. Mirror the
// normalizePitcherId helper in pitching-stats so batting also drops the
// stub cleanly instead of routing data to a hidden sink.
const normalizeBatterId = (id: string | null | undefined): string | null =>
  id && id !== UNKNOWN_BATTER_STUB ? id : null;

// FanGraphs 2023 wOBA linear weights
const W_BB  = 0.69;
const W_HBP = 0.72;
const W_1B  = 0.89;
const W_2B  = 1.27;
const W_3B  = 1.62;
const W_HR  = 2.10;

function makeEmptyStats(playerId: string, playerName: string): BattingStats {
  return {
    playerId,
    playerName,
    gamesAppeared: 0,
    plateAppearances: 0,
    atBats: 0,
    runs: 0,
    hits: 0,
    doubles: 0,
    triples: 0,
    homeRuns: 0,
    rbi: 0,
    walks: 0,
    strikeouts: 0,
    hitByPitch: 0,
    sacrificeFlies: 0,
    sacrificeHits: 0,
    avg: NaN,
    obp: NaN,
    slg: NaN,
    ops: NaN,
    iso: NaN,
    babip: NaN,
    kPct: NaN,
    bbPct: NaN,
    woba: NaN,
    battedBalls: 0,
    hardHitBalls: 0,
    hardHitPct: NaN,
    qab: 0,
    qabPct: NaN,
  };
}

/**
 * Minimum pitches seen in a plate appearance to credit a Quality At-Bat for
 * "long at-bat" alone. 8 is the most common high-school standard.
 */
const QAB_PITCH_THRESHOLD = 8;

/** Format a rate stat (0–1) as ".XXX" or "---" when NaN/Infinity. */
export function formatBattingRate(value: number): string {
  if (!isFinite(value) || isNaN(value)) return '---';
  return value.toFixed(3).replace(/^0/, '');
}

/** Format a percentage (0–1) as "XX.X%" or "---" when NaN/Infinity. */
export function formatBattingPct(value: number): string {
  if (!isFinite(value) || isNaN(value)) return '---';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Per-game lineup context used to infer a batter when a PA-closing event's
 * payload omits `batterId` entirely or carries the legacy 'unknown-batter'
 * stub. Callers should supply our team's lineup in batting order (the
 * `battingOrder` values don't need to be contiguous — they're just sorted)
 * and whether our team is the home team for that game.
 */
export type BattingLineupContext = {
  ourLineup: { playerId: string; battingOrder: number }[];
  isHome: boolean;
  /**
   * Player ids whose at-bats in THIS game should be excluded from the
   * returned stats map. Used to honor `game_lineups.count_toward_stats=false`
   * for guest appearances per the league's stat-attribution policy.
   */
  excludedPlayerIds?: ReadonlySet<string>;
};

/**
 * Derive season batting statistics for all batters from an ordered list of
 * game events. Events must be sorted by (game_id, sequence_number) ascending.
 *
 * @param events            All game events for the season (filtered to relevant types).
 * @param players           Name lookup for player IDs.
 * @param lineupsByGameId   Optional per-game lineup context. When supplied,
 *                          PA-closing events with a missing or 'unknown-batter'
 *                          batter are attributed to `ourLineup[completedPAs %
 *                          size]` instead of silently dropping. Recovers stats
 *                          for legacy stub data and for scoring sessions that
 *                          skipped setting an active batter.
 * @returns A map from playerId → BattingStats.
 */
export function deriveBattingStats(
  events: GameEvent[],
  players: { id: string; firstName: string; lastName: string }[],
  lineupsByGameId?: Map<string, BattingLineupContext>,
): Map<string, BattingStats> {
  const nameMap = new Map<string, string>(
    players.map((p) => [p.id, `${p.firstName} ${p.lastName}`]),
  );

  const statsMap = new Map<string, BattingStats>();

  // Players whose at-bats in the CURRENT game iteration should be silently
  // dropped (guest appearance with count_toward_stats=false). Updated at the
  // top of each game's loop body below. Mutations on the returned sink are
  // discarded, so call sites stay unchanged.
  let currentExcluded: ReadonlySet<string> = new Set<string>();
  const sink = makeEmptyStats('__excluded__', '__excluded__');

  function getStats(playerId: string): BattingStats {
    if (currentExcluded.has(playerId)) {
      // Return a fresh sink each call so accumulated values from one
      // excluded player don't pollute another's tally if the caller
      // somehow stashes the reference.
      return makeEmptyStats('__excluded__', '__excluded__');
    }
    if (!statsMap.has(playerId)) {
      const name = nameMap.get(playerId) ?? 'Unknown';
      statsMap.set(playerId, makeEmptyStats(playerId, name));
    }
    return statsMap.get(playerId)!;
  }
  // Suppress unused-variable warning for the bare `sink` reference above —
  // we intentionally create fresh sinks inside getStats to avoid cross-call
  // contamination, but keep the constant around as documentation of intent.
  void sink;

  // Group events by game_id preserving sequence order
  const gameMap = new Map<string, GameEvent[]>();
  for (const event of events) {
    const gameId = (event as any).game_id ?? event.gameId;
    if (!gameMap.has(gameId)) gameMap.set(gameId, []);
    gameMap.get(gameId)!.push(event);
  }

  for (const [gameId, gameEvents] of gameMap.entries()) {
    gameEvents.sort((a, b) => {
      const aSeq = (a as any).sequence_number ?? a.sequenceNumber;
      const bSeq = (b as any).sequence_number ?? b.sequenceNumber;
      return aSeq - bSeq;
    });

    currentExcluded = lineupsByGameId?.get(gameId)?.excludedPlayerIds ?? new Set<string>();
    const appearedThisGame = new Set<string>();

    function markAppeared(playerId: string) {
      if (!appearedThisGame.has(playerId)) {
        appearedThisGame.add(playerId);
        getStats(playerId).gamesAppeared += 1;
      }
    }

    // ── Lineup-based batter inference (only if caller supplied context) ────
    // Store the lineup as an array of { playerId, battingOrder } objects
    // sorted by battingOrder ascending. Keeping the original battingOrder
    // value (not just position in the array) matters for substitutions that
    // carry `battingOrderPosition` — legacy lineups can have gaps (slot 2
    // missing, etc.), so looking up by array index would attribute the sub
    // to the wrong slot. We dense-pack for cycling (baseball batting order
    // skips empty slots), but match by value for substitutions.
    const lineupInfo = lineupsByGameId?.get(gameId);
    const orderedLineup: { playerId: string; battingOrder: number }[] = lineupInfo
      ? lineupInfo.ourLineup
          .filter((e) => e.playerId && typeof e.battingOrder === 'number')
          .slice()
          .sort((a, b) => a.battingOrder - b.battingOrder)
          .map((e) => ({ playerId: e.playerId, battingOrder: e.battingOrder }))
      : [];
    let ourCompletedPAs = 0;

    // Our team is batting during the "top" of the inning when we're the
    // visitor and during the "bottom" when we're the home team. Matches the
    // convention used by ScoringBoard and stats/page.tsx's `weAreHome`.
    const isOurHalfInning = (isTop: boolean): boolean => {
      if (!lineupInfo) return false;
      return lineupInfo.isHome ? !isTop : isTop;
    };

    // Resolve the batter for a PA-closing event:
    //   • prefer the payload id (but treat the 'unknown-batter' stub as missing)
    //   • when our team is batting and we have a lineup, infer from the
    //     batting-order slot implied by `ourCompletedPAs`
    //   • otherwise return null and let the caller drop the event
    const resolveBatterId = (
      rawId: unknown,
      isTop: boolean,
    ): string | null => {
      const normalized = normalizeBatterId(rawId as string | null | undefined);
      if (normalized) return normalized;
      if (!isOurHalfInning(isTop) || orderedLineup.length === 0) return null;
      return orderedLineup[ourCompletedPAs % orderedLineup.length]?.playerId ?? null;
    };

    // Called after every PA-closing handler to advance the batting order
    // pointer that resolveBatterId uses for the next inference.
    const creditOurPA = (isTop: boolean): void => {
      if (isOurHalfInning(isTop)) ourCompletedPAs += 1;
    };

    // ── Base-runner tracking (player IDs) for run attribution ──────────────
    let r1: string | null = null; // runner on 1st
    let r2: string | null = null; // runner on 2nd
    let r3: string | null = null; // runner on 3rd

    function clearBases() { r1 = null; r2 = null; r3 = null; }

    // ── QAB tracking state ───────────────────────────────────────────────
    //
    // Pitches thrown in the current PA, keyed by batterId. Reset on the
    // PA-closing event for that batter. We count payload pitches rather
    // than reading the ab.pitchNumber in pitching-stats so batting-stats
    // can independently derive 8+ pitch QABs.
    const pitchesInPA = new Map<string, number>();
    // Outs accumulated so far in the current half-inning. Reset on
    // INNING_CHANGE. Used to decide whether an out can count as a
    // productive-out QAB (only when <2 outs before the event).
    let outsThisInning = 0;
    // Set after an OUT-type PA when <2 outs were recorded before it and a
    // runner was on 2nd or 3rd. Cleared when a subsequent
    // BASERUNNER_ADVANCE / SCORE moves that runner (crediting QAB) or when
    // the next PA-closing event starts (in which case the out was not
    // productive).
    let productiveOutPending: {
      batterId: string;
      r2SnapshotId: string | null;
      r3SnapshotId: string | null;
    } | null = null;
    // Credit QAB once per PA. Because multiple code paths (hit, walk,
    // hard-hit, 8-pitch, productive out, etc.) can all want to credit the
    // same PA, guard with a per-PA flag. The flag is reset at the START of
    // each new PA-closing event (not in resetPAState) so that deferred
    // productive-out credit — which fires on a later BASERUNNER_ADVANCE /
    // SCORE after the OUT already ran — can't double-credit a PA that was
    // already counted via hard-hit or 8+ pitch.
    let qabCreditedThisPA = false;
    const creditQAB = (batterId: string): void => {
      if (qabCreditedThisPA) return;
      getStats(batterId).qab += 1;
      qabCreditedThisPA = true;
    };
    const resetPAState = (batterId: string): void => {
      pitchesInPA.delete(batterId);
      // Do NOT reset qabCreditedThisPA here — it must persist through the
      // window where productiveOutPending can fire. The flag resets at the
      // start of the next PA-closing event handler.
    };

    function scoreRunner(runnerId: string | null) {
      if (runnerId) {
        getStats(runnerId).runs += 1;
      }
    }

    /** Force-advance all runners (walk / HBP / error reach). Batter goes to 1st. */
    function forceAdvance(batterId: string) {
      if (r1 && r2 && r3) scoreRunner(r3); // bases loaded → runner on 3rd scores
      if (r1 && r2) r3 = r2;
      else if (!r3 && r2) { /* r2 stays */ }
      if (r1) r2 = r1;
      r1 = batterId;
    }

    // Pre-pass: map any BASERUNNER_OUT / BASERUNNER_ADVANCE events with
    // `relatedEventId` to their parent play. The HIT branch below consults
    // this to skip default run-scoring and base placement for any runner
    // whose outcome on the play is captured by a linked outcome event.
    const overridesByParentId = new Map<string, { outIds: Set<string>; advIds: Set<string> }>();
    for (const ev of gameEvents) {
      const etype = (ev as any).event_type ?? ev.eventType;
      if (etype !== 'baserunner_out' && etype !== 'baserunner_advance') continue;
      const p = ev.payload as any;
      const parentId: string | undefined = p?.relatedEventId;
      const runnerId: string | undefined = p?.runnerId;
      if (!parentId || !runnerId) continue;
      let entry = overridesByParentId.get(parentId);
      if (!entry) {
        entry = { outIds: new Set(), advIds: new Set() };
        overridesByParentId.set(parentId, entry);
      }
      if (etype === 'baserunner_out') entry.outIds.add(runnerId);
      else entry.advIds.add(runnerId);
    }
    const isOverriddenRunner = (runnerId: string | null, parentId: string): boolean => {
      if (!runnerId) return false;
      const o = overridesByParentId.get(parentId);
      if (!o) return false;
      return o.outIds.has(runnerId) || o.advIds.has(runnerId);
    };

    for (const event of gameEvents) {
      const etype: string = (event as any).event_type ?? event.eventType;
      const payload = event.payload as any;
      // `is_top_of_inning` is stored on every game_events row (snake_case in
      // DB, camelCase in TS GameEvent type). Read it once per event so
      // resolveBatterId and creditOurPA share the same half-inning answer.
      const isTop: boolean = (event as any).is_top_of_inning ?? event.isTopOfInning ?? true;

      // ── INNING_CHANGE ──────────────────────────────────────────────────────
      if (etype === 'inning_change') {
        clearBases();
        // Reset out count and clear any unresolved productive-out pending —
        // the half-inning change ends the window in which a previous PA's
        // runner advancement could still count.
        outsThisInning = 0;
        productiveOutPending = null;
        pitchesInPA.clear();
        continue;
      }

      // ── PITCH_THROWN ───────────────────────────────────────────────────
      // We only use PITCH_THROWN to count pitches per PA for QAB detection;
      // all other stat credit comes from PA-closing events.
      if (etype === EventType.PITCH_THROWN) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        pitchesInPA.set(batterId, (pitchesInPA.get(batterId) ?? 0) + 1);
        continue;
      }

      // ── HIT ────────────────────────────────────────────────────────────────
      if (etype === EventType.HIT) {
        const p = payload as HitPayload;
        const { hitType, trajectory, rbis, sprayY, fieldersChoice } = p;
        const batterId = resolveBatterId(p.batterId, isTop);
        if (!batterId) continue;

        // New PA — clear any stale productive-out pending from the prior PA.
        productiveOutPending = null;
        qabCreditedThisPA = false;

        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.atBats += 1;
        s.battedBalls += 1;

        if (!fieldersChoice) {
          s.hits += 1;
          // A non-FC hit always qualifies as a QAB.
          creditQAB(batterId);

          if (isHardHit(hitType, trajectory, sprayY)) s.hardHitBalls += 1;

          switch (hitType) {
            case HitType.DOUBLE:    s.doubles += 1;   break;
            case HitType.TRIPLE:    s.triples += 1;   break;
            case HitType.HOME_RUN:  s.homeRuns += 1;  break;
            default: break;  // single
          }
        } else if (isHardHit(hitType, trajectory, sprayY)) {
          // Fielder's choice that was struck hard still earns a QAB on
          // quality of contact.
          s.hardHitBalls += 1;
          creditQAB(batterId);
        }

        // 8+ pitch PA earns a QAB regardless of outcome.
        if ((pitchesInPA.get(batterId) ?? 0) >= QAB_PITCH_THRESHOLD) {
          creditQAB(batterId);
        }
        resetPAState(batterId);

        // ── Advance runners, attribute runs, and auto-derive RBI (OBR 9.04) ──
        // When the inning is already over (e.g. a fielder's choice whose
        // preceding BASERUNNER_OUT was the 3rd out), no runners advance and
        // no runs/RBI are credited. The PA + AB above still count so the
        // lineup advances — matches deriveGameState's HIT guard in
        // packages/shared/src/utils/game-state.ts.
        if (outsThisInning < OUTS_PER_INNING) {
          const bases = hitType === 'home_run' ? 4
            : hitType === 'triple' ? 3
            : hitType === 'double' ? 2
            : 1;

          // Runners with a linked BASERUNNER_OUT / BASERUNNER_ADVANCE (same
          // parent id) are excluded from default scoring and base placement;
          // the linked event handles them. Lets the scorer record "R2 held
          // at 3B on a double" or "R1 thrown out at 3B advancing" without
          // double-counting runs.
          const parentId = event.id;
          const r1Override = isOverriddenRunner(r1, parentId);
          const r2Override = isOverriddenRunner(r2, parentId);
          const r3Override = isOverriddenRunner(r3, parentId);

          let runsScored = 0;
          if (bases === 4) {
            if (r3 && !r3Override) { scoreRunner(r3); runsScored += 1; }
            if (r2 && !r2Override) { scoreRunner(r2); runsScored += 1; }
            if (r1 && !r1Override) { scoreRunner(r1); runsScored += 1; }
            scoreRunner(batterId);
            runsScored += 1;
            // Clear bases; the linked BASERUNNER_OUT will no-op against an
            // empty slot (still increments outs); BASERUNNER_ADVANCE places
            // the runner on toBase.
            clearBases();
          } else {
            // Determine which runners score
            if (r3 && !r3Override)                    { scoreRunner(r3); runsScored += 1; }
            if (r2 && 2 + bases >= 4 && !r2Override)  { scoreRunner(r2); runsScored += 1; }
            if (r1 && 1 + bases >= 4 && !r1Override)  { scoreRunner(r1); runsScored += 1; }

            // Snapshot runners we'd otherwise place by default, then skip
            // overridden ones so the linked event can place them correctly.
            // (Overridden R3 was suppressed from scoring above and is being
            // overwritten by the auto-advance assignment below; the linked
            // BASERUNNER_ADVANCE — if any — runs after this HIT and places
            // the runner at their actual end base.)
            const prevR1 = r1, prevR2 = r2;
            if (bases === 1) {
              r3 = r2 && !r2Override ? prevR2 : null;
              r2 = r1 && !r1Override ? prevR1 : null;
              r1 = batterId;
            } else if (bases === 2) {
              r3 = r1 && !r1Override ? prevR1 : null;
              r2 = batterId;
              r1 = null;
            } else if (bases === 3) {
              r3 = batterId;
              r2 = null;
              r1 = null;
            }
          }

          // Explicit payload.rbis (including 0) overrides derivation — scorer
          // may use this for OBR 9.04(b)(3) judgment calls where a run scored
          // but only because of a fielding error.
          s.rbi += rbis !== undefined ? rbis : runsScored;
        }
        continue;
      }

      // ── OUT ────────────────────────────────────────────────────────────────
      if (etype === EventType.OUT) {
        const p = payload as OutPayload;
        const { outType, trajectory } = p;
        const batterId = resolveBatterId(p.batterId, isTop);
        if (!batterId) continue;

        // Capture pre-PA state for productive-out detection before we mutate.
        const preOuts = outsThisInning;
        const preR2 = r2;
        const preR3 = r3;

        productiveOutPending = null;
        qabCreditedThisPA = false;

        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);

        const isStrikeout = outType === 'strikeout';
        if (isStrikeout) {
          s.strikeouts += 1;
          s.atBats += 1;
        } else {
          s.atBats += 1;
          s.battedBalls += 1;
          if (isHardHit(undefined, trajectory, payload?.sprayY as number | undefined)) {
            s.hardHitBalls += 1;
            // Hard-hit out counts as a QAB even though the batter is out.
            creditQAB(batterId);
          }
        }

        // 8+ pitch PAs credit QAB regardless of outcome.
        if ((pitchesInPA.get(batterId) ?? 0) >= QAB_PITCH_THRESHOLD) {
          creditQAB(batterId);
        }

        // Productive out candidate: non-strikeout out with <2 outs before
        // this PA and a runner on 2nd or 3rd to potentially advance/score.
        // Strikeouts are explicitly excluded per standard definition.
        if (!isStrikeout && preOuts < 2 && (preR2 || preR3)) {
          productiveOutPending = {
            batterId,
            r2SnapshotId: preR2,
            r3SnapshotId: preR3,
          };
        }

        outsThisInning += 1;
        resetPAState(batterId);
        continue;
      }

      // ── STRIKEOUT (explicit event) ─────────────────────────────────────────
      if (etype === EventType.STRIKEOUT) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;

        productiveOutPending = null;
        qabCreditedThisPA = false;

        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.atBats += 1;
        s.strikeouts += 1;

        // Strikeouts never count as productive outs. An 8+ pitch strikeout
        // is still a QAB though — the long PA is the quality indicator.
        if ((pitchesInPA.get(batterId) ?? 0) >= QAB_PITCH_THRESHOLD) {
          creditQAB(batterId);
        }

        outsThisInning += 1;
        resetPAState(batterId);
        continue;
      }

      // ── DROPPED_THIRD_STRIKE ──────────────────────────────────────────────
      if (etype === EventType.DROPPED_THIRD_STRIKE) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;

        productiveOutPending = null;
        qabCreditedThisPA = false;

        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.atBats += 1;
        s.strikeouts += 1;
        if ((pitchesInPA.get(batterId) ?? 0) >= QAB_PITCH_THRESHOLD) {
          creditQAB(batterId);
        }
        if (payload?.outcome === 'thrown_out') {
          outsThisInning += 1;
        }
        resetPAState(batterId);
        if (payload?.outcome !== 'thrown_out') {
          forceAdvance(batterId);
        }
        continue;
      }

      // ── WALK ───────────────────────────────────────────────────────────────
      if (etype === EventType.WALK) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.walks += 1;
        creditQAB(batterId);
        // Per OBR 9.04(a)(2): a base on balls with the bases loaded forces
        // the runner on third home and credits the batter with 1 RBI.
        const forcedRun = !!(r1 && r2 && r3);
        forceAdvance(batterId);
        const explicitRbis = payload?.rbis as number | undefined;
        s.rbi += explicitRbis !== undefined ? explicitRbis : (forcedRun ? 1 : 0);
        resetPAState(batterId);
        continue;
      }

      // ── CATCHER_INTERFERENCE ───────────────────────────────────────────────
      if (etype === EventType.CATCHER_INTERFERENCE) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        creditQAB(batterId);
        // Per OBR 9.02(a)(4) CI does NOT count as an at-bat.
        // Per OBR 9.04(a)(2), a bases-loaded CI forces a run and credits RBI.
        const forcedRun = !!(r1 && r2 && r3);
        forceAdvance(batterId);
        const explicitRbis = payload?.rbis as number | undefined;
        s.rbi += explicitRbis !== undefined ? explicitRbis : (forcedRun ? 1 : 0);
        resetPAState(batterId);
        continue;
      }

      // ── HIT_BY_PITCH ───────────────────────────────────────────────────────
      if (etype === EventType.HIT_BY_PITCH) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.hitByPitch += 1;
        creditQAB(batterId);
        // Per OBR 9.04(a)(2): HBP with the bases loaded forces in a run.
        const forcedRun = !!(r1 && r2 && r3);
        forceAdvance(batterId);
        const explicitRbis = payload?.rbis as number | undefined;
        s.rbi += explicitRbis !== undefined ? explicitRbis : (forcedRun ? 1 : 0);
        resetPAState(batterId);
        continue;
      }

      // ── SACRIFICE_FLY ──────────────────────────────────────────────────────
      if (etype === EventType.SACRIFICE_FLY) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.sacrificeFlies += 1;
        s.battedBalls += 1;
        creditQAB(batterId);
        // Per OBR 9.04(a)(1): a sacrifice fly that scores the runner from
        // third credits the batter with 1 RBI.
        const runScored = !!r3;
        if (r3) { scoreRunner(r3); r3 = null; }
        const explicitRbis = payload?.rbis as number | undefined;
        s.rbi += explicitRbis !== undefined ? explicitRbis : (runScored ? 1 : 0);
        outsThisInning += 1;
        resetPAState(batterId);
        continue;
      }

      // ── SACRIFICE_BUNT ────────────────────────────────────────────────────
      if (etype === EventType.SACRIFICE_BUNT) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.sacrificeHits += 1;
        s.battedBalls += 1;
        creditQAB(batterId);
        // OBR 9.08(a): sac bunt advances runners one base; squeeze scores
        // the runner from third and credits the batter with 1 RBI.
        const runScored = !!r3;
        if (r3) scoreRunner(r3);
        r3 = r2 ?? null;
        r2 = r1;
        r1 = null;
        const explicitRbis = payload?.rbis as number | undefined;
        s.rbi += explicitRbis !== undefined ? explicitRbis : (runScored ? 1 : 0);
        outsThisInning += 1;
        resetPAState(batterId);
        continue;
      }

      // ── FIELD_ERROR ────────────────────────────────────────────────────────
      if (etype === EventType.FIELD_ERROR) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.atBats += 1;
        s.battedBalls += 1;
        const traj = payload?.trajectory as string | undefined;
        const sy = payload?.sprayY as number | undefined;
        if (isHardHit(undefined, traj, sy)) {
          s.hardHitBalls += 1;
          creditQAB(batterId);
        }
        if ((pitchesInPA.get(batterId) ?? 0) >= QAB_PITCH_THRESHOLD) {
          creditQAB(batterId);
        }
        forceAdvance(batterId);
        resetPAState(batterId);
        continue;
      }

      // ── DOUBLE_PLAY ────────────────────────────────────────────────────────
      if (etype === EventType.DOUBLE_PLAY) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.atBats += 1;
        // Double plays can technically be long enough to earn the 8-pitch
        // QAB, but by definition end the rally — never count as productive.
        if ((pitchesInPA.get(batterId) ?? 0) >= QAB_PITCH_THRESHOLD) {
          creditQAB(batterId);
        }
        // Remove the forced runner from base tracking so stats that depend
        // on runner state (RBI auto-derive on the next hit, etc.) stay
        // consistent. The legacy "no runnerOutBase" case leaves state alone.
        const runnerOutBase = payload?.runnerOutBase as 1 | 2 | 3 | undefined;
        if (runnerOutBase === 1) r1 = null;
        else if (runnerOutBase === 2) r2 = null;
        else if (runnerOutBase === 3) r3 = null;
        outsThisInning += 2;
        resetPAState(batterId);
        continue;
      }

      // ── TRIPLE_PLAY ────────────────────────────────────────────────────────
      // Every triple play ends the half-inning (3 outs), so base state will
      // be reset by the following INNING_CHANGE. We only need to credit the
      // batter with a PA + AB — without this handler the batter's turn was
      // silently dropped and batting stats undercounted relative to opponent
      // batting (which does handle triple_play).
      if (etype === EventType.TRIPLE_PLAY) {
        const batterId = resolveBatterId(payload?.batterId, isTop);
        if (!batterId) continue;
        productiveOutPending = null;
        qabCreditedThisPA = false;
        markAppeared(batterId);
        const s = getStats(batterId);
        s.plateAppearances += 1;
        creditOurPA(isTop);
        s.atBats += 1;
        outsThisInning += 3;
        resetPAState(batterId);
        continue;
      }

      // ── SCORE (explicit — stolen home, balk, runner advance) ──────────────
      if (etype === EventType.SCORE) {
        const scoringPlayerId: string | undefined = payload?.scoringPlayerId;
        if (!scoringPlayerId) continue;
        // deriveGameState mints an event-id stand-in to hold a base for a
        // runner with no batter of record (see baserunnerIdentity). That
        // identifies a runner, not a player, so crediting a run here would
        // invent an 'Unknown' batting row no roster backs. The base
        // bookkeeping below still runs — the runner did leave the base.
        if (nameMap.has(scoringPlayerId)) scoreRunner(scoringPlayerId);
        // If a runner who was on 2nd or 3rd before the last out event
        // scores, the out was productive — credit QAB to the batter from
        // that PA. Check before clearing the scoring runner from bases so
        // the snapshot comparison is accurate.
        if (
          productiveOutPending &&
          (scoringPlayerId === productiveOutPending.r3SnapshotId ||
            scoringPlayerId === productiveOutPending.r2SnapshotId)
        ) {
          creditQAB(productiveOutPending.batterId);
        }
        // Remove from bases
        if (r3 === scoringPlayerId) r3 = null;
        else if (r2 === scoringPlayerId) r2 = null;
        else if (r1 === scoringPlayerId) r1 = null;
        continue;
      }

      // ── STOLEN_BASE ────────────────────────────────────────────────────────
      if (etype === 'stolen_base') {
        const runnerId: string | undefined = payload?.runnerId;
        const toBase: number | undefined = payload?.toBase;
        if (!runnerId || !toBase) continue;
        // Remove from current base
        if (r1 === runnerId) r1 = null;
        else if (r2 === runnerId) r2 = null;
        else if (r3 === runnerId) r3 = null;
        // Place on new base (toBase 4 = scored; run credited by SCORE event)
        if (toBase === 3) r3 = runnerId;
        else if (toBase === 2) r2 = runnerId;
        continue;
      }

      // ── CAUGHT_STEALING ────────────────────────────────────────────────────
      if (etype === 'caught_stealing') {
        const runnerId: string | undefined = payload?.runnerId;
        if (r1 === runnerId) r1 = null;
        else if (r2 === runnerId) r2 = null;
        else if (r3 === runnerId) r3 = null;
        outsThisInning += 1;
        continue;
      }

      // ── BASERUNNER_OUT ─────────────────────────────────────────────────────
      // Emitted ahead of a HIT with fieldersChoice:true (the forced runner is
      // retired first). Track the out locally so the HIT handler above can
      // short-circuit run attribution when this was the 3rd out.
      if (etype === 'baserunner_out') {
        const runnerId: string | undefined = payload?.runnerId;
        if (r1 === runnerId) r1 = null;
        else if (r2 === runnerId) r2 = null;
        else if (r3 === runnerId) r3 = null;
        outsThisInning += 1;
        continue;
      }

      // ── BASERUNNER_ADVANCE ─────────────────────────────────────────────────
      if (etype === 'baserunner_advance') {
        const runnerId: string | undefined = payload?.runnerId;
        const toBase: number | undefined = payload?.toBase;
        if (!runnerId || !toBase) continue;
        // Productive-out credit: if a runner from 2nd or 3rd (as snapshotted
        // before the last out) advances on the play, the out was productive.
        // Skip wild pitch / passed ball / balk / overthrow / error / voluntary
        // advances — those are separate events not caused by the batter's
        // at-bat. AdvanceReason.ON_PLAY and missing reason both count.
        const reason = payload?.reason as string | undefined;
        const isOnPlayAdvance = reason === undefined || reason === 'on_play';
        if (
          isOnPlayAdvance &&
          productiveOutPending &&
          (runnerId === productiveOutPending.r2SnapshotId ||
            runnerId === productiveOutPending.r3SnapshotId)
        ) {
          creditQAB(productiveOutPending.batterId);
        }
        if (r1 === runnerId) r1 = null;
        else if (r2 === runnerId) r2 = null;
        else if (r3 === runnerId) r3 = null;
        // toBase 4 = scored; run credited by SCORE event
        if (toBase === 3) r3 = runnerId;
        else if (toBase === 2) r2 = runnerId;
        else if (toBase === 1) r1 = runnerId;
        continue;
      }

      // ── SUBSTITUTION ───────────────────────────────────────────────────────
      if (etype === 'substitution') {
        const inId: string | undefined = payload?.inPlayerId;
        const outId: string | undefined = payload?.outPlayerId;
        const isOpponentSub = payload?.isOpponentSubstitution === true;
        if (inId && outId) {
          // If the substituted player is on base, replace them
          if (r1 === outId) r1 = inId;
          if (r2 === outId) r2 = inId;
          if (r3 === outId) r3 = inId;
        }
        // Keep the inferred-lineup order in sync with our substitutions so a
        // pinch hitter's PA still resolves to the real player. Only apply for
        // our team's subs — opponent subs are tracked separately in
        // opponent-batting-stats and don't affect our batting-order pointer.
        //
        // Match by playerId when outPlayerId is given (the canonical swap).
        // Match by battingOrder value when only battingOrderPosition is
        // given (slot had no known prior occupant). We match by *value* —
        // not array index — because dense-packed lineups with gaps (e.g.
        // battingOrders [1, 3, 5]) would otherwise attribute a sub at
        // position 3 to the third entry (battingOrder 5) instead of the
        // real slot 3. Fall back to index-based lookup only if no slot
        // with that battingOrder exists (defensive; preserves prior
        // behavior for callers whose lineups don't include the slot yet).
        if (!isOpponentSub && orderedLineup.length > 0 && inId) {
          if (outId) {
            const idx = orderedLineup.findIndex((e) => e.playerId === outId);
            if (idx >= 0) orderedLineup[idx].playerId = inId;
          } else if (typeof payload?.battingOrderPosition === 'number') {
            const pos = payload.battingOrderPosition;
            const byBatOrder = orderedLineup.findIndex((e) => e.battingOrder === pos);
            if (byBatOrder >= 0) {
              orderedLineup[byBatOrder].playerId = inId;
            } else {
              // Slot doesn't exist yet — this is a lineup extension (e.g. adding
              // a 10th batter mid-game). Append and re-sort so the rotation at
              // `ourCompletedPAs % orderedLineup.length` walks the new slot.
              orderedLineup.push({ playerId: inId, battingOrder: pos });
              orderedLineup.sort((a, b) => a.battingOrder - b.battingOrder);
            }
          }
        }
        continue;
      }
    }
  }

  // ── Compute derived rates ─────────────────────────────────────────────────
  for (const s of statsMap.values()) {
    const singles = s.hits - s.doubles - s.triples - s.homeRuns;
    const totalBases = singles + 2 * s.doubles + 3 * s.triples + 4 * s.homeRuns;

    s.avg   = s.atBats > 0 ? s.hits / s.atBats : NaN;
    s.slg   = s.atBats > 0 ? totalBases / s.atBats : NaN;

    const obpDenom = s.atBats + s.walks + s.hitByPitch + s.sacrificeFlies;
    s.obp   = obpDenom > 0 ? (s.hits + s.walks + s.hitByPitch) / obpDenom : NaN;

    s.ops   = (isNaN(s.obp) || isNaN(s.slg)) ? NaN : s.obp + s.slg;
    s.iso   = (isNaN(s.slg) || isNaN(s.avg)) ? NaN : s.slg - s.avg;

    const babipDenom = s.atBats - s.strikeouts - s.homeRuns + s.sacrificeFlies;
    s.babip = babipDenom > 0 ? (s.hits - s.homeRuns) / babipDenom : NaN;

    s.kPct  = s.plateAppearances > 0 ? s.strikeouts / s.plateAppearances : NaN;
    s.bbPct = s.plateAppearances > 0 ? s.walks / s.plateAppearances : NaN;

    const wobaDenom = s.atBats + s.walks + s.sacrificeFlies + s.hitByPitch;
    s.woba  = wobaDenom > 0
      ? (W_BB * s.walks + W_HBP * s.hitByPitch + W_1B * singles +
         W_2B * s.doubles + W_3B * s.triples + W_HR * s.homeRuns) / wobaDenom
      : NaN;

    s.hardHitPct = s.battedBalls > 0 ? s.hardHitBalls / s.battedBalls : NaN;
    s.qabPct     = s.plateAppearances > 0 ? s.qab / s.plateAppearances : NaN;
  }

  return statsMap;
}
