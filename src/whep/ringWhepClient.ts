export interface RingWhepOptions {
  deviceId: string;
  bearerToken: string;
  endpointBase?: string;
}

export interface RingWhepHandshakePayload {
  whepUrl: string;
  headers: Record<string, string>;
}

/**
 * Builds the compliant Ring (Amazon Vision) WebRTC WHEP request configuration.
 * Enforces video-only recvonly constraints required by api.amazonvision.com.
 */
export function buildRingWhepEndpoint(options: RingWhepOptions): RingWhepHandshakePayload {
  const base = (options.endpointBase ?? "https://api.amazonvision.com").replace(/\/+$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("WHEP requires a clean HTTPS endpoint");
  if (!options.deviceId.trim()) {
    throw new Error("Ring WHEP requires a non-empty deviceId");
  }
  if (!options.bearerToken.trim() || /[\r\n]/.test(options.bearerToken)) {
    throw new Error("Ring WHEP requires a valid Bearer token");
  }

  return {
    whepUrl: `${base}/v1/devices/${encodeURIComponent(options.deviceId)}/media/streaming/whep/sessions`,
    headers: {
      Authorization: `Bearer ${options.bearerToken}`,
      "Content-Type": "application/sdp"
    }
  };
}

export type RingSessionState = "new" | "gathering" | "complete" | "posting" | "connected" | "failed" | "closed";
export interface RingSessionSnapshot { deviceId: string; state: RingSessionState; location?: string; answer?: string }
export interface WhepResponse { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type WhepTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<WhepResponse>;

/** Caller owns RTCPeerConnection, supplies its final localDescription after ICE complete. */
export class RingWhepSessionManager {
  private sessions = new Map<string, { options: RingWhepOptions; snapshot: RingSessionSnapshot }>();
  private activeDeviceId: string | null = null;
  constructor(private readonly transport: WhepTransport) {}
  register(options: RingWhepOptions): RingSessionSnapshot {
    buildRingWhepEndpoint(options);
    if (this.sessions.has(options.deviceId)) throw new Error("Camera already registered");
    const snapshot: RingSessionSnapshot = { deviceId: options.deviceId, state: "new" };
    this.sessions.set(options.deviceId, { options: { ...options }, snapshot });
    return { ...snapshot };
  }
  private entry(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown camera");
    return session;
  }
  getSession(id: string): RingSessionSnapshot { return { ...this.entry(id).snapshot }; }
  get activeCamera(): string | null { return this.activeDeviceId; }
  updateIceGatheringState(id: string, state: "new" | "gathering" | "complete"): void {
    const current = this.entry(id).snapshot;
    const order = ["new", "gathering", "complete"];
    if (!order.includes(state) || !order.includes(current.state) || order.indexOf(state) < order.indexOf(current.state)) throw new Error("Invalid ICE transition");
    current.state = state;
  }
  async connect(id: string, finalSdpOffer: string): Promise<RingSessionSnapshot> {
    const session = this.entry(id);
    if (session.snapshot.state !== "complete") throw new Error("ICE gathering must be complete before POST");
    assertValidRingWhepSdpOffer(finalSdpOffer);
    const { whepUrl, headers } = buildRingWhepEndpoint(session.options);
    session.snapshot.state = "posting";
    try {
      const response = await this.transport(whepUrl, { method: "POST", headers, body: finalSdpOffer });
      if (response.status !== 201) throw new Error("WHEP requires 201 Created");
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/sdp") throw new Error("WHEP answer must be application/sdp");
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing WHEP session Location");
      const sessionUrl = new URL(location, whepUrl);
      if (sessionUrl.origin !== new URL(whepUrl).origin || !sessionUrl.pathname.startsWith(new URL(whepUrl).pathname + "/") || sessionUrl.username || sessionUrl.password || sessionUrl.hash) throw new Error("Invalid WHEP session Location");
      // Preserve a trusted resource handle for cleanup if answer validation fails.
      session.snapshot.location = sessionUrl.href;
      const answer = await response.text();
      if (!/^v=0\r?$/m.test(answer) || !/^m=video\s/m.test(answer) || !/^a=(sendonly|sendrecv)\r?$/m.test(answer)) throw new Error("Invalid SDP answer");
      session.snapshot = { deviceId: id, state: "connected", location: sessionUrl.href, answer };
      return this.getSession(id);
    } catch (error) { session.snapshot.state = "failed"; throw error; }
  }
  switchCamera(id: string): RingSessionSnapshot {
    if (this.entry(id).snapshot.state !== "connected") throw new Error("PiP camera must be connected");
    this.activeDeviceId = id;
    return this.getSession(id);
  }
  async close(id: string): Promise<void> {
    const session = this.entry(id);
    if (session.snapshot.state === "posting") throw new Error("Wait for pending connection before closing");
    if (session.snapshot.state === "closed") return;
    if (session.snapshot.location) {
      const response = await this.transport(session.snapshot.location, { method: "DELETE", headers: { Authorization: `Bearer ${session.options.bearerToken}` } });
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) throw new Error("WHEP cleanup failed");
    }
    session.snapshot = { deviceId: id, state: "closed" };
    if (this.activeDeviceId === id) this.activeDeviceId = null;
  }
}

/**
 * Validates that an outgoing SDP Offer strictly contains a recvonly video media section
 * and omits audio transceivers, preventing Ring WHEP 4xx negotiation rejections.
 */
export function assertValidRingWhepSdpOffer(sdp: string): void {
  const lines = sdp.split(/\r?\n/);
  if (lines[0] !== "v=0") throw new Error("SDP must start with v=0");
  if (!lines.some(line => /^m=video\s/.test(line))) {
    throw new Error("Ring WHEP SDP offer must contain an m=video media description");
  }
  if (lines.some(line => /^m=audio\s/.test(line))) {
    throw new Error("Ring WHEP endpoint rejects SDP offers containing m=audio transceivers");
  }
  if (lines.filter(line => line.startsWith("m=")).length !== 1) throw new Error("Ring WHEP requires one video media section");
  if (!lines.includes("a=recvonly") || lines.some(line => /^a=(sendonly|sendrecv|inactive)$/.test(line))) {
    throw new Error("Ring WHEP SDP offer must specify a=recvonly direction");
  }
}
