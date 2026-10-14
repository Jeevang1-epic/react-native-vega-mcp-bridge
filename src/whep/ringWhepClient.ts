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
  const base = (options.endpointBase ?? "[https://api.amazonvision.com](https://api.amazonvision.com)").replace(/\/+$/, "");
  if (!options.deviceId.trim()) {
    throw new Error("Ring WHEP requires a non-empty deviceId");
  }
  if (!options.bearerToken.trim()) {
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

/**
 * Validates that an outgoing SDP Offer strictly contains a recvonly video media section
 * and omits audio transceivers, preventing Ring WHEP 4xx negotiation rejections.
 */
export function assertValidRingWhepSdpOffer(sdp: string): void {
  if (!sdp.includes("m=video")) {
    throw new Error("Ring WHEP SDP offer must contain an m=video media description");
  }
  if (sdp.includes("m=audio")) {
    throw new Error("Ring WHEP endpoint rejects SDP offers containing m=audio transceivers");
  }
  if (!sdp.includes("a=recvonly")) {
    throw new Error("Ring WHEP SDP offer must specify a=recvonly direction");
  }
}
