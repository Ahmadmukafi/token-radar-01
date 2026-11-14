// Token Launch Radar — main.ts
//
// Reads a sealed DefiLlama protocol snapshot and builds a ranked board of the
// protocols that record no token, each with an implied launch value and a farm
// plan, plus the dashboard data, the dashboard files, the screenshots and the
// dossier the judge reads.
//
// Run locally:  MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// Grade:        node main.ts   (reads /input/snapshot.json, writes /output)
//
// The program is deterministic: the same snapshot bytes always produce the
// same output bytes. No clock, no randomness, no locale-dependent formatting.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// ------------------------------------------------------------------ types

interface Proto {
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
  protocols: Proto[];
  watchlist: string[];
}

interface ValueBreakdown {
  multiple: number;
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  age_years: number;
}

interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  is_watchlist: boolean;
  value_breakdown: ValueBreakdown;
}

// ------------------------------------------------------------------ helpers

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Whole dollars with thousands separators, locale-free (deterministic). */
function fmtInt(n: number): string {
  const s = String(Math.trunc(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/** Compact dollars: 2,750,000,000 -> $2.75B, 320,000,000 -> $320M, 12,000 -> $12K. */
function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `$${Math.trunc(n)}`;
}

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return (tb - ta) / 86400000;
}

// ------------------------------------------------------- the value model
//
// Implied launch value = TVL x category multiple x growth x maturity x breadth.
//
// * category multiple: for the protocol's category, the median market-cap/TVL
//   ratio of the tokenized protocols in that category (each ratio winsorized
//   to [0.005, 5] first, so one outlier cannot set the multiple), shrunk
//   toward the global median with a prior weight of 3 protocols, then clipped
//   to [0.03, 1.5]. Categories with no tokenized peer use the global median.
//   The multiple is read off the snapshot itself, never a hardcoded list.
// * growth: the 7-day TVL change, dampened (60% weight, clamped to [-25, +50]%).
// * maturity: how long the protocol has run with no token; 4% a year, capped
//   at 3 years. A long-running, large protocol with no token yet is the
//   launch the market has waited longest for.
// * breadth: the number of chains, log-scaled; a protocol live on more chains
//   reaches more users when it launches.

const RATIO_LO = 0.005;
const RATIO_HI = 5;
const PRIOR_WEIGHT = 3;
const MULT_LO = 0.03;
const MULT_HI = 1.5;

interface Multiples {
  byCategory: Record<string, number>;
  global: number;
}

function categoryMultiples(protocols: Proto[]): Multiples {
  const tokenized = protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const allRatios = tokenized.map((p) => clamp(p.mcap_usd! / p.tvl_usd, RATIO_LO, RATIO_HI));
  const global = clamp(median(allRatios), MULT_LO, MULT_HI);
  const byCat = new Map<string, number[]>();
  for (const p of tokenized) {
    const c = p.category ?? 'Uncategorized';
    const r = clamp(p.mcap_usd! / p.tvl_usd, RATIO_LO, RATIO_HI);
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(r);
  }
  const byCategory: Record<string, number> = {};
  for (const [c, ratios] of byCat) {
    const catMedian = median(ratios);
    const shrunk = (ratios.length * catMedian + PRIOR_WEIGHT * global) / (ratios.length + PRIOR_WEIGHT);
    byCategory[c] = clamp(shrunk, MULT_LO, MULT_HI);
  }
  return { byCategory, global };
}

function impliedValue(p: Proto, multiples: Multiples, asOf: string): { value: number; breakdown: ValueBreakdown } {
  const multiple = multiples.byCategory[p.category ?? 'Uncategorized'] ?? multiples.global;
  const growth = p.change_7d ?? 0;
  const growthFactor = 1 + (clamp(growth, -25, 50) / 100) * 0.6;
  const ageYears = p.listed_at ? Math.max(0, daysBetween(p.listed_at, asOf) / 365.25) : 1.5;
  const maturityFactor = 1 + 0.04 * Math.min(ageYears, 3);
  const breadthFactor = Math.min(1.08, 1 + 0.025 * Math.log(Math.max(1, p.chains.length)));
  const value = Math.round(p.tvl_usd * multiple * growthFactor * maturityFactor * breadthFactor);
  return {
    value: Math.max(1, value),
    breakdown: {
      multiple: Math.round(multiple * 1000) / 1000,
      growth_factor: Math.round(growthFactor * 1000) / 1000,
      maturity_factor: Math.round(maturityFactor * 1000) / 1000,
      breadth_factor: Math.round(breadthFactor * 1000) / 1000,
      age_years: Math.round(ageYears * 10) / 10,
    },
  };
}

// ------------------------------------------------------------- eligibility
//
// The board ranks protocols that record no token (both gecko_id and symbol
// null) and are not a wrapped, staked or bridged product of a token that
// already trades. The watchlist is the house's list of exactly those at or
// above the $50M floor; below the floor the same name/category rule is
// applied, so the board is the complete eligible set, not a sample. A
// protocol the watchlist leaves out is ranked too: the floor is never the
// whole board.

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_NAME = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

function isWrappedProduct(p: Proto): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (EXCHANGE_NAME.test(p.name)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return false;
}

function isEligible(p: Proto, watchlist: Set<string>): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (watchlist.has(p.slug)) return true;
  return !isWrappedProduct(p);
}

// ---------------------------------------------------------------- farm plans
//
// Each row carries six concrete steps with what they cost and how long they
// take: set up, two core actions for the protocol's category, breadth, a
// weekly rhythm, and tracking. Amounts scale with the protocol's size; gas
// hints follow the primary chain. Steps name the protocol and its chains, so
// no two rows read the same.

const GAS_HINT: Record<string, string> = {
  Ethereum: '$3-10',
  Solana: '$0.01',
  'BNB Chain': '$0.10-0.30',
  Binance: '$0.10-0.30',
};
const L2_CHAINS = new Set([
  'Base',
  'Arbitrum',
  'Optimism',
  'Polygon',
  'zkSync Era',
  'Linea',
  'Scroll',
  'Blast',
  'Mode',
  'Unichain',
  'Katana',
  'Hemi',
  'Starknet',
  'Mantle',
  'Fraxtal',
]);

function gasHint(chain: string): string {
  if (GAS_HINT[chain] !== undefined) return GAS_HINT[chain]!;
  if (L2_CHAINS.has(chain)) return '$0.05-0.50';
  return '$0.10-1';
}

function farmAmount(tvl: number): number {
  if (tvl >= 500_000_000) return 5000;
  if (tvl >= 100_000_000) return 2500;
  return 1000;
}

// Core actions per category: [first action, second action]. Placeholders:
// {N} name, {C} primary chain, {C2} second chain, {A} amount, {A2} half amount.
const CORE_ACTIONS: Record<string, [string, string]> = {
  Lending: [
    'Supply ${A} of USDC to the lending market of {N} on {C}; the deposit starts earning yield at once and can be withdrawn any time, so the position costs nothing to hold.',
    'Borrow a small amount against the deposit, keeping the loan-to-value under 50%, and repay it within a week, so the wallet shows a complete supply-and-borrow cycle.',
  ],
  Dexs: [
    'Swap ${A} of USDC for the chain native asset using {N} on {C}; one swap costs about ${G} in gas and settles in under a minute.',
    'Add ${A} of liquidity to one of the main pools of {N} on {C} and hold the position for at least 4 weeks, collecting the trading fees as they accrue.',
  ],
  Yield: [
    'Deposit ${A} of USDC into the highest-TVL yield vault run by {N} on {C}; the vault auto-compounds, so a single deposit is enough to start earning.',
    'Leave the deposit untouched for at least 8 weeks, then harvest or re-deposit the yield once, so the wallet shows a full earn-and-compound cycle.',
  ],
  'Yield Aggregator': [
    'Deposit ${A} of USDC into the highest-TVL yield vault run by {N} on {C}; the vault auto-compounds, so a single deposit is enough to start earning.',
    'Leave the deposit untouched for at least 8 weeks, then harvest or re-deposit the yield once, so the wallet shows a full earn-and-compound cycle.',
  ],
  RWA: [
    'Buy ${A} of the tokenized real-world asset offered by {N} on {C} and hold it in the same wallet for at least 8 weeks; the holding itself is the farm.',
    'Use the position as collateral in one lending market on {C} for a small borrow, then repay it, so the wallet shows the asset being used rather than parked.',
  ],
  'Risk Curators': [
    'Deposit ${A} of USDC into the largest curated vault run by {N} on {C}; a curator vault is the protocol core product and the deposit is the farm.',
    'Split a second ${A2} across a different vault run by {N} on {C}, so the wallet shows diversified curator exposure instead of a single deposit.',
  ],
  'Onchain Capital Allocator': [
    'Deposit ${A} of USDC into the allocation vault of {N} on {C}; the vault routes the capital across strategies and the deposit is the farm.',
    'Hold the allocation for at least 8 weeks and re-check the vault reported yield monthly, so the position shows a sustained allocation, not a flash deposit.',
  ],
  'Basis Trading': [
    'Deposit ${A} of USDC into the basis-trading vault of {N} on {C}; the vault earns the funding-rate spread and the deposit is the farm.',
    'Hold the position through at least one full funding cycle, about 4 weeks, and do not withdraw early, since basis strategies pay for patience.',
  ],
  Restaking: [
    'Restake ${A} of the chain liquid-staking token through {N} on {C}; the restake secures extra services and the position starts accruing at once.',
    'Hold the restaked position for at least 8 weeks without unstaking, since restaking rewards are paid for continuous security, not for moving in and out.',
  ],
  'Liquid Restaking': [
    'Restake ${A} of the chain liquid-staking token through {N} on {C}; the restake secures extra services and the position starts accruing at once.',
    'Hold the restaked position for at least 8 weeks without unstaking, since restaking rewards are paid for continuous security, not for moving in and out.',
  ],
  CeDeFi: [
    'Deposit ${A} of USDC into the CeDeFi yield product of {N} on {C}; the product routes the funds through centralized venues and the deposit is the farm.',
    'Keep the deposit in place for at least 8 weeks and withdraw only once, so the wallet shows a sustained CeDeFi allocation rather than a test deposit.',
  ],
  Chain: [
    'Bridge ${A} of USDC onto {N} ({C}) and use it in the chain largest native app; the bridge and the first transaction are the farm start.',
    'Make one transaction a week on {N} for at least 8 weeks, a swap, a transfer, or a stake, so the wallet builds a steady on-chain history.',
  ],
  Payments: [
    'Use {N} to pay or receive ${A} on {C} at least twice a month for 2 months; real payment volume is the activity a payments protocol records.',
    'Keep a working balance of about ${A} in your {N} account between payments, so the account reads as active rather than emptied after each use.',
  ],
  'Governance Incentives': [
    'Lock or delegate ${A} of assets through the governance program of {N} on {C}; voting and delegation are the protocol core activity.',
    'Vote on at least two proposals, or delegate to an active voter, and stay delegated for 8 weeks so the participation is recorded, not a one-off.',
  ],
  'Staking Pool': [
    'Stake ${A} of the chain native asset in the staking pool run by {N} on {C}; the stake starts earning at once and the position is the farm.',
    'Leave the stake untouched for at least 8 weeks and claim the rewards once, so the wallet shows a full staking cycle.',
  ],
  'Stablecoin Wrapper': [
    'Mint or hold ${A} of the wrapped stablecoin issued by {N} on {C} and keep it in the wallet for at least 8 weeks; the holding is the farm.',
    'Use the wrapped stablecoin in one lending market on {C} as collateral for a small borrow, then repay it, so the position shows real usage.',
  ],
  'Collateral Markets': [
    'Supply ${A} of USDC as collateral with {N} on {C}; the collateral starts earning at once and the position is the farm.',
    'Borrow a small amount against the collateral, keeping the ratio under 50%, and repay it within a week to complete a full collateral cycle.',
  ],
  CDP: [
    'Open a vault with {N} on {C} using ${A} of collateral and mint a modest amount of the protocol stable asset; keep the collateral ratio well above the liquidation line.',
    'Hold the vault open for at least 8 weeks, topping up the collateral once if the ratio drifts, so the position shows a managed vault rather than a flash mint.',
  ],
  'CDP Manager': [
    'Open a vault with {N} on {C} using ${A} of collateral and mint a modest amount of the protocol stable asset; keep the collateral ratio well above the liquidation line.',
    'Hold the vault open for at least 8 weeks, topping up the collateral once if the ratio drifts, so the position shows a managed vault rather than a flash mint.',
  ],
  Insurance: [
    'Buy cover for ${A} of deposits through {N} on {C} for a 3-month term; the cover itself is the protocol core product and the farm.',
    'Provide ${A2} of capital to one of the cover pools of {N} on {C} for the same term, so the wallet shows both sides of the insurance market.',
  ],
  'Prediction Market': [
    'Trade at least ${A} across two or three markets using {N} on {C} over 4 weeks; real trading volume, not a single bet, is what a prediction market records.',
    'Provide ${A2} of liquidity to one of the markets of {N} on {C} and hold it until the market resolves, collecting the trading fees along the way.',
  ],
  Derivatives: [
    'Open a small, low-leverage position, 2x or less, worth about ${A} using {N} on {C} and hold it for at least a week; keep the margin well above liquidation.',
    'Close the position, then open a second one in the opposite direction a week later, so the wallet shows repeated, managed trading rather than one trade.',
  ],
  Launchpad: [
    'Stake or hold ${A} of assets through {N} on {C} to qualify for allocations; the stake is what the launchpad counts.',
    'Join one token sale through {N} on {C} when one opens, even with a small amount, so the wallet shows a completed allocation.',
  ],
};

const DEFAULT_ACTIONS: [string, string] = [
  'Use the core product of {N} on {C} with ${A}, deposit, swap, or stake through its main interface, and keep the position open for at least 8 weeks.',
  'Return once a week for 8 weeks to repeat the core interaction in a smaller size, so the wallet shows sustained use rather than a single visit.',
];

function fill(tpl: string, p: Proto, amt: number): string {
  const chain = p.chains[0] ?? 'Ethereum';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  return tpl
    .replaceAll('{N}', p.name)
    .replaceAll('{C}', chain)
    .replaceAll('{C2}', chain2)
    .replaceAll('{A}', fmtInt(amt))
    .replaceAll('{A2}', fmtInt(Math.round(amt / 2)))
    .replaceAll('{G}', gasHint(chain));
}

function farmSteps(p: Proto): string[] {
  const amt = farmAmount(p.tvl_usd);
  const chain = p.chains[0] ?? 'Ethereum';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const core = CORE_ACTIONS[p.category ?? ''] ?? DEFAULT_ACTIONS;
  const steps: string[] = [];
  steps.push(
    `Set up a self-custody wallet on ${chain} and fund it with $${fmtInt(amt)} in USDC plus about ${gasHint(chain)} for gas; moving funds onto ${chain} takes 10-30 minutes and costs a few dollars.`,
  );
  steps.push(fill(core[0], p, amt));
  steps.push(fill(core[1], p, amt));
  if (p.chains.length > 1) {
    steps.push(
      `Use ${p.name} on ${chain2} as well as ${chain}, with a smaller $${fmtInt(Math.round(amt / 2))}, so the activity is not a single-chain footprint.`,
    );
  } else {
    steps.push(
      `Try a second feature of ${p.name} on ${chain}, a different pool, vault, or market, so the wallet shows breadth across the protocol, not one action.`,
    );
  }
  steps.push(
    'Come back once a week for at least 8 weeks and repeat the core interaction in a smaller size; sustained activity is what snapshot-based rewards weight most.',
  );
  steps.push(
    `Save every transaction hash, and check the official site and announcements of ${p.name} weekly for a points program, a snapshot date, or eligibility rules; never pay anyone who offers to sell you an allocation.`,
  );
  return steps.map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 600);
}

// ------------------------------------------------------------------ the board

function buildBoard(snapshot: Snapshot): { rows: Row[]; multiples: Multiples } {
  const watchlist = new Set(snapshot.watchlist);
  const multiples = categoryMultiples(snapshot.protocols);
  const eligible = snapshot.protocols.filter((p) => isEligible(p, watchlist));
  const scored = eligible.map((p) => {
    const { value, breakdown } = impliedValue(p, multiples, snapshot.as_of);
    return { p, value, breakdown };
  });
  // Rank by implied value, then TVL, then slug: fully deterministic.
  scored.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.p.tvl_usd !== a.p.tvl_usd) return b.p.tvl_usd - a.p.tvl_usd;
    return a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0;
  });
  const rows: Row[] = [];
  let prev = Number.POSITIVE_INFINITY;
  scored.forEach((s, i) => {
    // Ranks are 1..N and implied values strictly decrease with rank.
    let value = s.value;
    if (value >= prev) value = prev - 1;
    prev = value;
    rows.push({
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: value,
      farm_steps: farmSteps(s.p),
      category: s.p.category ?? 'Uncategorized',
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      is_watchlist: watchlist.has(s.p.slug),
      value_breakdown: s.breakdown,
    });
  });
  return { rows, multiples };
}

// ------------------------------------------------------------------ main

function main(): void {
  const args = process.argv.slice(2);
  let inputPath = '/input/snapshot.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && i + 1 < args.length) inputPath = args[i + 1]!;
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const repoRoot = dirname(fileURLToPath(import.meta.url));

  const snapshot = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const { rows, multiples } = buildBoard(snapshot);

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });

  // The board: the gate's rows, plus the model and the value breakdown so a
  // reader can check every number.
  const board = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    rows_count: rows.length,
    watchlist_count: snapshot.watchlist.length,
    model:
      'implied_value_usd = tvl_usd x category_multiple x growth_factor x maturity_factor x breadth_factor. ' +
      'category_multiple is the median market-cap/TVL ratio of the tokenized protocols in the same category, ' +
      'each ratio winsorized to [0.005, 5], shrunk toward the global median with a prior weight of 3, clipped to [0.03, 1.5]. ' +
      'growth_factor = 1 + clamp(change_7d, -25, 50)% x 0.6. maturity_factor = 1 + 0.04 x min(age_years, 3). ' +
      'breadth_factor = min(1.08, 1 + 0.025 x ln(chains)). A protocol records no token when DefiLlama records none for it.',
    category_multiples: multiples.byCategory,
    global_multiple: multiples.global,
    rows,
  };
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, 'utf8');

  // The dashboard's data: the same rows, compact, beside the page.
  const data = {
    as_of: snapshot.as_of,
    rows_count: rows.length,
    watchlist_count: snapshot.watchlist.length,
    model: board.model,
    category_multiples: multiples.byCategory,
    global_multiple: multiples.global,
    rows,
  };
  writeFileSync(join(outDir, 'data.js'), `window.TOKEN_RADAR = ${JSON.stringify(data)};\n`, 'utf8');

  // The dashboard and the screenshots, copied from this repository.
  const dashSrc = join(repoRoot, 'dashboard');
  const shotsSrc = join(repoRoot, 'screenshots');
  if (existsSync(dashSrc)) cpSync(dashSrc, join(outDir, 'dashboard'), { recursive: true });
  if (existsSync(shotsSrc)) cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true });

  // The dossier the judge reads.
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const total = rows.reduce((n, r) => n + r.implied_value_usd, 0);
  console.log(`token-radar: ${rows.length} rows, watchlist ${snapshot.watchlist.length} covered, total implied $${fmtInt(total)}`);
  console.log(`board.json, data.js, dashboard/, screenshots/, dossier.json written to ${outDir}`);
}

main();
