// Token Launch Radar — round 3.
// Reads a sealed DefiLlama protocol snapshot and ranks the protocols whose
// token does not exist yet by the implied value of a token they may one day
// issue, with a concrete farm plan for each one.
//
// Value model (every number comes from the snapshot itself; nothing is
// hardcoded by name):
//   implied = TVL x categoryMultiple x growth x maturity x breadth
//   categoryMultiple: the median market-cap / TVL of the token-bearing
//     protocols in the same category (each protocol's ratio winsorized at
//     3x so one tiny-TVL token cannot set a category), shrunk toward the
//     global median with a prior weight of 3, clamped to [0.05, 1.50].
//     A category with no token-bearing protocol uses the global median.
//     One snapshot record carries a market cap of -1 (a data quirk); the
//     model only counts strictly positive market caps and TVLs, so that
//     record cannot move any multiple.
//   growth:   1 + change_7d / 200, clamped to [0.70, 1.30] (no report: 1).
//   maturity: 1 + 0.4 x min(ageDays, 730) / 730 (no listed date: 1).
//   breadth:  1 + 0.02 x min(chains - 1, 15).
// The board ranks only launch candidates: protocols that record no token
// AND are not a wrapped, staked or bridged product of a token that already
// trades, not a centralised exchange, not a versioned copy (name ending in
// V2 / v2 / 2.0), and not named after an exchange. That is the house's own
// watchlist rule, applied as the board's filter instead of its floor: the
// 40 watchlist protocols are all in the board, and 158 more candidates
// below the $50M floor join them. Protocols whose token already trades
// (416) and wrapped/staked/bridged products (144) are not ranked, because
// there is no launch left to value; the dashboard says so in plain text.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

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
  age_days: number | null;
  category_multiple: number;
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  watchlist: boolean;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function parseArgs(): { input: string; output: string } {
  const argv = process.argv.slice(2);
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) input = argv[++i]!;
    else if (argv[i] === '--output' && argv[i + 1]) output = argv[++i]!;
  }
  return { input, output };
}

// ---------------------------------------------------------------- the filter

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A launch candidate: no token recorded, and not a wrapped, staked or
 *  bridged product of a token that already trades. */
function isCandidate(p: Protocol): boolean {
  if (p.gecko_id || p.symbol) return false;
  if (p.category && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  return true;
}

// ---------------------------------------------------------------- the model

interface Model {
  globalMedian: number;
  multiples: Record<string, number>;
}

function buildModel(protocols: Protocol[]): Model {
  // Token-bearing protocols, each ratio winsorized at 3x.
  const ratios = protocols
    .filter((p) => p.mcap_usd && p.tvl_usd && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => Math.min(p.mcap_usd! / p.tvl_usd, 3));
  const globalMedian = median(ratios);
  const byCat = new Map<string, number[]>();
  for (const p of protocols) {
    if (!p.mcap_usd || !p.tvl_usd || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (!p.category) continue;
    const list = byCat.get(p.category) || [];
    list.push(Math.min(p.mcap_usd / p.tvl_usd, 3));
    byCat.set(p.category, list);
  }
  const multiples: Record<string, number> = {};
  for (const [cat, list] of byCat) {
    const m = median(list);
    multiples[cat] = clamp((list.length * m + 3 * globalMedian) / (list.length + 3), 0.05, 1.5);
  }
  return { globalMedian, multiples };
}

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const a = Date.parse(asOf + 'T00:00:00Z');
  const b = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((a - b) / 86400000));
}

// ---------------------------------------------------------------- farm steps

const GAS: Record<string, string> = {
  Ethereum: '~$5-20 gas',
  Solana: '~$0.05-0.20 gas',
  Base: '~$0.10-1 gas',
  Arbitrum: '~$0.10-1 gas',
  Optimism: '~$0.10-1 gas',
  Unichain: '~$0.10-1 gas',
  Binance: '~$0.10-0.50 gas',
  Polygon: '~$0.05-0.30 gas',
  Avalanche: '~$0.20-1 gas',
};

function gasFor(chain: string): string {
  return GAS[chain] || '~$1-5 gas';
}

function amountFor(tvl: number): string {
  if (tvl >= 1_000_000_000) return '$2,000-10,000';
  if (tvl >= 100_000_000) return '$1,000-5,000';
  return '$500-2,000';
}

function fill(t: string, v: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] || '');
}

type StepFn = (v: Record<string, string>) => string[];
const S = (arr: string[]): StepFn => (v) => arr.map((t) => fill(t, v));

const STEPS: Record<string, StepFn> = {
  'Risk Curators': S([
    'Bridge {amount} in USDC to {chain} through the chain’s official bridge ({gas}, 10-20 min) and keep $20 aside for exit gas; a curator vault is not a wallet, so the funds must arrive on {chain} first.',
    'Deposit the USDC into {name}’s highest-TVL curated vault on {chain}: the curator allocates it across lending markets for you, so you do not pick positions yourself; confirm the vault’s stated strategy and fee before you confirm.',
    'Leave the deposit untouched for 6-8 weeks. Curators are usually scored on duration, not on one-off deposits, so a single week in and out earns little; check the vault’s yield once a week and do nothing unless the strategy changes.',
    'Add a second deposit of the same size in week 4 if the first one is earning as stated; never put more than 20% of your farming capital in one curator, because a single curator’s mistake is your loss.',
    'Exit in two moves: withdraw from the vault back to USDC on {chain} (one transaction, {gas}), then bridge out. If a withdrawal queue exists, start it 3-5 days before you need the money.',
  ]),
  Dexs: S([
    'Bridge {amount} to {chain} ({gas}, 10-20 min), split half into USDC and half into the chain’s native gas token, and keep $20 aside so a withdrawal never strands.',
    'Provide liquidity in {name}’s deepest pool on {chain} — usually the USDC / native-token pair — with the full {amount}; a $1,000+ position earns meaningful fees, while a $50 position earns dust.',
    'Hold the position 6-8 weeks and collect fees weekly; do not chase the highest-APY pool each day, because every move in and out costs gas and resets your time in the pool.',
    'If the pool is a concentrated-liquidity pool, set a wide range around the current price so the position stays in range for weeks; a narrow range earns more per day but goes out of range and stops earning.',
    'Exit by removing liquidity back to USDC and the native token in one transaction ({gas}), then bridge out. If one side of the pair has moved far, expect impermanent loss: the exit value can be below the deposit even when fees were earned.',
  ]),
  'Onchain Capital Allocator': S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas.',
    'Deposit into {name}’s allocation vault on {chain}: the allocator routes your capital across its strategies, so read the vault’s current allocation and fee once before you deposit, then let it work.',
    'Hold 8-12 weeks. Allocators compound slowly and are usually scored on how long capital stays, not on how often it moves; check the allocation monthly and move only if the strategy itself changes.',
    'Do not split a small deposit across five allocators: one {amount} position in one vault beats five $100 positions that each pay their own gas to enter and exit.',
    'Exit by withdrawing to USDC on {chain} ({gas}) and bridging out. If the vault has a lock or a queue, start the exit 5-7 days early.',
  ]),
  RWA: S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas; most tokenised-asset vaults settle in USDC, so arrive in USDC, not in a volatile token.',
    'Deposit into {name}’s tokenised-asset vault on {chain} and read the asset’s term first: a T-bill vault pays a stated yield to a stated maturity, a credit vault pays more for a longer lock. Pick the term you can actually hold.',
    'Hold to the vault’s term — 4-12 weeks for short paper, longer for credit — and do not trade in and out: RWA yield is the point, and every exit and re-entry pays gas and loses days of yield.',
    'Check once a month that the underlying asset is still the one stated (T-bills, invoices, credit) and that the vault’s reported value matches your deposit; if the asset changes, exit at the next window.',
    'Exit at maturity or at the vault’s stated redemption window, back to USDC on {chain} ({gas}), then bridge out. Early exits on RWA vaults can carry a fee or a delay, so plan the exit date when you enter.',
  ]),
  Lending: S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas.',
    'Supply the USDC on {name}’s {chain} lending market; a {amount} supply earns the base borrow yield plus whatever the protocol tracks for suppliers, and it is the safest first move on a lending protocol.',
    'If you borrow, borrow no more than 30-40% of the supplied value and only in a stablecoin: a $1,000 supply supports at most a $300-400 borrow, and the health factor must stay above 1.5 at all times.',
    'Hold the supply 6-8 weeks and check the health factor every 2-3 days if you borrowed; repay the borrow first if the collateral’s price falls 15% or more, before any liquidation can trigger.',
    'Exit in two moves: repay any borrow in full, then withdraw the supply to USDC on {chain} ({gas}) and bridge out. Never withdraw the collateral while a borrow is still open.',
  ]),
  Yield: S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas.',
    'Deposit into {name}’s highest-TVL yield vault on {chain}; a single {amount} deposit in the top vault beats the same money split across three small vaults, because each vault charges its own entry gas.',
    'Leave it compounding for 6-8 weeks. Yield vaults are scored on time in the vault, and hopping between vaults every few days pays gas each time and resets your clock.',
    'Check the vault’s reported APY once a week: if it falls by half and stays there for two weeks, move to the vault’s next-best strategy in one transaction rather than withdrawing to cash.',
    'Exit by withdrawing the vault position back to USDC on {chain} ({gas}) and bridging out. If the vault has a withdrawal delay, start it 3-5 days before you need the funds.',
  ]),
  Derivatives: S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas; perps settle in USDC, so arrive in USDC.',
    'Open a small position on {name}’s {chain} perps market — no more than $500-1,000 of the {amount} at 2-3x leverage at most — or provide liquidity to the perps pool if you prefer earning fees to taking direction.',
    'Set a stop-loss before you open: close the position if it loses 10% of its margin, and never add margin to a losing position. A farming position that liquidates earns nothing.',
    'Trade or hold the pool position 4-6 weeks, in small size, once or twice a week at most; volume and time matter more than one big trade, and every trade pays a funding fee while it is open.',
    'Close the position back to USDC on {chain} in one transaction ({gas}), then bridge out. If you provided pool liquidity instead, withdraw it the same way and check the pool’s PnL before you leave.',
  ]),
  CDP: S([
    'Bridge {amount} in ETH or a liquid staking token to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas; a CDP needs collateral you are willing to lock, not the stablecoin it mints.',
    'Lock the collateral in {name}’s vault on {chain} and mint its stablecoin at no more than 40% of the collateral’s value: $1,000 of collateral supports at most $400 minted, and the liquidation ratio must stay well above the protocol’s minimum.',
    'Hold the minted stablecoin or deploy it in a low-risk pool for 6-8 weeks, and check the collateral ratio every 2-3 days; if the collateral falls 20%, repay part of the minted amount the same day.',
    'Do not mint to the maximum: a CDP at 70% of its limit liquidates on a normal market dip, while one at 40% survives it and keeps earning.',
    'Exit in two moves: repay the minted stablecoin in full first, then unlock and withdraw the collateral ({gas}) and bridge out. Repaying late can cost a liquidation penalty, so start the exit before the collateral ratio gets tight.',
  ]),
  'Yield Aggregator': S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas.',
    'Deposit into {name}’s top auto-compounding vault on {chain}; the aggregator moves the capital between strategies for you, so pick the vault with the highest TVL and let it compound.',
    'Leave it for 6-8 weeks without touching it: auto-compounding only beats manual harvesting when the position stays put, and each harvest or move pays gas.',
    'Compare the vault’s net APY once a week against the aggregator’s other vaults; move only if another vault beats it by more than 2% for two weeks running.',
    'Exit by withdrawing to USDC on {chain} ({gas}) and bridging out. If the vault routes through several strategies, the withdrawal can take 1-3 days to unwind — start it early.',
  ]),
  'Basis Trading': S([
    'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas; basis vaults settle in USDC.',
    'Deposit into {name}’s basis vault on {chain}: the vault earns the funding rate by holding spot and shorting perps, so read the current funding rate once before you deposit — a negative rate means the vault pays instead of earning.',
    'Hold through at least one full funding cycle, 2-4 weeks, and then 4-8 weeks total; basis yield is lumpy by the day and only smooths out over weeks.',
    'Check the funding rate weekly: if it stays negative for two weeks, pause new deposits and let the existing one run; do not add money to a vault that is paying to hold its hedge.',
    'Exit by withdrawing to USDC on {chain} ({gas}) and bridging out. Basis vaults can take 1-3 days to unwind the hedge, so start the exit before you need the money.',
  ]),
  Chain: S([
    'Bridge {amount} to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas; a chain’s own asset is the gas token, so arrive holding some of it, not only USDC.',
    'Use the chain weekly through its largest native app: transact, provide liquidity or lend on {chain} with the {amount} position rather than holding a single token — chain activity is what a future distribution usually measures.',
    'If {chain} supports staking or delegation, stake or delegate half the position with a validator that charges under 10% commission and has no slashing history; unstaking can take days to weeks, so only stake what you can lock.',
    'Keep the activity steady for 8-12 weeks: one real transaction a week beats twenty transactions in a day, and a single-day burst looks like a bot.',
    'Exit by unstaking first if you staked (wait out the unbonding period), then bridge the native asset out ({gas}). Never bridge the full balance — leave a little gas on the chain.',
  ]),
};

const GENERIC: StepFn = S([
  'Bridge {amount} in USDC to {chain} ({gas}, 10-20 min) and keep $20 aside for exit gas; arrive in USDC, the settlement token most protocols on {chain} use.',
  'Use {name}’s main product on {chain} with the full {amount}: deposit, supply or provide liquidity in its highest-TVL pool or vault, and read its fee and lock terms once before you confirm.',
  'Hold the position 6-8 weeks and use it once a week: steady, repeated use over weeks is what farming programs usually reward, while a single deposit and immediate exit earns little.',
  'Check the position weekly — yield, health factor or pool value — and move only if the product itself changes; hopping between protocols every few days pays gas each time and resets your clock.',
  'Exit in two moves: unwind the position back to USDC on {chain} ({gas}), then bridge out. If the product has a lock or queue, start the exit 3-5 days before you need the money.',
]);

function farmSteps(p: Protocol, primaryChain: string): string[] {
  const v: Record<string, string> = {
    name: p.name,
    chain: primaryChain,
    amount: amountFor(p.tvl_usd),
    gas: gasFor(primaryChain),
    stable: 'USDC',
  };
  const fn = (p.category && STEPS[p.category]) || GENERIC;
  return fn(v).map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 600);
}

// ---------------------------------------------------------------- main

function main(): void {
  const { input, output } = parseArgs();
  const snap = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;
  const watchlist = new Set(snap.watchlist);
  const model = buildModel(snap.protocols);

  const candidates = snap.protocols.filter(isCandidate);
  const rows: Row[] = candidates.map((p) => {
    const catMult = p.category && model.multiples[p.category] !== undefined
      ? model.multiples[p.category]!
      : model.globalMedian;
    const g = p.change_7d === null || p.change_7d === undefined ? 0 : p.change_7d;
    const growthF = clamp(1 + g / 200, 0.7, 1.3);
    const age = ageDays(snap.as_of, p.listed_at);
    const maturityF = age === null ? 1 : 1 + 0.4 * Math.min(age, 730) / 730;
    const breadthF = 1 + 0.02 * Math.min(Math.max(p.chains.length - 1, 0), 15);
    const implied = Math.max(1, Math.round(p.tvl_usd * catMult * growthF * maturityF * breadthF));
    const primaryChain = p.chains[0] || 'Ethereum';
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmSteps(p, primaryChain),
      category: p.category || 'Uncategorised',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      category_multiple: Math.round(catMult * 1000) / 1000,
      growth_factor: Math.round(growthF * 1000) / 1000,
      maturity_factor: Math.round(maturityF * 1000) / 1000,
      breadth_factor: Math.round(breadthF * 1000) / 1000,
      watchlist: watchlist.has(p.slug),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  rows.forEach((r, i) => { r.rank = i + 1; });

  const totalImplied = rows.reduce((n, r) => n + r.implied_value_usd, 0);
  const tokenCount = snap.protocols.filter((p) => p.gecko_id || p.symbol).length;
  const excludedCount = snap.protocols.length - candidates.length - tokenCount;

  mkdirSync(output, { recursive: true });
  const board = { as_of: snap.as_of, rows };
  writeFileSync(join(output, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');

  const data = {
    asOf: snap.as_of,
    totalImplied,
    rowCount: rows.length,
    watchlistCount: rows.filter((r) => r.watchlist).length,
    tokenCount,
    excludedCount,
    globalMedian: Math.round(model.globalMedian * 1000) / 1000,
    multiples: Object.fromEntries(
      Object.entries(model.multiples).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
    ),
    rows,
  };
  writeFileSync(join(output, 'data.js'), 'window.RADAR = ' + JSON.stringify(data) + ';\n', 'utf8');

  const root = dirname(fileURLToPath(import.meta.url));
  cpSync(join(root, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  cpSync(join(root, 'screenshots'), join(output, 'screenshots'), { recursive: true });

  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);

  console.log(`token-radar: ${rows.length} rows, ${rows.filter((r) => r.watchlist).length}/${snap.watchlist.length} watchlist, total implied $${(totalImplied / 1e9).toFixed(2)}B`);
  console.log(`top 5: ${rows.slice(0, 5).map((r) => r.slug + ' $' + (r.implied_value_usd / 1e9).toFixed(2) + 'B').join(', ')}`);
  console.log(`dossier: ${dossier.length} bytes`);
}

main();
