import { z } from "zod";

export const BEE_STREAM_PATH = "/v1/stream?types=new-utterance,todo-created,update-conversation-summary";
export const BeeEpochSchema = z.number().int().nonnegative().max(8640000000000000);
export const BeeAlarmSchema = z.union([BeeEpochSchema, z.string().datetime({ offset: true }), z.date()]).transform(value => new Date(value).getTime()).pipe(BeeEpochSchema);
export function normalizeAlarmAt(value: unknown): { epochMs: number; isoString: string } | null {
  if (value === null) return null;
  const epochMs = BeeAlarmSchema.parse(value);
  return { epochMs, isoString: new Date(epochMs).toISOString() };
}
export function alarmAtForWrite(value: unknown): string | null { return normalizeAlarmAt(value)?.isoString ?? null; }
const IdSchema = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
export const BeeFactSchema = z.object({ id: IdSchema, text: z.string().min(1), confirmed: z.boolean().optional() });
export const BeeFactsSchema = z.union([z.array(BeeFactSchema), z.object({ facts: z.array(BeeFactSchema) }).transform(value => value.facts)]);
export function normalizeBeeFacts(value: unknown) { return BeeFactsSchema.parse(value); }
export const BeeStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new-utterance"), data: z.object({ utterance: z.object({ text: z.string().min(1), speaker: z.string().optional() }), conversation_uuid: z.string().min(1) }) }),
  z.object({ type: z.literal("todo-created"), data: z.object({ todo: z.object({ id: IdSchema, text: z.string().min(1), completed: z.boolean().optional(), alarmAt: BeeEpochSchema.nullable().optional(), alarm_at: BeeEpochSchema.nullable().optional() }) }) }),
  z.object({ type: z.literal("update-conversation-summary"), data: z.object({ conversation_id: IdSchema, short_summary: z.string() }) })
]);
export type BeeStreamEvent = z.infer<typeof BeeStreamEventSchema>;
export interface BeeHouseholdNote { source: BeeStreamEvent["type"]; text: string; conversationId?: string; todoId?: string; alarmAt?: ReturnType<typeof normalizeAlarmAt> }
export function normalizeBeeEvent(value: unknown): BeeHouseholdNote {
  const event = BeeStreamEventSchema.parse(value);
  if (event.type === "new-utterance") return { source: event.type, text: event.data.utterance.text, conversationId: event.data.conversation_uuid };
  if (event.type === "update-conversation-summary") return { source: event.type, text: event.data.short_summary, conversationId: event.data.conversation_id };
  const todo = event.data.todo;
  const alarm = todo.alarm_at !== undefined ? todo.alarm_at : todo.alarmAt;
  return { source: event.type, text: todo.text, todoId: todo.id, ...(alarm !== undefined ? { alarmAt: normalizeAlarmAt(alarm) } : {}) };
}

/** Incremental decoded-text SSE parser. Feed TextDecoder streaming output; incomplete EOF frames are discarded. */
export class BeeSseParser {
  private line = "";
  private event = "";
  private data: string[] = [];
  private skipLf = false;
  private first = true;
  private size = 0;
  constructor(private readonly maxEventCharacters = 1024 * 1024) {}
  push(chunk: string): BeeHouseholdNote[] {
    const output: BeeHouseholdNote[] = [];
    for (const char of chunk) {
      if (this.first) { this.first = false; if (char === "\uFEFF") continue; }
      if (this.skipLf && char === "\n") { this.skipLf = false; continue; }
      this.skipLf = false;
      if (++this.size > this.maxEventCharacters) { this.reset(); throw new Error("Bee SSE event exceeds size limit"); }
      if (char !== "\r" && char !== "\n") { this.line += char; continue; }
      this.skipLf = char === "\r";
      const line = this.line;
      this.line = "";
      if (line === "") {
        const event = this.event;
        const data = this.data.join("\n");
        this.event = ""; this.data = []; this.size = 0;
        if (data && ["new-utterance", "todo-created", "update-conversation-summary"].includes(event)) output.push(normalizeBeeEvent({ type: event, data: JSON.parse(data) }));
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") this.event = value;
        if (field === "data") this.data.push(value);
      }
    }
    return output;
  }
  reset(): void { this.line = ""; this.event = ""; this.data = []; this.skipLf = false; this.first = true; this.size = 0; }
  end(): void { this.reset(); }
}

export interface ExpectedDelivery { id: string; keywords: string[] }
/** Explicit keyword evidence only: a match does not establish a visitor's identity or authorize access. */
export function correlateDeliveries(notes: readonly Pick<BeeHouseholdNote, "text">[], deliveries: readonly ExpectedDelivery[]) {
  const tokens = (text: string) => text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  return deliveries.flatMap(delivery => {
    const evidence = notes.filter(note => {
      const text = ` ${tokens(note.text).join(" ")} `;
      return delivery.keywords.some(keyword => { const phrase = tokens(keyword).join(" "); return phrase.length > 0 && text.includes(` ${phrase} `); });
    }).map(note => note.text);
    return evidence.length ? [{ deliveryId: delivery.id, evidence }] : [];
  });
}
