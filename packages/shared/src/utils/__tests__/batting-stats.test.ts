import { deriveBattingStats, type BattingLineupContext } from '../batting-stats';
import { EventType, HitType, HitTrajectory, PitchOutcome } from '../../types/game-event';

type Evt = {
  game_id: string;
  sequence_number: number;
  event_type: string;
  payload: Record<string, unknown>;
  is_top_of_inning: boolean;
};

const GAME = 'g1';
let seq = 0;
let topOfInning = true;
const e = (
  event_type: string,
  payload: Record<string, unknown>,
  isTop = topOfInning,
): Evt => ({
  game_id: GAME,
  sequence_number: seq++,
  event_type,
  payload,
  is_top_of_inning: isTop,
});
const resetSeq = () => { seq = 0; topOfInning = true; };

const players = [
  { id: 'p1', firstName: 'Alice', lastName: 'Atbat' },
  { id: 'p2', firstName: 'Bob',   lastName: 'Basher' },
];

describe('deriveBattingStats — normalizeBatterId', () => {
  beforeEach(resetSeq);

  it("drops events stamped with the legacy 'unknown-batter' stub without creating a phantom row", () => {
    const events = [
      e(EventType.HIT,       { batterId: 'unknown-batter', hitType: HitType.SINGLE }),
      e(EventType.WALK,      { batterId: 'unknown-batter' }),
      e(EventType.STRIKEOUT, { batterId: 'unknown-batter' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.has('unknown-batter')).toBe(false);
    expect(stats.size).toBe(0);
  });

  it('drops events with missing batterId (undefined) cleanly', () => {
    const events = [
      e(EventType.HIT,       { hitType: HitType.SINGLE }),
      e(EventType.WALK,      {}),
      e(EventType.STRIKEOUT, {}),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.size).toBe(0);
  });

  it('attributes stats to a real batter when the id is valid', () => {
    const events = [
      e(EventType.HIT,       { batterId: 'p1', hitType: HitType.SINGLE }),
      e(EventType.WALK,      { batterId: 'p1' }),
      e(EventType.STRIKEOUT, { batterId: 'p1' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    const s = stats.get('p1')!;
    expect(s).toBeDefined();
    expect(s.plateAppearances).toBe(3);
    expect(s.hits).toBe(1);
    expect(s.walks).toBe(1);
    expect(s.strikeouts).toBe(1);
    expect(s.atBats).toBe(2); // walk doesn't count as AB
  });
});

describe('deriveBattingStats — excludedPlayerIds', () => {
  beforeEach(resetSeq);

  it('drops at-bats for players in the per-game excludedPlayerIds set', () => {
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.SINGLE }),
      e(EventType.HIT, { batterId: 'p2', hitType: HitType.DOUBLE }),
      e(EventType.STRIKEOUT, { batterId: 'p1' }),
    ];
    const lineupsByGameId = new Map<string, BattingLineupContext>([
      [
        GAME,
        {
          ourLineup: [],
          isHome: true,
          excludedPlayerIds: new Set(['p1']),
        },
      ],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineupsByGameId);
    // p1 was excluded — no stats entry should exist
    expect(stats.has('p1')).toBe(false);
    // p2 is unaffected
    expect(stats.get('p2')?.hits).toBe(1);
  });
});

describe('deriveBattingStats — lineup-replay batter inference', () => {
  beforeEach(resetSeq);

  const ourLineupCtx = (isHome: boolean): BattingLineupContext => ({
    isHome,
    ourLineup: [
      { playerId: 'p1', battingOrder: 1 },
      { playerId: 'p2', battingOrder: 2 },
      { playerId: 'p3', battingOrder: 3 },
    ],
  });

  it('attributes a null-batter PA to the expected lineup slot when our team is batting', () => {
    // Home team at bat = bottom of inning (isTop=false). We are home.
    const events = [
      e(EventType.HIT, { hitType: HitType.SINGLE }, false), // slot 1 (p1)
      e(EventType.OUT, { outType: 'groundout' },    false), // slot 2 (p2)
      e(EventType.WALK, {},                         false), // slot 3 (p3)
      e(EventType.STRIKEOUT, {},                    false), // wraps back to slot 1 (p1)
    ];
    const lineups = new Map([[GAME, ourLineupCtx(true)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p1')?.plateAppearances).toBe(2);
    expect(stats.get('p1')?.strikeouts).toBe(1);
    expect(stats.get('p1')?.hits).toBe(1);
    expect(stats.get('p2')?.plateAppearances).toBe(1);
    expect(stats.get('p3')?.plateAppearances).toBe(1);
    expect(stats.has('unknown-batter')).toBe(false);
  });

  it('attributes PAs correctly when we are the visitor (top of inning = our bat)', () => {
    const events = [
      e(EventType.HIT, { hitType: HitType.SINGLE }, true),
      e(EventType.OUT, { outType: 'flyout' },       true),
    ];
    const lineups = new Map([[GAME, ourLineupCtx(false)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p1')?.plateAppearances).toBe(1);
    expect(stats.get('p2')?.plateAppearances).toBe(1);
  });

  it('does not infer for the opposing half-inning (isTop events when we are home)', () => {
    const events = [e(EventType.HIT, { hitType: HitType.SINGLE }, true)];
    const lineups = new Map([[GAME, ourLineupCtx(true)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.size).toBe(0);
  });

  it('prefers a real batterId over inference', () => {
    const events = [
      e(EventType.HIT, { batterId: 'p2', hitType: HitType.SINGLE }, false),
    ];
    const lineups = new Map([[GAME, ourLineupCtx(true)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p2')?.plateAppearances).toBe(1);
    expect(stats.has('p1')).toBe(false);
  });

  it('treats the stub as missing and falls back to inference', () => {
    const events = [
      e(EventType.HIT, { batterId: 'unknown-batter', hitType: HitType.SINGLE }, false),
    ];
    const lineups = new Map([[GAME, ourLineupCtx(true)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p1')?.plateAppearances).toBe(1);
    expect(stats.has('unknown-batter')).toBe(false);
  });

  it('drops the event when no lineup is supplied (backwards-compatible)', () => {
    const events = [e(EventType.HIT, { hitType: HitType.SINGLE }, false)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.size).toBe(0);
  });

  it('tracks pinch-hitter substitutions so inferred PAs land on the new player', () => {
    const events = [
      e(EventType.HIT, { hitType: HitType.SINGLE }, false), // slot 1 (p1)
      e('substitution', { inPlayerId: 'p9', outPlayerId: 'p2' }, false),
      e(EventType.HIT, { hitType: HitType.SINGLE }, false), // slot 2 now = p9
    ];
    const lineups = new Map([[GAME, ourLineupCtx(true)]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p1')?.plateAppearances).toBe(1);
    expect(stats.get('p9')?.plateAppearances).toBe(1);
    expect(stats.has('p2')).toBe(false);
  });

  it('attributes a substitution-by-position correctly when the lineup has batting-order gaps', () => {
    // Lineup has slots 1 and 3 only (slot 2 missing). A substitution comes
    // in for battingOrderPosition 3; it should land on the slot-3 entry,
    // not on the second dense-packed array element (which would be wrong
    // if we used idx = 3 - 1 without a battingOrder lookup).
    const gappyLineup: BattingLineupContext = {
      isHome: true,
      ourLineup: [
        { playerId: 'p1', battingOrder: 1 },
        { playerId: 'p3', battingOrder: 3 },
      ],
    };
    const events = [
      // sub in p9 at position 3; no outPlayerId (slot had occupant but sub tracked by position)
      e('substitution', { inPlayerId: 'p9', battingOrderPosition: 3 }, false),
      // PA 1 (slot 1 → p1)
      e(EventType.HIT, { hitType: HitType.SINGLE }, false),
      // PA 2 (dense-packed index 1 → now p9, which IS the real slot-3 player)
      e(EventType.OUT, { outType: 'groundout' }, false),
    ];
    const lineups = new Map([[GAME, gappyLineup]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p1')?.plateAppearances).toBe(1);
    expect(stats.get('p9')?.plateAppearances).toBe(1);
    expect(stats.has('p3')).toBe(false);
  });

  it('appends a new slot when a SUBSTITUTION extends the lineup past the current end', () => {
    // 3-player lineup; mid-game we add a 4th batter at battingOrderPosition 4.
    // The rotation should walk slot 4 before wrapping back to slot 1.
    const lineupCtx: BattingLineupContext = {
      isHome: true,
      ourLineup: [
        { playerId: 'p1', battingOrder: 1 },
        { playerId: 'p2', battingOrder: 2 },
        { playerId: 'p3', battingOrder: 3 },
      ],
    };
    const events = [
      e(EventType.HIT,       { hitType: HitType.SINGLE }, false), // slot 1 → p1
      e(EventType.OUT,       { outType: 'groundout' },     false), // slot 2 → p2
      e(EventType.WALK,      {},                           false), // slot 3 → p3
      // Add a 4th batter to the end of the order.
      e('substitution', { inPlayerId: 'p4', battingOrderPosition: 4 }, false),
      e(EventType.HIT,       { hitType: HitType.DOUBLE },  false), // slot 4 → p4
      e(EventType.STRIKEOUT, {},                           false), // wraps → p1
    ];
    const lineups = new Map([[GAME, lineupCtx]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players, lineups);
    expect(stats.get('p1')?.plateAppearances).toBe(2);
    expect(stats.get('p1')?.strikeouts).toBe(1);
    expect(stats.get('p2')?.plateAppearances).toBe(1);
    expect(stats.get('p3')?.plateAppearances).toBe(1);
    expect(stats.get('p4')?.plateAppearances).toBe(1);
    expect(stats.get('p4')?.hits).toBe(1);
    expect(stats.get('p4')?.doubles).toBe(1);
  });
});

describe('deriveBattingStats — TRIPLE_PLAY handler', () => {
  beforeEach(resetSeq);

  it('credits the batter with a PA and AB on a triple play', () => {
    const events = [
      e(EventType.TRIPLE_PLAY, { batterId: 'p1' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    const s = stats.get('p1')!;
    expect(s).toBeDefined();
    expect(s.plateAppearances).toBe(1);
    expect(s.atBats).toBe(1);
    expect(s.hits).toBe(0);
  });

  it("doesn't create a phantom row when the triple_play payload carries the legacy stub", () => {
    const events = [
      e(EventType.TRIPLE_PLAY, { batterId: 'unknown-batter' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.has('unknown-batter')).toBe(false);
  });
});

describe('deriveBattingStats — Quality At-Bats (QAB)', () => {
  beforeEach(resetSeq);

  const basicPitch = (pitcherId: string, batterId: string, outcome = PitchOutcome.BALL) =>
    e(EventType.PITCH_THROWN, { pitcherId, batterId, outcome });

  it('credits a QAB for any hit (non fielders-choice)', () => {
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.SINGLE }),
      e(EventType.HIT, { batterId: 'p2', hitType: HitType.DOUBLE }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p1')!.qab).toBe(1);
    expect(stats.get('p2')!.qab).toBe(1);
  });

  it('does not credit a QAB for a fielders-choice hit', () => {
    const events = [e(EventType.HIT, { batterId: 'p1', hitType: HitType.SINGLE, fieldersChoice: true })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p1')!.qab).toBe(0);
  });

  it('credits a QAB for walk, HBP, sacrifice fly, and sacrifice bunt', () => {
    const events = [
      e(EventType.WALK, { batterId: 'p1' }),
      e(EventType.HIT_BY_PITCH, { batterId: 'p2' }),
      e(EventType.SACRIFICE_FLY, { batterId: 'p1' }),
      e(EventType.SACRIFICE_BUNT, { batterId: 'p2' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p1')!.qab).toBe(2);
    expect(stats.get('p2')!.qab).toBe(2);
  });

  it('credits a QAB for an 8+ pitch plate appearance ending in a strikeout', () => {
    // Build 8 pitches then a strikeout
    const events = [
      basicPitch('pit1', 'p1', PitchOutcome.BALL),
      basicPitch('pit1', 'p1', PitchOutcome.FOUL),
      basicPitch('pit1', 'p1', PitchOutcome.FOUL),
      basicPitch('pit1', 'p1', PitchOutcome.BALL),
      basicPitch('pit1', 'p1', PitchOutcome.FOUL),
      basicPitch('pit1', 'p1', PitchOutcome.BALL),
      basicPitch('pit1', 'p1', PitchOutcome.FOUL),
      basicPitch('pit1', 'p1', PitchOutcome.SWINGING_STRIKE),
      e(EventType.STRIKEOUT, { batterId: 'p1', pitcherId: 'pit1' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p1')!.qab).toBe(1);
  });

  it('does not credit QAB for a 7-pitch strikeout (below 8-pitch threshold)', () => {
    const events = [
      basicPitch('pit1', 'p1', PitchOutcome.SWINGING_STRIKE),
      basicPitch('pit1', 'p1', PitchOutcome.BALL),
      basicPitch('pit1', 'p1', PitchOutcome.FOUL),
      basicPitch('pit1', 'p1', PitchOutcome.BALL),
      basicPitch('pit1', 'p1', PitchOutcome.FOUL),
      basicPitch('pit1', 'p1', PitchOutcome.BALL),
      basicPitch('pit1', 'p1', PitchOutcome.SWINGING_STRIKE),
      e(EventType.STRIKEOUT, { batterId: 'p1', pitcherId: 'pit1' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p1')!.qab).toBe(0);
  });

  it('credits a QAB for a hard-hit out (line drive or deep fly)', () => {
    const events = [
      e(EventType.OUT, { batterId: 'p1', outType: 'lineout', trajectory: HitTrajectory.LINE_DRIVE }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p1')!.qab).toBe(1);
  });

  it('credits a QAB for a productive out (<2 outs, runner on 2nd advances)', () => {
    // p1 singles (reach 1st), p2 singles (p1→2nd, p2 on 1st), then p3 groundout
    // with 0 outs and runner on 2nd advances to 3rd → productive out.
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.SINGLE }),
      e(EventType.HIT, { batterId: 'p2', hitType: HitType.SINGLE }),
      e(EventType.OUT, { batterId: 'p3', outType: 'groundout' }),
      e('baserunner_advance', { runnerId: 'p1', fromBase: 2, toBase: 3, reason: 'on_play' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p3')!.qab).toBe(1);
  });

  it('credits a QAB for an out that scores a runner from 3rd', () => {
    // p1 triples (reach 3rd), p2 groundout, runner from 3rd scores
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.TRIPLE }),
      e(EventType.OUT, { batterId: 'p2', outType: 'groundout' }),
      e(EventType.SCORE, { scoringPlayerId: 'p1' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p2')!.qab).toBe(1);
  });

  it('does not credit productive out for a strikeout', () => {
    // Runner on 2nd, 0 outs, strikeout → not productive
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.DOUBLE }),
      e(EventType.STRIKEOUT, { batterId: 'p2' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p2')!.qab).toBe(0);
  });

  it('does not credit productive out when there are already 2 outs', () => {
    // 2 outs via two groundouts, then runner advance on 3rd out → not productive
    const events = [
      e(EventType.OUT, { batterId: 'p1', outType: 'groundout' }),
      e(EventType.OUT, { batterId: 'p2', outType: 'groundout' }),
      e(EventType.HIT, { batterId: 'p3', hitType: HitType.DOUBLE }), // runner on 2nd
      e(EventType.OUT, { batterId: 'p1', outType: 'groundout' }),
      e('baserunner_advance', { runnerId: 'p3', fromBase: 2, toBase: 3, reason: 'on_play' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    // p1's second PA: 2 outs, so advance does not trigger QAB
    expect(stats.get('p1')!.qab).toBe(0);
  });

  it('credits QAB only once when a PA qualifies by multiple criteria', () => {
    // Hard-hit line-drive OUT that also advances runner from 2nd on the play.
    // Should credit QAB exactly once despite qualifying via hard-hit AND
    // productive-out.
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.DOUBLE }), // runner to 2nd
      e(EventType.OUT, {
        batterId: 'p2',
        outType: 'lineout',
        trajectory: HitTrajectory.LINE_DRIVE,
      }),
      e('baserunner_advance', { runnerId: 'p1', fromBase: 2, toBase: 3, reason: 'on_play' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p2')!.qab).toBe(1);
  });

  it('does not credit productive-out QAB when the runner advanced on a wild pitch', () => {
    // Groundout with runner on 2nd, then wild-pitch advance. The advance
    // isn't caused by the at-bat so the OUT shouldn't earn a productive-out
    // QAB.
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.DOUBLE }),
      e(EventType.OUT, { batterId: 'p2', outType: 'groundout' }),
      e('baserunner_advance', { runnerId: 'p1', fromBase: 2, toBase: 3, reason: 'wild_pitch' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    expect(stats.get('p2')!.qab).toBe(0);
  });

  it('computes qabPct as qab / plateAppearances', () => {
    const events = [
      e(EventType.HIT, { batterId: 'p1', hitType: HitType.SINGLE }),
      e(EventType.STRIKEOUT, { batterId: 'p1' }),
      e(EventType.OUT, { batterId: 'p1', outType: 'groundout' }),
      e(EventType.WALK, { batterId: 'p1' }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    const s = stats.get('p1')!;
    expect(s.plateAppearances).toBe(4);
    expect(s.qab).toBe(2); // hit + walk
    expect(s.qabPct).toBeCloseTo(0.5, 5);
  });
});

describe('deriveBattingStats — DROPPED_THIRD_STRIKE', () => {
  beforeEach(resetSeq);

  it('credits K + PA + AB on a thrown_out D3K (still an out)', () => {
    const events = [
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'p1',
        outcome: 'thrown_out',
        fieldingSequence: [2, 3],
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    const s = stats.get('p1')!;
    expect(s.plateAppearances).toBe(1);
    expect(s.atBats).toBe(1);
    expect(s.strikeouts).toBe(1);
    expect(s.hits).toBe(0);
  });

  it('credits K + PA + AB on a reached_on_error D3K — batter is not credited with a hit', () => {
    const events = [
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'p1',
        outcome: 'reached_on_error',
        errorBy: 2,
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    const s = stats.get('p1')!;
    expect(s.plateAppearances).toBe(1);
    expect(s.atBats).toBe(1);
    expect(s.strikeouts).toBe(1);
    expect(s.hits).toBe(0);
  });

  it('credits K + PA + AB on a reached_wild_pitch D3K — batter is not credited with a hit', () => {
    const events = [
      e(EventType.DROPPED_THIRD_STRIKE, {
        batterId: 'p1',
        outcome: 'reached_wild_pitch',
        isWildPitch: true,
      }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = deriveBattingStats(events as any, players);
    const s = stats.get('p1')!;
    expect(s.plateAppearances).toBe(1);
    expect(s.atBats).toBe(1);
    expect(s.strikeouts).toBe(1);
    expect(s.hits).toBe(0);
  });
});

describe('deriveBattingStats — SCORE from an unrecognized runner', () => {
  beforeEach(resetSeq);

  // deriveGameState mints an event-id stand-in to hold a base when a runner
  // has no batter of record (an opponent half scored without their order
  // entered). A SCORE naming that stand-in must not manufacture a batting row
  // for it: the id is a runner handle, not a player.
  it('does not create a stats row for an event-id stand-in', () => {
    const standIn = 'evt-9f3c1b2a-not-a-player';
    const stats = deriveBattingStats(
      [
        e(EventType.SCORE, { scoringPlayerId: standIn }),
      ] as never,
      players,
    );

    expect(stats.has(standIn)).toBe(false);
    expect([...stats.values()].some((s) => s.playerName === 'Unknown')).toBe(false);
  });

  it('still credits a run to a runner the roster knows', () => {
    const stats = deriveBattingStats(
      [
        e(EventType.SCORE, { scoringPlayerId: 'p1' }),
      ] as never,
      players,
    );

    expect(stats.get('p1')?.runs).toBe(1);
  });
});
