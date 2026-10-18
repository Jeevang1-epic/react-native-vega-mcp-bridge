import { VegaMcpOverlayCard, VegaMcpActionItem, VegaMcpOverlayCardSchema } from "../types/protocol.js";

export interface PlaybackPosition { currentTime: number; timelineId: string }
export interface PlaybackBookmark { readonly seconds: number; readonly timelineId: string }
export interface CatchUpWindow { startSeconds: number; endSeconds: number; durationSeconds: number; timelineId: string }
function validatePosition(position: PlaybackPosition): void {
  if (!Number.isFinite(position.currentTime) || position.currentTime < 0 || !position.timelineId.trim()) throw new Error("Playback requires a finite nonnegative position and timeline ID");
}
/** Pass the MSE/EME player's media currentTime, not wall-clock time or the live edge. */
export function captureInterruptionTimestamp(position: PlaybackPosition): PlaybackBookmark {
  validatePosition(position);
  return Object.freeze({ seconds: position.currentTime, timelineId: position.timelineId });
}
export function computeCatchUpWindow(bookmark: PlaybackBookmark, position: PlaybackPosition): CatchUpWindow {
  validatePosition(position);
  validatePosition({ currentTime: bookmark.seconds, timelineId: bookmark.timelineId });
  if (bookmark.timelineId !== position.timelineId || position.currentTime < bookmark.seconds) throw new Error("Playback timeline changed; exact catch-up is unavailable");
  return { startSeconds: bookmark.seconds, endSeconds: position.currentTime, durationSeconds: position.currentTime - bookmark.seconds, timelineId: bookmark.timelineId };
}

export interface FocusStateSnapshot {
  activeCardId: string | null;
  focusedActionId: string | null;
  previousTvElementId: string | null;
  focusLockedInsideOverlay: boolean;
}

/**
 * Deterministic focus state machine for React Native for Vega (TVFocusGuideView / FocusManager).
 * Ensures D-pad focus transitions cleanly into PiP overlays and restores media player focus on dismiss.
 */
export class VegaFocusCoordinator {
  private bookmark: PlaybackBookmark | null = null;
  private state: FocusStateSnapshot = {
    activeCardId: null,
    focusedActionId: null,
    previousTvElementId: null,
    focusLockedInsideOverlay: false
  };

  public presentOverlay(card: VegaMcpOverlayCard, currentTvElementId: string, playback?: PlaybackPosition): FocusStateSnapshot {
    card = VegaMcpOverlayCardSchema.parse(card);
    if (!currentTvElementId.trim()) throw new Error("Focus restoration requires an element ID");
    if (!this.state.focusLockedInsideOverlay) this.bookmark = playback ? captureInterruptionTimestamp(playback) : null;
    const primaryAction =
      card.actions.find((a) => a.isPrimaryFocus) ?? card.actions[0];

    this.state = {
      activeCardId: card.cardId,
      focusedActionId: primaryAction ? primaryAction.id : null,
      previousTvElementId: this.state.previousTvElementId ?? currentTvElementId,
      focusLockedInsideOverlay: true
    };
    return { ...this.state };
  }

  public moveFocusNext(actions: VegaMcpActionItem[]): FocusStateSnapshot {
    if (!this.state.focusLockedInsideOverlay || actions.length === 0) {
      return { ...this.state };
    }
    const currentIndex = actions.findIndex((a) => a.id === this.state.focusedActionId);
    const nextIndex = (currentIndex + 1) % actions.length;
    this.state.focusedActionId = actions[nextIndex].id;
    return { ...this.state };
  }

  public captureInterruptionTimestamp(position: PlaybackPosition): PlaybackBookmark {
    if (!this.bookmark) this.bookmark = captureInterruptionTimestamp(position);
    return { ...this.bookmark };
  }

  public computeCatchUpWindow(position: PlaybackPosition): CatchUpWindow | null {
    return this.bookmark ? computeCatchUpWindow(this.bookmark, position) : null;
  }

  public dismissOverlay(playback?: PlaybackPosition): { restoredElementId: string | null; snapshot: FocusStateSnapshot; catchUpWindow: CatchUpWindow | null; catchUpUnavailable: boolean } {
    const restoredElementId = this.state.previousTvElementId;
    let catchUpWindow: CatchUpWindow | null = null;
    let catchUpUnavailable = false;
    if (this.bookmark) {
      if (!playback) catchUpUnavailable = true;
      else { try { catchUpWindow = computeCatchUpWindow(this.bookmark, playback); } catch { catchUpUnavailable = true; } }
    }
    this.bookmark = null;
    this.state = {
      activeCardId: null,
      focusedActionId: null,
      previousTvElementId: null,
      focusLockedInsideOverlay: false
    };
    return { restoredElementId, snapshot: { ...this.state }, catchUpWindow, catchUpUnavailable };
  }
}
