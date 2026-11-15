// Token Launch Radar — dashboard logic.
//
// The value model, in code, so the page and the board agree:
//   implied = TVL x categoryMultiple x growth x maturity x breadth
//   categoryMultiple: median market-cap / TVL of the token-bearing
//     protocols in the same category (ratios winsorized at 3x), shrunk
//     toward the global median with prior weight 3, clamped [0.05, 1.50].
//   growth   = clamp(1 + change_7d / 200, 0.70, 1.30)
//   maturity = 1 + 0.4 x min(ageDays, 730) / 730
//   breadth  = 1 + 0.02 x min(chains - 1, 15)
// main.ts computes every row this way from the snapshot; this file only
// renders the rows, so a screenshot and the code behind it can never disagree.

const MODEL = {
  formula: 'implied = tvl * categoryMultiple * growth * maturity * breadth',
  globalMedian: null, // filled from the snapshot at render time (see below)
  priorWeight: 3,
  ratioCap: 3,
  multipleClamp: [0.05, 1.5],
  growth: 'clamp(1 + change_7d / 200, 0.70, 1.30)',
  maturity: '1 + 0.4 * min(ageDays, 730) / 730',
  breadth: '1 + 0.02 * min(chains - 1, 15)',
};

const D = window.RADAR;
MODEL.globalMedian = D.globalMedian;
document.getElementById('global-median').textContent = D.globalMedian.toFixed(3);
const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
  : '$' + Math.round(n).toLocaleString('en-US');
const fmtPct = (g) => g === null || g === undefined ? '—'
  : (g > 0 ? '+' : '') + g.toFixed(1) + '%';
const fmtAge = (a) => a === null || a === undefined ? '—'
  : a >= 365 ? (a / 365).toFixed(1) + 'y' : a + 'd';

// ---- header stats -------------------------------------------------------
$('stats').innerHTML =
  stat(fmtUsd(D.totalImplied), 'total implied value') +
  stat(String(D.rowCount), 'protocols ranked') +
  stat(String(D.watchlistCount), 'on the watchlist') +
  stat(D.asOf, 'snapshot date');
function stat(b, s) {
  return '<div class="stat"><b>' + b + '</b><span>' + s + '</span></div>';
}

$('excluded-note').textContent =
  D.tokenCount + ' protocols in the snapshot already have a token that trades, and ' +
  D.excludedCount + ' more record no token but are a wrapped, staked or bridged product, ' +
  'an exchange, or a versioned copy.';

// ---- multiples table ----------------------------------------------------
const mt = document.querySelector('#mult-table tbody');
mt.innerHTML = Object.entries(D.multiples)
  .map(([c, m]) => '<tr><td>' + esc(c) + '</td><td>' + m.toFixed(3) + '&times;</td></tr>')
  .join('');

// ---- category filter ----------------------------------------------------
const cats = [...new Set(D.rows.map((r) => r.category))].sort();
$('cat-filter').innerHTML = '<option value="">All categories</option>' +
  cats.map((c) => '<option>' + esc(c) + '</option>').join('');

// ---- board ---------------------------------------------------------------
let sortKey = 'rank';
let sortDir = 1;
let selected = null;

function visibleRows() {
  const q = $('search').value.trim().toLowerCase();
  const cat = $('cat-filter').value;
  const watchOnly = $('watch-only').checked;
  const top100 = $('top100').checked;
  let rows = D.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    if (cat && r.category !== cat) return false;
    if (watchOnly && !r.watchlist) return false;
    if (top100 && r.rank > 100) return false;
    return true;
  });
  rows = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (Array.isArray(av) && Array.isArray(bv)) return sortDir * (av.length - bv.length);
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * ((av === null ? -Infinity : av) - (bv === null ? -Infinity : bv));
  });
  return rows;
}

function renderBoard() {
  const rows = visibleRows();
  $('count').textContent = rows.length + ' of ' + D.rows.length + ' shown';
  const tb = document.querySelector('#board tbody');
  tb.innerHTML = rows.map((r) => {
    const g = r.change_7d;
    const cls = g === null ? '' : g >= 0 ? 'pos' : 'neg';
    return '<tr data-slug="' + r.slug + '"' + (selected === r.slug ? ' class="sel"' : '') + '>' +
      '<td>' + r.rank + '</td>' +
      '<td><span class="nm">' + esc(r.name) + '</span>' +
      (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') +
      '<span class="sl">' + r.slug + '</span></td>' +
      '<td>' + esc(r.category) + '</td>' +
      '<td>' + r.chains.slice(0, 3).map(esc).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
      '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
      '<td class="num ' + cls + '">' + fmtPct(g) + '</td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td></tr>';
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- detail ---------------------------------------------------------------
function renderDetail(r) {
  const calc = fmtUsd(r.tvl_usd) + ' &times; ' + r.category_multiple.toFixed(3) +
    ' &times; ' + r.growth_factor.toFixed(3) + ' &times; ' + r.maturity_factor.toFixed(3) +
    ' &times; ' + r.breadth_factor.toFixed(3) + ' = ' + fmtUsd(r.implied_value_usd) +
    ' (factors shown rounded to 3 decimals; the board uses full precision)';
  const why = r.watchlist
    ? 'On the house watchlist: TVL at or above $50M, no token recorded, and not a wrapped, staked or bridged product.'
    : 'Below the watchlist floor or outside its rule, but the same filter: no token recorded and not a wrapped, staked or bridged product — the early one this radar exists to find.';
  $('detail').innerHTML =
    '<h2>' + esc(r.name) + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
    '<p class="meta">Rank #' + r.rank + ' &middot; ' + esc(r.category) + ' &middot; ' +
    r.chains.map(esc).join(', ') + ' &middot; ' + esc(r.slug) + '</p>' +
    '<div class="breakdown">' +
    factor(fmtUsd(r.tvl_usd), 'TVL in the snapshot') +
    factor(r.category_multiple.toFixed(3) + '&times;', 'category multiple (' + esc(r.category) + ')') +
    factor(r.growth_factor.toFixed(3) + '&times;', 'growth (7d ' + fmtPct(r.change_7d) + ')') +
    factor(r.maturity_factor.toFixed(3) + '&times;', 'maturity (' + fmtAge(r.age_days) + ' with no token)') +
    factor(r.breadth_factor.toFixed(3) + '&times;', 'breadth (' + r.chains.length + ' chains)') +
    factor(fmtUsd(r.implied_value_usd), 'implied value', true) +
    '</div>' +
    '<p class="calc"><code>' + calc + '</code></p>' +
    '<h3>How to farm it</h3>' +
    '<ol>' + r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<p class="why">' + why + ' The implied value is the radar’s own claim from the snapshot’s figures — ' +
    'not a price, and not a promise that a token launches.</p>';
}
function factor(b, s, total) {
  return '<div class="factor' + (total ? ' total' : '') + '"><b>' + b + '</b><span>' + s + '</span></div>';
}

// ---- events ---------------------------------------------------------------
document.querySelector('#board tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  selected = tr.dataset.slug;
  const r = D.rows.find((x) => x.slug === selected);
  if (r) { renderDetail(r); renderBoard(); }
});
document.querySelectorAll('#board th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = k === 'name' || k === 'category' ? 1 : -1; }
    renderBoard();
  });
});
['search', 'cat-filter', 'watch-only', 'top100'].forEach((id) => {
  $(id).addEventListener('input', renderBoard);
  $(id).addEventListener('change', renderBoard);
});

renderBoard();
renderDetail(D.rows[0]);

// ---- deep links (for the entry's own screenshots; also useful to a reader) ----
// ?view=detail&slug=<slug> opens that protocol's detail and scrolls to it.
// ?view=watchlist turns the watchlist filter on.
(function deepLink() {
  const q = new URLSearchParams(location.search);
  const view = q.get('view');
  if (view === 'watchlist') {
    $('watch-only').checked = true;
    renderBoard();
    return;
  }
  if (view === 'detail') {
    const slug = q.get('slug');
    const r = D.rows.find((x) => x.slug === slug) || D.rows[0];
    selected = r.slug;
    document.body.classList.add('detail-only');
    renderDetail(r);
    renderBoard();
  }
})();
