import { z } from 'zod';

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const balanceSnapshotSchema = z.object({
  asset: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  free: z.number().finite().nonnegative(),
  locked: z.number().finite().nonnegative(),
}).strict();

export const hostMarketSchema = z.object({
  source: z.literal('binance-mcp'),
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  price: z.number().finite().positive(),
  changePercent: z.number().finite().optional(),
  toolNames: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  observedAt: z.string().datetime().optional(),
}).strict();

export const tradeProposalInputSchema = z.object({
  proposalId: safeId,
  asset: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  side: z.literal('BUY'),
  amountUSDT: z.number().finite().positive().max(10),
  balanceUSDT: z.number().finite().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  paymentReceiptId: txHash,
}).strict();

export const tradeStatusInputSchema = z.object({
  proposalId: safeId,
  status: z.enum(['refused', 'filled', 'cancelled']),
  reason: z.string().trim().min(1).max(500).optional(),
  orderId: safeId.optional(),
  filledPrice: z.number().finite().positive().optional(),
  executedQty: z.number().finite().positive().optional(),
  amountUSDT: z.number().finite().positive().max(10).optional(),
  source: z.enum(['binance-mcp-host', 'binance-mcp-direct-approved']).optional(),
  mcpToolName: z.string().trim().min(1).max(200).optional(),
  beforeBalances: z.array(balanceSnapshotSchema).min(1).max(200).optional(),
  afterBalances: z.array(balanceSnapshotSchema).min(1).max(200).optional(),
}).strict();

export const emptyBodySchema = z.object({}).strict();

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): { data?: T; error?: string } {
  const result = schema.safeParse(body);
  return result.success ? { data: result.data } : { error: result.error.message };
}
