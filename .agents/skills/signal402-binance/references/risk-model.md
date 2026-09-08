# Risk model

The risk engine is pure TypeScript. It makes no network calls and never places an order.

## Spot

The Risk Guardian compares the live USDT free balance with the proposed quote amount. It refuses non finite balances, non positive amounts, amounts over 10 USDT, or an amount greater than the available balance. The market signal must also be `BUY_SMALL`. A `WAIT` result creates no order intent.

## Futures

The DeltaZero adapted envelope checks:

* data freshness and source provenance
* isolated margin and leverage at or below 3x
* combined position, open order, and requested notional at or below 10 USDT
* available margin plus fee reserve
* funding and next funding time
* order book depth, spread, and estimated slippage
* liquidation distance and exchange filter and leverage bracket verification
* explicit position side and reduce only semantics
* protective stop support for a new directional USDⓈ M position

Neutral and COIN M contexts are analytical. They return `reportOnly: true` and cannot create a write proposal. The gate does not estimate a guaranteed maximum loss.

## Persistent controls

The local risk state stores an operator kill switch and equity drawdown state. New proposals stop when the kill switch is enabled or the state is `HALTED`. The state is written atomically with restricted file permissions and contains no credentials. A halt is sticky and can be cleared only by the authenticated dashboard after the equity recovery check and a typed `RESET_HALT` confirmation. Clearing the state never cancels an existing Binance order.

## Binance CEX carry

Carry is calculated from Spot price, Futures mark, funding, horizon, fees, spread, and slippage. It reports basis, funding carry, round trip cost, net expected carry, and a break even estimate. The report is advisory and does not imply a permission to trade.
