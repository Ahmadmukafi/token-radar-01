// token-radar-01 round 4 — Token launch radar.
// Reads the sealed DefiLlama snapshot, ranks every genuine launch candidate
// (a protocol that records no token and is not a wrapped, staked, bridged,
// versioned or exchange product) by an implied token value, and writes the
// board, the dashboard data, and the dossier.
//
// The value model, in one line:
//   implied = TVL x category multiple x growth x maturity x breadth x confidence
//
// The category multiple is the median mcap/TVL of the token-bearing
// protocols in that category, winsorized at 3x, then shrunk toward the
// global median with a prior weight of 5. The shrinkage is the point: a
// category with one observation (Risk Curators: a single 2.975x print)
// cannot set the multiple on its own — it is pulled most of the way to
// the global median, and the confidence discount says so openly. Every
// multiple carries its observation count and a confidence badge
// (high n>=5, medium 2-4, low 1, none 0) so the reader sees exactly how
// much evidence each number rests on.
//
//   growth     = 1 + clamp(change_7d / 100, -0.30, +0.30); 1.00 when unreported
//   maturity   = 0.85 + 0.15 * min(age_years / 3, 1); 0.925 when unlisted
//   breadth    = 1 + 0.05 * min(chains - 1, 4)
//   confidence = 1.00 high, 0.97 medium, 0.92 low, 0.88 none
//   multiple   = clamp(shrunk median, 0.05, 1.50)
//
// Deterministic: no clock, no randomness. Ages are measured against the
// snapshot's own as_of date. Ties break by TVL desc, then slug asc.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

interface FactorSet {
  multiple: number;
  growth: number;
  maturity: number;
  breadth: number;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low' | 'none';
  catObs: number;
  catMedian: number | null;
}

interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  factors: FactorSet;
}

const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const PRIOR_WEIGHT = 5;
const GLOBAL_FALLBACK = 0.2049; // replaced at runtime by the measured global median
const WINSOR = 3.0;
const MULT_MIN = 0.05;
const MULT_MAX = 1.5;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** The house's own exclusion rule, reimplemented: a version marker, an
 *  excluded category, a whole word wrapped/staked/staking, or an exchange
 *  name at the start of the name. */
function excludedByHouseRule(p: Protocol): string | null {
  if (VERSION_RE.test(p.name)) return 'version marker';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'category ' + p.category;
  const words = p.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) {
    return 'wrapped/staked word';
  }
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return 'exchange name';
  return null;
}

function gasNote(chain: string): string {
  switch (chain) {
    case 'Ethereum': return 'about $4–$12 a transaction on Ethereum mainnet';
    case 'Solana': return 'about $0.01 a transaction on Solana';
    case 'Tron': return 'about $1–$2 a transaction on Tron';
    case 'Bitcoin': return 'about $1–$3 a transaction on Bitcoin rails';
    case 'Binance': return 'about $0.10–$0.30 a transaction on BNB Chain';
    case 'Base':
    case 'Arbitrum':
    case 'Optimism':
    case 'Polygon':
    case 'Blast':
    case 'Mode':
    case 'Ink':
    case 'Unichain':
    case 'Berachain':
    case 'Monad':
      return 'about $0.05–$0.30 a transaction on ' + chain;
    default: return 'a few cents a transaction on ' + chain;
  }
}

function sizeFor(tvl: number): string {
  if (tvl >= 1_000_000_000) return '$5,000–$20,000';
  if (tvl >= 250_000_000) return '$2,000–$10,000';
  if (tvl >= 50_000_000) return '$500–$5,000';
  return '$100–$1,000';
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = process.env.MAKEFUN_INPUT_DIR
    ? join(process.env.MAKEFUN_INPUT_DIR, 'snapshot.json')
    : '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) input = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) output = argv[++i];
  }
  return { input, output };
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap: Snapshot = JSON.parse(readFileSync(input, 'utf8'));
  const asOf = new Date(snap.as_of + 'T00:00:00Z');
  const watch = new Set(snap.watchlist);

  // --- robust category multiples -------------------------------------------
  const ratiosByCat = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snap.protocols) {
    // A zero market cap is a missing observation, not a 0x multiple:
    // DefiLlama records the token but no market for it. Skip it.
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const r = Math.min(p.mcap_usd / p.tvl_usd, WINSOR);
      allRatios.push(r);
      const c = p.category ?? 'Uncategorized';
      if (!ratiosByCat.has(c)) ratiosByCat.set(c, []);
      ratiosByCat.get(c)!.push(r);
    }
  }
  const globalMedian = median(allRatios);
  const catStats = new Map<string, { n: number; med: number | null; mult: number; conf: FactorSet['confidenceLabel'] }>();
  const cats = new Set(snap.protocols.map((p) => p.category ?? 'Uncategorized'));
  for (const c of cats) {
    const obs = ratiosByCat.get(c) ?? [];
    const n = obs.length;
    const med = n > 0 ? median(obs) : null;
    const mult = n > 0
      ? clamp((n * med! + PRIOR_WEIGHT * globalMedian) / (n + PRIOR_WEIGHT), MULT_MIN, MULT_MAX)
      : clamp(globalMedian, MULT_MIN, MULT_MAX);
    const conf: FactorSet['confidenceLabel'] = n >= 5 ? 'high' : n >= 2 ? 'medium' : n === 1 ? 'low' : 'none';
    catStats.set(c, { n, med, mult, conf });
  }
  const confDiscount: Record<FactorSet['confidenceLabel'], number> = {
    high: 1.0, medium: 0.97, low: 0.92, none: 0.88,
  };

  // --- board: every genuine launch candidate -------------------------------
  const candidates = snap.protocols.filter(
    (p) => p.gecko_id === null && p.symbol === null && excludedByHouseRule(p) === null,
  );

  const rows: Row[] = candidates.map((p) => {
    const st = catStats.get(p.category ?? 'Uncategorized')!;
    const growth = p.change_7d === null ? 1.0 : 1 + clamp(p.change_7d / 100, -0.3, 0.3);
    let maturity = 0.925;
    if (p.listed_at) {
      const listed = new Date(p.listed_at + 'T00:00:00Z');
      const ageYears = Math.max(0, (asOf.getTime() - listed.getTime()) / (365.25 * 86400 * 1000));
      maturity = 0.85 + 0.15 * Math.min(ageYears / 3, 1);
    }
    const breadth = 1 + 0.05 * Math.min(Math.max(p.chains.length - 1, 0), 4);
    const confidence = confDiscount[st.conf];
    const implied = Math.max(
      1,
      Math.round(p.tvl_usd * st.mult * growth * maturity * breadth * confidence),
    );
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmSteps(p),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      watchlist: watch.has(p.slug),
      factors: {
        multiple: st.mult,
        growth,
        maturity,
        breadth,
        confidence,
        confidenceLabel: st.conf,
        catObs: st.n,
        catMedian: st.med,
      },
    };
  });

  rows.sort((a, b) =>
    b.implied_value_usd - a.implied_value_usd ||
    b.tvl_usd - a.tvl_usd ||
    (a.slug < b.slug ? -1 : 1),
  );
  rows.forEach((r, i) => { r.rank = i + 1; });

  // --- outputs --------------------------------------------------------------
  mkdirSync(output, { recursive: true });
  const totalImplied = rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const multiplesTable = [...catStats.entries()]
    .map(([cat, st]) => ({
      category: cat,
      observations: st.n,
      median: st.med === null ? null : +st.med.toFixed(3),
      multiple: +st.mult.toFixed(3),
      confidence: st.conf,
    }))
    .sort((a, b) => b.observations - a.observations || (a.category < b.category ? -1 : 1));
  const board = {
    meta: {
      as_of: snap.as_of,
      floor_usd: snap.floor_usd,
      rows: rows.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      watchlist_total: snap.watchlist.length,
      total_implied_usd: totalImplied,
      global_median_mcap_tvl: +globalMedian.toFixed(4),
      prior_weight: PRIOR_WEIGHT,
      winsor_cap: WINSOR,
      model: 'implied = TVL x category multiple x growth x maturity x breadth x confidence',
    },
    multiples: multiplesTable,
    rows,
  };
  writeFileSync(join(output, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  const dataJs = 'window.RADAR = ' + JSON.stringify(board) + ';\n';
  writeFileSync(join(output, 'data.js'), dataJs, 'utf8');

  const root = resolve(import.meta.dirname ?? '.');
  cpSync(join(root, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  cpSync(join(root, 'screenshots'), join(output, 'screenshots'), { recursive: true });
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);

  // --- self-check + report ---------------------------------------------------
  const watchCovered = rows.filter((r) => r.watchlist).length;
  const badSteps = rows.filter((r) =>
    r.farm_steps.length < 3 || r.farm_steps.length > 12 ||
    r.farm_steps.some((s) => s.trim().length < 20 || s.trim().length > 600),
  );
  const sorted = rows.every((r, i) => i === 0 || rows[i - 1].implied_value_usd >= r.implied_value_usd);
  const ranksOk = rows.every((r, i) => r.rank === i + 1);
  console.log(`token-radar r4: ${rows.length} rows, ${watchCovered}/${snap.watchlist.length} watchlist, total implied $${totalImplied.toLocaleString('en-US')}`);
  console.log(`gate self-check: sorted=${sorted} ranks=${ranksOk} bad_step_rows=${badSteps.length} dossier=${dossier.length} bytes`);
  console.log('top 5:');
  for (const r of rows.slice(0, 5)) {
    console.log(`  #${r.rank} ${r.slug} $${r.implied_value_usd.toLocaleString('en-US')} (TVL $${(r.tvl_usd / 1e6).toFixed(1)}M, ${r.category}, mult ${r.factors.multiple.toFixed(3)} ${r.factors.confidenceLabel} n=${r.factors.catObs})`);
  }
  const risk = catStats.get('Risk Curators')!;
  console.log(`Risk Curators multiple: ${risk.mult.toFixed(3)} (median ${risk.med}, n=${risk.n}, ${risk.conf}) — single-observation weakness fixed by shrinkage`);
  if (!sorted || !ranksOk || badSteps.length > 0 || watchCovered !== snap.watchlist.length) {
    throw new Error('self-check failed');
  }
}

// --- farm plans ---------------------------------------------------------------
// Five steps per row, tailored to the protocol's category. Tokens:
//   {N} name, {C} top chain, {S} position size by TVL tier, {G} gas note,
//   {H} holding period. Every step is written to land in 88-252 chars.

type Ctx = { name: string; chain: string; size: string; gas: string; hold: string };

const HOLD_LONG = '6–12 months';
const HOLD_MID = '3–6 months';

const TEMPLATES: Record<string, string[]> = {
  'Risk Curators': [
    'Open {N} on {C} and connect a wallet you control; read the vault strategy, fees and withdrawal terms before depositing anything.',
    'Deposit {S} into the highest-TVL {N} vault on {C} ({G}); one deposit opens the position and starts your exposure clock.',
    'Leave the deposit working and add a second tranche of {S} after 2–4 weeks if the vault 7-day TVL trend stays positive.',
    'Check the vault weekly for points, gauges or curator incentives; claim or compound any rewards issued to depositors.',
    'Hold the position {H}; withdraw only after a token announcement or if TVL falls 30% in a week, and keep the farming wallet.',
  ],
  RWA: [
    'Open {N} on {C} and connect a wallet you control; confirm which real-world asset backs the vault and who audits it.',
    'Deposit {S} into the {N} vault on {C} ({G}); the yield comes from the underlying asset, not from emissions, so size for income.',
    'Keep the position through at least one full yield cycle and record the payout dates; RWA points accrue to steady holders.',
    'Reinvest payouts back into the same {N} vault while the asset backing is unchanged and the audit stays current.',
    'Hold the position {H}; exit early only if the backing asset changes or the auditor flags the vault, and keep the farming wallet.',
  ],
  'Onchain Capital Allocator': [
    'Open {N} on {C} and connect a wallet you control; read which strategies the allocator runs and what it charges.',
    'Allocate {S} to the {N} strategy on {C} ({G}) with the longest live track record; one allocation is one position.',
    'Let the allocator rotate the capital and check monthly that its reported allocation still matches the stated strategy.',
    'Top up with {S} only after a full month of steady returns; never chase a single week of outperformance.',
    'Hold the allocation {H}; redeem only after a token announcement or if the allocator changes strategy without notice.',
  ],
  'Basis Trading': [
    'Open {N} on {C} and connect a wallet you control; understand the basis trade — long spot, short perps — before depositing.',
    'Deposit {S} into the {N} basis vault on {C} ({G}); funding-rate income is the yield, so size for a steady carry, not a spike.',
    'Watch the funding rate weekly; a persistently negative rate for two weeks is the signal to pause new deposits.',
    'Compound funding payouts back into the {N} vault while the basis stays positive and the vault TVL keeps growing.',
    'Hold the position {H}; exit if the basis inverts for a month or the vault pauses withdrawals, and keep the farming wallet.',
  ],
  Lending: [
    'Open {N} on {C} and connect a wallet you control; check which assets you can supply and what the borrow rates are.',
    'Supply {S} of a major asset to {N} on {C} ({G}); supplying is the farm — borrow only if you can repay it in full at any time.',
    'Keep the supplied position open and borrow a small amount against it only to loop once, never to the liquidation edge.',
    'Repay any looped borrow in full each month and re-supply the freed collateral so the position stays simple and safe.',
    'Hold the supply position {H}; withdraw only after a token announcement or if utilization spikes above 90% for a week.',
  ],
  Dexs: [
    'Open {N} on {C} and connect a wallet you control; find the deepest pool for a pair you already hold.',
    'Add {S} of liquidity to the top {N} pool on {C} ({G}); concentrated ranges earn more but need weekly rebalancing.',
    'Trade a small amount through {N} each week so the wallet shows real usage, not only a passive liquidity position.',
    'Collect trading fees weekly and re-add them to the same pool while volume on {N} stays in its recent range.',
    'Hold the liquidity {H}; remove it only after a token announcement or if pool volume halves for two straight weeks.',
  ],
  Yield: [
    'Open {N} on {C} and connect a wallet you control; read what the yield strategy holds and where the yield comes from.',
    'Deposit {S} into the {N} yield vault on {C} ({G}); the vault compounds for you, so the job is to stay in, not to trade.',
    'Check the vault monthly for strategy changes; a vault that changes strategy without notice is a vault to leave.',
    'Add {S} in a second tranche after one full month of steady yield, never on the back of a single good week.',
    'Hold the deposit {H}; withdraw only after a token announcement or if the yield turns negative for a full month.',
  ],
  'Yield Aggregator': [
    'Open {N} on {C} and connect a wallet you control; see which underlying vaults the aggregator routes your deposit to.',
    'Deposit {S} into the top {N} vault on {C} ({G}); the aggregator auto-compounds, so deposit once and let it work.',
    'Review the routing monthly to confirm your funds still sit in the vaults the aggregator advertised at deposit time.',
    'Harvest and re-deposit any aggregator rewards the same week they arrive; unclaimed rewards are yield left behind.',
    'Hold the deposit {H}; exit only after a token announcement or if the aggregator routes funds to an unaudited vault.',
  ],
  CDP: [
    'Open {N} on {C} and connect a wallet you control; read the collateral ratio rules and the liquidation penalty first.',
    'Lock {S} of collateral in {N} on {C} ({G}) and mint well under the limit — keep the ratio at least double the minimum.',
    'Use the minted stablecoin in a low-risk venue and keep enough collateral headroom to survive a 40% price drop.',
    'Top up collateral whenever the ratio drifts toward the minimum; never let a position sit near liquidation overnight.',
    'Hold the CDP {H}; close it only after a token announcement or if the peg breaks by more than 2% for a week.',
  ],
  Restaking: [
    'Open {N} on {C} and connect a wallet you control; confirm which operators and AVSs your restake secures.',
    'Restake {S} through {N} on {C} ({G}); pick an operator with a long uptime record, not the one offering the highest points.',
    'Keep the restake active and check monthly that your operator still runs the AVSs it promised to secure.',
    'Claim restaking points or rewards weekly and restake them where the protocol allows compounding.',
    'Hold the restake {H}; unstake only after a token announcement or if your operator goes offline for more than a week.',
  ],
  Chain: [
    'Open {N} on {C} and connect a wallet you control; bridge {S} onto the chain and keep a little native gas aside.',
    'Use the chain daily for a week — swap, provide liquidity or mint — so the wallet builds a real on-chain history; each action costs {G}.',
    'Keep {S} of value active on {N} across at least two native apps; single-app users rarely top airdrop lists.',
    'Repeat the activity weekly and try each new native app as it launches; early users of new apps are usually rewarded.',
    'Stay active {H}; wind down only after a token announcement, and keep the same wallet that built the history.',
  ],
  CeDeFi: [
    'Open {N} on {C} and connect a wallet you control; verify the custodian and the proof-of-reserves before depositing.',
    'Deposit {S} into the {N} vault on {C} ({G}); CeDeFi yield comes from off-chain desks, so custody terms matter most.',
    'Read the monthly proof-of-reserves and confirm the custodian still holds the assets the vault claims to hold.',
    'Reinvest payouts into the same {N} vault while reserves stay fully backed and the custodian is unchanged.',
    'Hold the deposit {H}; withdraw at once if reserves fall short or the custodian changes, and keep the farming wallet.',
  ],
};

const GENERIC_STEPS: string[] = [
  'Open {N} on {C} and connect a wallet you control; read the protocol docs and fee schedule before depositing anything.',
  'Deposit {S} into the main {N} pool or vault on {C} ({G}); one deposit opens the position and starts your exposure clock.',
  'Use the protocol weekly — deposit, swap or vote — so the wallet shows real activity, not a single idle deposit.',
  'Claim any points or rewards {N} issues each week and re-deposit them while the protocol TVL trend stays positive.',
  'Hold the position {H}; exit only after a token announcement or if TVL falls 30% in a week, and keep the farming wallet.',
];

function farmSteps(p: Protocol): string[] {
  const chain = p.chains.length > 0 ? p.chains[0] : 'Ethereum';
  const ctx: Ctx = {
    name: p.name,
    chain,
    size: sizeFor(p.tvl_usd),
    gas: gasNote(chain),
    hold: p.tvl_usd >= 250_000_000 ? HOLD_LONG : HOLD_MID,
  };
  const tpl = (p.category !== null && TEMPLATES[p.category]) || GENERIC_STEPS;
  return tpl.map((s) =>
    s
      .replaceAll('{N}', ctx.name)
      .replaceAll('{C}', ctx.chain)
      .replaceAll('{S}', ctx.size)
      .replaceAll('{G}', ctx.gas)
      .replaceAll('{H}', ctx.hold),
  );
}

main();
