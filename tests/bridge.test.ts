import { describe, it, expect } from "vitest";
import {
  BeeTodoWriteSchema,
  BeeTodoResponseSchema,
  VegaMcpOverlayCardSchema,
  buildRingWhepEndpoint,
  assertValidRingWhepSdpOffer,
  VegaFocusCoordinator
} from "../src/index.js";

describe("react-native-vega-mcp-bridge verification suite", () => {
  it("normalizes Bee /v1/todos alarm_at between ISO-8601 writes and epoch ms reads", () => {
    const writePayload = BeeTodoWriteSchema.parse({
      text: "Verify cold-chain insulin delivery at front door",
      alarm_at: 1791984600000
    });
    expect(writePayload.alarm_at).toBe("2026-10-14T13:30:00.000Z");

    const readPayload = BeeTodoResponseSchema.parse({
      id: "todo_991",
      text: "Verify cold-chain insulin delivery at front door",
      alarm_at: 1791984600000
    });
    expect(readPayload.alarm_at.isoString).toBe("2026-10-14T13:30:00.000Z");
  });

  it("enforces Ring WHEP video-only recvonly SDP invariants", () => {
    const endpoint = buildRingWhepEndpoint({
      deviceId: "ring-front-door-01",
      bearerToken: "rk_live_987654"
    });
    expect(endpoint.whepUrl).toContain("/v1/devices/ring-front-door-01/media/streaming/whep/sessions");

    expect(() =>
      assertValidRingWhepSdpOffer("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n")
    ).not.toThrow();

    expect(() =>
      assertValidRingWhepSdpOffer("v=0\r\nm=video 9\r\nm=audio 9\r\na=recvonly\r\n")
    ).toThrow(/m=audio/);
  });

  it("locks and restores 10-foot D-pad focus across MCP PiP lifecycle", () => {
    const coordinator = new VegaFocusCoordinator();
    const card = VegaMcpOverlayCardSchema.parse({
      cardId: "card_01",
      title: "Pharmacy Delivery Arrived",
      subtitle: "Matched with 2:15 PM Bee voice note",
      severity: "caretaking",
      actions: [
        { id: "act_1", label: "Unlock Drop-Box", mcpToolName: "unlock_box", arguments: {}, isPrimaryFocus: true },
        { id: "act_2", label: "Dismiss & Bookmark", mcpToolName: "bookmark_tv", arguments: {}, isPrimaryFocus: false }
      ]
    });

    const presented = coordinator.presentOverlay(card, "shaka-player-controls");
    expect(presented.focusedActionId).toBe("act_1");
    expect(presented.focusLockedInsideOverlay).toBe(true);

    const cycled = coordinator.moveFocusNext(card.actions);
    expect(cycled.focusedActionId).toBe("act_2");

    const dismissed = coordinator.dismissOverlay();
    expect(dismissed.restoredElementId).toBe("shaka-player-controls");
    expect(dismissed.snapshot.focusLockedInsideOverlay).toBe(false);
  });
});
