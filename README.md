# Signal402

Signal402 is a real Binance Agent OS agent. A Seller Agent sells a live briefing through Binance B402 x402. A Buyer Agent pays with the Binance Agentic Wallet, reads its live Agentic subaccount through a supported Binance MCP host, and submits one real Spot MARKET BUY only after the human presses `APPROVE` in the dashboard.

There are no simulated payments, receipts, balances, fills, or order IDs.

## What the buyer pays for

Signal402 does not sell a raw ticker wrapper. It sells a verified market intelligence artifact for a requested symbol. After real B402 settlement, the Seller returns the live Binance snapshot plus an explainable screening result:

1. Direction from the 24 hour move.
2. Risk tier from momentum and the observed 24 hour range.
3. Confidence based on the completeness of the live snapshot.
4. A deterministic `BUY_SMALL` or `WAIT` action.
5. The thesis and the rule that invalidates the result.

The action is not a profit promise. `BUY_SMALL` only permits the next safety checks. `WAIT` blocks proposal creation. The Buyer still reads the live Agentic subaccount, applies Risk Guardian, and waits for dashboard approval. This is the reason for the 0.01 USDC payment: the Buyer pays for an independently produced, timestamped interpretation rather than free price access.

The screening rules are visible and deterministic. A move of at least 1 percent is bullish, a move of at most negative 1 percent is bearish, and high risk starts at an absolute move of 8 percent or a 24 hour range of 12 percent. Only bullish, non high risk snapshots produce `BUY_SMALL`.

## Public frontend and live console

The repository includes a small public Vercel front door in [`web/`](./web/). It explains the workflow and its hard boundaries without exposing credentials, balances, payment data, or fake market values. The live operator console is the Express app at `http://localhost:3001` because its authenticated approval state, Binance OAuth host connection, and audit trail must remain on a stateful agent host. A Vercel static deployment is therefore a product entry point, not a claim that Vercel is executing trades.

The local console uses a compact execution control room layout. It keeps MCP state, data source, access mode, risk status, approval, order evidence, and the Futures event trail visible. A `MCP: FALLBACK` label means the optional public REST source is active. It never means that Binance account or order data came from the fallback.

## Temporary free access

If B402 merchant onboarding is not available yet, set `SIGNAL402_FREE_ACCESS=true` in `.env`. The Seller then returns the live briefing without requesting payment. The response has no receipt and the dashboard shows `ACCESS: FREE`. This mode does not create a fake receipt and does not weaken live Binance MCP data, Risk Guardian, dashboard approval, the 10 USDT order cap, or audit logging. Paid B402 mode remains the default. Never describe a free briefing as a settled B402 payment.

## Run with your own account

The Binance MCP account and the B402 wallet are different Binance products. The Spot order uses the Binance Agentic subaccount. The x402 payment uses the Binance Agentic Wallet on BSC. Fund both with small amounts before using production funds.

1. Clone and install.

   ```sh
   git clone https://github.com/Teecash96/Signal402.git
   cd Signal402
   npm install
   cp .env.example .env
   ```

2. Generate a local bridge token and put the same value in `.env` as `SIGNAL402_HOST_TOKEN`.

   ```sh
   export SIGNAL402_HOST_TOKEN=$(openssl rand -hex 32)
   ```

   Copy the printed value into the `SIGNAL402_HOST_TOKEN` line in `.env`.

3. Create the dashboard password hash without putting the password in shell history.

   ```sh
   npm run hash:dashboard-password
   ```

   Copy the printed `SIGNAL402_DASHBOARD_PASSWORD_HASH` line into `.env`. The helper prints shell quotes around the scrypt value so its `$` separators stay intact. Set `SIGNAL402_DASHBOARD_SESSION_SECRET` and `MCP_TOKEN_ENCRYPTION_KEY` to separate random values. The dashboard approval route has a server side session, secure cookie settings, a five failure login limit, and a honeypot. Set the optional Cloudflare Turnstile keys to add challenge verification. Do not run `source .env`; the application loads `.env` itself.

4. Apply for Binance B402 merchant credentials. Binance provides the production base URL, `clientId`, and `accessToken` after onboarding. Generate the RSA key pair locally, submit only the public key, keep the private key locally, and set a seller BSC address in `B402_PAY_TO`. This repository refuses to issue a fake challenge when these values are missing. If onboarding is unavailable, use the temporary free access mode above.

5. For paid mode, install and log in to the Binance Agentic Wallet CLI. The executable must be available as `baw`, or set `BINANCE_AGENTIC_WALLET_BIN` to its path. The payment tool uses the documented `baw x402-payment preview` and `baw x402-payment sign` commands. You can skip this step while temporary free access is enabled.

6. Start the Seller.

   ```sh
   npm run start:seller
   ```

   The Seller does not authenticate to Binance in host mode. The supported MCP host performs Binance login and asks for Market data, Account, and Trade scopes for the Agentic subaccount. Do not grant a transfer scope. Binance Agent OS does not provide a withdrawal scope.

7. Add two MCP servers to a supported host such as Codex Desktop, Codex CLI, Claude, Cursor, or ChatGPT. Binance owns the OAuth flow. Signal402 does not open a custom OAuth page or store Binance tokens.

   Binance MCP:

   ```sh
   codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic
   ```

   Signal402 MCP, from the repository directory:

   ```sh
   codex mcp add signal402-agent --env SIGNAL402_HOST_TOKEN=$SIGNAL402_HOST_TOKEN --env SELLER_ENDPOINT_URL=http://localhost:3001 -- npx tsx "$PWD/src/agent/server.ts"
   ```

8. Open [http://localhost:3001](http://localhost:3001). Sign in with the dashboard password. The header must show `MCP: LIVE` after the host publishes a live ticker. `DATA: FALLBACK` is allowed only when `ALLOW_PUBLIC_REST_FALLBACK=true` and is clearly labelled.

9. Fund the Agentic subaccount with USDT using the Binance web UI. The documented path is Profile, Dashboard, Subaccount, Asset Management, Transfer. Keep at least 10 USDT available for the capped Spot order.

10. In the supported host, call `signal402_get_workflow` and follow the returned workflow. The host discovers Binance tool names at runtime, publishes the live market snapshot, pays the real 0.01 USDC challenge after human confirmation in paid mode, or continues without payment in free mode. It stops when the Seller returns `WAIT`, or creates the proposal when the Seller returns `BUY_SMALL`. It then waits for the dashboard `APPROVE`, submits one real MARKET BUY capped at 10 USDT, reads the real fill and balances, and records the receipt only in paid mode.

The full agent contract is in [`SIGNAL402_AGENT.md`](./SIGNAL402_AGENT.md). Load it in the supported host before enabling trading.

## Binance Futures mode

Spot is the default. Set `FUTURES_SYMBOL` and use the Futures branch in `SIGNAL402_AGENT.md` only when you have deliberately funded the matching Binance Agentic Futures wallet.

For a deliberate USD M directional run, set `SIGNAL402_MARKET_TYPE=USD_M`, keep `SIGNAL402_FUTURES_MODE=directional`, and publish a fresh context through `signal402_publish_futures_context`. For neutral analysis set `SIGNAL402_FUTURES_MODE=neutral`; the server will keep it report only. The context values, not an environment variable, are the source of truth for the risk proof.

Signal402 supports two contract types:

1. `USD_M` uses USDT collateral. Directional analysis can submit one real order when every gate passes.
2. `COIN_M` uses coin collateral. It is report only in this version. No COIN M order write is accepted.

There are two analysis modes:

1. `directional` evaluates one long or short intent. A USD M opening order also needs a declared protective stop plan exposed by the live host.
2. `neutral` measures long and short imbalance and returns a hedge ratio. It is report only. Signal402 never submits two hedge legs automatically.

The Futures risk envelope is deterministic and versioned. It records the input hash, output hash, evidence tool names, decision, risk zone, margin required, margin utilization, funding exposure, spread, slippage, liquidation distance, and invalidation rule. It refuses stale data older than 15 seconds, cross margin, leverage above 3x, unverified exchange filters, missing funding or liquidation data, spread or slippage above 50 basis points, absolute funding above 5 basis points per interval, liquidation distance below 10 percent, insufficient available margin, and a combined notional above 10 USDT. The cap applies to the projected exposure. A reduce only order may lower an existing exposure.

The host sends funding as `fundingRateBps`, in basis points for one funding interval. It also sends `nextFundingTime`. Signal402 does not convert an unknown unit or guess a missing interval. After dashboard approval, the host must re-read the account and market data and call `signal402_revalidate_futures_context`; a stale or changed context cancels the execution path.

Signal402 requires isolated margin and reads the existing leverage. It never changes leverage, margin mode, or position mode automatically. Futures orders use an explicit symbol, side, position side, quantity, and `reduceOnly` value. `quoteOrderQty` is never sent. Every directional USD M order needs dashboard `APPROVE` and a separate `CONFIRM` step. The host then submits one live MARKET order through its runtime discovered Binance Futures MCP tool and records authenticated order and account events. The dashboard shows the receipt, order ID, fill, position, margin, and event timeline only when those values came from Binance.

The risk envelope is a risk estimate, not a guaranteed loss limit. Liquidation, fees, funding changes, latency, and exchange execution can produce a different result. Keep the Agentic Futures wallet funded only with an amount you can lose, and use Binance's emergency stop if needed.

The implementation follows the [Binance Agent OS agentic MCP documentation](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic) and records the authenticated order and account events described by [Binance Futures user data streams](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/user-data-streams).

## Supported host architecture

Binance Agent OS currently authorizes approved AI hosts. Signal402 therefore runs as a local MCP server beside the official Binance MCP server. The host owns Binance OAuth and calls both servers. Signal402 owns the marketplace state, x402 payment flow, Risk Guardian, dashboard approval gate, and append only audit log.

The host bridge accepts only live market data and fill records that identify their Binance MCP source. It rejects missing runtime tool names, invalid balances, missing order fields, fills before dashboard approval, and amounts above the hard 10 USDT cap. Signal402 never accepts a simulated receipt.

The older direct `BinanceMcpClient` remains only as an isolated path for a future Binance approved client. It is not the default and must not be used to bypass the supported host flow.

## Real Binance x402 flow implemented here

The Seller calls the authenticated Binance B402 v2 API. The paths are:

```text
POST {B402_BASE_URL}/papi/v2/b402/supported
POST {B402_BASE_URL}/papi/v2/b402/verify
POST {B402_BASE_URL}/papi/v2/b402/settle
```

Each request is signed with RSA SHA256 over the exact JSON body concatenated with the millisecond timestamp. The required headers are `Content-Type`, `X-Tesla-ClientId`, `X-Tesla-SignAccessToken`, `X-Tesla-Signature`, and `X-Tesla-Timestamp`.

The Seller caches `/supported`, copies the complete `extra` object into a v2 `PaymentRequirements` entry, and returns HTTP 402 with a Base64 `PAYMENT-REQUIRED` header. It also sends the documented `X-PAYMENT-REQUIREMENTS` compatibility header. The body contains `x402Version: 2`, `resource`, and `accepts`. The selected requirement is exact USDC on BSC for 0.01 USDC, with the amount represented in atomic units.

The Buyer passes the 402 requirement to:

```text
baw x402-payment preview --paymentRequirements <base64-or-json> --json
baw x402-payment sign --paymentId <id> --selectedIndex <index> --json
```

The signed response supplies a `PAYMENT-SIGNATURE` header. The Buyer replays the request with that header. B402 verifies, settles, and returns `PAYMENT-RESPONSE`, whose Base64 JSON contains the settlement transaction hash. The Seller delivers the briefing only after `/verify` is valid and `/settle` returns success with a valid 32 byte transaction hash. A pending transaction with a nonempty hash is polled through the idempotent `/settle` endpoint for up to 30 minutes. A failed or unsigned payment never produces a briefing.

## Safety model

No withdrawal permission is requested or available. In supported host mode, Binance OAuth tokens remain inside the supported MCP host and are never handled by Signal402. The isolated direct client is disabled unless Binance approves it and stores only an encrypted token cache. The order is always a Spot `MARKET BUY`, never larger than 10 USDT, and requires the dashboard `APPROVE` action. The host checks real USDT immediately before proposal and again immediately before order. It reads balances after the order and refuses to call the dashboard `filled` state unless Binance returns a real order ID and filled price. Every material action is appended to `logs/signal402.jsonl`; the log is ignored by Git.

For a refusal test, use a real account with less than the proposed amount. Do not set a fake balance variable. If the live balance is too low, the dashboard shows the red `RISK GUARDIAN: refused` state and no order call is made.

## Security controls

Secrets stay in environment variables or the Binance host. The browser receives no API key, access token, private key, or wallet credential. If the approved direct client is used, its OAuth token state is encrypted with AES 256 GCM in `.mcp-tokens.json` and the file is ignored with mode `0600`. The local audit log is redacted by default and can encrypt its details with `SIGNAL402_AUDIT_ENCRYPTION_KEY`; production should set `SIGNAL402_REQUIRE_AUDIT_ENCRYPTION=true`.

The Seller sends security headers, limits JSON bodies to 32 KB, restricts CORS to `SIGNAL402_ALLOWED_ORIGINS`, rejects unknown fields with Zod schemas, and returns trimmed state without raw MCP payloads. Dashboard state and approval require the dashboard session. Host market, proposal, status, and state writes require the bridge token. Trade status cannot be changed by editing a client field: the server checks the payment receipt, configured symbol, ten USDT cap, approval state, runtime MCP tool name, order fields, and before and after balance changes.

Set `SIGNAL402_FORCE_HTTPS=true`, `SIGNAL402_COOKIE_SECURE=true`, and `SIGNAL402_TRUST_PROXY=true` only when a trusted TLS reverse proxy is in front of the Seller. Run `npm audit` before deployment. Signal402 has no database, SQL query layer, password table, or file upload endpoint, so public database keys, row level security, query parameterization, and upload validation are not applicable until those components are added.

## Configuration

See [`.env.example`](./.env.example). Keep `.env`, `.mcp-tokens.json`, RSA keys, wallet credentials, and audit logs out of Git. Start with Binance B402 Sandbox where available. Production B402 access requires Binance partner onboarding and IP whitelisting.
