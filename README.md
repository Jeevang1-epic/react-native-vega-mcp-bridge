# react-native-vega-mcp-bridge

Apache-2.0 TypeScript primitives for 10-foot Fire TV / Vega OS experiences connecting Alexa+ MCP Apps, Ring WHEP video, and Bee household notes. Built for the Amazon Developer Hackathon Open Source Mini-Challenge.

## Architecture

```text
 Bee CLI proxy                  Alexa+ / MCP host
 /v1/stream + /v1/facts          Streamable HTTP JSON-RPC
          |                              |
          v                              v
 +--------------------+        +-----------------------+
 | BeeSseParser       |        | mcpAppsBuilder        |
 | Zod normalization  |------->| cards + UI metadata   |
 | delivery evidence  |        | versioned envelopes   |
 +--------------------+        +-----------+-----------+
                                           |
 Ring Amazon Vision                        v
 WHEP POST / DELETE              +----------------------+
          ^                      | VegaFocusCoordinator |
          |                      | overlay / bookmark   |
 +--------+---------------+      | dismiss / catch-up    |
 | RingWhepSessionManager |----->+-----------+----------+
 | per-camera ICE state   |                  |
 +------------------------+                  v
                              Host React Native application
                              TVFocusGuideView + media player
                              MSE/EME + optional AI summarizer
```

The library builds validated data and deterministic state without a React/native dependency. Adapters own authentication, RTCPeerConnection, native focus refs, playback and AI calls. Carousel cards are application-defined `structuredContent`, not a standardized Alexa card format. MCP Apps compatibility uses `_meta.ui.resourceUri` on a tool definition and a separately registered `ui://` HTML resource.

## Verification

Use Node 24 (see `.nvmrc`):

```sh
npm install
npm test
npm run build
```

On Windows with restricted PowerShell execution, use `npm.cmd`. Vitest uses injected transports and no cloud accounts. Tests cover valid and malformed envelopes, ICE ordering, camera switching, SSE chunk boundaries, timestamps and playback windows. The build emits JavaScript and declarations in `dist/`. Native Vega playback and authenticated Alexa+/Ring/Bee interoperability require separate device integration testing.

## MCP envelopes and carousel cards

```ts
import {
  buildJsonRpcRequest, buildJsonRpcNotification, buildMcpEnvelope,
  buildVegaCarousel, validateStreamableHttpHeaders,
} from "react-native-vega-mcp-bridge";

const call = buildJsonRpcRequest(1, "tools/call", {
  name: "show_delivery", arguments: { deviceId: "front-door" },
});
const modern = buildMcpEnvelope(call, { protocolVersion: "2026-07-28" });
const legacy = buildMcpEnvelope(call, {
  protocolVersion: "2025-11-25", sessionId: "server-issued-session-id",
});
const notification = buildJsonRpcNotification("notifications/progress", {
  progressToken: "delivery", progress: 1, total: 2,
});
validateStreamableHttpHeaders({
  Origin: "https://alexa.amazon.com",
  Accept: "application/json, text/event-stream",
});
const carousel = buildVegaCarousel([{
  cardId: "delivery", title: "Delivery at the door", subtitle: "Expected parcel",
  severity: "caretaking", whepDeviceId: "front-door",
  actions: [{ id: "dismiss", label: "Return to game", mcpToolName: "dismiss",
    arguments: {}, isPrimaryFocus: true }],
}], "ui://delivery/carousel.html");
// registerAppTool(..., { ..., _meta: carousel.toolMeta }, handler)
// handler returns carousel.result; registerAppResource serves the UI HTML.
```

| API | Contract |
| --- | --- |
| `buildJsonRpcRequest` / `buildJsonRpcNotification` | Validated JSON-RPC 2.0; notifications omit `id` |
| `buildMcpEnvelope` | Returns `{ headers, body }`; legacy sessions are optional until issued by the server |
| Stateless envelope | Sets `params._meta["io.modelcontextprotocol/protocolVersion"]`, `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` when `params.name` exists; rejects sessions and initialization handshakes |
| `validateStreamableHttpHeaders` | Checks both accepted media types, duplicate/injected headers, and supplied Origin against an exact allowlist |
| `buildVegaCarousel` / `VegaCarouselSchema` | Nonempty cards/actions, unique IDs, at most one primary action per card |

Supply your deployment's trusted origins as the validator's second argument. Missing Origin is permitted for native clients; a present untrusted Origin is rejected. This ingress check is not authentication. The builder is not a complete MCP server, negotiation engine, or implementation of every protocol extension.

## Ring WHEP and multi-camera PiP

```text
 new --> gathering --> complete --> posting --> connected --> closed
  |_______________________^             |
                                        +----> failed --> closed
 connected(front) <-- switchCamera --> connected(back)
```

```ts
import { RingWhepSessionManager } from "react-native-vega-mcp-bridge";

const cameras = new RingWhepSessionManager((url, init) => fetch(url, init));
cameras.register({ deviceId: "front-door", bearerToken: accessToken });
// Install the listener before createOffer/setLocalDescription.
peer.addEventListener("icegatheringstatechange", () => {
  cameras.updateIceGatheringState("front-door", peer.iceGatheringState);
});
// Wait for complete; use the FINAL localDescription with gathered candidates.
const session = await cameras.connect("front-door", peer.localDescription!.sdp);
await peer.setRemoteDescription({ type: "answer", sdp: session.answer! });
cameras.switchCamera("front-door"); // Host attaches this camera's stream to PiP.
await cameras.close("front-door");
peer.close();
```

`register`, `getSession`, `updateIceGatheringState`, `connect`, `switchCamera`, `activeCamera`, and `close` form the registry API. Duplicate IDs and invalid transitions throw. Each camera needs its own peer. Switching does not destroy another camera's stream. `connected` means HTTP signaling validated; the host must monitor peer connectivity.

POST targets `https://api.amazonvision.com/v1/devices/{deviceId}/media/streaming/whep/sessions`. Offers require one recvonly video section. The response requires 201, SDP content type, a same-origin session Location, and a basic video SDP answer. The peer performs full SDP negotiation. Trusted Location handles survive answer validation failure so callers can DELETE them with `close`. Failed/closed entries are terminal; create a new manager for a fresh lifecycle. Transport adapters should implement timeouts and reject unexpected redirects. Use PiP for non-security caretaking and delivery verification; note matches do not establish identity or authorize access.

## Bee SSE, facts and delivery evidence

```ts
import {
  BEE_STREAM_PATH, BeeSseParser, normalizeBeeFacts,
  normalizeAlarmAt, alarmAtForWrite, correlateDeliveries,
} from "react-native-vega-mcp-bridge";

const parser = new BeeSseParser();
const decoder = new TextDecoder();
// GET proxyBase + BEE_STREAM_PATH; for each Uint8Array chunk:
const notes = parser.push(decoder.decode(chunk, { stream: true }));
const facts = normalizeBeeFacts(await factsResponse.json()); // GET /v1/facts
const matches = correlateDeliveries([...notes, ...facts], [
  { id: "expected-parcel", keywords: ["parcel", "pharmacy delivery"] },
]);
const read = normalizeAlarmAt(1791984600000);
const write = alarmAtForWrite(read!.epochMs); // ISO-8601 for todo writes
// At EOF, feed decoder.decode(), then parser.end() to discard incomplete frames.
```

`BEE_STREAM_PATH` filters `new-utterance,todo-created,update-conversation-summary`. `BeeStreamEventSchema` validates payloads; `normalizeBeeEvent` produces household notes. SSE handles LF/CRLF/CR, comments, multiline data and arbitrary text chunks. The default event limit is 1 MiB characters, configurable through the constructor. Unknown events are ignored; malformed supported events throw. Reset/reconnect after a parse error. The parser does not reconnect or replay; Bee streaming is at-most-once, so reconcile snapshots when completeness matters.

Facts accept an array or `{ facts: [...] }`; numeric/string IDs normalize to strings. Alarm helpers preserve null, accept ISO timestamps with timezones or epoch milliseconds, and reject invalid ranges. SSE todos support `alarmAt` and REST-style `alarm_at`; omitted alarms remain omitted. Existing `BeeTodoWriteSchema` and `BeeTodoResponseSchema` stay exported for backward compatibility. Correlation returns `{ deliveryId, evidence }[]` using explicit whole-word/phrase matches, with no autonomous action.

## Playback bookmarks and focus hooks

```ts
import { VegaFocusCoordinator } from "react-native-vega-mcp-bridge";
const focus = new VegaFocusCoordinator();
const timelineId = "sports-stream-period-1";
const snapshot = focus.presentOverlay(card, "media-player", {
  currentTime: player.currentTime, timelineId,
});
// Host focuses snapshot.focusedActionId and enables TVFocusGuideView traps.
focus.moveFocusNext(card.actions);
const dismissal = focus.dismissOverlay({ currentTime: player.currentTime, timelineId });
// Host disables traps and focuses dismissal.restoredElementId.
if (dismissal.catchUpWindow) {
  const { startSeconds, endSeconds, durationSeconds } = dismissal.catchUpWindow;
  // Pass this interval to your licensed replay or AI summary service.
}
```

Standalone `captureInterruptionTimestamp(position)` and `computeCatchUpWindow(bookmark, position)` are exported, with equivalent coordinator methods. Media time is in seconds, including fractions. Original focus and bookmark survive replacement overlays; dismissal clears both. Paused playback yields zero missed seconds. Timeline mismatch, backward seeking or missing samples make catch-up unavailable; dismissal still restores the focus target and sets `catchUpUnavailable`.

Change `timelineId` on source changes, discontinuities or any seek (including forward seeks). Both samples must refer to continuous playback of the same timeline. MSE buffer eviction, DRM/EME licensing, replay availability, native focus changes and AI generation are host responsibilities; this library extracts no protected media.

## References

- [MCP July 2026 specification release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP Apps registration](https://apps.extensions.modelcontextprotocol.io/api/documents/Quickstart.html)
- [Ring API development guide](https://developer.amazon.com/docs/ring/develop.html)
- [Bee API](https://docs.bee.computer/docs/api) and [realtime payloads](https://docs.bee.computer/docs/realtime)

## License

Apache-2.0. See [LICENSE](LICENSE).
