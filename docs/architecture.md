# Signal402 architecture

Signal402 connects an agent client to live Binance context, a deterministic risk gate, and a human controlled execution boundary. The supported MCP host owns Binance OAuth and runtime tool discovery. Signal402 owns the briefing, risk decision, proposal, approval state, and redacted audit trail.

## System architecture

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
    ACCESS[Free access or optional B402]
    RISK[DeltaZero style Risk Guardian]
    DECISION{WAIT, refused, or eligible}
    MODE[Neutral and COIN M: report only]
    PLAN[Hash bound proposal]
    DASH[Approval dashboard]
    AUDIT[Redacted audit log]
  end

  BINANCE[(Binance Agent OS MCP)]
  B402[(Optional Binance B402 settlement)]

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
  ACCESS -->|free briefing| RISK
  ACCESS -->|paid terms| B402
  B402 -->|verified receipt| RISK
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

## Agent sequence

```mermaid
sequenceDiagram
  autonumber
  actor Trader
  participant Agent as Agent client
  participant Host as Supported MCP host
  participant Binance as Binance MCP
  participant Signal as Signal402
  participant Dashboard
  participant B402 as Optional B402
  participant Audit as Audit log

  Trader->>Agent: Ask for a market decision
  Agent->>Signal: signal402_get_workflow
  Host->>Binance: Discover tools and read live context
  Host->>Signal: signal402_publish_market
  Signal->>Signal: Validate freshness and source
  Agent->>Signal: signal402_request_briefing

  opt Paid B402 mode
    Signal-->>Agent: Exact payment terms
    Agent->>B402: Approve and settle exact payment
    B402-->>Signal: Verified receipt
  end

  Signal-->>Agent: Briefing with access state and evidence
  Agent->>Signal: signal402_assess_risk

  alt WAIT or refusal
    Signal-->>Agent: Stop before proposal
    Signal->>Audit: Record safe stop
  else Neutral or COIN M report only
    Signal-->>Agent: Report only with hedge or contract evidence
    Signal->>Audit: Record report
  else Eligible Spot or USD M direction
    Agent->>Signal: signal402_create_proposal
    Signal-->>Dashboard: Exact proposal and hash bound plan
    Trader->>Dashboard: APPROVE
    Dashboard-->>Agent: Approval recorded
    Agent->>Host: Fresh account read and revalidation
    Trader->>Dashboard: CONFIRM when Futures requires it
    Agent->>Binance: One capped order
    Binance-->>Agent: Real order and account events
    Agent->>Signal: Reconcile order, fill, and balances
    Signal->>Audit: Record verified evidence
  end
```

## Trust boundary legend

| Boundary | Signal402 allows | Signal402 refuses |
| --- | --- | --- |
| Supported MCP host | OAuth, runtime discovery, live account reads, and order calls | Invented tool names and public REST account or order data |
| Signal402 Seller | Briefings, risk decisions, proposals, approvals, and redacted audit records | OAuth tokens, API keys, fake receipts, and fake fills |
| Binance Agentic Wallet | Exact B402 payment signing when paid mode is configured | Trade approval and Binance order submission |
| Dashboard | Human approval and confirmation for the exact proposal | Credentials, tokens, or client supplied status changes |
| Binance | Market data, account state, payment settlement, orders, and fills | A promise of profit or a guaranteed loss limit |

## Operating modes

| Mode | Output | Order writes |
| --- | --- | --- |
| Free Spot | Live briefing with no receipt | One capped order may proceed after every gate |
| Paid Spot | Briefing after real B402 settlement | One capped order may proceed after every gate |
| USD M directional | Futures risk envelope and proposal when eligible | One isolated order may proceed after approval and confirmation |
| Neutral Futures | Hedge ratio and risk evidence | Report only |
| COIN M Futures | Contract risk evidence | Report only |

No path grants withdrawal or transfer access. A risk estimate is not a guaranteed loss limit.
