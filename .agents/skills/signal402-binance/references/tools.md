# Signal402 tool contract

The Signal402 MCP server exposes stable Signal402 tools. Binance tool names are not stable and are never hardcoded. The host must list Binance tools at runtime and pass the exact names as provenance. For Spot publication, pass the complete discovered list, including the balance and order tools that may be used after approval.

## Read and analysis tools

* `signal402_get_capabilities`
* `signal402_get_risk_state`
* `signal402_publish_market`
* `signal402_publish_futures_context`
* `signal402_publish_carry_context`
* `signal402_assess_risk`
* `signal402_assess_futures_risk`
* `signal402_get_carry_report`
* `signal402_get_state`

## Payment and proposal tools

* `signal402_request_briefing`
* `signal402_pay_briefing`
* `signal402_create_proposal`
* `signal402_create_futures_proposal`
* `signal402_wait_for_approval`
* `signal402_wait_for_futures_approval`
* `signal402_revalidate_futures_context`
* `signal402_confirm_futures_execution`

## Evidence tools

* `signal402_record_fill`
* `signal402_record_futures_event`

The evidence tools reject invented IDs and require source tool names, timestamps, and before and after account state. The server returns an immutable plan and, after reconciliation, a hash verified receipt.
