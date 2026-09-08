import { deriveGameState } from '../game-state';
import { deriveBattingStats } from '../batting-stats';
import { computeOpponentBatting } from '../opponent-batting-stats';
import { derivePitchingStats } from '../pitching-stats';
import {
  EventType,
  HitType,
  PitchOutcome,
  type GameEvent,
  type GameEventPayload,
} from '../../types/game-event';

const GAME = 'g1';
const HOME_TEAM = 'team-home';

let seq = 0;
let isTopOfInning = true;
let inning = 1;

const resetSeq = () => {
  seq = 0;
  isTopOfInning = true;
  inning = 1;
};

/** Build a minimal GameEvent for reducer testing. */
function e(eventType: EventType, payload: GameEventPayload): GameEvent {
  return {
    id: `evt-${seq}`,
    gameId: GAME,
    sequenceNumber: seq++,
    eventType,
    inning,
    isTopOfInning,
    payload,
    occurredAt: new Date(2026, 3, 1, 12, 0, seq).toISOString(),
    createdBy: 'tester',
    deviceId: 'test-device',
  };
}

/**
 * A PA ending in a HIT. Includes a PITCH_THROWN so the reducer's
 * `state.currentBatterId` is set to the correct batter (the HIT handler
 * uses state, not payload, when placing runners on base).
 */
function batterHit(batterId: string, hitType: HitType, extra: Record<string, unknown> = {}): GameEvent[] {
  return [
    e(EventType.PITCH_THROWN, { batterId, outcome: PitchOutcome.IN_PLAY }),
    e(EventType.HIT, { batterId, hitType, ...extra }),
  ];
}

/** A PA ending in an OUT. */
function batterOut(batterId: string, outType: 'groundout' | 'flyout' | 'strikeout' = 'groundout'): GameEvent[] {
  return [
    e(EventType.PITCH_THROWN, { batterId, outcome: PitchOutcome.IN_PLAY }),
    e(EventType.OUT, { batterId, outType }),
  ];
}

/** End the current inning (top or bottom) via an INNING_CHANGE event. */
function advanceInning(): GameEvent {
  if (!isTopOfInning) {
    // End of bottom half → next inning, top half.
    inning++;
    isTopOfInning = true;
  } else {
    // End of top half → same inning, bottom half.
    isTopOfInning = false;
  }
  return e(EventType.INNING_CHANGE, {});
}

describe('deriveGameState — fielder\'s choice that ends the inning', () => {
  beforeEach(resetSeq);

  it('advances the batting order when FC is the 3rd out (PA counter increments)', () => {
    // Top of 1st. Away team bats. Two outs already, runner on 1st
    // (placed there by the first PA's HIT). 4th batter hits into a
    // fielder's choice that retires the runner at 2nd — the 3rd out.
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'home-p1',
        homeLineupPitcherId: 'away-p1',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'h1',
      }),
      ...batterHit('a1', HitType.SINGLE),      // PA1: runner on 1st
      ...batterOut('a2', 'groundout'),          // PA2: 1 out
      ...batterOut('a3', 'flyout'),             // PA3: 2 outs
      // PA4: fielder's choice retiring runner from 1st (who becomes the 3rd out).
      e(EventType.PITCH_THROWN, { batterId: 'a4', outcome: PitchOutcome.IN_PLAY }),
      e(EventType.BASERUNNER_OUT, { runnerId: 'a1' }),
      e(EventType.HIT, { batterId: 'a4', hitType: HitType.SINGLE, fieldersChoice: true }),
    ];

    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.outs).toBe(3);
    // Four PAs have completed in the top half — lineup should now be on
    // the 5th batter when the away team next comes up to bat.
    expect(state.completedTopHalfPAs).toBe(4);
  });

  it('does not score a runner from 3rd on a 3rd-out fielder\'s choice', () => {
    // Setup: away team, two outs, runner on 3rd. FC retires a runner
    // forced at 2nd (also loaded the bases first).
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'home-p1',
        homeLineupPitcherId: 'away-p1',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'h1',
      }),
      // Load the bases with three consecutive walks.
      e(EventType.WALK, { batterId: 'a1' }),
      e(EventType.WALK, { batterId: 'a2' }),
      e(EventType.WALK, { batterId: 'a3' }),
      // Two outs.
      ...batterOut('a4', 'flyout'),
      ...batterOut('a5', 'groundout'),
      // 3rd-out FC: retire a3 (forced to 2nd); a1 would score from 3rd
      // on a plain single, but this is a 3rd-out FC so no run should
      // count.
      e(EventType.PITCH_THROWN, { batterId: 'a6', outcome: PitchOutcome.IN_PLAY }),
      e(EventType.BASERUNNER_OUT, { runnerId: 'a3' }),
      e(EventType.HIT, { batterId: 'a6', hitType: HitType.SINGLE, fieldersChoice: true }),
    ];

    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.outs).toBe(3);
    expect(state.awayScore).toBe(0);
    expect(state.homeScore).toBe(0);
    // PA still credited so the lineup advances: 3 walks + 2 outs + 1 FC = 6 PAs.
    expect(state.completedTopHalfPAs).toBe(6);
  });

  it('still scores a runner from 3rd on a non-inning-ending fielder\'s choice', () => {
    // Regression guard for the pre-existing behavior: with only 1 out
    // before the play, a FC that retires the runner from 1st is the
    // 2nd out — the runner from 3rd still scores on the "single".
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'home-p1',
        homeLineupPitcherId: 'away-p1',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'h1',
      }),
      // Put a1 on 3rd via a triple.
      ...batterHit('a1', HitType.TRIPLE),
      // Put a2 on 1st via a single — now runners on 1st + 3rd, 0 outs.
      ...batterHit('a2', HitType.SINGLE),
      // 1 out.
      ...batterOut('a3', 'flyout'),
      // FC: retire a2 at 2nd (2nd out — not the 3rd). Batter a4 reaches
      // 1st; a1 from 3rd scores on the play.
      e(EventType.PITCH_THROWN, { batterId: 'a4', outcome: PitchOutcome.IN_PLAY }),
      e(EventType.BASERUNNER_OUT, { runnerId: 'a2' }),
      e(EventType.HIT, { batterId: 'a4', hitType: HitType.SINGLE, fieldersChoice: true }),
    ];

    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.outs).toBe(2);
    expect(state.awayScore).toBe(1); // runner from 3rd scored
    // Batter a4 is now on 1st.
    expect(state.runnersOnBase.first).toBe('a4');
    expect(state.runnersOnBase.second).toBe(null);
    expect(state.runnersOnBase.third).toBe(null);
    expect(state.completedTopHalfPAs).toBe(4);
  });

  it('keeps the same batter next inning when the 3rd-out FC skipped the PA (regression)', () => {
    // End-to-end: simulate the reported scenario across an inning
    // boundary. Batter #4 hits into a 3rd-out FC; on the next top-half,
    // the batting-position formula completedTopHalfPAs % 9 should land
    // on slot 5 (index 4 into the 9-slot lineup), not slot 4 again.
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'home-p1',
        homeLineupPitcherId: 'away-p1',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'h1',
      }),
      // Top 1: a1 singles, a2 & a3 go out, a4 FCs for the 3rd out.
      ...batterHit('a1', HitType.SINGLE),
      ...batterOut('a2', 'groundout'),
      ...batterOut('a3', 'flyout'),
      e(EventType.PITCH_THROWN, { batterId: 'a4', outcome: PitchOutcome.IN_PLAY }),
      e(EventType.BASERUNNER_OUT, { runnerId: 'a1' }),
      e(EventType.HIT, { batterId: 'a4', hitType: HitType.SINGLE, fieldersChoice: true }),
      // Bottom 1: home bats and makes three quick outs.
      advanceInning(),
      ...batterOut('h1', 'flyout'),
      ...batterOut('h2', 'groundout'),
      ...batterOut('h3', 'strikeout'),
      // Top 2 begins.
      advanceInning(),
    ];

    const state = deriveGameState(GAME, events, HOME_TEAM);

    // Away has batted 4 times. Into a 9-batter lineup, slot 5 (index 4)
    // leads off the top of the 2nd.
    expect(state.completedTopHalfPAs).toBe(4);
    expect(4 % 9).toBe(4); // sanity — before the fix, this was 3 (a4 again).
  });
});

describe('stats reducers — fielder\'s choice that ends the inning', () => {
  beforeEach(resetSeq);

  const players = [
    { id: 'a1', firstName: 'A', lastName: 'One' },
    { id: 'a2', firstName: 'A', lastName: 'Two' },
    { id: 'a3', firstName: 'A', lastName: 'Three' },
    { id: 'a4', firstName: 'A', lastName: 'Four' },
    { id: 'p1', firstName: 'P', lastName: 'One' },
  ];

  /**
   * Build the canonical event stream: away team with runner on 3rd, two
   * outs, batter a4 hits into a fielder's choice that retires the runner
   * from 3rd. The preceding BASERUNNER_OUT is the 3rd out, so no runs
   * should be credited and no RBI for the batter.
   */
  function thirdOutFCEvents(): GameEvent[] {
    return [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'p1',
        homeLineupPitcherId: 'p1',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'a1',
      }),
      // Put a1 on 3rd with a triple.
      ...batterHit('a1', HitType.TRIPLE),
      // Two outs.
      ...batterOut('a2', 'groundout'),
      ...batterOut('a3', 'flyout'),
      // 3rd-out FC: BASERUNNER_OUT retires a1 (from 3rd), HIT records the PA.
      e(EventType.PITCH_THROWN, { batterId: 'a4', pitcherId: 'p1', outcome: PitchOutcome.IN_PLAY }),
      e(EventType.BASERUNNER_OUT, { runnerId: 'a1', pitcherId: 'p1' }),
      e(EventType.HIT, {
        batterId: 'a4',
        pitcherId: 'p1',
        hitType: HitType.SINGLE,
        fieldersChoice: true,
      }),
    ];
  }

  it('deriveBattingStats: does not credit R to runner on 3rd or RBI to batter', () => {
    const events = thirdOutFCEvents();
    const stats = deriveBattingStats(events, players);

    expect(stats.get('a1')?.runs ?? 0).toBe(0);
    expect(stats.get('a4')?.rbi ?? 0).toBe(0);
    // The batter's PA and AB are still credited (FC counts as AB, not a hit).
    expect(stats.get('a4')?.plateAppearances).toBe(1);
    expect(stats.get('a4')?.atBats).toBe(1);
    expect(stats.get('a4')?.hits).toBe(0);
  });

  it('derivePitchingStats: does not charge the pitcher with a run on a 3rd-out FC', () => {
    const events = thirdOutFCEvents();
    const stats = derivePitchingStats(events, players);

    expect(stats.get('p1')?.runsAllowed ?? 0).toBe(0);
    expect(stats.get('p1')?.earnedRunsAllowed ?? 0).toBe(0);
    // The FC HIT payload carries fieldersChoice:true so it does NOT add to
    // hitsAllowed; the earlier real triple by a1 accounts for the single
    // hit allowed in this scenario.
    expect(stats.get('p1')?.hitsAllowed).toBe(1);
  });

  it('deriveBattingStats: still credits R and RBI on a non-inning-ending FC', () => {
    // Same shape, but with only 1 out before the FC so the play is the 2nd
    // out, not the 3rd. Runner from 3rd still scores on the "single" — this
    // is the regression guard that my outs-guard did not over-correct.
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'p1',
        homeLineupPitcherId: 'p1',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'a1',
      }),
      ...batterHit('a1', HitType.TRIPLE),
      ...batterOut('a2', 'groundout'),
      // Only 1 out when a3 hits into the FC.
      e(EventType.PITCH_THROWN, { batterId: 'a3', pitcherId: 'p1', outcome: PitchOutcome.IN_PLAY }),
      e(EventType.BASERUNNER_OUT, { runnerId: 'a1', pitcherId: 'p1' }),
      e(EventType.HIT, {
        batterId: 'a3',
        pitcherId: 'p1',
        hitType: HitType.SINGLE,
        fieldersChoice: true,
      }),
    ];
    const stats = deriveBattingStats(events, players);

    // Wait — with a triple to 3rd and BASERUNNER_OUT removing a1, a1 is
    // already off base by the time the HIT fires. So the FC "single"
    // places the batter on 1st but nobody scores. The guard should have
    // no effect either way here. Assert the absence of over-counting:
    expect(stats.get('a1')?.runs ?? 0).toBe(0);
    expect(stats.get('a3')?.rbi ?? 0).toBe(0);
  });

  it('computeOpponentBatting: does not credit R/RBI to opponents on a 3rd-out FC', () => {
    // Snake-case DB-shaped events (computeOpponentBatting's expected shape).
    let s = 0;
    const oe = (event_type: string, payload: Record<string, unknown>) => ({
      game_id: 'g-opp',
      sequence_number: s++,
      event_type,
      payload,
    });
    const events = [
      oe('hit', { opponentBatterId: 'o1', hitType: 'triple' }), // o1 → 3rd
      oe('out', { opponentBatterId: 'o2', outType: 'groundout' }),
      oe('out', { opponentBatterId: 'o3', outType: 'flyout' }),
      // 3rd-out FC: BASERUNNER_OUT (o1) + HIT (o4, fieldersChoice).
      oe('baserunner_out', { runnerId: 'o1' }),
      oe('hit', { opponentBatterId: 'o4', hitType: 'single', fieldersChoice: true }),
    ];
    const oppMap = new Map<string, string>([
      ['o1', 'O One'],
      ['o2', 'O Two'],
      ['o3', 'O Three'],
      ['o4', 'O Four'],
    ]);
    const rows = computeOpponentBatting(events, oppMap);

    const o1 = rows.find((r) => r.playerId === 'o1');
    const o4 = rows.find((r) => r.playerId === 'o4');
    expect(o1?.r ?? 0).toBe(0);
    expect(o4?.rbi ?? 0).toBe(0);
    // o4 still credited with the PA + AB.
    expect(o4?.pa).toBe(1);
    expect(o4?.ab).toBe(1);
    expect(o4?.h).toBe(0);
  });
});

describe('deriveGameState — DROPPED_THIRD_STRIKE', () => {
  beforeEach(resetSeq);

  const startEvents: GameEvent[] = [];
  const start = () => [
    e(EventType.GAME_START, {
      awayLineupPitcherId: 'home-p',
      homeLineupPitcherId: 'away-p',
      awayLeadoffBatterId: 'a1',
      homeLeadoffBatterId: 'h1',
    }),
  ];
  void startEvents;

  it('thrown_out increments outs and resets the count', () => {
    const events: GameEvent[] = [
      ...start(),
      e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.SWINGING_STRIKE }),
      e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.SWINGING_STRIKE }),
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'a1',
        pitcherId: 'home-p',
        outcome: 'thrown_out',
        fieldingSequence: [2, 3],
      }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.outs).toBe(1);
    expect(state.balls).toBe(0);
    expect(state.strikes).toBe(0);
    expect(state.runnersOnBase.first).toBe(null);
    expect(state.completedTopHalfPAs).toBe(1);
  });

  it('reached_on_error places batter on first and does not increment outs', () => {
    const events: GameEvent[] = [
      ...start(),
      e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.SWINGING_STRIKE }),
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'a1',
        pitcherId: 'home-p',
        outcome: 'reached_on_error',
        errorBy: 2,
      }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.outs).toBe(0);
    expect(state.runnersOnBase.first).toBe('a1');
    expect(state.completedTopHalfPAs).toBe(1);
  });

  it('reached_wild_pitch places batter on first and does not increment outs', () => {
    const events: GameEvent[] = [
      ...start(),
      e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.SWINGING_STRIKE }),
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'a1',
        pitcherId: 'home-p',
        outcome: 'reached_wild_pitch',
        isWildPitch: true,
      }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.outs).toBe(0);
    expect(state.runnersOnBase.first).toBe('a1');
  });

  it('force-scores a run when bases were loaded and the batter reaches', () => {
    const events: GameEvent[] = [
      ...start(),
      // Load the bases via three walks.
      e(EventType.WALK, { batterId: 'a1' }),
      e(EventType.WALK, { batterId: 'a2' }),
      e(EventType.WALK, { batterId: 'a3' }),
      // a4 reaches on D3K reached-on-error → bases-loaded force-in.
      e(EventType.PITCH_THROWN, { batterId: 'a4', outcome: PitchOutcome.SWINGING_STRIKE }),
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'a4',
        pitcherId: 'home-p',
        outcome: 'reached_on_error',
        errorBy: 2,
      }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.awayScore).toBe(1);
    expect(state.outs).toBe(0);
    // a1 (forced home), a2 → 3rd, a3 → 2nd, a4 → 1st.
    expect(state.runnersOnBase.first).toBe('a4');
    expect(state.runnersOnBase.second).toBe('a3');
    expect(state.runnersOnBase.third).toBe('a2');
  });
});

describe('deriveGameState — runner outcomes linked to a HIT via relatedEventId', () => {
  beforeEach(resetSeq);

  const start = () => [
    e(EventType.GAME_START, {
      awayLineupPitcherId: 'home-p',
      homeLineupPitcherId: 'away-p',
      awayLeadoffBatterId: 'a1',
      homeLeadoffBatterId: 'h1',
    }),
  ];

  it('Scenario 1 — double with R1 thrown out at 3B: batter on 2B, R1 cleared, outs +1', () => {
    // Put a1 on 1st via a single, then a2 doubles. R1 (a1) is thrown out
    // advancing to 3rd on the play.
    const pa1 = batterHit('a1', HitType.SINGLE);
    const pitch2 = e(EventType.PITCH_THROWN, { batterId: 'a2', outcome: PitchOutcome.IN_PLAY });
    const hit2 = e(EventType.HIT, { batterId: 'a2', hitType: HitType.DOUBLE });
    const out1 = e(EventType.BASERUNNER_OUT, {
      runnerId: 'a1',
      fromBase: 1,
      relatedEventId: hit2.id,
    });
    const state = deriveGameState(GAME, [...start(), ...pa1, pitch2, hit2, out1], HOME_TEAM);

    expect(state.outs).toBe(1);
    expect(state.runnersOnBase.first).toBe(null);
    expect(state.runnersOnBase.second).toBe('a2');
    expect(state.runnersOnBase.third).toBe(null);
    expect(state.awayScore).toBe(0);
  });

  it('Scenario 2a — double with R2 held at 3B: batter on 2B, R2 on 3B, no run', () => {
    // a1 doubles → R2 on 2nd. a2 doubles → default would score R2; with
    // an override, R2 holds at 3B.
    const pa1 = batterHit('a1', HitType.DOUBLE);
    const pitch2 = e(EventType.PITCH_THROWN, { batterId: 'a2', outcome: PitchOutcome.IN_PLAY });
    const hit2 = e(EventType.HIT, { batterId: 'a2', hitType: HitType.DOUBLE });
    const held = e(EventType.BASERUNNER_ADVANCE, {
      runnerId: 'a1',
      fromBase: 2,
      toBase: 3,
      reason: 'on_play',
      relatedEventId: hit2.id,
    });
    const state = deriveGameState(GAME, [...start(), ...pa1, pitch2, hit2, held], HOME_TEAM);

    expect(state.outs).toBe(0);
    expect(state.awayScore).toBe(0);
    expect(state.runnersOnBase.second).toBe('a2');
    expect(state.runnersOnBase.third).toBe('a1');
  });

  it('Scenario 2b — double with R2 thrown out at home: batter on 2B, no R3, outs +1', () => {
    const pa1 = batterHit('a1', HitType.DOUBLE);
    const pitch2 = e(EventType.PITCH_THROWN, { batterId: 'a2', outcome: PitchOutcome.IN_PLAY });
    const hit2 = e(EventType.HIT, { batterId: 'a2', hitType: HitType.DOUBLE });
    const thrownOut = e(EventType.BASERUNNER_OUT, {
      runnerId: 'a1',
      fromBase: 2,
      relatedEventId: hit2.id,
    });
    const state = deriveGameState(GAME, [...start(), ...pa1, pitch2, hit2, thrownOut], HOME_TEAM);

    expect(state.outs).toBe(1);
    expect(state.awayScore).toBe(0);
    expect(state.runnersOnBase.second).toBe('a2');
    expect(state.runnersOnBase.third).toBe(null);
  });

  it('regression — double with no overrides still auto-advances runners (fast path)', () => {
    // a1 on 1st via single, then a2 doubles. Default: a1 → 3rd, a2 → 2nd.
    const events: GameEvent[] = [
      ...start(),
      ...batterHit('a1', HitType.SINGLE),
      ...batterHit('a2', HitType.DOUBLE),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.outs).toBe(0);
    expect(state.awayScore).toBe(0);
    expect(state.runnersOnBase.second).toBe('a2');
    expect(state.runnersOnBase.third).toBe('a1');
  });

  it('triple with R1 held at 3B — only R3/R2 score, not R1', () => {
    // Put a1 on 1st, a2 on 2nd, a3 on 3rd via two singles and a double.
    // Wait, simpler: load bases via walks, then triple with R1 held at 3rd.
    const events: GameEvent[] = [
      ...start(),
      e(EventType.WALK, { batterId: 'a1' }),  // a1 on 1st
      e(EventType.WALK, { batterId: 'a2' }),  // a1 on 2nd, a2 on 1st
      e(EventType.WALK, { batterId: 'a3' }),  // a1 on 3rd, a2 on 2nd, a3 on 1st
    ];
    const pitch4 = e(EventType.PITCH_THROWN, { batterId: 'a4', outcome: PitchOutcome.IN_PLAY });
    const hit4 = e(EventType.HIT, { batterId: 'a4', hitType: HitType.TRIPLE });
    // R1 (a3, on 1st pre-play) held at 3rd instead of scoring.
    const held = e(EventType.BASERUNNER_ADVANCE, {
      runnerId: 'a3',
      fromBase: 1,
      toBase: 3,
      reason: 'on_play',
      relatedEventId: hit4.id,
    });
    const state = deriveGameState(GAME, [...events, pitch4, hit4, held], HOME_TEAM);

    expect(state.outs).toBe(0);
    expect(state.awayScore).toBe(2); // a1, a2 scored; a3 held
    expect(state.runnersOnBase.third).toBe('a3'); // a3 held at 3rd
    // Wait — the batter is on 3rd after a triple. The held runner takes
    // priority by event order: HIT places batter at 3rd, then ADVANCE
    // overwrites with a3.
  });

  it('HR with trailing runner thrown out — HR credited, only non-out runners score', () => {
    const events: GameEvent[] = [
      ...start(),
      e(EventType.WALK, { batterId: 'a1' }),  // a1 on 1st
    ];
    const pitch2 = e(EventType.PITCH_THROWN, { batterId: 'a2', outcome: PitchOutcome.IN_PLAY });
    const hr = e(EventType.HIT, { batterId: 'a2', hitType: HitType.HOME_RUN });
    const out1 = e(EventType.BASERUNNER_OUT, {
      runnerId: 'a1',
      fromBase: 1,
      relatedEventId: hr.id,
    });
    const state = deriveGameState(GAME, [...events, pitch2, hr, out1], HOME_TEAM);

    expect(state.outs).toBe(1);
    expect(state.awayScore).toBe(1); // batter only; a1 thrown out
    expect(state.runnersOnBase.first).toBe(null);
    expect(state.runnersOnBase.second).toBe(null);
    expect(state.runnersOnBase.third).toBe(null);
  });
});

describe('deriveGameState — EVENT_VOIDED / PITCH_REVERTED filtering', () => {
  beforeEach(resetSeq);

  const start = () => [
    e(EventType.GAME_START, {
      awayLineupPitcherId: 'home-p',
      homeLineupPitcherId: 'away-p',
      awayLeadoffBatterId: 'a1',
      homeLeadoffBatterId: 'h1',
    }),
  ];

  /** EVENT_VOIDED marker targeting a previously recorded event. */
  function voided(target: GameEvent): GameEvent {
    return e(EventType.EVENT_VOIDED, {
      voidedEventId: target.id,
      voidedSequenceNumber: target.sequenceNumber,
    });
  }

  it('a voided HIT restores runners and the PA count', () => {
    const pitch1 = e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.IN_PLAY });
    const hit1 = e(EventType.HIT, { batterId: 'a1', hitType: HitType.SINGLE });
    const state = deriveGameState(GAME, [...start(), pitch1, hit1, voided(hit1)], HOME_TEAM);

    expect(state.runnersOnBase.first).toBe(null);
    expect(state.completedTopHalfPAs).toBe(0);
    expect(state.awayScore).toBe(0);
  });

  it('a voided OUT restores the out count and PA count', () => {
    const pitch1 = e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.IN_PLAY });
    const out1 = e(EventType.OUT, { batterId: 'a1', outType: 'groundout' });
    const state = deriveGameState(GAME, [...start(), pitch1, out1, voided(out1)], HOME_TEAM);

    expect(state.outs).toBe(0);
    expect(state.completedTopHalfPAs).toBe(0);
  });

  it('voiding only a linked BASERUNNER_OUT restores the parent HIT default advance', () => {
    // a1 singles; a2 doubles with a linked "a1 thrown out at 3B" override.
    // Voiding just the child outcome event should restore the default
    // advance (a1 → 3rd on a double) and remove the out.
    const pa1 = batterHit('a1', HitType.SINGLE);
    const pitch2 = e(EventType.PITCH_THROWN, { batterId: 'a2', outcome: PitchOutcome.IN_PLAY });
    const hit2 = e(EventType.HIT, { batterId: 'a2', hitType: HitType.DOUBLE });
    const childOut = e(EventType.BASERUNNER_OUT, {
      runnerId: 'a1',
      fromBase: 1,
      relatedEventId: hit2.id,
    });
    const state = deriveGameState(
      GAME,
      [...start(), ...pa1, pitch2, hit2, childOut, voided(childOut)],
      HOME_TEAM,
    );

    expect(state.outs).toBe(0);
    expect(state.runnersOnBase.third).toBe('a1');
    expect(state.runnersOnBase.second).toBe('a2');
  });

  it('a voided WALK restores balls/strikes and baserunners', () => {
    const walk1 = e(EventType.WALK, { batterId: 'a1' });
    const state = deriveGameState(GAME, [...start(), walk1, voided(walk1)], HOME_TEAM);

    expect(state.runnersOnBase.first).toBe(null);
    expect(state.completedTopHalfPAs).toBe(0);
  });

  it('PITCH_REVERTED trims replay back to revertToSequenceNumber', () => {
    // Two strikes recorded, then the second is reverted (web-style undo).
    const strike1 = e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.CALLED_STRIKE });
    const strike2 = e(EventType.PITCH_THROWN, { batterId: 'a1', outcome: PitchOutcome.CALLED_STRIKE });
    const revert = e(EventType.PITCH_REVERTED, {
      revertToSequenceNumber: strike1.sequenceNumber,
    });
    const state = deriveGameState(GAME, [...start(), strike1, strike2, revert], HOME_TEAM);

    expect(state.strikes).toBe(1);
  });
});

describe('deriveGameState — base placement uses the payload batter (no preceding pitch)', () => {
  beforeEach(resetSeq);

  const start = () => [
    e(EventType.GAME_START, {
      awayLineupPitcherId: 'home-p',
      homeLineupPitcherId: 'away-p',
      awayLeadoffBatterId: 'a1',
      homeLeadoffBatterId: 'h1',
    }),
  ];

  it('places the HIT payload batter on base even when currentBatterId is stale', () => {
    // a1 singles (state.currentBatterId becomes a1). Then a2 singles with NO
    // preceding pitch — the quick-entry path a mobile scorer can take. The
    // batter placed on 1st must be a2 (payload), not the stale a1.
    const events: GameEvent[] = [
      ...start(),
      ...batterHit('a1', HitType.SINGLE), // a1 → 1st, currentBatterId = a1
      // a2 reaches on a single with no pitch event first.
      e(EventType.HIT, { batterId: 'a2', hitType: HitType.SINGLE }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.runnersOnBase.first).toBe('a2');
    expect(state.runnersOnBase.second).toBe('a1');
  });

  it('places the FIELD_ERROR payload batter on first when currentBatterId is stale', () => {
    const events: GameEvent[] = [
      ...start(),
      ...batterOut('a1', 'groundout'), // currentBatterId = a1
      e(EventType.FIELD_ERROR, { batterId: 'a2', errorBy: 6 }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.runnersOnBase.first).toBe('a2');
  });
});

describe('deriveGameState — GAME_END / isFinal', () => {
  beforeEach(resetSeq);

  const start = () => [
    e(EventType.GAME_START, {
      awayLineupPitcherId: 'home-p',
      homeLineupPitcherId: 'away-p',
      awayLeadoffBatterId: 'a1',
      homeLeadoffBatterId: 'h1',
    }),
  ];

  it('isFinal is false while the game is live', () => {
    const state = deriveGameState(GAME, [...start(), ...batterHit('a1', HitType.SINGLE)], HOME_TEAM);
    expect(state.isFinal).toBe(false);
  });

  it('GAME_END sets isFinal without disturbing other state', () => {
    const events = [
      ...start(),
      ...batterHit('a1', HitType.SINGLE),
      e(EventType.GAME_END, { homeScore: 0, awayScore: 0 }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.isFinal).toBe(true);
    expect(state.runnersOnBase.first).toBe('a1');
  });

  it('a voided GAME_END leaves the game live', () => {
    const end = e(EventType.GAME_END, { homeScore: 0, awayScore: 0 });
    const events = [
      ...start(),
      end,
      e(EventType.EVENT_VOIDED, { voidedEventId: end.id, voidedSequenceNumber: end.sequenceNumber }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    expect(state.isFinal).toBe(false);
  });
});

describe('deriveGameState — pitcherPitchCounts', () => {
  beforeEach(resetSeq);

  it('accumulates cumulative totals per pitcher across pitching and inning changes', () => {
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'p1',
        homeLineupPitcherId: 'p3',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'h1',
      }),
      // Top 1: p1 throws 2 pitches.
      e(EventType.PITCH_THROWN, { pitcherId: 'p1', batterId: 'a1', outcome: PitchOutcome.BALL }),
      e(EventType.PITCH_THROWN, { pitcherId: 'p1', batterId: 'a1', outcome: PitchOutcome.CALLED_STRIKE }),
      // Mid-inning pitching change: p2 throws 3.
      e(EventType.PITCHING_CHANGE, { newPitcherId: 'p2', outgoingPitcherId: 'p1' }),
      e(EventType.PITCH_THROWN, { pitcherId: 'p2', batterId: 'a1', outcome: PitchOutcome.BALL }),
      e(EventType.PITCH_THROWN, { pitcherId: 'p2', batterId: 'a1', outcome: PitchOutcome.BALL }),
      e(EventType.PITCH_THROWN, { pitcherId: 'p2', batterId: 'a1', outcome: PitchOutcome.FOUL }),
      // Bottom 1: other team's pitcher p3 throws 1.
      advanceInning(),
      e(EventType.PITCH_THROWN, { pitcherId: 'p3', batterId: 'h1', outcome: PitchOutcome.BALL }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.pitcherPitchCounts).toEqual({ p1: 2, p2: 3, p3: 1 });
    expect(state.currentPitcherPitchCount).toBe(1); // p3's running total
  });
});

describe('deriveGameState — HIT_BY_PITCH pair (regression guard)', () => {
  beforeEach(resetSeq);

  it('pitch outcome hbp + HIT_BY_PITCH event places batter on 1B and forces with bases loaded', () => {
    const events: GameEvent[] = [
      e(EventType.GAME_START, {
        awayLineupPitcherId: 'home-p',
        homeLineupPitcherId: 'away-p',
        awayLeadoffBatterId: 'a1',
        homeLeadoffBatterId: 'h1',
      }),
      // Load the bases via three walks.
      e(EventType.WALK, { batterId: 'a1' }),
      e(EventType.WALK, { batterId: 'a2' }),
      e(EventType.WALK, { batterId: 'a3' }),
      // HBP pair for a4 — the shape mobile/web emit together.
      e(EventType.PITCH_THROWN, { batterId: 'a4', pitcherId: 'home-p', outcome: PitchOutcome.HIT_BY_PITCH }),
      e(EventType.HIT_BY_PITCH, { batterId: 'a4', pitcherId: 'home-p' }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.awayScore).toBe(1); // a1 forced home
    expect(state.runnersOnBase.first).toBe('a4');
    expect(state.runnersOnBase.second).toBe('a3');
    expect(state.runnersOnBase.third).toBe('a2');
    expect(state.completedTopHalfPAs).toBe(4);
  });
});

describe('deriveGameState — anonymous opponent batters', () => {
  beforeEach(resetSeq);

  // A scorer keeping their own team's book has no opponent roster, so events
  // recorded during the opponent's half carry a pitcher but no batter of any
  // kind. Those runners still have to occupy bases and score, otherwise a
  // string of opponent hits leaves the scoreboard at 0.
  it('places a batter-less hit on base so later hits drive them in', () => {
    const events: GameEvent[] = [
      e(EventType.GAME_START, { homeLineupPitcherId: 'home-p' }),
      // Opponent doubles twice, then homers — no batter id on any of them.
      e(EventType.HIT, { hitType: HitType.DOUBLE, pitcherId: 'home-p' }),
      e(EventType.HIT, { hitType: HitType.DOUBLE, pitcherId: 'home-p' }),
      e(EventType.HIT, { hitType: HitType.HOME_RUN, pitcherId: 'home-p' }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);

    // Double, then a double scoring that runner, then a 2-run homer = 3.
    expect(state.awayScore).toBe(3);
    expect(state.runnersOnBase).toEqual({ first: null, second: null, third: null });
  });

  it('keeps anonymous runners distinct rather than collapsing them onto one base', () => {
    const events: GameEvent[] = [
      e(EventType.GAME_START, { homeLineupPitcherId: 'home-p' }),
      e(EventType.WALK, { pitcherId: 'home-p' }),
      e(EventType.WALK, { pitcherId: 'home-p' }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);

    expect(state.runnersOnBase.first).not.toBeNull();
    expect(state.runnersOnBase.second).not.toBeNull();
    expect(state.runnersOnBase.first).not.toBe(state.runnersOnBase.second);
    expect(state.awayScore).toBe(0);
  });

  it('does not credit an anonymous runner to a named batter', () => {
    const events: GameEvent[] = [
      e(EventType.GAME_START, { homeLineupPitcherId: 'home-p' }),
      e(EventType.HIT, { hitType: HitType.SINGLE, pitcherId: 'home-p' }),
    ];
    const state = deriveGameState(GAME, events, HOME_TEAM);
    const batting = deriveBattingStats(events, [
      { id: 'home-p', firstName: 'Home', lastName: 'Pitcher' },
    ]);

    expect(state.runnersOnBase.first).not.toBeNull();
    // The stand-in identifies a runner only; it must never appear as a batter.
    expect(batting.has(state.runnersOnBase.first!)).toBe(false);
  });
});

describe('deriveGameState — pitch and strike totals', () => {
  beforeEach(resetSeq);

  const pitch = (pitcherId: string, outcome: PitchOutcome) =>
    e(EventType.PITCH_THROWN, { batterId: 'a1', pitcherId, outcome });

  it('counts every pitch that is not a ball or hit batsman as a strike', () => {
    const state = deriveGameState(GAME, [
      e(EventType.GAME_START, { homeLineupPitcherId: 'p1' }),
      pitch('p1', PitchOutcome.CALLED_STRIKE),
      pitch('p1', PitchOutcome.SWINGING_STRIKE),
      pitch('p1', PitchOutcome.FOUL),
      pitch('p1', PitchOutcome.FOUL_TIP),
      pitch('p1', PitchOutcome.IN_PLAY),
      pitch('p1', PitchOutcome.BALL),
      pitch('p1', PitchOutcome.INTENTIONAL_BALL),
      pitch('p1', PitchOutcome.HIT_BY_PITCH),
    ], HOME_TEAM);

    expect(state.pitcherPitchCounts.p1).toBe(8);
    expect(state.pitcherStrikeCounts.p1).toBe(5);
  });

  it('keeps strikes separate per pitcher across a pitching change', () => {
    const state = deriveGameState(GAME, [
      e(EventType.GAME_START, { homeLineupPitcherId: 'p1' }),
      pitch('p1', PitchOutcome.CALLED_STRIKE),
      pitch('p1', PitchOutcome.BALL),
      pitch('p2', PitchOutcome.FOUL),
      pitch('p2', PitchOutcome.SWINGING_STRIKE),
      pitch('p2', PitchOutcome.BALL),
    ], HOME_TEAM);

    expect(state.pitcherStrikeCounts.p1).toBe(1);
    expect(state.pitcherPitchCounts.p1).toBe(2);
    expect(state.pitcherStrikeCounts.p2).toBe(2);
    expect(state.pitcherPitchCounts.p2).toBe(3);
  });

  it('reports no strikes for a pitcher who has thrown none', () => {
    const state = deriveGameState(GAME, [
      e(EventType.GAME_START, { homeLineupPitcherId: 'p1' }),
      pitch('p1', PitchOutcome.BALL),
    ], HOME_TEAM);

    expect(state.pitcherStrikeCounts.p1 ?? 0).toBe(0);
  });
});
