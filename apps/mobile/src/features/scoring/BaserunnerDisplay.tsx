import { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { AdvanceReason } from '@baseball/shared';
import type { LiveGameState } from '@baseball/shared';

type Base = 1 | 2 | 3;

interface RosterPlayer {
  id: string;
  name: string;
  jerseyNumber?: number;
}

interface BaserunnerDisplayProps {
  gameState: LiveGameState;
  onRecordStolenBase?: (fromBase: Base, runnerId: string) => void;
  onRecordCaughtStealing?: (fromBase: Base, runnerId: string) => void;
  onRecordAdvance?: (fromBase: Base, runnerId: string, reason: AdvanceReason) => void;
  onRecordPickoffOut?: (fromBase: Base, runnerId: string) => void;
  onRecordPinchRunner?: (fromBase: Base, outRunnerId: string, inRunnerId: string) => void;
  onRecordCourtesyRunner?: (fromBase: Base, outRunnerId: string, inRunnerId: string) => void;
  roster?: RosterPlayer[];
  /**
   * Short identifier for the runner on a base — a jersey number where we have
   * one. Without it the diamond says someone is on second but not who, which
   * is the one thing the scorer needs when deciding whether to send them.
   */
  runnerShortLabel?: (runnerId: string) => string;
  /** Full name, for the action sheet's title. */
  runnerName?: (runnerId: string) => string;
}

const DIAMOND_SIZE = 116;

/**
 * Renders a baseball diamond with filled bases for occupied runners.
 * Tapping an occupied base opens an action modal for baserunning events
 * (stolen base, caught stealing, advance on wild pitch / passed ball).
 */
export function BaserunnerDisplay({
  gameState,
  onRecordStolenBase,
  onRecordCaughtStealing,
  onRecordAdvance,
  onRecordPickoffOut,
  onRecordPinchRunner,
  onRecordCourtesyRunner,
  roster,
  runnerShortLabel,
  runnerName,
}: BaserunnerDisplayProps) {
  const { first, second, third } = gameState.runnersOnBase;
  const [selected, setSelected] = useState<{ base: Base; runnerId: string } | null>(null);
  const [pinchRunnerPicker, setPinchRunnerPicker] = useState<{
    base: Base;
    runnerId: string;
    courtesy: boolean;
  } | null>(null);

  const interactive = !!(onRecordStolenBase || onRecordCaughtStealing || onRecordAdvance || onRecordPickoffOut || onRecordPinchRunner || onRecordCourtesyRunner);

  function handleBaseTap(base: Base, runnerId: string | null) {
    if (!interactive || !runnerId) return;
    setSelected({ base, runnerId });
  }

  function close() {
    setSelected(null);
  }

  function handleSteal() {
    if (!selected) return;
    onRecordStolenBase?.(selected.base, selected.runnerId);
    close();
  }

  function handleCaughtStealing() {
    if (!selected) return;
    onRecordCaughtStealing?.(selected.base, selected.runnerId);
    close();
  }

  function handleAdvance(reason: AdvanceReason) {
    if (!selected) return;
    onRecordAdvance?.(selected.base, selected.runnerId, reason);
    close();
  }

  function handlePickoffOut() {
    if (!selected) return;
    onRecordPickoffOut?.(selected.base, selected.runnerId);
    close();
  }

  function handlePinchRunnerStart() {
    if (!selected) return;
    setPinchRunnerPicker({ base: selected.base, runnerId: selected.runnerId, courtesy: false });
    close();
  }

  function handleCourtesyRunnerStart() {
    if (!selected) return;
    setPinchRunnerPicker({ base: selected.base, runnerId: selected.runnerId, courtesy: true });
    close();
  }

  function handlePinchRunnerPick(inRunnerId: string) {
    if (!pinchRunnerPicker) return;
    if (pinchRunnerPicker.courtesy) {
      onRecordCourtesyRunner?.(pinchRunnerPicker.base, pinchRunnerPicker.runnerId, inRunnerId);
    } else {
      onRecordPinchRunner?.(pinchRunnerPicker.base, pinchRunnerPicker.runnerId, inRunnerId);
    }
    setPinchRunnerPicker(null);
  }

  return (
    <View
      className="items-center justify-center"
      style={{ width: DIAMOND_SIZE, height: DIAMOND_SIZE }}
    >
      <View className="relative" style={{ width: 96, height: 96 }}>
        <BaseTap
          base={2}
          runnerId={second}
          style={{ top: 0, left: 34 }}
          onPress={handleBaseTap}
          interactive={interactive}
          label={second ? runnerShortLabel?.(second) : undefined}
        />
        <BaseTap
          base={3}
          runnerId={third}
          style={{ top: 34, left: 0 }}
          onPress={handleBaseTap}
          interactive={interactive}
          label={third ? runnerShortLabel?.(third) : undefined}
        />
        <BaseTap
          base={1}
          runnerId={first}
          style={{ top: 34, left: 68 }}
          onPress={handleBaseTap}
          interactive={interactive}
          label={first ? runnerShortLabel?.(first) : undefined}
        />
        {/* Home plate — bottom center (indicator only) */}
        <View
          className="absolute w-4 h-4 bg-gray-300 rotate-45"
          style={{ bottom: 0, left: 40 }}
        />
      </View>

      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={close}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5">
            <Text className="text-lg font-bold text-gray-900 mb-1">
              {selected
                ? `${runnerName?.(selected.runnerId) ?? 'Runner'} on ${baseLabel(selected.base)}`
                : ''}
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              What just happened to this runner?
            </Text>

            <View className="gap-3">
              {onRecordStolenBase && (
                <RunnerActionButton
                  label="Stolen Base"
                  sub={selected ? `Advances to ${baseLabel((selected.base + 1) as 2 | 3 | 4)}` : ''}
                  color="bg-blue-600"
                  onPress={handleSteal}
                />
              )}
              {onRecordCaughtStealing && (
                <RunnerActionButton
                  label="Caught Stealing"
                  sub="Runner is out"
                  color="bg-red-600"
                  onPress={handleCaughtStealing}
                />
              )}
              {onRecordAdvance && (
                <>
                  <RunnerActionButton
                    label="Advance on Wild Pitch"
                    sub={selected ? `Advances to ${baseLabel((selected.base + 1) as 2 | 3 | 4)}` : ''}
                    color="bg-amber-600"
                    onPress={() => handleAdvance(AdvanceReason.WILD_PITCH)}
                  />
                  <RunnerActionButton
                    label="Advance on Passed Ball"
                    sub={selected ? `Advances to ${baseLabel((selected.base + 1) as 2 | 3 | 4)}` : ''}
                    color="bg-yellow-600"
                    onPress={() => handleAdvance(AdvanceReason.PASSED_BALL)}
                  />
                </>
              )}
              {onRecordPickoffOut && (
                <RunnerActionButton
                  label="Picked Off"
                  sub="Runner is out on pickoff throw"
                  color="bg-gray-700"
                  onPress={handlePickoffOut}
                />
              )}
              {onRecordPinchRunner && roster && roster.length > 0 && (
                <RunnerActionButton
                  label="Pinch Runner"
                  sub="Replace this runner with a new player"
                  color="bg-sky-700"
                  onPress={handlePinchRunnerStart}
                />
              )}
              {onRecordCourtesyRunner && roster && roster.length > 0 && (
                <RunnerActionButton
                  label="Courtesy Runner"
                  sub="Replace a catcher or pitcher without a regular sub"
                  color="bg-emerald-700"
                  onPress={handleCourtesyRunnerStart}
                />
              )}
            </View>

            <TouchableOpacity className="mt-4 py-3 items-center" onPress={close}>
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Pinch runner: pick incoming player from roster */}
      <Modal
        visible={!!pinchRunnerPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setPinchRunnerPicker(null)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white rounded-t-2xl px-5 pb-8 pt-5" style={{ maxHeight: '75%' }}>
            <Text className="text-lg font-bold text-gray-900 mb-1">
              {pinchRunnerPicker?.courtesy ? 'Courtesy Runner' : 'Pinch Runner'}
            </Text>
            <Text className="text-sm text-gray-500 mb-4">
              Select the new runner for {pinchRunnerPicker ? baseLabel(pinchRunnerPicker.base) : ''}.
            </Text>
            {roster && roster.length > 0 ? (
              <ScrollView className="max-h-96">
                <View className="gap-2">
                  {roster.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      className="bg-sky-700 rounded-xl px-4 py-3"
                      onPress={() => handlePinchRunnerPick(p.id)}
                    >
                      <Text className="text-white font-semibold text-base">
                        {p.jerseyNumber !== undefined ? `#${p.jerseyNumber} ` : ''}
                        {p.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            ) : (
              <Text className="text-gray-500 text-sm py-4">No players loaded.</Text>
            )}
            <TouchableOpacity className="mt-4 py-3 items-center" onPress={() => setPinchRunnerPicker(null)}>
              <Text className="text-gray-500 font-semibold">Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function baseLabel(base: 1 | 2 | 3 | 4): string {
  switch (base) {
    case 1: return '1st';
    case 2: return '2nd';
    case 3: return '3rd';
    case 4: return 'home';
  }
}

function BaseTap({
  base,
  runnerId,
  style,
  onPress,
  interactive,
  label,
}: {
  base: Base;
  runnerId: string | null;
  style: object;
  onPress: (base: Base, runnerId: string | null) => void;
  interactive: boolean;
  label?: string;
}) {
  const occupied = !!runnerId;
  const fill = occupied
    ? 'bg-amber-300 border-2 border-amber-500'
    : 'bg-gray-200 border-2 border-gray-300';
  // The base is drawn rotated 45°; the label inside has to be turned back or
  // it reads on the diagonal.
  const content = occupied && label ? (
    <View className="flex-1 items-center justify-center -rotate-45">
      <Text className="text-[10px] font-bold text-amber-900" numberOfLines={1}>
        {label}
      </Text>
    </View>
  ) : null;

  if (!interactive || !occupied) {
    return (
      <View className={`absolute w-7 h-7 rotate-45 ${fill}`} style={style}>
        {content}
      </View>
    );
  }

  return (
    <TouchableOpacity
      className={`absolute w-7 h-7 rotate-45 ${fill}`}
      style={style}
      onPress={() => onPress(base, runnerId)}
    >
      {content}
    </TouchableOpacity>
  );
}

function RunnerActionButton({
  label,
  sub,
  color,
  onPress,
}: {
  label: string;
  sub: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity className={`${color} rounded-xl px-5 py-4`} onPress={onPress}>
      <Text className="text-white font-semibold">{label}</Text>
      {sub ? <Text className="text-white/70 text-xs mt-0.5">{sub}</Text> : null}
    </TouchableOpacity>
  );
}
