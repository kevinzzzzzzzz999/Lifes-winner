export const replayDisplayModes = ['progressive', 'dimmed'] as const;
export type ReplayDisplayMode = typeof replayDisplayModes[number];
export const futureInkOpacity = 0.18;
export function replayDisplayMode(value: unknown): ReplayDisplayMode {
 return replayDisplayModes.includes(value as ReplayDisplayMode) ? value as ReplayDisplayMode : 'dimmed';
}
export function replayInkOpacity(mode: ReplayDisplayMode, revealed: boolean): number {
 return revealed ? 1 : mode === 'dimmed' ? futureInkOpacity : 0;
}
