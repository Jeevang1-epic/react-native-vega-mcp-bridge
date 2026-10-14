import { VegaMcpOverlayCard, VegaMcpActionItem } from "../types/protocol.js";

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
  private state: FocusStateSnapshot = {
    activeCardId: null,
    focusedActionId: null,
    previousTvElementId: null,
    focusLockedInsideOverlay: false
  };

  public presentOverlay(card: VegaMcpOverlayCard, currentTvElementId: string): FocusStateSnapshot {
    const primaryAction =
      card.actions.find((a) => a.isPrimaryFocus) ?? card.actions[0];

    this.state = {
      activeCardId: card.cardId,
      focusedActionId: primaryAction ? primaryAction.id : null,
      previousTvElementId: currentTvElementId,
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

  public dismissOverlay(): { restoredElementId: string | null; snapshot: FocusStateSnapshot } {
    const restoredElementId = this.state.previousTvElementId;
    this.state = {
      activeCardId: null,
      focusedActionId: null,
      previousTvElementId: null,
      focusLockedInsideOverlay: false
    };
    return { restoredElementId, snapshot: { ...this.state } };
  }
}
