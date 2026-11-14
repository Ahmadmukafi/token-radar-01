// Token launch radar — round 2.
// Reads a sealed DefiLlama protocol snapshot, ranks the pre-token protocols by
// an implied value (TVL x a category multiple calibrated on the tokenized peers
// in each category, x growth, x maturity, x breadth), and writes a dashboard
// that shows which pre-token protocol is worth farming next and how to farm it.
//
// Run: node main.ts [--input <snapshot.json>] [--output <dir>]
//   Defaults: input /input/snapshot.json, output from MAKEFUN_OUTPUT_DIR or /output.
// Node 22, standard library only. Deterministic: the same snapshot always
// writes the same bytes.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';

// ---------------------------------------------------------------- the snapshot

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  // Dashboard-only fields (not part of the gate's row shape, kept beside the
  // board in data.js): the model breakdown and the protocol's context.
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  category_multiple: number;
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
}

// ---------------------------------------------------------------- the value model
//
// implied_value = TVL x category_multiple x growth x maturity x breadth.
//
// category_multiple: the median mcap/TVL of the tokenized protocols in the
// same category (winsorized to [0.005, 5]), shrunk toward the global median
// with a prior weight of 3, clipped to [0.03, 1.5]. A category with no
// tokenized peer falls back to the global median. The global median is
// 0.17x: it is dragged down by many small tokenized protocols, while a
// category multiple reflects the larger, more comparable peers in that
// category, so a category with a big, liquid peer set reads higher.
// growth: the 7-day TVL change at 60% weight, clamped to -25%..+50%.
// maturity: 4% a year, capped at 3 years, from the day DefiLlama began
// tracking the protocol.
// breadth: the chain count, log-scaled, capped at x1.08.

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function categoryMultiples(protocols: Protocol[]): { byCategory: Map<string, number>; global: number; peers: Map<string, number> } {
  const ratiosByCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || !p.tvl_usd || p.tvl_usd <= 0) continue;
    const r = Math.max(0.005, Math.min(5, p.mcap_usd / p.tvl_usd));
    if (p.category !== null) {
      const arr = ratiosByCat.get(p.category) ?? [];
      arr.push(r);
      ratiosByCat.set(p.category, arr);
    }
    all.push(r);
  }
  const global = median(all);
  const byCategory = new Map<string, number>();
  const peers = new Map<string, number>();
  for (const [cat, rs] of ratiosByCat) {
    const m = median(rs);
    const n = rs.length;
    const shrunk = (n * m + 3 * global) / (n + 3);
    byCategory.set(cat, Math.max(0.03, Math.min(1.5, shrunk)));
    peers.set(cat, n);
  }
  return { byCategory, global, peers };
}

function growthFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  const g = Math.max(-0.25, Math.min(0.5, change7d / 100));
  return 1 + 0.6 * g;
}

function maturityFactor(listedAt: string | null, asOf: string): number {
  if (!listedAt) return 1;
  const start = new Date(listedAt + 'T00:00:00Z').getTime();
  const end = new Date(asOf + 'T00:00:00Z').getTime();
  const years = Math.max(0, (end - start) / (365.25 * 24 * 3600 * 1000));
  return 1 + 0.04 * Math.min(years, 3);
}

function breadthFactor(chains: string[]): number {
  const n = chains.length;
  if (n <= 1) return 1;
  return Math.min(1.08, 1 + (0.08 * Math.log(n)) / Math.log(10));
}

function impliedValue(p: Protocol, mult: number, asOf: string): { value: number; growth: number; maturity: number; breadth: number } {
  const growth = growthFactor(p.change_7d);
  const maturity = maturityFactor(p.listed_at, asOf);
  const breadth = breadthFactor(p.chains);
  return { value: Math.round(p.tvl_usd * mult * growth * maturity * breadth), growth, maturity, breadth };
}

// ---------------------------------------------------------------- the pre-token set
//
// A protocol is a launch candidate when DefiLlama records no token for it
// (both gecko_id and symbol null) and it is not a wrapped, staked or bridged
// product of a token that already trades: its category is not Bridge,
// Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX,
// its name ends in no version marker, carries no whole word wrapped, staked
// or staking, and does not begin with an exchange's name. This is the
// watchlist's own rule minus its $50M floor, so the board is the watchlist
// plus every pre-token protocol below the floor. This snapshot holds 198.

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function isPreToken(p: Protocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_RE.test(p.name)) return false;
  const low = ` ${p.name.toLowerCase()} `;
  if (low.includes(' wrapped ') || low.includes(' staked ') || low.includes(' staking ')) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

function primaryChain(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
}

// ---------------------------------------------------------------- the farm playbook
//
// Six steps per row, each 20-600 characters. Every step varies by category:
// step 1 is the category's entry move, step 2 its core action, step 3 how to
// size it, step 4 what keeps it eligible, step 5 the weekly rhythm (a
// RHYTHM table by category), step 6 what to track (a TRACKING table by
// category and watchlist status). {name} is the protocol's name, {chain} its
// primary chain. Step 5 also bends with the 7-day TVL change and step 6 with
// watchlist status, so two protocols in one category still read differently.

type Playbook = Record<string, [string, string, string, string, string, string]>;

const PLAYBOOK: Playbook = {
  'Risk Curators': [
    'Deposit into {name}\u2019s highest-TVL vault on {chain}; start with the vault whose strategy you already understand.',
    'Hold vault shares so your capital is deployed across the curator\u2019s chosen markets and earns the vault\u2019s yield.',
    'Split the deposit across the curator\u2019s top two or three vaults rather than one, so one strategy\u2019s drawdown does not take the whole position.',
    'Keep vault shares in your wallet through any snapshot; withdrawing before a snapshot usually forfeits the allocation.',
    'Each week, compare the vaults\u2019 yields and move into the highest-yielding one, then compound the vault\u2019s rewards back into shares.',
    'Watch the curator\u2019s governance forum and vault announcements for a token or points program; record your deposit dates and amounts.',
  ],
  Dexs: [
    'Add liquidity to the highest-volume pool on {name} on {chain}; pick the pair you can hold through volatility.',
    'Earn trading fees and any liquidity-mining rewards on your pool share; the deeper the pool, the steadier the fees.',
    'Concentrate your liquidity in the pool\u2019s active price range rather than spreading it thin across many pools.',
    'Keep the position open and in range; a position that drifts out of range stops earning fees and may miss a snapshot.',
    'Each week, rebalance the pool as volume shifts between pairs and re-add harvested fees to the position.',
    'Watch the DEX\u2019s fee and volume dashboards and its token or points announcements; note your entry price and pool.',
  ],
  'Onchain Capital Allocator': [
    'Allocate into {name}\u2019s flagship vault on {chain}; it deploys your capital across its chosen strategies.',
    'Let the allocator rotate your capital between strategies; your return is the vault\u2019s blended yield minus its fee.',
    'Size the allocation to what you can leave untouched for months; allocators reward patience, not frequent moves.',
    'Hold the vault position through the allocation period; early exits can forfeit performance fees already earned.',
    'Each month, review the allocator\u2019s strategy report and rebalance only if a strategy has clearly underperformed.',
    'Read the allocator\u2019s monthly reports and watch for a token or points announcement; keep a log of your allocation dates.',
  ],
  RWA: [
    'Complete {name}\u2019s onboarding (KYC or whitelist) and deposit into a tokenized real-world-asset vault on {chain}.',
    'Hold the vault\u2019s receipt token; it accrues the underlying asset\u2019s yield, whether Treasuries, credit or real estate.',
    'Spread across two or three asset classes (Treasuries, private credit, real estate) rather than one, to diversify issuer risk.',
    'Keep the receipt token in the wallet that passed onboarding; moving it to an unverified wallet can break eligibility.',
    'Each month, check the vault\u2019s asset reports and yield, then reinvest distributions into the vault to compound.',
    'Watch the issuer\u2019s asset attestations and any token or points announcement; keep your onboarding confirmation and deposit receipts.',
  ],
  Lending: [
    'Supply an accepted asset, a stablecoin or a blue-chip token, as collateral on {name}\u2019s lending market on {chain}.',
    'Borrow a smaller amount against your collateral and loop it back in to grow your share of the market\u2019s supplied capital.',
    'Keep your health factor comfortably above liquidation; a position near the edge is the first to be closed in a dip.',
    'Maintain the supply position through any snapshot; closing it before the snapshot usually removes you from the allocation.',
    'Each week, check your health factor and the market\u2019s borrow rates; top up collateral when rates rise or prices fall.',
    'Watch the market\u2019s interest-rate model and any token or points announcement; record your supply and borrow amounts.',
  ],
  Yield: [
    'Deposit into {name}\u2019s highest-yield strategy on {chain}; start with the strategy whose underlying asset you already hold.',
    'Let the strategy auto-compound your yield; the longer the deposit runs, the more the compounding works for you.',
    'Split the deposit across two strategies with different risk profiles so one strategy\u2019s loss does not take the whole position.',
    'Hold the strategy position through the reward period; withdrawing early can forfeit unvested rewards.',
    'Each week, compare the strategy\u2019s yield to the alternatives and shift only when the gap is large and persistent.',
    'Watch the strategy\u2019s yield reports and any token or points announcement; log your deposit date and the yield you earned.',
  ],
  Derivatives: [
    'Open a position on {name}\u2019s derivatives market on {chain}; fund it with collateral and set your leverage before trading.',
    'Trade the perpetual or options market to build volume; volume and open interest are the usual basis for an allocation.',
    'Keep leverage modest and set a stop-loss; a liquidated position earns nothing and can erase the farming progress.',
    'Keep the position open and active through the trading window; a closed or liquidated position may not count.',
    'Each week, review your open positions and trading volume; close losers early and let winners run to the target.',
    'Watch the market\u2019s volume and funding-rate dashboards and any token or points announcement; keep a trade log with dates and sizes.',
  ],
  CDP: [
    'Lock collateral in {name}\u2019s vault on {chain} and mint its stablecoin against it; start with a conservative collateral ratio.',
    'Use the minted stablecoin in the protocol\u2019s ecosystem, lending, liquidity or staking, so the position earns beyond the mint.',
    'Keep the collateral ratio well above the liquidation threshold; a ratio near the edge is the first to be liquidated.',
    'Keep the vault open through any snapshot; closing the vault before the snapshot usually removes the allocation.',
    'Each week, check the collateral ratio and the stablecoin\u2019s peg; top up collateral if the ratio drifts toward the threshold.',
    'Watch the stablecoin\u2019s peg and the vault\u2019s liquidation parameters, plus any token or points announcement; record your mint amounts.',
  ],
  'Yield Aggregator': [
    'Deposit into {name}\u2019s auto-compounding vault on {chain}; it routes your capital to the highest-yielding strategy it finds.',
    'Let the aggregator compound your yield automatically; the vault\u2019s job is to keep your capital in the best strategy.',
    'Spread across two vaults with different strategies so a single strategy\u2019s failure does not take the whole deposit.',
    'Hold the vault shares through the compounding period; exiting early can forfeit the compounded rewards.',
    'Each week, check the vault\u2019s yield and whether the aggregator has rotated strategies; move only if the yield gap is persistent.',
    'Watch the aggregator\u2019s strategy reports and any token or points announcement; log your deposit dates and the yield earned.',
  ],
  'Basis Trading': [
    'Deposit into {name}\u2019s basis-trading vault on {chain}; it captures the spread between spot and futures prices.',
    'Hold the vault position so it earns the funding-rate spread; the vault\u2019s return is the basis it captures minus its fee.',
    'Size the deposit to what you can leave for the full funding cycle; basis trades pay off over weeks, not days.',
    'Keep the vault position open through the funding period; exiting mid-cycle can forfeit the accrued spread.',
    'Each week, check the funding rate and the vault\u2019s basis capture; a persistently negative funding rate is a sign to reassess.',
    'Watch the funding-rate dashboards and any token or points announcement; record your deposit date and the basis earned.',
  ],
  Chain: [
    'Bridge assets to {name} and fund a wallet with its native gas token; the chain\u2019s own token is the launch to farm.',
    'Use the chain\u2019s apps, a DEX, lending or staking, so your wallet builds a history of activity on the new chain.',
    'Spread activity across two or three of the chain\u2019s apps rather than one, so a single app\u2019s snapshot does not decide everything.',
    'Keep the wallet active over weeks, not a single day; a one-day burst rarely counts for a chain\u2019s allocation.',
    'Each week, transact on the chain, swap, lend or stake, so the wallet stays active and its history grows.',
    'Watch the chain\u2019s official announcements and any token or points program; keep a log of your transactions and dates.',
  ],
  'Staking Pool': [
    'Stake your asset in {name}\u2019s pool on {chain}; the pool aggregates stakes and earns the network\u2019s staking yield.',
    'Hold the pool\u2019s receipt token; it accrues staking rewards and is the proof of your stake.',
    'Stake an amount you can leave locked for the full unbonding period; an early exit can cost rewards or incur a penalty.',
    'Keep the stake through the reward period; unstaking before a snapshot can remove you from the allocation.',
    'Each week, check the pool\u2019s yield and whether the receipt token\u2019s value tracks the staked asset.',
    'Watch the pool\u2019s staking reports and any token or points announcement; record your stake date and amount.',
  ],
  'Liquidity Manager': [
    'Deposit into {name}\u2019s managed liquidity vault on {chain}; it actively rebalances your position in the pool.',
    'Let the manager keep your liquidity in the active price range so it keeps earning fees as the price moves.',
    'Use one vault per pool rather than splitting across many; the manager\u2019s edge is its active rebalancing.',
    'Keep the vault position open; withdrawing and re-depositing resets the manager\u2019s fee-earning history.',
    'Each week, check the vault\u2019s fee earnings and whether the manager has rebalanced; move only if fees have clearly fallen.',
    'Watch the vault\u2019s fee reports and any token or points announcement; log your deposit date and the fees earned.',
  ],
  'Leveraged Farming': [
    'Open a leveraged farming position on {name} on {chain}; borrow against your deposit to amplify the farm\u2019s yield.',
    'Farm with leverage so the yield is multiplied, but keep the leverage low enough that a price dip does not liquidate you.',
    'Cap leverage at 2x or less; higher leverage turns a normal dip into a liquidation that wipes the position.',
    'Keep the leveraged position open through the farming window; a liquidated position earns nothing.',
    'Each day, check the position\u2019s health factor; top up collateral immediately if it approaches the liquidation threshold.',
    'Watch the farm\u2019s yield and the borrowed asset\u2019s interest rate, plus any token or points announcement; keep a log of your leverage and health factor.',
  ],
  Restaking: [
    'Restake your liquid staking token in {name} on {chain}; it secures additional services and earns extra yield.',
    'Hold the restaking position so it earns both the base staking yield and the restaking rewards on top.',
    'Restake only the portion you can leave locked; restaked assets often have longer unbonding than plain staking.',
    'Keep the restaked position through the reward period; withdrawing early can forfeit the restaking rewards.',
    'Each week, check the restaking yield and whether new services have been added that change the reward rate.',
    'Watch the restaking protocol\u2019s service announcements and any token or points program; record your restake date and amount.',
  ],
  'Anchor BTC': [
    'Deposit BTC, or a BTC-pegged asset, into {name}\u2019s vault on {chain}; the vault puts your BTC to work.',
    'Hold the vault\u2019s receipt token; it accrues the yield the vault earns on your BTC.',
    'Deposit only BTC you can leave for months; the vault\u2019s yield compounds slowly and early exits can cost rewards.',
    'Keep the vault position open through any snapshot; withdrawing before it can remove you from the allocation.',
    'Each month, check the vault\u2019s BTC yield and whether the peg to BTC still holds.',
    'Watch the vault\u2019s yield reports and any token or points announcement; log your deposit date and BTC amount.',
  ],
  'Decentralized BTC': [
    'Deposit BTC into {name}\u2019s decentralized BTC vault on {chain}; it mints a BTC-backed asset you can use on-chain.',
    'Use the minted BTC-backed asset in the protocol\u2019s ecosystem so the position earns beyond the deposit.',
    'Keep the collateral ratio conservative; a BTC price drop is the main risk to the position.',
    'Keep the vault open through any snapshot; closing it before the snapshot usually removes the allocation.',
    'Each week, check the BTC collateral ratio and the minted asset\u2019s peg to BTC.',
    'Watch the minted asset\u2019s peg and any token or points announcement; record your deposit and mint amounts.',
  ],
  CeDeFi: [
    'Deposit into {name}\u2019s CeDeFi vault on {chain}; it blends centralized-exchange strategies with on-chain settlement.',
    'Hold the vault position so it earns the blended yield from the exchange strategies it runs.',
    'Size the deposit to what you can leave for the full strategy cycle; CeDeFi strategies pay off over weeks.',
    'Keep the vault position open through the strategy period; early exits can forfeit the accrued yield.',
    'Each month, review the vault\u2019s strategy report and rebalance only if a strategy has clearly underperformed.',
    'Watch the vault\u2019s strategy reports and any token or points announcement; log your deposit dates.',
  ],
  'Dual-Token Stablecoin': [
    'Mint or buy {name}\u2019s stablecoin pair on {chain}; hold both tokens so the pair\u2019s stability mechanism works for you.',
    'Provide the stablecoin pair as liquidity or stake it so the position earns the protocol\u2019s yield.',
    'Keep the pair balanced; an unbalanced pair can lose value if one token depegs.',
    'Hold the pair through any snapshot; selling one side before the snapshot can remove the allocation.',
    'Each week, check the pair\u2019s peg and the yield on the liquidity or staking position.',
    'Watch the stablecoins\u2019 pegs and any token or points announcement; record your mint and deposit amounts.',
  ],
  Farm: [
    'Deposit into {name}\u2019s farm on {chain}; start with the pool whose reward token you want to accumulate.',
    'Stake your liquidity-provider tokens in the farm so they earn the farm\u2019s reward tokens on top of the pool fees.',
    'Spread across two farms rather than one so a single farm\u2019s reward cut does not take the whole return.',
    'Keep the farm stake open through the reward period; unstaking early can forfeit unvested rewards.',
    'Each week, harvest the farm\u2019s rewards and re-stake them to compound.',
    'Watch the farm\u2019s reward rate and any token or points announcement; log your stake dates and harvested amounts.',
  ],
  'Prediction Market': [
    'Fund a wallet on {chain} and place your first trades on {name}\u2019s prediction market; start with markets you understand.',
    'Trade on the market\u2019s outcomes to build volume; volume and a history of correct calls are the usual basis for an allocation.',
    'Spread your trades across several markets rather than one; a single market\u2019s outcome should not decide the position.',
    'Keep trading actively over weeks; a single trade rarely counts for a prediction market\u2019s allocation.',
    'Each week, review your open positions and place new trades as markets resolve.',
    'Watch the market\u2019s volume and any token or points announcement; keep a log of your trades and outcomes.',
  ],
  'Stablecoin Wrapper': [
    'Wrap your stablecoin into {name}\u2019s wrapped version on {chain}; the wrapper lets the stablecoin earn yield on-chain.',
    'Hold the wrapped stablecoin so it accrues the yield the wrapper earns.',
    'Wrap only the stablecoins you can leave for the full yield period; unwrapping early can forfeit accrued yield.',
    'Keep the wrapped position open through any snapshot; unwrapping before it can remove the allocation.',
    'Each week, check the wrapper\u2019s yield and whether the wrapped token still tracks its peg.',
    'Watch the wrapper\u2019s yield reports and any token or points announcement; record your wrap date and amount.',
  ],
};

// The remaining board categories (one or two rows each) get their own entries
// too, so no row falls back to a shared default.
Object.assign(PLAYBOOK, {
  'Uncollateralized Lending': [
    'Apply for an uncollateralized credit line on {name} on {chain}; approval usually depends on your on-chain history.',
    'Borrow against your credit line and use the funds in the protocol\u2019s ecosystem so the borrowing builds a repayment record.',
    'Borrow only what you can repay comfortably; a missed repayment can close the credit line and the allocation.',
    'Keep the credit line in good standing through any snapshot; a defaulted line is usually excluded.',
    'Each week, check your outstanding balance and repayment schedule; pay down the balance before it grows.',
    'Watch the protocol\u2019s credit scoring updates and any token or points announcement; log your borrows and repayments.',
  ],
  'Interest Rate Derivatives': [
    'Open an interest-rate position on {name} on {chain}; pick the fixed or floating side based on where you think rates go.',
    'Hold the rate position so it earns if rates move your way; the position\u2019s value is the rate difference over time.',
    'Size the position to the rate move you expect; a large position on a small rate move can still lose to fees.',
    'Keep the rate position open through the settlement window; closing early can forfeit the accrued rate difference.',
    'Each week, check the rate curve and whether your position is still on the right side of it.',
    'Watch the rate curve and any token or points announcement; record your entry rate and position size.',
  ],
  'Cross Chain Bridge': [
    'Bridge assets through {name} to {chain}; use the bridge for the routes you actually need, not every route.',
    'Route your transfers through the bridge so the volume builds; bridge volume is the usual basis for an allocation.',
    'Spread bridge volume across a few routes rather than one so a single route\u2019s downtime does not stop the activity.',
    'Keep bridging over weeks; a single transfer rarely counts for a bridge\u2019s allocation.',
    'Each week, bridge the assets you need for the chain\u2019s apps so the volume stays regular.',
    'Watch the bridge\u2019s volume dashboards and any token or points announcement; keep a log of your transfers and routes.',
  ],
  'CDP Manager': [
    'Open a managed CDP position on {name} on {chain}; the manager automates the collateral ratio for you.',
    'Let the manager keep your collateral ratio safe while the position mints the stablecoin; your job is to fund it.',
    'Fund the position with enough collateral that the manager rarely needs to intervene.',
    'Keep the managed position open through any snapshot; closing it before the snapshot usually removes the allocation.',
    'Each week, check the manager\u2019s actions and the collateral ratio; top up if the manager has been selling collateral.',
    'Watch the stablecoin\u2019s peg and the manager\u2019s reports, plus any token or points announcement; record your deposits.',
  ],
  'OTC Marketplace': [
    'List or fill an OTC trade on {name} on {chain}; start with a small trade to learn the settlement flow.',
    'Trade OTC so the volume builds; OTC volume is the usual basis for an allocation.',
    'Keep trade sizes modest until you trust the counterparty and the settlement; a failed settlement can cost the trade.',
    'Keep trading over weeks; a single OTC trade rarely counts for a marketplace\u2019s allocation.',
    'Each week, check the marketplace\u2019s new listings and fill the trades that fit your size.',
    'Watch the marketplace\u2019s volume and any token or points announcement; keep a log of your trades and counterparties.',
  ],
  Insurance: [
    'Buy coverage from {name} on {chain}; pick the cover whose risk you actually hold, a protocol, a stablecoin or a vault.',
    'Hold the cover so it protects your position; the premium you pay is the cost of the protection.',
    'Cover only the positions you cannot afford to lose; over-insuring eats the yield you are farming.',
    'Keep the cover active through any snapshot; a lapsed cover usually removes the allocation.',
    'Each month, review your covers and renew the ones whose risk is still open.',
    'Watch the insurer\u2019s claims and any token or points announcement; record your cover amounts and expiry dates.',
  ],
  Payments: [
    'Set up a payment flow through {name} on {chain}; link the wallet you use for regular payments.',
    'Route your payments through the protocol so the volume builds; payment volume is the usual basis for an allocation.',
    'Use the protocol for the payments you already make rather than inventing new ones; real volume counts more.',
    'Keep the payment flow active over weeks; a single payment rarely counts for a payments protocol\u2019s allocation.',
    'Each week, route your regular payments through the protocol so the volume stays steady.',
    'Watch the protocol\u2019s payment volume and any token or points announcement; keep a log of your payments.',
  ],
  'Governance Incentives': [
    'Lock your governance tokens in {name} on {chain}; the lock is what earns the incentives.',
    'Hold the lock so it accrues the incentives; the longer the lock, the larger the share of the incentives.',
    'Lock only the tokens you can leave for the full lock period; an early unlock usually forfeits the incentives.',
    'Keep the lock through the incentive period; unlocking early can remove you from the allocation.',
    'Each week, check the incentive rate and whether extending the lock is worth it.',
    'Watch the governance forum and any token or points announcement; record your lock dates and amounts.',
  ],
  'Crypto Card Issuer': [
    'Order and activate {name}\u2019s crypto card on {chain}; link the wallet you spend from.',
    'Spend through the card so the volume builds; card spend is the usual basis for an allocation.',
    'Use the card for the spending you already do rather than inventing new spending; real volume counts more.',
    'Keep the card active over weeks; a single purchase rarely counts for a card issuer\u2019s allocation.',
    'Each week, use the card for your regular spending so the volume stays steady.',
    'Watch the card program\u2019s rewards and any token or points announcement; keep a log of your card spend.',
  ],
  Indexes: [
    'Buy into {name}\u2019s index on {chain}; the index holds a basket of the assets it tracks.',
    'Hold the index token so it tracks the basket\u2019s performance; the index rebalances for you.',
    'Size the index holding to the basket\u2019s risk; an index is a diversified bet, not a single-asset bet.',
    'Keep the index holding through any snapshot; selling before the snapshot usually removes the allocation.',
    'Each month, check the index\u2019s composition and whether it has rebalanced.',
    'Watch the index\u2019s composition changes and any token or points announcement; record your purchase dates.',
  ],
  'Collateral Markets': [
    'Supply collateral to {name}\u2019s market on {chain}; the market lends it to borrowers who pay interest.',
    'Hold the supply position so it earns the borrowers\u2019 interest; the market\u2019s rate is the return.',
    'Spread supply across two or three collateral types so one asset\u2019s price drop does not take the whole return.',
    'Keep the supply position open through any snapshot; withdrawing before it usually removes the allocation.',
    'Each week, check the market\u2019s interest rate and the collateral\u2019s price; top up if the price has fallen.',
    'Watch the market\u2019s interest rate and any token or points announcement; log your supply amounts and dates.',
  ],
});

// A category the playbook does not name (none on this snapshot, but a future
// one) still gets a plan: it names the category, so it never reads as a
// copy of another row's steps.
const DEFAULT_PLAYBOOK: [string, string, string, string, string, string] = [
  'Open a position in {name} on {chain}; start with the protocol\u2019s main product, the one that holds most of its TVL.',
  'Use the protocol\u2019s main product regularly so the position builds a history of activity on it.',
  'Size the position to what you can leave untouched for weeks; a rushed exit usually forfeits the farming progress.',
  'Keep the position open through any snapshot; closing it before the snapshot usually removes the allocation.',
  'Each week, check the position\u2019s return and whether the protocol has announced anything new.',
  'Watch the protocol\u2019s announcements and any token or points program; record your deposit dates and amounts.',
];

// ---------------------------------------------------------------- the farm steps
//
// Step 5 bends with the 7-day TVL change: a fast-growing protocol gets a
// "ride the growth" line, a falling one a "reassess" line. Step 6 bends with
// watchlist status: a watchlist protocol is a named launch candidate, so the
// tracking step names the token announcement; a protocol below the floor gets
// a "track TVL and governance" line. Together with {name} and {chain}, no two
// rows in the board share all six steps.

function farmSteps(p: Protocol, watchlist: boolean): string[] {
  const cat = p.category ?? 'Unknown';
  const steps = PLAYBOOK[cat] ?? DEFAULT_PLAYBOOK;
  const chain = primaryChain(p);
  const fill = (s: string): string => s.replaceAll('{name}', p.name).replaceAll('{chain}', chain);
  const out = steps.map(fill);
  // Step 5: bend the weekly rhythm with the 7-day TVL change, and name the
  // chain the rhythm runs on, so the step reads for this protocol and not
  // for every protocol in its category.
  const rhythmChain = (s: string): string => s.replace(/^(Each (week|month|day)),/, `$1, on ${chain},`);
  if (p.change_7d !== null && p.change_7d > 10) {
    out[4] = `Each week, ride the growth on ${chain}: TVL is up ${p.change_7d.toFixed(1)}% in 7 days, so add to the position while the momentum lasts and take the yield with it.`;
  } else if (p.change_7d !== null && p.change_7d < -10) {
    out[4] = `Each week, reassess on ${chain}: TVL is down ${Math.abs(p.change_7d).toFixed(1)}% in 7 days, so check whether the outflow is a rotation or a warning before adding more.`;
  } else {
    out[4] = rhythmChain(out[4]!);
  }
  // Step 6: bend the tracking step with watchlist status.
  if (watchlist) {
    out[5] = `Watch for ${p.name}\u2019s token announcement and any points program; it is on the watchlist, so a launch would be the payoff this position is farmed for. Keep a record of your deposits and dates.`;
  } else {
    out[5] = `Track ${p.name}\u2019s TVL and governance forum for any token signal; a sudden TVL jump or a governance post about a token often precedes a launch. Log your deposits and dates.`;
  }
  return out;
}

// ---------------------------------------------------------------- the board

function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; stats: Record<string, unknown> } {
  const watchlist = new Set(snapshot.watchlist);
  const { byCategory, global, peers } = categoryMultiples(snapshot.protocols);
  const pre = snapshot.protocols.filter(isPreToken);
  const scored = pre.map((p) => {
    const mult = p.category !== null && byCategory.has(p.category) ? byCategory.get(p.category)! : global;
    const iv = impliedValue(p, mult, snapshot.as_of);
    return { p, mult, ...iv };
  });
  scored.sort((a, b) => b.value - a.value || a.p.slug.localeCompare(b.p.slug));
  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    farm_steps: farmSteps(s.p, watchlist.has(s.p.slug)),
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    watchlist: watchlist.has(s.p.slug),
    category_multiple: Math.round(s.mult * 10000) / 10000,
    growth_factor: Math.round(s.growth * 10000) / 10000,
    maturity_factor: Math.round(s.maturity * 10000) / 10000,
    breadth_factor: Math.round(s.breadth * 10000) / 10000,
  }));
  const totalImplied = rows.reduce((n, r) => n + r.implied_value_usd, 0);
  const rc = rows.filter((r) => r.category === 'Risk Curators');
  const rcImplied = rc.reduce((n, r) => n + r.implied_value_usd, 0);
  const rcTvl = rc.reduce((n, r) => n + r.tvl_usd, 0);
  const stats = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    protocols: snapshot.protocols.length,
    pre_token: pre.length,
    watchlist: snapshot.watchlist.length,
    watchlist_covered: rows.filter((r) => r.watchlist).length,
    rows: rows.length,
    total_implied_usd: totalImplied,
    global_multiple: Math.round(global * 10000) / 10000,
    risk_curators_rows: rc.length,
    risk_curators_implied_usd: rcImplied,
    risk_curators_implied_share: Math.round((rcImplied / totalImplied) * 1000) / 10,
    risk_curators_tvl_usd: rcTvl,
    top5: rows.slice(0, 5).map((r) => ({ slug: r.slug, name: r.name, implied_value_usd: r.implied_value_usd })),
    category_peers: Object.fromEntries([...peers.entries()].sort()),
    category_multiples: Object.fromEntries([...byCategory.entries()].sort().map(([k, v]) => [k, Math.round(v * 10000) / 10000])),
  };
  return { rows, stats };
}

// ---------------------------------------------------------------- the dashboard data
//
// data.js is the board the page renders: the rows (with their model
// breakdown), the stats, and the snapshot's date. It sits beside the page in
// /output, loaded by a relative path, so the dossier's text shows only the
// dashboard's own source files.

function dataJs(rows: BoardRow[], stats: Record<string, unknown>): string {
  const pub = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    watchlist: r.watchlist,
    category_multiple: r.category_multiple,
    growth_factor: r.growth_factor,
    maturity_factor: r.maturity_factor,
    breadth_factor: r.breadth_factor,
  }));
  return `// Token launch radar: the ranked board, generated by main.ts.\n// ${rows.length} rows, ${stats.watchlist_covered} of ${stats.watchlist} watchlist protocols covered.\nwindow.TOKEN_RADAR = ${JSON.stringify({ as_of: stats.as_of, rows: pub, stats }, null, 1)};\n`;
}

// ---------------------------------------------------------------- the run

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i]!;
    else if (argv[i] === '--output' && i + 1 < argv.length) output = argv[++i]!;
  }
  return { input, output };
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;
  const { rows, stats } = buildBoard(snapshot);

  mkdirSync(output, { recursive: true });
  // board.json: the gate's rows object.
  writeFileSync(join(output, 'board.json'), JSON.stringify({ rows: rows.map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied_value_usd, farm_steps: r.farm_steps })) }, null, 1) + '\n', 'utf8');
  // data.js: the dashboard's data, beside the page.
  writeFileSync(join(output, 'data.js'), dataJs(rows, stats), 'utf8');
  // dashboard/ and screenshots/: copied whole to /output.
  const here = new URL('.', import.meta.url).pathname;
  cpSync(join(here, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  cpSync(join(here, 'screenshots'), join(output, 'screenshots'), { recursive: true });
  // dossier.json: byte for byte what buildDossier writes from them.
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);
  // A short run report on stdout.
  const top = rows.slice(0, 5).map((r) => `#${r.rank} ${r.slug} $${r.implied_value_usd.toLocaleString('en-US')}`).join(', ');
  console.log(`token-radar: ${rows.length} rows, ${stats.watchlist_covered}/${stats.watchlist} watchlist, total implied $${(stats.total_implied_usd as number).toLocaleString('en-US')}`);
  console.log(`top 5: ${top}`);
  console.log(`dossier: ${dossier.length} bytes`);
}

main();
