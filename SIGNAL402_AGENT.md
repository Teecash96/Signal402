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
6. Read the live Spot account balance through Binance MCP.
7. Create a proposal with `signal402_create_proposal`. The Risk Guardian refuses when free USDT is below the proposed size.
8. Wait for the human dashboard `APPROVE` using `signal402_wait_for_approval`.
9. Re-read the live balance through Binance MCP immediately before the order.
10. Place exactly one Spot MARKET BUY using the runtime Binance MCP order schema. The quote amount must be at most 10 USDT.
11. Read the real order result and balances through Binance MCP.
12. Record the fill with `signal402_record_fill` only when the order ID, filled price, quantities, and before and after balances came from Binance MCP.

## Hard prohibitions

Never call a withdrawal or external transfer.

Never submit an order before the dashboard approval.

Never fabricate a payment receipt, balance, fill, order ID, or price.

Never use public REST for account or order data. Public REST is an explicitly labelled market data fallback only.

If a Binance MCP response is missing, ambiguous, stale, or rate limited, stop. Do not retry a write blindly.
