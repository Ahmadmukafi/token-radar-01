# Token launch radar — round 4 notes

## What changed vs round 3

Round 3's disclosed weakness was the Risk Curator multiple: 0.904 rested on a
single token observation (2.975x) shrunk toward the median with prior weight 3.
Twelve of the forty watchlist rows are Risk Curators, so that one point carried
a large share of the board. Round 4 fixes it three ways:

1. **Wider shrinkage prior (weight 5, was 3).** Risk Curators now get
   (2.975 + 5 × 0.214) / 6 = 0.674 instead of 0.904. Every category with
   one observation is pulled most of the way to the global median.
2. **Winsorization at 3x before the median.** The Prediction Market category's
   single observation is 400x; uncapped it would poison its own multiple.
   Capped at 3x first, it shrinks to 0.671 — still the top of its range,
   but no longer absurd.
3. **A confidence discount as a fifth factor.** High (n≥5) = 1.00, medium
   (2–4) = 0.97, low (1) = 0.92, none (0) = 0.88. The multiple table and
   every detail panel show the observation count and the confidence badge,
   so the model admits what it does not know instead of hiding it.

## The board

198 rows — exactly the set of genuine launch candidates in the snapshot:
every protocol that records no token and passes the house exclusion rule
(no version marker, no Bridge/Canonical Bridge/Liquid Staking/Liquid
Restaking/Restaked BTC/CEX category, no whole word wrapped/staked/staking,
no exchange-name prefix). The 40 watchlist rows are a subset; the other 158
are the below-floor candidates the radar exists to find. Rank 1 is the
highest implied value; ranks are 1–198 with no ties broken by fiat.

## The model

implied = TVL × category multiple × growth × maturity × breadth × confidence

- **Category multiple**: median mcap/TVL of token-bearing protocols in the
  category, winsorized at 3x, shrunk toward the global median 0.214 with
  prior weight 5, clamped 0.05–1.50.
- **Growth**: 1 + 7-day TVL change, clamped ±30%; 1.00 when unreported.
- **Maturity**: 0.85 + 0.15 × min(age ÷ 3 years, 1); 0.925 when unlisted.
- **Breadth**: 1 + 0.05 per extra chain, capped at 1.20.
- **Confidence**: 1.00 / 0.97 / 0.92 / 0.88 by observation count.

## The page

- The top rows are visible without scrolling; the method box is one slim bar
  (the full method and the multiples table expand on demand).
- The implied-value column carries a bar so relative size is visible at a
  glance; the multiple column carries a confidence dot (green/amber/red/grey).
- The watchlist filter is amber and one click away; the detail panel shows
  the full five-factor arithmetic and the five farm steps.
- Farm plans: 5 steps per row, tailored by category (12 templates + generic
  fallback), naming the chain, the gas cost on that chain, a position size
  by TVL tier ($100–$1,000 under $50M; $500–$5,000 at $50–250M;
  $2,000–$10,000 at $250M–$1B; $5,000–$20,000 above $1B) and a holding
  period (3–6 months, 6–12 months above $250M TVL).

## Honest limits

- The snapshot records no token for these protocols; that is not proof any
  of them has none, and an implied value is this entry's own claim, never a
  promise a token launches or what it would trade at.
- Categories with no token observation use the global median outright; the
  confidence discount (0.88) is the price of that ignorance, shown in the
  open.
- A 7-day TVL change is a noisy growth signal; it is clamped to ±30% so a
  single week cannot dominate a ranking.
