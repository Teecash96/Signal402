# Signal402

Signal402 is a real Binance Agent OS demonstration. A Seller Agent reads live market data through Binance Agentic MCP and sells a briefing through Binance B402 x402. A Buyer Agent pays with the Binance Agentic Wallet, reads its real Agentic subaccount balance, and submits one real Spot MARKET BUY only after the human presses `APPROVE` in the dashboard.

There are no simulated payments, receipts, balances, fills, or order IDs.

## Run with your own account

The MCP account and the x402 wallet are different Binance products. The Spot order uses the Binance Agentic subaccount. The x402 payment uses the Binance Agentic Wallet on BSC. Fund both with small test amounts before using production funds.

1. Clone and install.

   ```sh
   git clone https://github.com/Teecash96/Signal402.git
   cd Signal402
   npm install
   cp .env.example .env
   ```

2. Apply for Binance B402 merchant credentials. Binance gives the production base URL, `clientId`, `accessToken`, and the Base64 PKCS#8 RSA private key after onboarding. Set them in `.env`, together with a seller BSC address in `B402_PAY_TO`. This repository refuses to issue a fake challenge when these values are missing.

3. Make sure the Binance Agentic Wallet CLI is installed and logged in. The executable must be available as `baw`, or set `BINANCE_AGENTIC_WALLET_BIN` to its path. The Buyer uses the documented commands `baw x402-payment preview` and `baw x402-payment sign`.

4. Start the Seller.

   ```sh
   npm run start:seller
   ```

   The first MCP request opens Binance login in the browser. Grant Market data, Account, and Trade scopes for the Agentic subaccount. Do not grant a transfer scope. Binance Agent OS does not provide a withdrawal scope.

5. Open [http://localhost:3001](http://localhost:3001). The header must show `MCP: LIVE`. The market card must show `DATA: MCP LIVE`. `DATA: FALLBACK` is allowed only when `ALLOW_PUBLIC_REST_FALLBACK=true` and is clearly labelled.

6. Fund the Agentic subaccount with USDT using Binance web UI. The documented path is Profile, Dashboard, Subaccount, Asset Management, Transfer. For a real order, keep at least 10 USDT available and use a small account first.

7. Start the Buyer in a second terminal.

   ```sh
   npm run start:buyer
   ```

   The Buyer requests the report. At the x402 prompt, confirm the exact 0.01 USDC payment by typing `PAY`. The Buyer signs only after this confirmation. When the proposal appears, open the dashboard and press `APPROVE`. The Buyer then reads the live balance again, submits a real MARKET BUY capped at 10 USDT, reads balances again, and prints the real order ID and filled price.

## MCP OAuth flow implemented here

The official Agentic MCP endpoint is:

```text
https://agent.binance.com/mcp/agentic
```

The flow is standard MCP OAuth with PKCE:

1. The MCP request returns HTTP 401 with a `WWW-Authenticate` resource metadata URL.
2. The client reads the protected resource metadata. Binance points to `https://agent.binance.com` as the authorization server.
3. The authorization metadata is discovered. The current Binance endpoints are `https://accounts.binance.com/agentic-oauth/authorize` and `https://accounts.binance.com/oauth-agentic/token`. The token endpoint accepts public clients with no client secret and supports `authorization_code` and `S256` PKCE.
4. Binance supports URL based client metadata. Signal402 publishes [`client-metadata.json`](./client-metadata.json) and uses its HTTPS URL as the client ID. The client creates a PKCE verifier, opens the Binance login URL, and receives the code at `http://localhost:8765/oauth/callback`.
5. The client exchanges `code`, `code_verifier`, `redirect_uri`, and the metadata URL for tokens. Tokens, the verifier, client information, and discovery metadata are stored in `.mcp-tokens.json`, which is gitignored.
6. The client reconnects with the access token and calls `tools/list`. It prints the exact tools returned by the account at runtime. Binance’s public Agentic MCP documentation describes capability groups but does not promise stable tool names, so Signal402 never hardcodes them. It selects ticker, balance, and Spot order tools from their live names and schemas.

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

The signed response supplies a `PAYMENT-SIGNATURE` header. The Buyer replays the request with that header. B402 verifies, settles, and returns `PAYMENT-RESPONSE`, whose Base64 JSON contains the settlement transaction hash. The Seller delivers the briefing only after `/verify` is valid and `/settle` returns success with a nonempty transaction hash. A pending transaction is polled. A failed or unsigned payment never produces a briefing.

## Safety model

No withdrawal permission is requested or available. The MCP token is stored locally and never logged. The order is always a Spot `MARKET BUY`, never larger than 10 USDT, and requires the dashboard `APPROVE` action. The Buyer checks real USDT immediately before proposal and again immediately before order. It reads balances after the order and refuses to call the dashboard `filled` state unless Binance returns a real order ID and filled price. Every material action is appended to `logs/signal402.jsonl`; the log is ignored by Git.

For a refusal test, use a real account with less than the proposed amount. Do not set a fake balance variable. If the live balance is too low, the dashboard shows the red `RISK GUARDIAN: refused` state and no order call is made.

## Configuration

See [`.env.example`](./.env.example). Keep `.env`, `.mcp-tokens.json`, RSA keys, wallet credentials, and audit logs out of Git. Start with Binance B402 Sandbox where available. Production B402 access requires Binance partner onboarding and IP whitelisting.
