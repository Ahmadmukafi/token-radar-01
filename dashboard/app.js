// Token Launch Radar — dashboard app. Renders window.TOKEN_RADAR (data.js).
// No network: every byte the page needs is in the board it ships with.

(function () {
  'use strict';
  var DATA = window.TOKEN_RADAR;
  if (!DATA) return;
  var rows = DATA.rows;
  var stats = DATA.stats;

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function fmtPct(x) {
    if (x === null || x === undefined) return '—';
    var s = (x > 0 ? '+' : '') + x.toFixed(1) + '%';
    return s;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- stats bar
  var statsEl = document.getElementById('stats');
  var statItems = [
    ['Protocols', String(rows.length)],
    ['Watchlist', stats.watchlist_covered + ' / ' + stats.watchlist],
    ['Total implied', fmtUsd(stats.total_implied_usd)],
    ['Snapshot', stats.as_of],
  ];
  statsEl.innerHTML = statItems.map(function (kv) {
    return '<div><dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd></div>';
  }).join('');

  // ---- category dropdown
  var cats = [];
  rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  var catSel = document.getElementById('category');
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });

  // ---- filters (also readable from the URL: ?filter=watchlist, ?category=X, ?q=text, #slug=...)
  var params = new URLSearchParams(window.location.search);
  var state = {
    filter: params.get('filter') || 'all',
    category: params.get('category') || '',
    q: params.get('q') || '',
    slug: (window.location.hash.match(/slug=([^&]+)/) || [])[1] || null,
  };
  var filterBtns = document.querySelectorAll('.filter-btn');
  function syncFilterButtons() {
    filterBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-filter') === state.filter); });
  }
  if (state.category) catSel.value = state.category;
  var searchEl = document.getElementById('search');
  if (state.q) searchEl.value = state.q;
  syncFilterButtons();

  document.getElementById('count-all').textContent = '(' + rows.length + ')';
  document.getElementById('count-watchlist').textContent = '(' + stats.watchlist_covered + ')';

  var tbody = document.getElementById('rows');
  var shownEl = document.getElementById('shown');
  var layout = document.querySelector('.layout');
  var detail = document.getElementById('detail');
  var detailBody = document.getElementById('detail-body');

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.filter === 'watchlist' && !r.watchlist) return false;
      if (state.category && r.category !== state.category) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function chainChips(r) {
    var chips = r.chains.slice(0, 4).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    if (r.chains.length > 4) chips += '<span class="chip more">+' + (r.chains.length - 4) + '</span>';
    return '<span class="chips">' + chips + '</span>';
  }

  function render() {
    var list = visibleRows();
    var html = list.map(function (r) {
      var chg = r.change_7d === null ? '<span>—</span>' : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + fmtPct(r.change_7d) + '</span>';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="proto"><span class="name">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="badge">Watchlist</span>' : '') + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + chainChips(r) + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num"><span class="val">' + fmtUsd(r.implied_value_usd) + '</span></td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = html;
    shownEl.textContent = 'Showing ' + list.length + ' of ' + rows.length + ' protocols' +
      (state.filter === 'watchlist' ? ' — watchlist only' : '') +
      (state.category ? ' — ' + state.category : '') + '.';
  }

  function openDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    var peers = (stats.category_peers && stats.category_peers[r.category] !== undefined) ? stats.category_peers[r.category] : null;
    var multLabel = 'Category multiple (' + (r.category || '—') + (peers === null ? ', no tokenized peer' : ', ' + peers + ' peer' + (peers === 1 ? '' : 's')) + ')';
    var breakdown = [
      ['TVL', fmtUsd(r.tvl_usd)],
      [multLabel, '×' + r.category_multiple.toFixed(2)],
      ['Growth (7d ' + fmtPct(r.change_7d) + ')', '×' + r.growth_factor.toFixed(2)],
      ['Maturity' + (r.listed_at ? ' (since ' + r.listed_at + ')' : ''), '×' + r.maturity_factor.toFixed(2)],
      ['Breadth (' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')', '×' + r.breadth_factor.toFixed(2)],
    ];
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    detailBody.innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="dslug">' + esc(r.slug) + ' · Rank #' + r.rank + (r.watchlist ? ' · <span class="badge">Watchlist</span>' : '') + '</p>' +
      '<div class="dval-label">Implied value</div><div class="dval">' + fmtUsd(r.implied_value_usd) + '</div>' +
      '<h3>How the value is built</h3>' +
      '<table class="breakdown"><tbody>' +
      breakdown.map(function (kv) { return '<tr><td>' + esc(kv[0]) + '</td><td>' + esc(kv[1]) + '</td></tr>'; }).join('') +
      '<tr class="total"><td>Implied value</td><td>' + fmtUsd(r.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="meta">Category: ' + esc(r.category || '—') + ' · TVL ' + fmtUsd(r.tvl_usd) + ' · ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + (r.listed_at ? ' · tracked since ' + r.listed_at : '') + '</p>' +
      '<h3>Farm plan — 6 steps</h3>' +
      '<ol class="farm">' + steps + '</ol>';
    detail.hidden = false;
    layout.classList.add('detail-open');
    var tr = tbody.querySelector('tr[data-slug="' + r.slug.replace(/"/g, '') + '"]');
    tbody.querySelectorAll('tr.selected').forEach(function (t) { t.classList.remove('selected'); });
    if (tr) tr.classList.add('selected');
  }

  function closeDetail() {
    detail.hidden = true;
    layout.classList.remove('detail-open');
    tbody.querySelectorAll('tr.selected').forEach(function (t) { t.classList.remove('selected'); });
  }

  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  document.getElementById('close-detail').addEventListener('click', closeDetail);
  filterBtns.forEach(function (b) {
    b.addEventListener('click', function () { state.filter = b.getAttribute('data-filter'); syncFilterButtons(); render(); });
  });
  catSel.addEventListener('change', function () { state.category = catSel.value; render(); });
  searchEl.addEventListener('input', function () { state.q = searchEl.value; render(); });

  render();
  if (state.slug) openDetail(decodeURIComponent(state.slug));
})();
