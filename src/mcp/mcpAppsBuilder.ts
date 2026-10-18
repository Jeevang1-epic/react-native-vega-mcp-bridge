import { z } from "zod";
import { VegaMcpOverlayCardSchema } from "../types/protocol.js";

export const McpProtocolVersionSchema = z.enum(["2025-11-25", "2026-07-28"]);
export type McpProtocolVersion = z.infer<typeof McpProtocolVersionSchema>;
export const JsonRpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int().finite()]).optional(),
  method: z.string().regex(/^[A-Za-z0-9_.\/-]+$/),
  params: z.record(z.unknown()).optional()
}).strict();
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;
export function buildJsonRpcRequest(id: string | number, method: string, params?: Record<string, unknown>): JsonRpcMessage {
  return JsonRpcMessageSchema.parse({ jsonrpc: "2.0", id, method, params });
}
export function buildJsonRpcNotification(method: string, params?: Record<string, unknown>): JsonRpcMessage {
  return JsonRpcMessageSchema.parse({ jsonrpc: "2.0", method, params });
}

export function validateStreamableHttpHeaders(headers: Record<string, string>, allowedOrigins: readonly string[] = ["https://alexa.amazon.com"]): true {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name in normalized || /[\r\n]/.test(value)) throw new Error("Invalid or duplicate HTTP header");
    normalized[name] = value;
  }
  // Origin may be absent for native clients; any supplied Origin must be explicitly trusted.
  const origin = normalized.origin;
  if (origin !== undefined && !allowedOrigins.includes(origin)) throw new Error("Untrusted Origin");
  const accepted = (normalized.accept ?? "").toLowerCase().split(",").filter(part => {
    const quality = part.match(/;\s*q=([^;]+)/);
    return !quality || (Number(quality[1]) > 0 && Number(quality[1]) <= 1);
  }).map(part => part.split(";")[0].trim());
  if (!accepted.includes("application/json") || !accepted.includes("text/event-stream")) throw new Error("Accept must include application/json and text/event-stream");
  return true;
}

export function buildMcpEnvelope(message: JsonRpcMessage, options: { protocolVersion: McpProtocolVersion; sessionId?: string }) {
  const body = JsonRpcMessageSchema.parse(message);
  const version = McpProtocolVersionSchema.parse(options.protocolVersion);
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version };
  if (version === "2026-07-28") {
    if (options.sessionId !== undefined) throw new Error("Stateless requests cannot carry a session ID");
    if (body.method === "initialize" || body.method === "notifications/initialized") throw new Error("Stateless protocol has no initialize handshake");
    const meta = z.record(z.unknown()).parse(body.params?._meta ?? {});
    body.params = { ...body.params, _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": version } };
    headers["Mcp-Method"] = body.method;
    if (body.params.name !== undefined) headers["Mcp-Name"] = z.string().regex(/^[\x21-\x7e]+$/).parse(body.params.name);
  } else if (options.sessionId !== undefined) {
    headers["Mcp-Session-Id"] = z.string().regex(/^[\x21-\x7e]+$/).parse(options.sessionId);
  }
  return { headers, body };
}

/** Application-defined cards carried in MCP structuredContent, not an ext-apps card standard. */
export const VegaCarouselSchema = z.object({ cards: z.array(VegaMcpOverlayCardSchema).min(1) }).superRefine(({ cards }, ctx) => {
  if (new Set(cards.map(card => card.cardId)).size !== cards.length) ctx.addIssue({ code: "custom", message: "Duplicate card IDs" });
  for (const card of cards) {
    if (new Set(card.actions.map(action => action.id)).size !== card.actions.length || card.actions.filter(action => action.isPrimaryFocus).length > 1) ctx.addIssue({ code: "custom", message: "Actions require unique IDs and at most one primary focus" });
  }
});
export function buildVegaCarousel(cards: z.input<typeof VegaMcpOverlayCardSchema>[], resourceUri: string) {
  if (!/^ui:\/\/[^\s]+$/.test(resourceUri)) throw new Error("UI resource must use ui://");
  const structuredContent = VegaCarouselSchema.parse({ cards });
  return {
    toolMeta: { ui: { resourceUri } },
    result: { content: [{ type: "text" as const, text: cards.map(card => card.title).join("; ") }], structuredContent }
  };
}
