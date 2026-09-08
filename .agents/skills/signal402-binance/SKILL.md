---
name: signal402-binance
description: Operate Signal402 as a real Binance Agent OS decision and execution layer. Use runtime discovered Binance MCP tools, B402 access, deterministic risk gates, human approval, single use execution plans, and hash verified receipts. Never simulate balances, fills, receipts, or order IDs.
---

# Signal402 Binance CEX skill

Signal402 is a Binance CEX service for agents that need explainable market intelligence and guarded execution. The supported Binance MCP host owns OAuth. Signal402 owns the decision contract, payment boundary, risk gate, approval state, and evidence record.

## Required route

1. Read `signal402_get_capabilities` and `signal402_get_risk_state`.
2. Discover Binance MCP tools at runtime. Never invent a tool name.
3. Read live market and account data. Publish it with `signal402_publish_market` or `signal402_publish_futures_context`.
4. Request the briefing. In paid mode inspect the exact B402 terms and ask the human to approve the payment before `signal402_pay_briefing`.
5. Run the Spot or Futures risk gate. Stop on `WAIT`, a refusal, a stale plan, or a blocked risk state.
6. Create the exact proposal. Keep the returned execution plan and plan hash.
7. Wait for the dashboard `APPROVE` action. Approval is not an order.
8. For directional USDⓈ M Futures, require the literal `CONFIRM` step after a fresh revalidation. Neutral and COIN M are report only.
9. Submit one live Binance MCP order with the exact plan fields. Do not change leverage or margin mode.
10. Read the authenticated order and balances or positions again. Record only the real order ID and real account change.
11. Verify the returned execution receipt hash and preserve the ordered audit trail.

## Hard limits

* Binance CEX only. No DEX, wallet signing, transfer, deposit, or withdrawal workflow.
* No API keys or OAuth tokens in Signal402. Use the supported Binance MCP host.
* Every write needs dashboard approval. Futures also needs `CONFIRM`.
* Spot and combined Futures notional are capped at 10 USDT.
* Futures leverage is capped at 3x and margin must already be isolated.
* No `quoteOrderQty` for Futures. No automatic leverage or margin changes.
* Opening Futures positions need a declared protective stop plan supported by the live host.
* Carry analysis is Binance CEX report only. It never submits two hedge legs.
* A risk estimate is not a guaranteed loss limit.

## Fail closed

Stop when the source is not clearly Binance MCP, a required value is missing, data is older than the configured limit, a plan is expired or tampered, the risk state is halted, the order fields differ from the plan, or the post trade state cannot prove a real change.

See `references/tools.md`, `references/risk-model.md`, and `references/receipts.md` for the machine contract.
