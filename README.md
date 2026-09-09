# Signal402

[![CI](https://github.com/Teecash96/Signal402/actions/workflows/ci.yml/badge.svg)](https://github.com/Teecash96/Signal402/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Signal402 is a real Binance Agent OS agent. A Seller Agent provides a live, evidence backed briefing through a supported Binance MCP host. The Buyer reads its Agentic subaccount and can submit one real Spot `MARKET BUY` only after the risk gate, dashboard `APPROVE`, and final execution checks pass.

There are no simulated balances, fills, or order IDs.

## Problem

Agents can read a price, but a price alone is not a trading decision. A useful agent workflow must also answer four questions:

1. What evidence produced this recommendation?
2. Did the buyer receive the exact report it requested?
3. Is the proposed order covered by the live account balance and risk rules?
4. Did Binance actually accept and fill the order?

Signal402 connects those answers into one auditable path. It provides a timestamped interpretation of live Binance data, gates the proposal with deterministic Spot and Futures rules, requires a human approval before every write, and records only order evidence returned by Binance. It is a decision and execution control layer, not a profit promise.

## Judges' 5 Minute Validation

This validation follows the timed structure used by the [DeltaZero judge validation](https://github.com/Teecash96/DeltaZero/blob/main/README.md). The first two minutes prove the local product without exchange credentials. The live MCP steps require a supported host connected to the official Binance Agent OS server. Signal402 never replaces missing live evidence with fixtures.

### Minute 1: Verify the local safety contract

Run this from the repository root:

```sh
npm ci
npm run validate:judge
```

Expected result:

```text
TypeScript build: pass
Deterministic test suite: pass
Dependency audit: pass
Git whitespace check: pass
```

This proves the compiled contracts, deterministic risk rules, security tests, dependency state, and repository whitespace. It does not prove Binance OAuth, account funding, or a real fill.

### Minute 2: Verify the Seller service

In Terminal 1:

```sh
npm run start:seller
```

In Terminal 2:

```sh
curl -sS http://localhost:3001/api/health | jq
curl -sS http://localhost:3001/api/report/info | jq
```

The response must show a healthy Seller and `ACCESS: FREE`.

### Minute 3: Verify the agent contract

Through a supported MCP host, call:

```text
signal402_get_capabilities
signal402_get_workflow
signal402_get_risk_state
```

Confirm that the response describes free access, the 10 USDT Spot cap, the Futures limits, human approval, no withdrawals, and the current persistent risk state. The host must discover Binance tool names at runtime. Signal402 does not accept invented names.

### Minute 4: Verify live Binance context and briefing

Through the same host, follow the returned workflow:

```text
signal402_publish_market
signal402_request_briefing
```

The dashboard must show the real symbol, price, timestamp, source tool name, and `MCP: LIVE` only when those values came from the connected Binance MCP host. It must show `ACCESS: FREE`.

If the host is not connected, the dashboard must remain `MCP: WAITING` or show the explicitly configured `MCP: FALLBACK` state. Neither state is live Binance evidence.

### Minute 5: Verify the risk and approval boundary

Call:

```text
signal402_assess_risk
signal402_create_proposal
signal402_wait_for_approval
```

The safe result is one of:

* `WAIT`, which stops before proposal creation
* `RISK GUARDIAN: refused`, which stops before any order call
* An exact proposal waiting for dashboard `APPROVE`

The optional live order path is separate. A funded account, dashboard `APPROVE`, and the existing confirmation rules are required. Only Binance returned order IDs, fills, events, and before and after balances may be shown as live evidence.

### Evidence standard

| Check | Proves | Does not prove |
| --- | --- | --- |
| `npm run validate:judge` | Build, tests, audit, and whitespace checks pass | Binance access or a real trade |
| Seller health and report info | Local service and free access policy are configured | Binance access or a real trade |
| `MCP: LIVE` | A supported host supplied a current Binance tool result | Profit or future price movement |
| Free briefing | A current report was released | A successful trading strategy |
| Risk decision | Deterministic rules accepted or refused the context | Guaranteed loss protection |
| Order evidence | Binance returned the order and account change | A successful trading strategy |

Never present a test fixture, a public REST fallback, or a planned order as live trading evidence.

## Architecture

The supported MCP host owns Binance OAuth and runtime tool discovery. Signal402 owns the agent contract, free briefing access, risk envelope, dashboard approval, and redacted audit trail.

```mermaid
flowchart LR
  TRADER((Trader))

  subgraph CLIENTS[Agent clients]
    CLI[CLI agent]
    MCPCLIENT[MCP client]
    HTTP[HTTP client]
  end

  subgraph HOST[Supported MCP host]
    WORKFLOW[Signal402 workflow]
    DISCOVERY[Runtime tool discovery]
    OAUTH[Binance OAuth]
  end

  subgraph SERVICE[Signal402 stateful Seller]
    CONTEXT[Live context intake]
    SELLER[Briefing API]
    ACCESS[Free access]
    RISK[DeltaZero style Risk Guardian]
    DECISION{WAIT, refused, or eligible}
    MODE[Neutral and COIN M: report only]
    PLAN[Hash bound proposal]
    DASH[Approval dashboard]
    AUDIT[Redacted audit log]
  end

  BINANCE[(Binance Agent OS MCP)]

  TRADER --> CLI
  TRADER --> MCPCLIENT
  TRADER --> HTTP
  CLI --> WORKFLOW
  MCPCLIENT --> WORKFLOW
  HTTP --> WORKFLOW
  WORKFLOW --> DISCOVERY
  OAUTH <--> BINANCE
  DISCOVERY --> BINANCE
  WORKFLOW -->|publish live context| CONTEXT
  BINANCE -->|market and account data| CONTEXT
  CONTEXT --> SELLER
  SELLER --> ACCESS
  ACCESS --> RISK
  RISK --> DECISION
  DECISION -->|WAIT or refusal| AUDIT
  DECISION --> MODE
  MODE --> AUDIT
  DECISION -->|eligible| PLAN
  PLAN --> DASH
  TRADER -->|APPROVE| DASH
  DASH --> WORKFLOW
  WORKFLOW -->|fresh check and one capped order| BINANCE
  BINANCE -->|real order, fill, account events| WORKFLOW
  WORKFLOW -->|reconcile verified evidence| AUDIT

  classDef trader fill:#f4c95d,stroke:#f4c95d,color:#071018
  classDef boundary fill:#0d1922,stroke:#5eead4,color:#edf5f3
  classDef safety fill:#29151c,stroke:#fb7185,color:#ffe4e6
  class TRADER trader
  class CLIENTS,HOST,SERVICE,ACCESS,PLAN,DASH,AUDIT boundary
  class MODE safety
```

The full system and sequence diagrams are in [docs/architecture.md](./docs/architecture.md). The one minute trader focused capture plan is in [docs/demo-script.md](./docs/demo-script.md).

### Trust boundaries

| Component | Responsibility | Never does |
| --- | --- | --- |
| Supported MCP host | Binance OAuth, runtime tool discovery, live account reads, and order calls | Invent tool names or use public REST for account data |
| Signal402 Seller | Free briefing access, risk state, approval state, and audit records | Hold Binance OAuth tokens or issue fake order evidence |
| Browser dashboard | Shows state and records human approval | Receive API keys, OAuth tokens, or wallet credentials |
| Binance | Source of truth for market, account, orders, and fills | Guarantee a risk estimate or a profit |

## Repository map

| Path | Purpose |
| --- | --- |
| [`src/agent/server.ts`](./src/agent/server.ts) | Signal402 MCP tools and the mandatory workflow |
| [`src/seller/index.ts`](./src/seller/index.ts) | Stateful Seller API, dashboard, approval routes, and health check |
| [`src/lib/binanceMcp.ts`](./src/lib/binanceMcp.ts) | Optional approved direct MCP client and encrypted token cache. Supported host mode remains the default |
| [`src/lib/futuresRisk.ts`](./src/lib/futuresRisk.ts) | Pure deterministic DeltaZero based Futures risk envelope |
| [`src/lib/executionPlan.ts`](./src/lib/executionPlan.ts) | Hash bound, 60 second, single use execution plans |
| [`src/lib/executionReceipt.ts`](./src/lib/executionReceipt.ts) | Ordered hash verified order evidence |
| [`src/lib/riskState.ts`](./src/lib/riskState.ts) | Persistent kill switch and equity drawdown state |
| [`src/lib/carryEconomics.ts`](./src/lib/carryEconomics.ts) | Binance CEX Spot and Futures carry report, report only |
| [`src/buyer/riskGuardian.ts`](./src/buyer/riskGuardian.ts) | Live USDT balance gate for Spot proposals |
| [`.agents/skills/signal402-binance/`](./.agents/skills/signal402-binance/) | Reusable Agent Skills contract for real Binance operation |
| [`test/`](./test/) | Deterministic risk, schema, security, and fill proof tests |
| [`web/`](./web/) | Safe public Vercel front door with no account data |
| [`SIGNAL402_AGENT.md`](./SIGNAL402_AGENT.md) | Host contract and exact tool sequence |

## What the buyer receives

Signal402 does not expose a raw ticker wrapper. It returns a verified market intelligence artifact for a requested symbol. The Seller returns the live Binance snapshot plus an explainable screening result:

1. Direction from the 24 hour move.
2. Risk tier from momentum and the observed 24 hour range.
3. Confidence based on the completeness of the live snapshot.
4. A deterministic `BUY_SMALL` or `WAIT` action.
5. The thesis and the rule that invalidates the result.

The action is not a profit promise. `BUY_SMALL` only permits the next safety checks. `WAIT` blocks proposal creation. The Buyer still reads the live Agentic subaccount, applies Risk Guardian, and waits for dashboard approval. The artifact is an independently produced, timestamped interpretation rather than a raw price feed.

The screening rules are visible and deterministic. A move of at least 1 percent is bullish, a move of at most negative 1 percent is bearish, and high risk starts at an absolute move of 8 percent or a 24 hour range of 12 percent. Only bullish, non high risk snapshots produce `BUY_SMALL`.

Signal402 also publishes a Binance CEX carry report when the host supplies both Spot and Futures market inputs. It shows basis, signed funding carry, round trip fees, spread, slippage, net expected carry, and a break even estimate. It is a transparent research artifact. It is always `reportOnly` and cannot submit a Spot and Futures hedge.

## Public frontend and live console

The repository includes a small public Vercel front door in [`web/`](./web/). It explains the workflow and its hard boundaries without exposing credentials, balances, or fake market values. The live operator console is the Express app at `http://localhost:3001` because its authenticated approval state, Binance OAuth host connection, and audit trail must remain on a stateful agent host. A Vercel static deployment is therefore a product entry point, not a claim that Vercel is executing trades.

Open the deployed public front door at [signal402-three.vercel.app](https://signal402-three.vercel.app/). It is intentionally informational. Do not enter Binance credentials into it.

The local console uses a compact execution control room layout. It keeps MCP state, data source, access mode, risk status, approval, order evidence, and the Futures event trail visible. A `MCP: FALLBACK` label means the optional public REST source is active. It never means that Binance account or order data came from the fallback.

## Free agent access

Signal402 provides free access. MCP, CLI, and HTTP agents can request the live briefing directly. Free access is not read only. Agents can publish live MCP context, run the risk gates, create proposals, and request real Binance orders when the dashboard approval, confirmation, account, and safety rules pass. The dashboard shows `ACCESS: FREE`. This mode does not weaken live Binance MCP data, Risk Guardian, dashboard approval, the 10 USDT order cap, Futures limits, or audit logging.

## Run with your own account

The Spot order uses the Binance Agentic subaccount. Fund it with a small amount before using production funds.

### Preflight

| Check | Required state |
| --- | --- |
| Node.js | Node 22 or newer |
| Binance MCP | Official `https://agent.binance.com/mcp/agentic` server connected in a supported host |
| Binance scopes | Market data, Account, and Trade only. No transfer or withdrawal scope |
| Seller | Running locally with a long random `SIGNAL402_HOST_TOKEN` |
| Dashboard | Password hash and session secret configured |
| Spot funds | Agentic subaccount has enough USDT for the capped order and fees |
| Access | Always free. No credentials beyond the supported Binance host are required |

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

4. Start the Seller.

   ```sh
   npm run start:seller
   ```

   The Seller does not authenticate to Binance in host mode. The supported MCP host performs Binance login and asks for Market data, Account, and Trade scopes for the Agentic subaccount. Do not grant a transfer scope. Binance Agent OS does not provide a withdrawal scope.

5. Add two MCP servers to a supported host such as Codex Desktop, Codex CLI, Claude, Cursor, or ChatGPT. Binance owns the OAuth flow. Signal402 does not open a custom OAuth page or store Binance tokens.

   Binance MCP:

   ```sh
   codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic
   ```

   Signal402 MCP, from the repository directory:

   ```sh
   codex mcp add signal402-agent --env SIGNAL402_HOST_TOKEN=$SIGNAL402_HOST_TOKEN --env SELLER_ENDPOINT_URL=http://localhost:3001 -- npx tsx "$PWD/src/agent/server.ts"
   ```

   In supported host mode, the MCP host is the Buyer. Do not also run `npm run start:buyer`; that legacy standalone process is not part of the host workflow.

6. Open [http://localhost:3001](http://localhost:3001). Sign in with the dashboard password. The header must show `MCP: LIVE` after the host publishes a live ticker. `DATA: FALLBACK` is allowed only when `ALLOW_PUBLIC_REST_FALLBACK=true` and is clearly labelled.

7. Fund the Agentic subaccount with USDT using the Binance web UI. The documented path is Profile, Dashboard, Subaccount, Asset Management, Transfer. Keep at least 10 USDT available for the capped Spot order.

8. In the supported host, call `signal402_get_workflow` and follow the returned workflow. The host discovers Binance tool names at runtime, publishes the live market snapshot, requests the free briefing, and stops when the Seller returns `WAIT` or creates the proposal when the Seller returns `BUY_SMALL`. It then waits for the dashboard `APPROVE`, submits one real MARKET BUY capped at 10 USDT, reads the real fill and balances, and records the Binance evidence.

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

Signal402 requires isolated margin and reads the existing leverage. It never changes leverage, margin mode, or position mode automatically. Futures orders use an explicit symbol, side, position side, quantity, and `reduceOnly` value. `quoteOrderQty` is never sent. Every directional USD M order needs dashboard `APPROVE` and a separate `CONFIRM` step. The host then submits one live MARKET order through its runtime discovered Binance Futures MCP tool and records authenticated order and account events. The dashboard shows the order ID, fill, position, margin, and event timeline only when those values came from Binance.

The risk envelope is a risk estimate, not a guaranteed loss limit. Liquidation, fees, funding changes, latency, and exchange execution can produce a different result. Keep the Agentic Futures wallet funded only with an amount you can lose, and use Binance's emergency stop if needed.

The implementation follows the [Binance Agent OS agentic MCP documentation](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic) and records the authenticated order and account events described by [Binance Futures user data streams](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/user-data-streams).

## Supported host architecture

Binance Agent OS currently authorizes approved AI hosts. Signal402 therefore runs as a local MCP server beside the official Binance MCP server. The host owns Binance OAuth and calls both servers. Signal402 owns the briefing state, Risk Guardian, dashboard approval gate, and append only audit log.

The host bridge accepts only live market data and fill records that identify their Binance MCP source. When publishing Spot data, pass the complete runtime discovered Binance tool list, including the balance and order tools that may be used after approval. It rejects missing runtime tool names, invalid balances, missing order fields, fills before dashboard approval, and amounts above the hard 10 USDT cap. Signal402 never accepts simulated order evidence.

Every eligible proposal also receives a 60 second execution plan. The plan binds the exact symbol, side, quantity, notional, position side, reduce only value, existing leverage, margin mode, source hashes, and expiry. A plan can be approved once and consumed once. A changed or stale plan is refused. A reconciled live order produces an ordered execution record with the plan hash, real Binance MCP tool name, order ID, fill values, before and after account state, and a SHA 256 proof hash.

The dashboard exposes a persistent risk control. An operator can enable the kill switch, and the host can publish live equity. A two percent drawdown shows a warning. A three percent drawdown halts new proposals. The state is written atomically to `state/signal402-risk.json`, which is ignored by Git. Clearing a kill switch never cancels an existing Binance order. A drawdown halt can be reset only from the authenticated dashboard after the recovery check and a typed `RESET_HALT` confirmation.

The older direct `BinanceMcpClient` remains only as an isolated path for a future Binance approved client. It is not the default and must not be used to bypass the supported host flow.

## Safety model

The safety model is enforced in server code and strict schemas. It is not only a prompt instruction.

| Gate | Enforcement |
| --- | --- |
| Account access | Binance OAuth stays in the supported MCP host. Signal402 never receives the host token. |
| Spot size | One `MARKET BUY` only. The quote amount is capped at 10 USDT. |
| Balance | The host reads USDT before proposal and again before the order. A balance below the proposed amount refuses the trade. |
| Human control | Every write needs dashboard `APPROVE`. Futures also needs `CONFIRM` for the exact order fields. |
| Futures | Isolated margin only, existing leverage at or below 3x, combined notional at or below 10 USDT, and no automatic leverage or margin changes. |
| Futures modes | Neutral analysis and all COIN M paths are report only. Directional USD M opening orders need a declared protective stop plan. |
| Evidence | A fill is recorded only when Binance returns an order ID, filled price, quantities, and changed before and after account or position snapshots. |
| Execution plan | A plan expires after 60 seconds, binds all order fields, and cannot be reused after a terminal state. |
| Persistent controls | The operator kill switch and drawdown halt block new proposals across process restarts. |
| Carry | Binance CEX carry is report only. It never creates a two leg hedge. |
| Prohibited actions | No withdrawals, transfers, hidden retries, fake values, or public REST account and order reads. |

No withdrawal permission is requested or available. In supported host mode, Binance OAuth tokens remain inside the supported MCP host and are never handled by Signal402. The isolated direct client is disabled unless Binance approves it and stores only an encrypted token cache. The order is always a Spot `MARKET BUY`, never larger than 10 USDT, and requires the dashboard `APPROVE` action. The host checks real USDT immediately before proposal and again immediately before order. It reads balances after the order and refuses to call the dashboard `filled` state unless Binance returns a real order ID and filled price. Every material action is appended to `logs/signal402.jsonl`; the log is ignored by Git.

For a refusal test, use a real account with less than the proposed amount. Do not set a fake balance variable. If the live balance is too low, the dashboard shows the red `RISK GUARDIAN: refused` state and no order call is made.

## Security controls

Secrets stay in environment variables or the Binance host. The browser receives no API key, access token, private key, or wallet credential. If the approved direct client is used, its OAuth token state is encrypted with AES 256 GCM in `.mcp-tokens.json` and the file is ignored with mode `0600`. The local audit log is redacted by default and can encrypt its details with `SIGNAL402_AUDIT_ENCRYPTION_KEY`; production should set `SIGNAL402_REQUIRE_AUDIT_ENCRYPTION=true`.

The Seller sends security headers, limits JSON bodies to 32 KB, restricts CORS to `SIGNAL402_ALLOWED_ORIGINS`, rejects unknown fields with Zod schemas, and returns trimmed state without raw MCP payloads. Dashboard state and approval require the dashboard session. Host market, proposal, status, and state writes require the bridge token. Trade status cannot be changed by editing a client field: the server checks the configured symbol, ten USDT cap, approval state, runtime MCP tool name, order fields, and before and after balance changes.

Set `SIGNAL402_FORCE_HTTPS=true`, `SIGNAL402_COOKIE_SECURE=true`, and `SIGNAL402_TRUST_PROXY=true` only when a trusted TLS reverse proxy is in front of the Seller. Run `npm audit` before deployment. Signal402 has no database, SQL query layer, password table, or file upload endpoint, so public database keys, row level security, query parameterization, and upload validation are not applicable until those components are added.

## Evidence standard

Local tests prove deterministic rules and rejection paths. They do not prove Binance OAuth, account funding, or a real fill. Live acceptance requires all of the following to be visible in the audit trail and dashboard:

1. A live Binance MCP tool name and timestamped market or Futures context.
2. An explicit free access state.
3. The risk envelope and the exact proposal fields.
4. Human dashboard approval and, for Futures, typed `CONFIRM`.
5. A real Binance order ID, fill, event, and before and after balance or position snapshots.

Never present a test fixture or a public REST price as live Binance trading evidence.

### Local release checks

Run the same checks used by GitHub Actions before publishing a change:

```sh
npm run build
npm test
npm audit --audit-level=moderate
git diff --check
```

## Configuration

See [`.env.example`](./.env.example). Keep `.env`, `.mcp-tokens.json`, and audit logs out of Git. Use the supported Binance MCP host for live account access.
