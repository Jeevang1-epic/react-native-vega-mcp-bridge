import { z } from "zod";

/**
 * Normalizes Bee Wearable /v1/todos asymmetric alarm_at timestamps:
 * - Write requests require ISO-8601 string ("2026-10-14T14:30:00.000Z")
 * - Read responses return epoch milliseconds (number)
 */
export const BeeTodoWriteSchema = z.object({
  text: z.string().min(1),
  alarm_at: z.union([z.date(), z.number(), z.string()]).transform((val) => {
    const date = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid alarm_at timestamp: ${String(val)}`);
    }
    return date.toISOString();
  })
});

export const BeeTodoResponseSchema = z.object({
  id: z.string(),
  text: z.string(),
  completed: z.boolean().optional().default(false),
  alarm_at: z.number().int().nonnegative().transform((epochMs) => ({
    epochMs,
    isoString: new Date(epochMs).toISOString()
  }))
});

/**
 * MCP Apps SDK (@modelcontextprotocol/ext-apps) 10-foot TV Carousel Card Schema
 */
export const VegaMcpActionItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  mcpToolName: z.string().min(1),
  arguments: z.record(z.unknown()),
  isPrimaryFocus: z.boolean().default(false)
});

export const VegaMcpOverlayCardSchema = z.object({
  cardId: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string(),
  severity: z.enum(["info", "caretaking", "urgent"]),
  whepDeviceId: z.string().optional(),
  beeContextSummary: z.string().optional(),
  actions: z.array(VegaMcpActionItemSchema).min(1)
});

export type VegaMcpOverlayCard = z.infer<typeof VegaMcpOverlayCardSchema>;
export type VegaMcpActionItem = z.infer<typeof VegaMcpActionItemSchema>;
