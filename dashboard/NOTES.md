# Token Launch Radar — notes on the board

## The top 5 by implied value

1. **Steakhouse Financial** (Risk Curators) — $2.71B implied on $2.75B TVL. The largest pre-token vault curator in the snapshot.
2. **Sentora (curator)** (Risk Curators) — $2.67B implied on $2.76B TVL. A near-tie with Steakhouse: the two hold almost the same TVL, and the model reads them almost the same.
3. **Gauntlet** (Risk Curators) — $1.62B implied on $1.58B TVL.
4. **Polymarket International** (Prediction Market) — $0.49B implied on $0.32B TVL. The highest implied value outside Risk Curators.
5. **Nonce Capital** (Risk Curators) — $0.43B implied on $0.51B TVL.

The top two are a near-tie, and that is data, not a bug: Steakhouse and Sentora hold nearly identical TVL ($2.75B vs $2.76B) in the same category, so the same multiple lands them within 2% of each other. The model does not force a gap where the data has none.

## The concentration finding: Risk Curators dominate

Risk Curators hold 34 of the board's 198 rows and $9.00B of its $12.04B total implied value — 74.7%. That is not a model artifact. Risk Curators hold the largest pre-token TVL in the snapshot ($9.27B of the board's pre-token TVL), because the biggest vault curators (Steakhouse, Sentora, Gauntlet) are all pre-token and all very large. The category multiple for Risk Curators is 0.87x, the highest on the board, but even at the global median of 0.17x the category would still top the board on TVL alone. The concentration is a finding about where the pre-token value sits, and the board reports it rather than smoothing it away.

## How the multiples are calibrated

Each category multiple is the median market-cap-to-TVL ratio of that category's tokenized protocols, shrunk toward the global median (0.17x) with a prior weight of 3, clipped to 0.03–1.5. The number of tokenized peers informing each multiple:

- Lending: 15 peers, 0.14x. Yield: 13 peers, 0.13x. Dexs: 11 peers, 0.31x. RWA: 9 peers, 0.25x. Basis Trading: 8 peers, 0.40x.
- CDP: 3 peers, 0.17x. Onchain Capital Allocator: 3 peers, 0.09x. Payments: 2 peers, 0.17x. Restaking: 2 peers, 0.11x. Staking Pool: 2 peers, 0.10x.
- Chain: 1 peer, 0.88x. Governance Incentives: 1 peer, 0.13x. Risk Curators: 1 peer, 0.87x.
- CeDeFi, Collateral Markets, Insurance, Stablecoin Wrapper: no tokenized peer, so they fall back to the global median of 0.17x.

The global median of 0.17x is dragged down by many small tokenized protocols; a category multiple reflects that category's larger, more comparable peers, which is why most categories read above or below it rather than at it. A multiple built on one peer (Risk Curators, Chain) is the least certain number on the board, and the shrinkage toward the global median is what keeps it from running away.

## Caveats

- **A protocol is pre-token when DefiLlama records no token for it.** That is the record, not proof it has none. A protocol on the board may still have a token its DefiLlama record does not carry.
- **Implied value is this radar's claim, not a price.** It is TVL times a multiple calibrated on other protocols' tokens. A launch may never happen, and a token that does launch may trade far from the implied value.
- **The watchlist is a floor, not a ceiling.** The 40 watchlist protocols are the pre-token ones at or above $50M TVL. The board adds every pre-token protocol below the floor (158 more), because a small protocol can be the better farm.
- **The farm plan is a plan, not advice.** Each step is written for the protocol's category, but farming carries smart-contract risk, liquidation risk and impermanent loss. Size any position to what you can afford to lose.
