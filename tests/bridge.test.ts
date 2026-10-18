import { describe, it, expect, vi } from "vitest";
import {
  buildMcpEnvelope, buildJsonRpcRequest, buildJsonRpcNotification, JsonRpcMessageSchema,
  validateStreamableHttpHeaders, buildVegaCarousel, RingWhepSessionManager,
  BeeSseParser, normalizeBeeFacts, normalizeBeeEvent, normalizeAlarmAt, alarmAtForWrite,
  correlateDeliveries, captureInterruptionTimestamp, computeCatchUpWindow
} from "../src/index.js";
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

const card = VegaMcpOverlayCardSchema.parse({ cardId: "door", title: "Delivery", subtitle: "Front door", severity: "caretaking", actions: [{ id: "dismiss", label: "Dismiss", mcpToolName: "dismiss", arguments: {} }] });
const offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n";
const answer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n";
const base = "https://api.amazonvision.com/v1/devices";
function response(id = "front", status = 201, sdp = answer, location = `${base}/${id}/media/streaming/whep/sessions/one`, contentType = "application/sdp") {
  return { status, headers: { get: (key: string) => key === "location" ? location : key === "content-type" ? contentType : null }, text: async () => sdp };
}
function manager(transport = vi.fn(async () => response())) {
  const sessions = new RingWhepSessionManager(transport);
  sessions.register({ deviceId: "front", bearerToken: "test-token" });
  return { sessions, transport };
}

describe("MCP Apps and transport envelopes", () => {
  it("echoes an issued legacy session ID without injecting modern metadata", () => {
    const envelope = buildMcpEnvelope(buildJsonRpcRequest(0, "tools/list"), { protocolVersion: "2025-11-25", sessionId: "issued-session" });
    expect(envelope.headers["Mcp-Session-Id"]).toBe("issued-session");
    expect(envelope.body.params).toBeUndefined();
    expect(validateStreamableHttpHeaders(envelope.headers)).toBe(true);
  });
  it("builds self-contained stateless tool calls without mutating input", () => {
    const input = buildJsonRpcRequest(1, "tools/call", { name: "show_delivery", _meta: { trace: "abc" } });
    const result = buildMcpEnvelope(input, { protocolVersion: "2026-07-28" });
    expect(result.headers).toMatchObject({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "show_delivery" });
    expect(result.headers).not.toHaveProperty("Mcp-Session-Id");
    expect(result.body.params?._meta).toEqual({ trace: "abc", "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
    expect(input.params?._meta).toEqual({ trace: "abc" });
  });
  it("rejects sessions and initialize in stateless mode", () => {
    expect(() => buildMcpEnvelope(buildJsonRpcRequest(1, "tools/list"), { protocolVersion: "2026-07-28", sessionId: "x" })).toThrow(/session/);
    expect(() => buildMcpEnvelope(buildJsonRpcRequest(1, "initialize"), { protocolVersion: "2026-07-28" })).toThrow(/handshake/);
  });
  it("keeps notifications ID-free and rejects invalid RPC envelopes", () => {
    expect(buildJsonRpcNotification("notifications/progress")).not.toHaveProperty("id");
    expect(JsonRpcMessageSchema.safeParse({ jsonrpc: "1.0", method: "tools/list" }).success).toBe(false);
    expect(() => buildJsonRpcRequest(NaN, "tools/list")).toThrow();
  });
  it("checks exact origins, case-insensitive headers and both accepted media types", () => {
    const headers = { aCcEpT: "application/json, text/event-stream", ORIGIN: "https://alexa.amazon.com" };
    expect(validateStreamableHttpHeaders(headers)).toBe(true);
    expect(() => validateStreamableHttpHeaders({ ...headers, ORIGIN: "https://alexa.amazon.com.evil.test" })).toThrow(/Origin/);
    expect(() => validateStreamableHttpHeaders({ Accept: "application/json, text/event-stream;q=0" })).toThrow(/Accept/);
    expect(() => validateStreamableHttpHeaders({ Accept: "application/json" })).toThrow(/Accept/);
    expect(() => validateStreamableHttpHeaders({ ...headers, accept: "*/*" })).toThrow(/duplicate/);
  });
  it("validates carousel focus identity and supplies ext-apps resource metadata", () => {
    expect(buildVegaCarousel([card], "ui://delivery/carousel.html").toolMeta.ui.resourceUri).toBe("ui://delivery/carousel.html");
    expect(() => buildVegaCarousel([card, card], "ui://delivery/view")).toThrow(/Duplicate/);
    expect(() => buildVegaCarousel([], "ui://delivery/view")).toThrow();
    expect(() => buildVegaCarousel([card], "https://example.com")).toThrow(/ui:/);
  });
});

describe("Ring ICE lifecycle and camera registry", () => {
  it("rejects direction conflicts and SDP substring spoofing", () => {
    expect(() => assertValidRingWhepSdpOffer(offer + "a=sendrecv\r\n")).toThrow(/recvonly/);
    expect(() => assertValidRingWhepSdpOffer("v=0\r\ns=m=video a=recvonly\r\n")).toThrow(/m=video/);
  });
  it("retains trusted session handles for cleanup after malformed answers", async () => {
    const transport = vi.fn(async (_url: string, init: { method: string }) => response("front", init.method === "DELETE" ? 204 : 201, "bad SDP"));
    const sessions = new RingWhepSessionManager(transport);
    sessions.register({ deviceId: "front", bearerToken: "test" });
    sessions.updateIceGatheringState("front", "complete");
    await expect(sessions.connect("front", offer)).rejects.toThrow(/SDP/);
    await sessions.close("front");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sessions.getSession("front").state).toBe("closed");
  });
  it("builds a real HTTPS endpoint and encodes device IDs", () => {
    expect(buildRingWhepEndpoint({ deviceId: "a/b", bearerToken: "test" }).whepUrl).toBe(`${base}/a%2Fb/media/streaming/whep/sessions`);
    expect(() => buildRingWhepEndpoint({ deviceId: "a", bearerToken: "test", endpointBase: "http://example.com" })).toThrow(/HTTPS/);
  });
  it("never posts before ICE complete and rejects backward transitions", async () => {
    const { sessions, transport } = manager();
    await expect(sessions.connect("front", offer)).rejects.toThrow(/complete/);
    sessions.updateIceGatheringState("front", "gathering");
    await expect(sessions.connect("front", offer)).rejects.toThrow(/complete/);
    expect(transport).not.toHaveBeenCalled();
    expect(() => sessions.updateIceGatheringState("front", "new")).toThrow(/transition/);
  });
  it("posts final SDP once, validates answer, and prevents duplicate connects", async () => {
    const { sessions, transport } = manager();
    sessions.updateIceGatheringState("front", "complete");
    const pending = sessions.connect("front", offer);
    await expect(sessions.connect("front", offer)).rejects.toThrow(/complete/);
    expect(await pending).toMatchObject({ state: "connected", answer });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual([`${base}/front/media/streaming/whep/sessions`, expect.objectContaining({ method: "POST", body: offer })]);
  });
  it.each([
    [200, answer, `${base}/front/media/streaming/whep/sessions/one`, "application/sdp"],
    [201, "bad SDP", `${base}/front/media/streaming/whep/sessions/one`, "application/sdp"],
    [201, answer, "https://evil.test/session", "application/sdp"],
    [201, answer, "", "application/sdp"],
    [201, answer, `${base}/front/media/streaming/whep/sessions/one`, "text/plain"]
  ])("marks invalid response %s as failed", async (status, sdp, location, contentType) => {
    const { sessions } = manager(vi.fn(async () => response("front", status as number, sdp as string, location as string, contentType as string)));
    sessions.updateIceGatheringState("front", "complete");
    await expect(sessions.connect("front", offer)).rejects.toThrow();
    expect(sessions.getSession("front").state).toBe("failed");
  });
  it("switches only ready cameras and cleans up selected sessions", async () => {
    const transport = vi.fn(async (url: string, init: { method: string }) => init.method === "DELETE" ? response("front", 204) : response(url.includes("/back/") ? "back" : "front"));
    const sessions = new RingWhepSessionManager(transport);
    for (const deviceId of ["front", "back"]) {
      sessions.register({ deviceId, bearerToken: "test" });
      expect(() => sessions.switchCamera(deviceId)).toThrow(/connected/);
      sessions.updateIceGatheringState(deviceId, "complete");
      await sessions.connect(deviceId, offer);
    }
    sessions.switchCamera("front"); sessions.switchCamera("back");
    expect(sessions.activeCamera).toBe("back");
    const copy = sessions.getSession("front"); copy.state = "closed";
    expect(sessions.getSession("front").state).toBe("connected");
    await sessions.close("back"); await sessions.close("back");
    expect(sessions.activeCamera).toBeNull();
    expect(transport).toHaveBeenCalledTimes(3);
  });
});

describe("Bee normalization", () => {
  it("parses arbitrary chunk splits, CRLF, comments and multiline data", () => {
    const parser = new BeeSseParser();
    const frame = ': heartbeat\r\nevent: new-utterance\r\ndata: {"utterance":{"text":"Parcel expected"},\r\ndata: "conversation_uuid":"c1"}\r\n\r\n';
    const notes = [...frame].flatMap(char => parser.push(char));
    expect(notes).toEqual([{ source: "new-utterance", text: "Parcel expected", conversationId: "c1" }]);
  });
  it("handles todos, summaries, unknown events and discards incomplete EOF frames", () => {
    const parser = new BeeSseParser();
    const notes = parser.push('event: connected\ndata: {}\n\nevent: todo-created\ndata: {"todo":{"id":10,"text":"Collect parcel","alarmAt":1700000000000}}\n\nevent: update-conversation-summary\ndata: {"conversation_id":123,"short_summary":"Parcel tomorrow"}\n\n');
    expect(notes[0].alarmAt?.epochMs).toBe(1700000000000);
    expect(notes[1].conversationId).toBe("123");
    expect(parser.push('event: new-utterance\ndata: {')).toEqual([]);
    parser.end();
    expect(parser.push("\n\n")).toEqual([]);
  });
  it("rejects malformed JSON, invalid event payloads and oversized frames", () => {
    expect(() => new BeeSseParser().push("event: new-utterance\ndata: nope\n\n")).toThrow();
    expect(() => normalizeBeeEvent({ type: "new-utterance", data: {} })).toThrow();
    expect(() => new BeeSseParser(10).push("x".repeat(11))).toThrow(/size/);
  });
  it("normalizes nullable alarms with timezone offsets and rejects invalid ranges", () => {
    expect(alarmAtForWrite("2026-10-18T12:00:00+05:30")).toBe("2026-10-18T06:30:00.000Z");
    expect(normalizeAlarmAt(null)).toBeNull();
    expect(alarmAtForWrite(0)).toBe("1970-01-01T00:00:00.000Z");
    for (const input of [NaN, Infinity, -1, 8640000000000001, "tomorrow", "2026-10-18"]) expect(() => normalizeAlarmAt(input)).toThrow();
  });
  it("normalizes facts and correlates explicit whole-word delivery evidence", () => {
    const facts = normalizeBeeFacts({ facts: [{ id: 1, text: "Expect parcel today", confirmed: true }] });
    expect(facts[0].id).toBe("1");
    expect(correlateDeliveries(facts, [{ id: "d1", keywords: ["PARCEL"] }, { id: "d2", keywords: ["par", ""] }])).toEqual([{ deliveryId: "d1", evidence: ["Expect parcel today"] }]);
    expect(() => normalizeBeeFacts([{ id: "x", text: "" }])).toThrow();
  });
});

describe("Playback bookmarks and focus restoration", () => {
  it("computes exact fractional media seconds for a time-shifted broadcast", () => {
    const bookmark = captureInterruptionTimestamp({ currentTime: 120.25, timelineId: "game" });
    expect(computeCatchUpWindow(bookmark, { currentTime: 151.75, timelineId: "game" })).toEqual({ startSeconds: 120.25, endSeconds: 151.75, durationSeconds: 31.5, timelineId: "game" });
    expect(computeCatchUpWindow(bookmark, { currentTime: 120.25, timelineId: "game" }).durationSeconds).toBe(0);
  });
  it("preserves original player focus and bookmark across camera overlays", () => {
    const focus = new VegaFocusCoordinator();
    focus.presentOverlay(card, "media-player", { currentTime: 10, timelineId: "game" });
    focus.presentOverlay({ ...card, cardId: "back" }, "pip-button", { currentTime: 15, timelineId: "game" });
    const result = focus.dismissOverlay({ currentTime: 25, timelineId: "game" });
    expect(result.restoredElementId).toBe("media-player");
    expect(result.catchUpWindow?.durationSeconds).toBe(15);
    expect(focus.dismissOverlay().restoredElementId).toBeNull();
    expect(focus.computeCatchUpWindow({ currentTime: 30, timelineId: "game" })).toBeNull();
  });
  it("restores focus even when seeking or a timeline change invalidates catch-up", () => {
    const focus = new VegaFocusCoordinator();
    focus.presentOverlay(card, "player", { currentTime: 10, timelineId: "game" });
    expect(focus.dismissOverlay({ currentTime: 5, timelineId: "other" })).toMatchObject({ restoredElementId: "player", catchUpWindow: null, catchUpUnavailable: true });
    expect(() => captureInterruptionTimestamp({ currentTime: NaN, timelineId: "game" })).toThrow();
  });
});
