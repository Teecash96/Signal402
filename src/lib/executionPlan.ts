import { randomUUID } from 'node:crypto';
import { sha256 } from './futuresRisk.js';

export const EXECUTION_PLAN_SCHEMA_VERSION = 'signal402-execution-plan-v1';
export const EXECUTION_PLAN_TTL_MS = 60_000;

export type ExecutionKind = 'spot' | 'futures';
export type ExecutionPlanStatus =
  | 'proposed'
  | 'approved'
  | 'confirmed'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'refused'
  | 'cancelled'
  | 'expired';

export type ExecutionPlan = {
  schemaVersion: typeof EXECUTION_PLAN_SCHEMA_VERSION;
  planId: string;
  proposalId: string;
  kind: ExecutionKind;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  quantity?: number;
  notionalUSDT: number;
  reduceOnly: boolean;
  leverage?: number;
  marginMode?: 'ISOLATED';
  contextHash?: string;
  riskHash?: string;
  paymentReceiptId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  status: ExecutionPlanStatus;
  planHash: string;
};

export type ExecutionPlanInput = Omit<ExecutionPlan, 'schemaVersion' | 'planId' | 'createdAt' | 'expiresAt' | 'updatedAt' | 'status' | 'planHash'> & {
  planId?: string;
  now?: Date | string | number;
  ttlMs?: number;
};

function iso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Execution plan timestamp is invalid');
  return date.toISOString();
}

function immutablePayload(plan: Omit<ExecutionPlan, 'planHash' | 'status' | 'updatedAt'>): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    proposalId: plan.proposalId,
    kind: plan.kind,
    symbol: plan.symbol,
    side: plan.side,
    positionSide: plan.positionSide,
    quantity: plan.quantity,
    notionalUSDT: plan.notionalUSDT,
    reduceOnly: plan.reduceOnly,
    leverage: plan.leverage,
    marginMode: plan.marginMode,
    contextHash: plan.contextHash,
    riskHash: plan.riskHash,
    paymentReceiptId: plan.paymentReceiptId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
}

export function executionPlanHash(plan: ExecutionPlan): string {
  const { planHash: _planHash, status: _status, updatedAt: _updatedAt, ...immutable } = plan;
  return sha256(immutable);
}

export function createExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  const start = new Date(input.now === undefined ? Date.now() : input.now);
  if (!Number.isFinite(start.getTime())) throw new Error('Execution plan timestamp is invalid');
  const ttlMs = Number.isFinite(input.ttlMs) ? Math.min(Math.max(input.ttlMs ?? EXECUTION_PLAN_TTL_MS, 1), EXECUTION_PLAN_TTL_MS) : EXECUTION_PLAN_TTL_MS;
  const createdAt = start.toISOString();
  const expiresAt = new Date(start.getTime() + ttlMs).toISOString();
  const planId = input.planId ?? `plan_${randomUUID()}`;
  const planWithoutHash: Omit<ExecutionPlan, 'planHash' | 'status' | 'updatedAt'> = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    planId,
    proposalId: input.proposalId,
    kind: input.kind,
    symbol: input.symbol.trim().toUpperCase(),
    side: input.side,
    positionSide: input.positionSide,
    quantity: input.quantity,
    notionalUSDT: input.notionalUSDT,
    reduceOnly: input.reduceOnly,
    leverage: input.leverage,
    marginMode: input.marginMode,
    contextHash: input.contextHash,
    riskHash: input.riskHash,
    paymentReceiptId: input.paymentReceiptId,
    createdAt,
    expiresAt,
  };
  const plan: ExecutionPlan = {
    ...planWithoutHash,
    status: 'proposed',
    updatedAt: createdAt,
    planHash: sha256(immutablePayload(planWithoutHash)),
  };
  return plan;
}

export function isExecutionPlanCurrent(plan: ExecutionPlan, now: Date | string | number = Date.now()): boolean {
  const timestamp = Date.parse(iso(now));
  return plan.status !== 'expired'
    && !['filled', 'refused', 'cancelled'].includes(plan.status)
    && Date.parse(plan.expiresAt) > timestamp
    && executionPlanHash(plan) === plan.planHash;
}

export function expireExecutionPlan(plan: ExecutionPlan, now: Date | string | number = Date.now()): ExecutionPlan {
  if (isExecutionPlanCurrent(plan, now)) return plan;
  if (['filled', 'refused', 'cancelled'].includes(plan.status)) return plan;
  return { ...plan, status: 'expired', updatedAt: iso(now) };
}

const transitions: Record<ExecutionPlanStatus, readonly ExecutionPlanStatus[]> = {
  proposed: ['approved', 'refused', 'cancelled', 'expired'],
  approved: ['confirmed', 'submitted', 'refused', 'cancelled', 'expired'],
  confirmed: ['submitted', 'refused', 'cancelled', 'expired'],
  submitted: ['partially_filled', 'filled', 'refused', 'cancelled'],
  partially_filled: ['filled', 'refused', 'cancelled'],
  filled: [],
  refused: [],
  cancelled: [],
  expired: [],
};

export function transitionExecutionPlan(plan: ExecutionPlan, nextStatus: ExecutionPlanStatus, now: Date | string | number = Date.now()): ExecutionPlan {
  if (plan.status === nextStatus) return plan;
  if (!transitions[plan.status].includes(nextStatus)) {
    throw new Error(`Invalid execution plan transition: ${plan.status} -> ${nextStatus}`);
  }
  if (nextStatus !== 'expired' && !isExecutionPlanCurrent(plan, now)) {
    throw new Error('Execution plan is expired, tampered, or already consumed');
  }
  return { ...plan, status: nextStatus, updatedAt: iso(now) };
}

export function planOrderMatches(
  plan: ExecutionPlan,
  order: Pick<ExecutionPlan, 'kind' | 'symbol' | 'side' | 'positionSide' | 'quantity' | 'notionalUSDT' | 'reduceOnly' | 'leverage' | 'marginMode'>,
): boolean {
  return plan.kind === order.kind
    && plan.symbol === order.symbol.trim().toUpperCase()
    && plan.side === order.side
    && plan.positionSide === order.positionSide
    && plan.quantity === order.quantity
    && plan.notionalUSDT === order.notionalUSDT
    && plan.reduceOnly === order.reduceOnly
    && plan.leverage === order.leverage
    && plan.marginMode === order.marginMode;
}
