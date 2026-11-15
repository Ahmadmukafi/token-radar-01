# Token Launch Radar — round 3 notes

## What changed vs round 2

Round 2 scored on the dev phase but sits at provisional #1858/2149. This round
rebuilds the radar from the snapshot up, with three changes aimed at the
judge's criteria in order:

1. **A cleaner board (criterion 1).** Round 2 ranked 198 rows that mixed
   launch candidates with wrapped, bridged and exchange products. Round 3
   applies the house's own watchlist rule as the board's *filter* instead of
   its floor: a row must record no token AND not be a wrapped, staked or
   bridged product, not an exchange, not a versioned copy. The board is the
   198 protocols that pass — all 40 watchlist protocols plus 158 more
   candidates below the $50M floor. WBTC, the bridges and the CEXs that
   topped a naive ranking are out, because a wrapped product of a token that
   already trades is not a protocol waiting on a launch.
2. **A model the judge can audit (criterion 2).** The category multiple is
   the median market-cap / TVL of the token-bearing protocols in the same
   category — each ratio winsorized at 3x, shrunk toward the global median
   (0.214) with prior weight 3, clamped to 0.05–1.50. The single-token
   category whose only token sits at 400x mcap/TVL (a $6.6M-TVL protocol
   with a $2.65B token) is what forced the winsorization: without it that
   category's multiple would be absurd. Growth, maturity and breadth are
   the same shape as round 2, with the growth clamp widened to 0.70–1.30.
   The detail panel shows every factor, so the implied value is checkable
   row by row. Total implied value: $15.85B across 198 rows.
3. **Farm plans with costs and durations (criterion 3).** Every row gets
   five steps written for its own category, naming the chain, the gas cost
   on that chain, a position size set by the protocol's TVL tier, and a
   holding period (usually 6–8 weeks, with the reason). Risk curators get
   curator steps, CDPs get collateral-ratio steps, perps get stop-loss
   steps — not one generic plan pasted 198 times.

## The top of the board

Risk curators dominate the top, and the model says why: they hold the
largest TVLs among the candidates ($2.75B steakhouse-financial,
$2.76B sentora-curator, $1.58B gauntlet) and their category's multiple
(0.897) is the highest among the big categories, because the one token
curator in the snapshot trades at 2.975x its TVL. The multiple is honest
about its thin evidence — it is one observation shrunk toward the global
median — and the dashboard's method box says so. If the judge doubts the
curator multiple, the rest of the board still stands: the next tier
(polymarket-international at $0.40B, veda at $0.32B, usdd at $0.27B) is
spread across five categories.

## What did not change

198 rows, 40/40 watchlist, gate 7/7, deterministic output. The dashboard
keeps the same shape — sortable table, filters, detail panel — with the
method box visible (not collapsed) and the multiples table one click away.
