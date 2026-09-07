# Signal402 Agent Contract

Signal402 is a live Binance Agent OS workflow. It is not a simulator.

## Runtime

Use the official Binance MCP server configured by the supported host. The host owns Binance OAuth. Never open a custom OAuth flow from Signal402 and never use a token issued to another client.

Use the Signal402 MCP server for marketplace state, x402 payment, risk checks, dashboard approval, and audit records.

## Required sequence

1. Discover Binance MCP tools at runtime. Never invent or hardcode Binance tool names.
2. Read the requested Spot ticker through Binance MCP.
3. Publish that result with `signal402_publish_market`.
4. Request the Seller payment challenge with `signal402_request_briefing`.
5. Show the human the exact 0.01 USDC terms. Call `signal402_pay_briefing` with `confirmPayment=true` only after explicit approval.
6. Read the paid briefing. If its rule action is `WAIT`, stop and report the thesis. Do not create a proposal or order.
7. Read the live Spot account balance through Binance MCP.
8. Create a proposal with `signal402_create_proposal`. The Seller also enforces the briefing action, and the Risk Guardian refuses when free USDT is below the proposed size.
9. Wait for the human dashboard `APPROVE` using `signal402_wait_for_approval`.
10. Re-read the live balance through Binance MCP immediately before the order.
11. Place exactly one Spot MARKET BUY using the runtime Binance MCP order schema. The quote amount must be at most 10 USDT.
12. Read the real order result and balances through Binance MCP.
13. Record the fill with `signal402_record_fill` only when the order ID, filled price, quantities, and before and after balances came from Binance MCP.

## Futures branch

Spot remains the default. Use this branch only when the human has selected an explicit Futures contract and strategy.

1. Discover runtime Binance Futures tools. Accept only tools clearly identified as Futures, USD M, COIN M, perpetual, derivative, or contract tools. Never guess a name.
2. Read mark price, index price, bid, ask, order book depth, estimated slippage, funding and next funding time, wallet and available margin, initial and maintenance margin, positions, open orders, liquidation data, exchange filters, and leverage brackets. Publish the strict snapshot with `signal402_publish_futures_context`.
3. Call `signal402_assess_futures_risk`. The deterministic envelope is based on the DeltaZero evidence and proof model. It fails closed when data is older than 15 seconds, margin is cross, leverage is above 3x, combined notional is above 10 USDT, margin is insufficient, required fields are missing, spread or slippage is above 50 basis points, funding is above 5 basis points per interval, liquidation distance is below 10 percent, or filters cannot be verified.
4. Request the real B402 challenge and show the human the exact 0.01 USDC terms. Pay only after payment approval. The Futures report is withheld until settlement verification succeeds.
5. Neutral mode returns a hedge ratio and evidence but is `REPORT ONLY`. It never submits two hedge legs. COIN M is also `REPORT ONLY` and never accepts an order write.
6. Directional USD M can create a proposal only when `executionEligible=true` and the order includes a declared protective stop plan supported by the live host. The Seller checks the proof hashes against its current context.
7. Wait for the dashboard `APPROVE`. Then require the human to type `CONFIRM` for the exact symbol, side, position side, quantity, notional, and `reduceOnly` value.
8. Re-read the account and context and call `signal402_revalidate_futures_context`. If revalidation fails, stop. Submit exactly one real USD M MARKET order through the runtime discovered Binance MCP tool. Use existing leverage at or below 3x and isolated margin. Never use `quoteOrderQty`. Never change leverage, margin mode, or position mode automatically.
9. Monitor the authenticated Futures user stream or order status. Record the real submitted, order update, account update, fill, margin call, and liquidation events with `signal402_record_futures_event`. A filled event must include before and after account and position snapshots that prove the real state changed.

## Hard prohibitions

Never call a withdrawal or external transfer.

Never submit an order before the dashboard approval.

Never fabricate a payment receipt, balance, fill, order ID, or price.

Never use public REST for account or order data. Public REST is an explicitly labelled market data fallback only.

If a Binance MCP response is missing, ambiguous, stale, or rate limited, stop. Do not retry a write blindly.

The 10 USDT cap is a combined notional policy, not a promise that losses cannot exceed 10 USDT. Futures PnL, funding, fees, and liquidation remain exchange risks.
