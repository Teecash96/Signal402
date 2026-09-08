# Plans and receipts

Every eligible write proposal produces a 60 second execution plan. The plan hash covers the symbol, side, position side, quantity, notional, reduce only value, leverage, margin mode, context and risk hashes, payment receipt, and expiry. Status changes do not change the intent hash.

Valid plan status order is:

`proposed` → `approved` → `confirmed` → `submitted` → `partially_filled` → `filled`

Refusal, cancellation, and expiry are terminal. A plan cannot be reused after a fill. The Seller rejects an order or fill when the plan is stale, tampered, or has different fields.

An execution receipt is generated only after the live MCP order result and post trade account evidence are reconciled. The receipt includes the real order ID, fill values, plan and risk hashes, approval times, source MCP tool name, before and after snapshots, ordered event records, and a SHA 256 receipt hash. Tokens, API keys, and raw MCP payloads are not recorded.
