import { useState, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal } from 'react-native';
import { HitType, PitchOutcome, PitchType } from '@baseball/shared';
import type { DefensiveLineup, DroppedThirdStrikeOutcome } from '@baseball/shared';
import { DefensiveDiamond } from './DefensiveDiamond';

interface DroppedThirdStrikeDetails {
  outcome: DroppedThirdStrikeOutcome;
  fieldingSequence?: number[];
  errorBy?: number;
  isWildPitch?: boolean;
}

type Base = 1 | 2 | 3;

export type BattedOutType = 'groundout' | 'flyout' | 'lineout' | 'popout' | 'other';

export type RosterPlayer = {
  id: string;
  name: string;
  jerseyNumber?: number;
  /** Optional split-name fields for richer display (e.g., on the defensive diamond). */
  firstName?: string;
  lastName?: string;
  /** Player's primary defensive position (e.g., 'SS', 'CF'). Seeds the defensive alignment. */
  primaryPosition?: string | null;
};

/**
 * Per-runner outcome on a play whose batter-result stands but whose
 * existing runners diverge from the default auto-advance. Used by the
 * post-hit modal for 2B/3B hits with runners on base.
 *
 * - `auto`     — runner advances by the default amount (no event emitted).
 * - `held`     — runner stops at `toBase`, short of the default. Recorded
 *                as a BASERUNNER_ADVANCE event linked via relatedEventId.
 * - `thrown_out` — runner is thrown out advancing. Recorded as a
 *                BASERUNNER_OUT event linked via relatedEventId.
 */
export type RunnerOutcome = {
  runnerId: string;
  fromBase: Base;
} & (
  | { kind: 'auto' }
  | { kind: 'held'; toBase: 2 | 3 }
  | { kind: 'thrown_out' }
);

interface PitchInputProps {
  onRecordPitch: (
    outcome: PitchOutcome,
    pitchType?: PitchType,
    zoneLocation?: number,
  ) => void;
  /** Scorer opted into pitch-type tracking at game start. When false the
   *  picker is hidden entirely rather than shown-and-ignored. */
  trackPitchType?: boolean;
  /** Scorer opted into pitch-location tracking at game start. */
  trackPitchLocation?: boolean;
  onRecordHit: (hitType: HitType) => void;
  /**
   * Optional: when present and the scorer taps 2B / 3B with runners on base,
   * the post-hit "runner outcomes" modal collects per-runner held / thrown-out
   * choices and the parent emits the HIT plus linked BASERUNNER_OUT /
   * BASERUNNER_ADVANCE events in one coordinated submission. Falls back to
   * onRecordHit when omitted or when no runners are on base (one-tap path).
   */
  onRecordHitWithRunnerOutcomes?: (hitType: HitType, outcomes: RunnerOutcome[]) => void;
  onRecordOut: (outType: BattedOutType) => void;
  // Walk and Strikeout no longer have manual buttons — auto-completion lives
  // in the parent's pitch handler. handleStrikeout is still passed because the
  // D3K modal's "Caught (regular K)" option resolves to a regular STRIKEOUT.
  onRecordStrikeout: () => void;
  onRecordError: (errorBy: number) => void;
  onRecordCatcherInterference: () => void;
  onRecordSacFly: () => void;
  onRecordSacBunt: () => void;
  /** Sacrifice fly chosen via the in-Out follow-up — carries the trajectory
   *  the scorer initially picked (groundout/flyout/lineout/popout/other) so
   *  the recorded payload preserves that context. */
  onRecordSacFlyFromOut?: (outType: BattedOutType) => void;
  /** Sacrifice bunt chosen via the in-Out follow-up — same trajectory carry-over. */
  onRecordSacBuntFromOut?: (outType: BattedOutType) => void;
  onRecordFieldersChoice: (runnerId: string, fromBase: Base) => void;
  /** Runner thrown out advancing during a play (e.g., on a hit, sac fly,
   *  wild pitch). Records BASERUNNER_OUT for the chosen runner. */
  onRecordRunnerOut: (runnerId: string, fromBase: Base) => void;
  onRecordWildPitch: () => void;
  onRecordPassedBall: () => void;
  onRecordBalk: () => void;
  onRecordDoublePlay: (runnerOut: { runnerId: string; base: Base } | null) => void;
  onRecordTriplePlay: () => void;
  onRecordPitchingChange: (newPitcherId: string) => void;
  onRecordPinchHitter: (newBatterId: string) => void;
  /** Defensive substitution: replace one fielder with another, optionally taking a new position. */
  onRecordDefensiveSub?: (outPlayerId: string, inPlayerId: string, newPosition?: string) => void;
  /** Position change: same player moves to a new defensive position. */
  onRecordPositionChange?: (playerId: string, newPosition: string) => void;
  /** Add a batter to the end of the order mid-game (late arrival, courtesy player). */
  onRecordAddBatter?: (newBatterId: string) => void;
  /** Player ids already in the active batting order — excluded from the Add Batter picker. */
  activeBattingOrderPlayerIds?: ReadonlyArray<string>;
  /** Current defensive alignment, shown above the defensive-sub / position-change pickers. */
  defensiveLineup?: DefensiveLineup | null;
  roster: RosterPlayer[];
  /** Per-player game pitch totals + compliance level, shown as badges in the
   *  pitching-change picker so the coach sees who is near/over their limit. */
  pitcherBadges?: Record<string, { count: number; level: 'ok' | 'warning' | 'danger' | 'over' }>;
  onUndoLastEvent: () => void;
  runnersOnBase: { base: Base; runnerId: string }[];
  onRecordDroppedThirdStrike?: (details: DroppedThirdStrikeDetails) => void;
  // Controlled modal state — parent opens the modal automatically when a
  // 3rd-strike pitch is recorded with D3K eligibility (per OBR 5.05(a)(2)).
  d3kModalOpen?: boolean;
  setD3KModalOpen?: (open: boolean) => void;
}

const PITCH_TYPES: Array<{ label: string; value: PitchType }> = [
  { label: 'FB', value: PitchType.FASTBALL },
  { label: 'CB', value: PitchType.CURVEBALL },
  { label: 'SL', value: PitchType.SLIDER },
  { label: 'CH', value: PitchType.CHANGEUP },
  { label: 'SI', value: PitchType.SINKER },
  { label: 'CT', value: PitchType.CUTTER },
  { label: 'SP', value: PitchType.SPLITTER },
  { label: 'KN', value: PitchType.KNUCKLEBALL },
];

const FIELDER_POSITIONS: Array<{ label: string; position: number }> = [
  { label: 'P',  position: 1 },
  { label: 'C',  position: 2 },
  { label: '1B', position: 3 },
  { label: '2B', position: 4 },
  { label: '3B', position: 5 },
  { label: 'SS', position: 6 },
  { label: 'LF', position: 7 },
  { label: 'CF', position: 8 },
  { label: 'RF', position: 9 },
];

const HIT_TYPES: Array<{ label: string; emoji: string; hitType: HitType; color: string }> = [
  { label: '1B', emoji: '⚾', hitType: HitType.SINGLE, color: 'bg-blue-600' },
  { label: '2B', emoji: '⚾⚾', hitType: HitType.DOUBLE, color: 'bg-indigo-600' },
  { label: '3B', emoji: '⚾⚾⚾', hitType: HitType.TRIPLE, color: 'bg-purple-600' },
  { label: 'HR', emoji: '💥', hitType: HitType.HOME_RUN, color: 'bg-amber-600' },
];

/**
 * Primary pitch and plate-appearance input interface.
 * Records individual pitches (ball/strike/foul) and plate outcomes (hit/out/walk/K).
 */
export function PitchInput({
  onRecordPitch,
  trackPitchType = true,
  trackPitchLocation = false,
  onRecordHit,
  onRecordHitWithRunnerOutcomes,
  onRecordOut,
  onRecordStrikeout,
  onRecordError,
  onRecordCatcherInterference,
  onRecordSacFly,
  onRecordSacBunt,
  onRecordSacFlyFromOut,
  onRecordSacBuntFromOut,
  onRecordFieldersChoice,
  onRecordRunnerOut,
  onRecordWildPitch,
  onRecordPassedBall,
  onRecordBalk,
  onRecordDoublePlay,
  onRecordTriplePlay,
  onRecordPitchingChange,
  onRecordPinchHitter,
  onRecordDefensiveSub,
  onRecordPositionChange,
  onRecordAddBatter,
  activeBattingOrderPlayerIds,
  defensiveLineup,
  roster,
  pitcherBadges,
  onUndoLastEvent,
  runnersOnBase,
  onRecordDroppedThirdStrike,
  d3kModalOpen = false,
  setD3KModalOpen,
}: PitchInputProps) {
  const showD3KModal = d3kModalOpen;
  const setShowD3KModal = setD3KModalOpen ?? (() => {});
  const [showFCModal, setShowFCModal] = useState(false);
  const [showRunnerOutModal, setShowRunnerOutModal] = useState(false);
  // Pending HIT awaiting per-runner outcome confirmation (2B/3B with
  // runners on). null = modal closed; non-null = modal open for that hit
  // type. The choices map is keyed by runnerId.
  const [pendingHitWithRunners, setPendingHitWithRunners] = useState<HitType | null>(null);
  const [runnerOutcomeChoices, setRunnerOutcomeChoices] = useState<
    Record<string, RunnerOutcome>
  >({});
  const [showOutModal, setShowOutModal] = useState(false);
  // Two-step Out modal: step 1 picks trajectory, step 2 asks "was this a sac?".
  // null = step 1 visible; non-null = step 2 visible with the picked trajectory.
  const [pendingOutType, setPendingOutType] = useState<BattedOutType | null>(null);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showDPModal, setShowDPModal] = useState(false);
  const [subModal, setSubModal] = useState<
    null | 'pinch_hitter' | 'pitching_change' | 'defensive' | 'position_change' | 'add_batter'
  >(null);
  // Defensive-sub / position-change picker state.
  const [defSubOutId, setDefSubOutId] = useState<string>('');
  const [defSubInId, setDefSubInId] = useState<string>('');
  const [defSubPosition, setDefSubPosition] = useState<string>('');
  const [selectedPitchType, setSelectedPitchType] = useState<PitchType | null>(null);
  // Strike-zone cell 1-9, or 0 for a pitch outside the zone. null = not picked.
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  // Branch sheets opened from the primary surface.
  const [showInPlaySheet, setShowInPlaySheet] = useState(false);
  const [showRunnersSheet, setShowRunnersSheet] = useState(false);
  const [showSubsSheet, setShowSubsSheet] = useState(false);
  const fcEligible = runnersOnBase.length > 0;

  /**
   * Close the branch sheet, then run the action. Several actions open a
   * follow-up modal (Out, Error, Fielder's Choice…) and two Modals visible
   * at once stack awkwardly on iOS, so the sheet always closes first.
   */
  function runFromSheet(close: (open: boolean) => void, action: () => void) {
    close(false);
    action();
  }

  function handlePitchOutcome(outcome: PitchOutcome) {
    onRecordPitch(
      outcome,
      trackPitchType ? selectedPitchType ?? undefined : undefined,
      trackPitchLocation ? selectedZone ?? undefined : undefined,
    );
    // Both selections latch only until the pitch is recorded.
    setSelectedPitchType(null);
    setSelectedZone(null);
  }

  function handleErrorPick(errorBy: number) {
    setShowErrorModal(false);
    onRecordError(errorBy);
  }

  function handleDPTap() {
    if (runnersOnBase.length === 0) {
      // No runners to force out; fall through to ambiguous DP (legacy).
      onRecordDoublePlay(null);
    } else {
      setShowDPModal(true);
    }
  }

  function handleDPPick(runnerId: string, base: Base) {
    setShowDPModal(false);
    onRecordDoublePlay({ runnerId, base });
  }

  function handleSubPick(playerId: string) {
    const mode = subModal;
    setSubModal(null);
    if (mode === 'pinch_hitter') onRecordPinchHitter(playerId);
    else if (mode === 'pitching_change') onRecordPitchingChange(playerId);
    else if (mode === 'add_batter' && onRecordAddBatter) onRecordAddBatter(playerId);
  }

  function openDefensiveSubModal() {
    setDefSubOutId('');
    setDefSubInId('');
    setDefSubPosition('');
    setSubModal('defensive');
  }

  function openPositionChangeModal() {
    setDefSubOutId('');
    setDefSubPosition('');
    setSubModal('position_change');
  }

  function submitDefensiveSub() {
    if (!onRecordDefensiveSub || !defSubOutId || !defSubInId) return;
    onRecordDefensiveSub(defSubOutId, defSubInId, defSubPosition || undefined);
    setSubModal(null);
  }

  function submitPositionChange() {
    if (!onRecordPositionChange || !defSubOutId || !defSubPosition) return;
    onRecordPositionChange(defSubOutId, defSubPosition);
    setSubModal(null);
  }

  function handleFCPick(runnerId: string, fromBase: Base) {
    setShowFCModal(false);
    onRecordFieldersChoice(runnerId, fromBase);
  }

  function handleRunnerOutPick(runnerId: string, fromBase: Base) {
    setShowRunnerOutModal(false);
    onRecordRunnerOut(runnerId, fromBase);
  }

  function handleHitTap(hitType: HitType) {
    const supportsOutcomes = !!onRecordHitWithRunnerOutcomes;
    const needsPrompt =
      supportsOutcomes &&
      runnersOnBase.length > 0 &&
      (hitType === HitType.DOUBLE || hitType === HitType.TRIPLE);
    if (!needsPrompt) {
      onRecordHit(hitType);
      return;
    }
    // Seed every runner with the default "auto" choice.
    const seed: Record<string, RunnerOutcome> = {};
    for (const r of runnersOnBase) {
      seed[r.runnerId] = { runnerId: r.runnerId, fromBase: r.base, kind: 'auto' };
    }
    setRunnerOutcomeChoices(seed);
    setPendingHitWithRunners(hitType);
  }

  function setRunnerChoice(runnerId: string, fromBase: Base, kind: 'auto' | 'held' | 'thrown_out') {
    setRunnerOutcomeChoices((prev) => {
      const next = { ...prev };
      if (kind === 'auto') {
        next[runnerId] = { runnerId, fromBase, kind: 'auto' };
      } else if (kind === 'thrown_out') {
        next[runnerId] = { runnerId, fromBase, kind: 'thrown_out' };
      } else {
        // "Held" — pick the next base the runner could realistically stop at.
        // For a runner on 1B that's 2B; for a runner on 2B that's 3B. Runners
        // on 3B can't "hold" further (3B is their default; advancing is to
        // home, which is the "auto" outcome).
        const toBase: 2 | 3 = fromBase === 1 ? 2 : 3;
        next[runnerId] = { runnerId, fromBase, kind: 'held', toBase };
      }
      return next;
    });
  }

  function confirmHitWithRunners() {
    if (!pendingHitWithRunners || !onRecordHitWithRunnerOutcomes) {
      setPendingHitWithRunners(null);
      return;
    }
    const outcomes = Object.values(runnerOutcomeChoices);
    onRecordHitWithRunnerOutcomes(pendingHitWithRunners, outcomes);
    setPendingHitWithRunners(null);
    setRunnerOutcomeChoices({});
  }

  function cancelHitWithRunners() {
    setPendingHitWithRunners(null);
    setRunnerOutcomeChoices({});
  }

  // Step 1: scorer picks the trajectory of the out. We stash it and advance
  // to step 2 where the scorer confirms it was a regular out or upgrades it
  // to a sacrifice fly/bunt.
  function handleOutPick(outType: BattedOutType) {
    setPendingOutType(outType);
  }

  // Step 2 (regular path): confirm the stashed trajectory as a plain OUT.
  function confirmRegularOut() {
    if (!pendingOutType) return;
    const t = pendingOutType;
    closeOutModal();
    onRecordOut(t);
  }

  // Step 2 (sac fly path): record SACRIFICE_FLY, carrying the trajectory
  // the scorer just picked as additional payload context.
  function confirmSacFlyFromOut() {
    if (!pendingOutType) return;
    const t = pendingOutType;
    closeOutModal();
    if (onRecordSacFlyFromOut) onRecordSacFlyFromOut(t);
    else onRecordSacFly();
  }

  // Step 2 (sac bunt path): record SACRIFICE_BUNT with trajectory context.
  function confirmSacBuntFromOut() {
    if (!pendingOutType) return;
    const t = pendingOutType;
    closeOutModal();
    if (onRecordSacBuntFromOut) onRecordSacBuntFromOut(t);
    else onRecordSacBunt();
  }

  function closeOutModal() {
    setShowOutModal(false);
    setPendingOutType(null);
  }

  function handleD3KOutcome(details: DroppedThirdStrikeDetails) {
    setShowD3KModal(false);
    onRecordDroppedThirdStrike?.(details);
  }

  return (
    <View className="flex-1 bg-slate-50">
      {/* Modifiers — only rendered when the scorer opted in at game start.
          Placed directly above the outcome buttons so the thumb travels
          modifier → outcome in the order a pitch is actually observed. */}
      {(trackPitchType || trackPitchLocation) && (
        <ScrollView className="px-4 pt-3" style={{ flexShrink: 1 }}>
          {trackPitchType && (
            <View className="mb-3">
              <Text className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">
                Pitch type
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                {PITCH_TYPES.map(({ label, value }) => {
                  const selected = selectedPitchType === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      className={`rounded-lg px-3 py-2 border ${
                        selected ? 'bg-slate-800 border-slate-900' : 'bg-white border-slate-300'
                      }`}
                      onPress={() => setSelectedPitchType(selected ? null : value)}
                    >
                      <Text
                        className={`text-xs font-bold tracking-wide ${
                          selected ? 'text-white' : 'text-slate-600'
                        }`}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {trackPitchLocation && (
            <View className="mb-2">
              <Text className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">
                Location
              </Text>
              <StrikeZoneGrid selected={selectedZone} onSelect={setSelectedZone} />
            </View>
          )}
        </ScrollView>
      )}

      {/* Primary outcomes — pinned to the bottom of the screen, never
          scrolls. Ball/strike/foul is the overwhelming majority of taps in
          a live game, so it stays one tap away and inside thumb reach.
          Everything a batted ball can become lives behind "In play". */}
      <View className="mt-auto px-3 pt-2">
        <View className="flex-row gap-2 mb-2">
          <PrimaryAction
            label="Ball"
            tone="ball"
            onPress={() => handlePitchOutcome(PitchOutcome.BALL)}
          />
          <PrimaryAction
            label="Foul"
            tone="foul"
            onPress={() => handlePitchOutcome(PitchOutcome.FOUL)}
          />
        </View>
        <View className="flex-row gap-2 mb-2">
          <PrimaryAction
            label="Called"
            caption="strike"
            tone="strike"
            onPress={() => handlePitchOutcome(PitchOutcome.CALLED_STRIKE)}
          />
          <PrimaryAction
            label="Swinging"
            caption="strike"
            tone="strike"
            onPress={() => handlePitchOutcome(PitchOutcome.SWINGING_STRIKE)}
          />
        </View>
        <PrimaryAction
          label="In play"
          caption="hit · out · reached"
          tone="inPlay"
          full
          onPress={() => setShowInPlaySheet(true)}
        />
      </View>

      {/* Everything infrequent — one row of sheets, out of the hot path. */}
      <View className="flex-row gap-2 px-3 pt-2 pb-3">
        <BranchButton label="Runners" onPress={() => setShowRunnersSheet(true)} />
        <BranchButton label="Subs" onPress={() => setShowSubsSheet(true)} />
        <BranchButton label="↩ Undo" onPress={onUndoLastEvent} />
      </View>

      {/* In play — what the batted ball became. Grouped the way a scorer
          thinks about it: did the batter hit safely, make an out, or reach
          without a hit? */}
      <ActionSheet
        visible={showInPlaySheet}
        title="In play"
        subtitle="What happened to the batter?"
        onClose={() => setShowInPlaySheet(false)}
      >
        <SheetGroup label="Hit">
          <View className="flex-row flex-wrap gap-2">
            {HIT_TYPES.map(({ label, emoji, hitType, color }) => (
              <OutcomeButton
                key={hitType}
                label={label}
                emoji={emoji}
                onPress={() => runFromSheet(setShowInPlaySheet, () => handleHitTap(hitType))}
                color={color}
              />
            ))}
          </View>
        </SheetGroup>

        <SheetGroup label="Out">
          <View className="flex-row flex-wrap gap-2">
            <OutcomeButton label="Out" emoji="✋" onPress={() => runFromSheet(setShowInPlaySheet, () => setShowOutModal(true))} color="bg-gray-600" />
            <OutcomeButton label="Sac Fly" emoji="SF" onPress={() => runFromSheet(setShowInPlaySheet, onRecordSacFly)} color="bg-teal-600" />
            <OutcomeButton label="Sac Bunt" emoji="SH" onPress={() => runFromSheet(setShowInPlaySheet, onRecordSacBunt)} color="bg-teal-700" />
            <OutcomeButton label="Double Play" emoji="DP" onPress={() => runFromSheet(setShowInPlaySheet, handleDPTap)} color="bg-zinc-700" />
            <OutcomeButton label="Triple Play" emoji="TP" onPress={() => runFromSheet(setShowInPlaySheet, onRecordTriplePlay)} color="bg-zinc-800" />
          </View>
        </SheetGroup>

        <SheetGroup label="Reached base">
          <View className="flex-row flex-wrap gap-2">
            <OutcomeButton label="Error" emoji="E" onPress={() => runFromSheet(setShowInPlaySheet, () => setShowErrorModal(true))} color="bg-orange-600" />
            <OutcomeButton label="Hit by pitch" emoji="HBP" onPress={() => runFromSheet(setShowInPlaySheet, () => handlePitchOutcome(PitchOutcome.HIT_BY_PITCH))} color="bg-orange-500" />
            <OutcomeButton label="Catcher Int." emoji="CI" onPress={() => runFromSheet(setShowInPlaySheet, onRecordCatcherInterference)} color="bg-rose-500" />
            {fcEligible && (
              <OutcomeButton label="Fielder's Choice" emoji="FC" onPress={() => runFromSheet(setShowInPlaySheet, () => setShowFCModal(true))} color="bg-purple-700" />
            )}
          </View>
        </SheetGroup>
      </ActionSheet>

      {/* Runners — plays that move or retire runners without a batted ball. */}
      <ActionSheet
        visible={showRunnersSheet}
        title="Runners"
        subtitle="Plays that don't involve the batter"
        onClose={() => setShowRunnersSheet(false)}
      >
        <View className="flex-row flex-wrap gap-2">
          <OutcomeButton label="Wild Pitch" emoji="WP" onPress={() => runFromSheet(setShowRunnersSheet, onRecordWildPitch)} color="bg-amber-600" />
          <OutcomeButton label="Passed Ball" emoji="PB" onPress={() => runFromSheet(setShowRunnersSheet, onRecordPassedBall)} color="bg-yellow-600" />
          <OutcomeButton label="Balk" emoji="BK" onPress={() => runFromSheet(setShowRunnersSheet, onRecordBalk)} color="bg-pink-600" />
          {fcEligible && (
            <OutcomeButton label="Runner Out" emoji="RO" onPress={() => runFromSheet(setShowRunnersSheet, () => setShowRunnerOutModal(true))} color="bg-rose-700" />
          )}
        </View>
        {!fcEligible && (
          <Text className="text-slate-400 text-xs mt-3">
            Runner plays appear here once someone is on base.
          </Text>
        )}
      </ActionSheet>

      {/* Subs — roster changes. */}
      <ActionSheet
        visible={showSubsSheet}
        title="Substitutions"
        subtitle="Change who's in the game"
        onClose={() => setShowSubsSheet(false)}
      >
        <View className="flex-row flex-wrap gap-2">
          <OutcomeButton label="Pinch Hitter" emoji="PH" onPress={() => runFromSheet(setShowSubsSheet, () => setSubModal('pinch_hitter'))} color="bg-sky-700" />
          <OutcomeButton label="Pitching Change" emoji="🔄" onPress={() => runFromSheet(setShowSubsSheet, () => setSubModal('pitching_change'))} color="bg-sky-800" />
          {onRecordDefensiveSub && (
            <OutcomeButton label="Defensive Sub" emoji="DS" onPress={() => runFromSheet(setShowSubsSheet, openDefensiveSubModal)} color="bg-sky-900" />
          )}
          {onRecordPositionChange && (
            <OutcomeButton label="Position Change" emoji="↔" onPress={() => runFromSheet(setShowSubsSheet, openPositionChangeModal)} color="bg-indigo-700" />
          )}
          {onRecordAddBatter && (
            <OutcomeButton label="Add Batter" emoji="+" onPress={() => runFromSheet(setShowSubsSheet, () => setSubModal('add_batter'))} color="bg-emerald-700" />
          )}
        </View>
      </ActionSheet>

      {/* Dropped third strike outcome modal */}
      <Modal
        visible={showD3KModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowD3KModal(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">
              Third Strike
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              Did the catcher catch it, or did it get away?
            </Text>

            <View className="gap-3">
              <TouchableOpacity
                className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                onPress={() => {
                  setShowD3KModal(false);
                  onRecordStrikeout();
                }}
              >
                <Text className="text-slate-800 font-semibold">Caught (regular K)</Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  Catcher caught the third strike — batter is out
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                onPress={() => handleD3KOutcome({
                  outcome: 'thrown_out',
                  fieldingSequence: [2, 3],
                })}
              >
                <Text className="text-slate-800 font-semibold">Batter Out (K 2-3)</Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  Catcher threw batter out at first
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                onPress={() => handleD3KOutcome({
                  outcome: 'reached_on_error',
                  errorBy: 2,
                })}
              >
                <Text className="text-slate-800 font-semibold">Safe - Error</Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  Batter reached on fielding error
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                onPress={() => handleD3KOutcome({
                  outcome: 'reached_wild_pitch',
                  isWildPitch: true,
                })}
              >
                <Text className="text-slate-800 font-semibold">Safe - Wild Pitch</Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  Batter reached on wild pitch
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                onPress={() => handleD3KOutcome({
                  outcome: 'reached_wild_pitch',
                  isWildPitch: false,
                })}
              >
                <Text className="text-slate-800 font-semibold">Safe - Passed Ball</Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  Batter reached on passed ball
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              className="mt-4 py-3 items-center"
              onPress={() => setShowD3KModal(false)}
            >
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Double-play runner picker: which runner was also retired? */}
      <Modal
        visible={showDPModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDPModal(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">Double Play</Text>
            <Text className="text-sm text-gray-500 mb-4">
              Batter is out. Which runner was retired on the second out?
            </Text>
            <View className="gap-3">
              {runnersOnBase.map(({ base, runnerId }) => (
                <TouchableOpacity
                  key={base}
                  className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                  onPress={() => handleDPPick(runnerId, base)}
                >
                  <Text className="text-slate-800 font-semibold">
                    Runner on {base === 1 ? '1st' : base === 2 ? '2nd' : '3rd'} retired
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity className="mt-4 py-3 items-center" onPress={() => setShowDPModal(false)}>
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Error fielder picker: OBR 9.12 — error must be charged to a position */}
      <Modal
        visible={showErrorModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowErrorModal(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">Error</Text>
            <Text className="text-sm text-gray-500 mb-4">
              Which fielder committed the error?
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {FIELDER_POSITIONS.map(({ label, position }) => (
                <TouchableOpacity
                  key={position}
                  className="bg-white border border-slate-300 rounded-xl px-4 py-3"
                  onPress={() => handleErrorPick(position)}
                >
                  <Text className="text-slate-800 font-semibold">
                    {position} — {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity className="mt-4 py-3 items-center" onPress={() => setShowErrorModal(false)}>
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Substitution / pitching change / defensive sub / position change */}
      <Modal
        visible={subModal !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSubModal(null)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '90%' }}>
            <Text className="text-lg font-bold text-gray-900 mb-1">
              {subModal === 'pinch_hitter'   ? 'Pinch Hitter' :
               subModal === 'pitching_change' ? 'Pitching Change' :
               subModal === 'defensive'       ? 'Defensive Substitution' :
               subModal === 'position_change' ? 'Position Change' :
               subModal === 'add_batter'      ? 'Add Batter' : ''}
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              {subModal === 'pinch_hitter'
                ? 'Who is coming in to bat?'
                : subModal === 'pitching_change'
                ? 'Who is coming in to pitch?'
                : subModal === 'defensive'
                ? 'Replace a fielder with a player from the roster.'
                : subModal === 'position_change'
                ? 'Move a player to a different defensive position.'
                : subModal === 'add_batter'
                ? 'Add a batter to the end of the order (late arrival, courtesy player).'
                : ''}
            </Text>

            <ScrollView style={{ maxHeight: 540 }}>
              {(subModal === 'defensive' || subModal === 'position_change') && defensiveLineup && (
                <View className="mb-4">
                  <DefensiveDiamond lineup={defensiveLineup} />
                </View>
              )}

              {(subModal === 'pinch_hitter' || subModal === 'pitching_change' || subModal === 'add_batter') && (() => {
                // For add_batter, hide players already in the order so the
                // coach can't accidentally double-add a starter.
                const filteredRoster = subModal === 'add_batter' && activeBattingOrderPlayerIds
                  ? roster.filter((p) => !activeBattingOrderPlayerIds.includes(p.id))
                  : roster;
                if (filteredRoster.length === 0) {
                  return (
                    <Text className="text-gray-500 text-sm py-4">
                      {subModal === 'add_batter'
                        ? 'Every roster player is already in the order.'
                        : 'No players loaded. Sync the roster first.'}
                    </Text>
                  );
                }
                // Player rows are a list to scan, not a wall of colour — the
                // accent lives on the left edge instead of filling the row.
                const buttonColor =
                  subModal === 'add_batter'
                    ? 'bg-white border border-emerald-300'
                    : 'bg-white border border-sky-300';
                return (
                  <View className="gap-2">
                    {filteredRoster.map((p) => {
                      // Pitch-count badge (pitching change only): total thrown
                      // this game, colored by the league compliance rule.
                      const badge =
                        subModal === 'pitching_change' ? pitcherBadges?.[p.id] : undefined;
                      const showBadge = badge && (badge.count > 0 || badge.level !== 'ok');
                      return (
                        <TouchableOpacity
                          key={p.id}
                          className={`${buttonColor} rounded-xl px-4 py-3 flex-row items-center`}
                          onPress={() => handleSubPick(p.id)}
                        >
                          <Text className="flex-1 text-slate-800 font-semibold text-base">
                            {p.jerseyNumber !== undefined ? `#${p.jerseyNumber} ` : ''}
                            {p.name}
                          </Text>
                          {showBadge && (
                            <View
                              className={`px-2 py-0.5 rounded-full ${
                                badge.level === 'over' || badge.level === 'danger'
                                  ? 'bg-red-200'
                                  : badge.level === 'warning'
                                    ? 'bg-amber-200'
                                    : 'bg-slate-100'
                              }`}
                            >
                              <Text
                                className={`text-xs font-semibold ${
                                  badge.level === 'over' || badge.level === 'danger'
                                    ? 'text-red-900'
                                    : badge.level === 'warning'
                                      ? 'text-amber-900'
                                      : 'text-slate-600'
                                }`}
                              >
                                {badge.count}p{badge.level === 'over' ? ' • over limit' : badge.level === 'danger' ? ' • at limit' : ''}
                              </Text>
                            </View>
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              })()}

              {subModal === 'defensive' && (
                <>
                  <PlayerPickerSection
                    label="Out (leaving the game)"
                    selectedId={defSubOutId}
                    onSelect={setDefSubOutId}
                    roster={roster}
                  />
                  <PlayerPickerSection
                    label="In (entering the game)"
                    selectedId={defSubInId}
                    onSelect={setDefSubInId}
                    roster={roster.filter((r) => r.id !== defSubOutId)}
                  />
                  <PositionPickerSection
                    label="New position (optional)"
                    selectedAbbr={defSubPosition}
                    onSelect={setDefSubPosition}
                    optional
                  />
                </>
              )}

              {subModal === 'position_change' && (
                <>
                  <PlayerPickerSection
                    label="Player"
                    selectedId={defSubOutId}
                    onSelect={setDefSubOutId}
                    roster={roster}
                  />
                  <PositionPickerSection
                    label="New position"
                    selectedAbbr={defSubPosition}
                    onSelect={setDefSubPosition}
                  />
                </>
              )}
            </ScrollView>

            {(subModal === 'defensive' || subModal === 'position_change') && (
              <View className="flex-row gap-3 mt-4">
                <TouchableOpacity
                  className={`flex-1 rounded-xl py-3 items-center ${
                    (subModal === 'defensive' ? defSubOutId && defSubInId : defSubOutId && defSubPosition)
                      ? 'bg-gray-900'
                      : 'bg-gray-300'
                  }`}
                  disabled={
                    subModal === 'defensive'
                      ? !defSubOutId || !defSubInId
                      : !defSubOutId || !defSubPosition
                  }
                  onPress={subModal === 'defensive' ? submitDefensiveSub : submitPositionChange}
                >
                  <Text className="text-slate-800 font-semibold">Record</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity className="mt-3 py-3 items-center" onPress={() => setSubModal(null)}>
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Out picker — two-step:
       *   Step 1: trajectory of the batted-ball out
       *   Step 2: was it a sacrifice (fly / bunt) or a regular out?
       *  Step 2 lets the scorer upgrade the play after seeing how it unfolded
       *  (e.g. tapped Flyout, then realized the runner from 3rd scored). */}
      <Modal
        visible={showOutModal}
        transparent
        animationType="slide"
        onRequestClose={closeOutModal}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            {pendingOutType === null ? (
              <>
                <Text className="text-lg font-bold text-gray-900 mb-1">Out</Text>
                <Text className="text-sm text-gray-500 mb-4">
                  How was the batter retired?
                </Text>

                <View className="gap-3">
                  <TouchableOpacity className="bg-white border border-slate-300 rounded-xl px-5 py-4" onPress={() => handleOutPick('groundout')}>
                    <Text className="text-slate-800 font-semibold">Groundout</Text>
                  </TouchableOpacity>
                  <TouchableOpacity className="bg-white border border-slate-300 rounded-xl px-5 py-4" onPress={() => handleOutPick('flyout')}>
                    <Text className="text-slate-800 font-semibold">Flyout</Text>
                  </TouchableOpacity>
                  <TouchableOpacity className="bg-white border border-slate-300 rounded-xl px-5 py-4" onPress={() => handleOutPick('lineout')}>
                    <Text className="text-slate-800 font-semibold">Lineout</Text>
                  </TouchableOpacity>
                  <TouchableOpacity className="bg-white border border-slate-300 rounded-xl px-5 py-4" onPress={() => handleOutPick('popout')}>
                    <Text className="text-slate-800 font-semibold">Popout</Text>
                  </TouchableOpacity>
                  <TouchableOpacity className="bg-white border border-slate-300 rounded-xl px-5 py-4" onPress={() => handleOutPick('other')}>
                    <Text className="text-slate-800 font-semibold">Other</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity className="mt-4 py-3 items-center" onPress={closeOutModal}>
                  <Text className="text-gray-500 font-semibold">Cancel</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text className="text-lg font-bold text-gray-900 mb-1">
                  {outTypeLabel(pendingOutType)} — sacrifice?
                </Text>
                <Text className="text-sm text-gray-500 mb-4">
                  Tag this {outTypeLabel(pendingOutType).toLowerCase()} as a
                  sacrifice fly or bunt, or record it as a regular out.
                </Text>

                <View className="gap-3">
                  <TouchableOpacity
                    className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                    onPress={confirmRegularOut}
                  >
                    <Text className="text-slate-800 font-semibold">Regular out</Text>
                    <Text className="text-slate-500 text-xs mt-0.5">
                      Records a normal {outTypeLabel(pendingOutType).toLowerCase()} (counts as an at-bat)
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                    onPress={confirmSacFlyFromOut}
                  >
                    <Text className="text-slate-800 font-semibold">Sacrifice fly</Text>
                    <Text className="text-slate-500 text-xs mt-0.5">
                      Runner scored from 3rd on the catch — PA but not an AB
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                    onPress={confirmSacBuntFromOut}
                  >
                    <Text className="text-slate-800 font-semibold">Sacrifice bunt</Text>
                    <Text className="text-slate-500 text-xs mt-0.5">
                      Bunt out that intentionally advanced a runner — PA but not an AB
                    </Text>
                  </TouchableOpacity>
                </View>

                <View className="flex-row justify-between items-center mt-4">
                  <TouchableOpacity className="py-3" onPress={() => setPendingOutType(null)}>
                    <Text className="text-gray-500 font-semibold">← Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity className="py-3" onPress={closeOutModal}>
                    <Text className="text-gray-500 font-semibold">Cancel</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Fielder's choice: scorer picks which runner was forced out */}
      <Modal
        visible={showFCModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFCModal(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">
              Fielder's Choice
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              Which runner was retired? Batter reaches first base.
            </Text>

            <View className="gap-3">
              {runnersOnBase.map(({ base, runnerId }) => (
                <TouchableOpacity
                  key={base}
                  className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                  onPress={() => handleFCPick(runnerId, base)}
                >
                  <Text className="text-slate-800 font-semibold">
                    Runner on {baseLabel(base)} retired
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              className="mt-4 py-3 items-center"
              onPress={() => setShowFCModal(false)}
            >
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Runner thrown out advancing — records BASERUNNER_OUT for the
       *  picked runner. Use after a play (hit, sac, wild pitch, etc.)
       *  when a runner was thrown out trying to take an extra base. */}
      <Modal
        visible={showRunnerOutModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRunnerOutModal(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">
              Runner Thrown Out
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              Which runner was thrown out advancing during the play?
            </Text>

            <View className="gap-3">
              {runnersOnBase.map(({ base, runnerId }) => (
                <TouchableOpacity
                  key={base}
                  className="bg-white border border-slate-300 rounded-xl px-5 py-4"
                  onPress={() => handleRunnerOutPick(runnerId, base)}
                >
                  <Text className="text-slate-800 font-semibold">
                    Runner on {baseLabel(base)} thrown out
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              className="mt-4 py-3 items-center"
              onPress={() => setShowRunnerOutModal(false)}
            >
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Per-runner outcomes prompt for 2B/3B with runners on base.
       *  Records the HIT plus any linked BASERUNNER_OUT / BASERUNNER_ADVANCE
       *  events (via relatedEventId) so the platform shows e.g.
       *  "Double (Runner from 2nd held at 3B)" in the play feed. */}
      <Modal
        visible={pendingHitWithRunners !== null}
        transparent
        animationType="slide"
        onRequestClose={cancelHitWithRunners}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">
              {pendingHitWithRunners === HitType.TRIPLE ? 'Triple' : 'Double'} — Runner Outcomes
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              For each runner on base, choose what happened. Default is the
              standard advance.
            </Text>

            <ScrollView className="max-h-96">
              {runnersOnBase.map(({ base, runnerId }) => {
                const choice = runnerOutcomeChoices[runnerId];
                const kind = choice?.kind ?? 'auto';
                // "Held" only makes sense when the runner could stop short
                // of the default end base. A runner on 3B has no shorter
                // advance than scoring, so we suppress that option.
                const canHold = base === 1 || base === 2;
                return (
                  <View key={runnerId} className="mb-4 border border-gray-200 rounded-xl p-3">
                    <Text className="text-sm font-semibold text-gray-700 mb-2">
                      Runner on {baseLabel(base)}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      <TouchableOpacity
                        className={`px-3 py-2 rounded-lg ${kind === 'auto' ? 'bg-slate-700' : 'bg-slate-100'}`}
                        onPress={() => setRunnerChoice(runnerId, base, 'auto')}
                      >
                        <Text className={kind === 'auto' ? 'text-white font-semibold' : 'text-gray-700'}>
                          Advanced as expected
                        </Text>
                      </TouchableOpacity>
                      {canHold && (
                        <TouchableOpacity
                          className={`px-3 py-2 rounded-lg ${kind === 'held' ? 'bg-amber-600' : 'bg-slate-100'}`}
                          onPress={() => setRunnerChoice(runnerId, base, 'held')}
                        >
                          <Text className={kind === 'held' ? 'text-white font-semibold' : 'text-gray-700'}>
                            Held at {base === 1 ? '2B' : '3B'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        className={`px-3 py-2 rounded-lg ${kind === 'thrown_out' ? 'bg-rose-700' : 'bg-slate-100'}`}
                        onPress={() => setRunnerChoice(runnerId, base, 'thrown_out')}
                      >
                        <Text className={kind === 'thrown_out' ? 'text-white font-semibold' : 'text-gray-700'}>
                          Thrown out
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              className="bg-slate-800 rounded-xl px-5 py-4 mt-2"
              onPress={confirmHitWithRunners}
            >
              <Text className="text-white font-semibold text-center">
                Confirm {pendingHitWithRunners === HitType.TRIPLE ? 'Triple' : 'Double'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="mt-2 py-3 items-center"
              onPress={cancelHitWithRunners}
            >
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/**
 * A primary pitch outcome. Deliberately oversized: these are tapped dozens
 * of times a game, often one-handed, outdoors, without looking down for
 * long. Big target and high-contrast fill beat visual restraint here.
 */
/**
 * Tinted surfaces rather than saturated fills: the buttons still read at a
 * glance and keep their semantic colour (safe / strike / neither), but sit
 * quietly next to the rest of the app's white-card UI.
 */
const TONES = {
  ball: { box: 'bg-emerald-50 border-emerald-300', text: 'text-emerald-900' },
  foul: { box: 'bg-amber-50 border-amber-300', text: 'text-amber-900' },
  strike: { box: 'bg-rose-50 border-rose-300', text: 'text-rose-900' },
  inPlay: { box: 'bg-slate-100 border-slate-400', text: 'text-slate-900' },
} as const;

function PrimaryAction({
  label,
  caption,
  tone,
  onPress,
  full,
}: {
  label: string;
  caption?: string;
  tone: keyof typeof TONES;
  onPress: () => void;
  /** Full-width row of its own. Without this the button uses flex-1 to share
   *  a row; as a lone child of the column that would instead make it grow and
   *  shrink vertically, squashing the label out of view. */
  full?: boolean;
}) {
  const { box, text } = TONES[tone];
  return (
    <TouchableOpacity
      className={`${box} border ${full ? 'w-full' : 'flex-1'} rounded-2xl py-4 items-center justify-center`}
      activeOpacity={0.7}
      onPress={onPress}
    >
      <Text className={`${text} text-lg font-bold tracking-tight`}>{label}</Text>
      {caption ? (
        <Text className={`${text} opacity-60 text-[11px] mt-0.5`}>{caption}</Text>
      ) : null}
    </TouchableOpacity>
  );
}

/** Opens one of the infrequent-action sheets. Quiet by design. */
function BranchButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      className="flex-1 bg-white border border-slate-300 rounded-xl py-3 items-center"
      onPress={onPress}
    >
      <Text className="text-slate-700 font-semibold text-sm">{label}</Text>
    </TouchableOpacity>
  );
}

/** Bottom sheet used by the branch actions. */
function ActionSheet({
  visible,
  title,
  subtitle,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/50">
        <View className="bg-white rounded-t-2xl" style={{ maxHeight: '85%' }}>
          <View className="px-5 pt-5 pb-3">
            <Text className="text-xl font-bold text-slate-900">{title}</Text>
            {subtitle ? (
              <Text className="text-sm text-slate-500 mt-0.5">{subtitle}</Text>
            ) : null}
          </View>
          {/* flexShrink is required — RN defaults it to 0, which would push
              the Close button outside the sheet's maxHeight. */}
          <ScrollView className="px-5" style={{ flexShrink: 1 }}>
            {children}
          </ScrollView>
          <TouchableOpacity
            className="px-5 pt-3 pb-8 items-center border-t border-slate-200"
            onPress={onClose}
          >
            <Text className="text-slate-500 font-semibold">Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Labelled group inside a sheet. */
function SheetGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="mb-5">
      <Text className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
        {label}
      </Text>
      {children}
    </View>
  );
}

/**
 * 3x3 strike zone from the catcher's view. Cells are numbered 1-9 left to
 * right, top to bottom (1 = up-and-in to a RHB, 9 = down-and-away), matching
 * the web scorer's `zoneLocation` encoding so both clients write the same
 * shape. 0 means the pitch missed the zone.
 */
function StrikeZoneGrid({
  selected,
  onSelect,
}: {
  selected: number | null;
  onSelect: (zone: number | null) => void;
}) {
  const rows = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ];
  return (
    <View className="flex-row items-start gap-3">
      <View className="border-2 border-gray-400 rounded-md overflow-hidden">
        {rows.map((row) => (
          <View key={row[0]} className="flex-row">
            {row.map((zone) => {
              const isSelected = selected === zone;
              return (
                <TouchableOpacity
                  key={zone}
                  accessibilityLabel={`Strike zone ${zone}`}
                  className={`w-12 h-12 items-center justify-center border border-gray-300 ${
                    isSelected ? 'bg-blue-600' : 'bg-white'
                  }`}
                  onPress={() => onSelect(isSelected ? null : zone)}
                >
                  <Text
                    className={`text-xs font-semibold ${
                      isSelected ? 'text-white' : 'text-gray-400'
                    }`}
                  >
                    {zone}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
      <TouchableOpacity
        className={`rounded-lg px-3 py-2 border ${
          selected === 0 ? 'bg-slate-800 border-slate-900' : 'bg-white border-gray-300'
        }`}
        onPress={() => onSelect(selected === 0 ? null : 0)}
      >
        <Text
          className={`text-xs font-semibold ${
            selected === 0 ? 'text-white' : 'text-gray-700'
          }`}
        >
          Outside zone
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function baseLabel(base: Base): string {
  switch (base) {
    case 1: return '1st';
    case 2: return '2nd';
    case 3: return '3rd';
  }
}

function outTypeLabel(outType: BattedOutType): string {
  switch (outType) {
    case 'groundout': return 'Groundout';
    case 'flyout':    return 'Flyout';
    case 'lineout':   return 'Lineout';
    case 'popout':    return 'Popout';
    case 'other':     return 'Out';
  }
}

function OutcomeButton({
  label,
  emoji,
  onPress,
  color,
}: {
  label: string;
  emoji: string;
  onPress: () => void;
  color: string;
}) {
  // The caller's colour is kept as a small accent rather than a full fill, so
  // a sheet of a dozen options reads as one calm list instead of a paintbox
  // while each option still keeps its identifying colour.
  return (
    <TouchableOpacity
      className="bg-white border border-slate-300 rounded-xl px-4 py-3 flex-row items-center gap-2.5"
      onPress={onPress}
    >
      <View className={`${color} w-2.5 h-2.5 rounded-full`} />
      <Text className="text-slate-800 font-semibold">{label}</Text>
      <Text className="text-slate-400 text-xs">{emoji}</Text>
    </TouchableOpacity>
  );
}

function PlayerPickerSection({
  label,
  selectedId,
  onSelect,
  roster,
}: {
  label: string;
  selectedId: string;
  onSelect: (id: string) => void;
  roster: RosterPlayer[];
}) {
  return (
    <View className="mb-4">
      <Text className="text-xs text-gray-400 uppercase tracking-wide mb-1.5">{label}</Text>
      {roster.length === 0 ? (
        <Text className="text-gray-500 text-sm py-2">No players available.</Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {roster.map((p) => {
            const selected = p.id === selectedId;
            return (
              <TouchableOpacity
                key={p.id}
                onPress={() => onSelect(p.id)}
                className={`rounded-lg px-3 py-2 border ${
                  selected ? 'bg-brand-700 border-brand-500' : 'bg-white border-gray-300'
                }`}
              >
                <Text className={`text-sm font-medium ${selected ? 'text-white' : 'text-gray-700'}`}>
                  {p.jerseyNumber !== undefined ? `#${p.jerseyNumber} ` : ''}
                  {p.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

function PositionPickerSection({
  label,
  selectedAbbr,
  onSelect,
  optional,
}: {
  label: string;
  selectedAbbr: string;
  onSelect: (abbr: string) => void;
  optional?: boolean;
}) {
  const positions = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
  return (
    <View className="mb-4">
      <Text className="text-xs text-gray-400 uppercase tracking-wide mb-1.5">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {optional && (
          <TouchableOpacity
            onPress={() => onSelect('')}
            className={`rounded-lg px-3 py-2 border ${
              selectedAbbr === '' ? 'bg-gray-700 border-gray-800' : 'bg-white border-gray-300'
            }`}
          >
            <Text className={`text-sm font-medium ${selectedAbbr === '' ? 'text-white' : 'text-gray-500'}`}>
              keep
            </Text>
          </TouchableOpacity>
        )}
        {positions.map((p) => {
          const selected = p === selectedAbbr;
          return (
            <TouchableOpacity
              key={p}
              onPress={() => onSelect(p)}
              className={`rounded-lg px-3 py-2 border ${
                selected ? 'bg-brand-700 border-brand-500' : 'bg-white border-gray-300'
              }`}
            >
              <Text className={`text-sm font-semibold ${selected ? 'text-white' : 'text-gray-700'}`}>
                {p}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}
