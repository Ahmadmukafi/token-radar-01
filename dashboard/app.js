// Token Launch Radar — dashboard app (no network; data comes from ../data.js).
(function () {
  'use strict';
  var D = window.TOKEN_RADAR;
  if (!D || !D.rows) {
    document.getElementById('meta').textContent = 'Data not loaded.';
    return;
  }
  var rows = D.rows;

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return '$' + Math.trunc(n);
  }
  function moneyFull(n) {
    return '$' + String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(v) {
    if (v === null || v === undefined) return { t: '—', c: 'flat' };
    var s = (v > 0 ? '+' : '') + v.toFixed(1) + '%';
    return { t: s, c: v > 0 ? 'up' : v < 0 ? 'down' : 'flat' };
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- meta + multiples -------------------------------------------------
  var wl = rows.filter(function (r) { return r.is_watchlist; }).length;
  document.getElementById('meta').innerHTML =
    '<b>' + rows.length + '</b> protocols &nbsp;·&nbsp; <b>' + wl + '</b> watchlist<br>' +
    'Snapshot ' + esc(D.as_of) + ' &nbsp;·&nbsp; global multiple <b>' + D.global_multiple.toFixed(2) + '×</b>';
  var mults = Object.keys(D.category_multiples).map(function (c) {
    return [c, D.category_multiples[c]];
  }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
  document.getElementById('multiples').innerHTML =
    '<strong>Category multiples in this board (median mcap/TVL of tokenized peers, shrunk):</strong> ' +
    mults.map(function (m) { return esc(m[0]) + ' <b>' + m[1].toFixed(2) + '×</b>'; }).join(' &nbsp;·&nbsp; ');

  // ---- filter controls --------------------------------------------------
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  var catSel = document.getElementById('cat');
  cats.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
  });
  var chainSel = document.getElementById('chain');
  chains.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o);
  });

  var q = document.getElementById('q');
  var sortSel = document.getElementById('sort');
  var wlBox = document.getElementById('wl');
  var tbody = document.getElementById('rows');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');
  var detailEl = document.getElementById('detail');
  var layoutEl = document.getElementById('layout');
  var selected = null;

  function currentRows() {
    var needle = q.value.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (wlBox.checked && !r.is_watchlist) return false;
      if (catSel.value && r.category !== catSel.value) return false;
      if (chainSel.value && r.chains.indexOf(chainSel.value) < 0) return false;
      if (needle && (r.name.toLowerCase().indexOf(needle) < 0 && r.slug.indexOf(needle) < 0)) return false;
      return true;
    });
    var s = sortSel.value;
    if (s === 'tvl') list.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (s === 'growth') list.sort(function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); });
    else if (s === 'name') list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else list.sort(function (a, b) { return a.rank - b.rank; });
    return list;
  }

  function render() {
    var list = currentRows();
    countEl.textContent = list.length + ' of ' + rows.length + ' shown';
    emptyEl.hidden = list.length > 0;
    var html = '';
    list.forEach(function (r) {
      var g = pct(r.change_7d);
      html += '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="r">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' +
        (r.is_watchlist ? '<span class="badge">Watchlist</span>' : '') +
        '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category) + '</td>' +
        '<td>' + r.chains.slice(0, 3).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
        (r.chains.length > 3 ? '<span class="chip">+' + (r.chains.length - 3) + '</span>' : '') + '</td>' +
        '<td class="r">' + money(r.tvl_usd) + '</td>' +
        '<td class="r ' + g.c + '">' + g.t + '</td>' +
        '<td class="r val">' + money(r.implied_value_usd) + '</td></tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { select(tr.getAttribute('data-slug'), true); });
    });
  }

  function select(slug, scroll) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    selected = slug;
    var b = r.value_breakdown;
    var g = pct(r.change_7d);
    detailEl.innerHTML =
      '<button class="close" id="dclose">Close</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="dsub">Rank #' + r.rank + ' &nbsp;·&nbsp; ' + esc(r.slug) + ' &nbsp;·&nbsp; ' + esc(r.category) +
      (r.is_watchlist ? ' &nbsp;·&nbsp; <span class="badge">Watchlist</span>' : '') + '</p>' +
      '<div class="big">' + money(r.implied_value_usd) + '</div>' +
      '<p class="dsub">implied launch value</p>' +
      '<h3>How the value is built</h3><dl>' +
      '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>' +
      '<dt>Category multiple</dt><dd>' + b.multiple.toFixed(3) + '× (' + esc(r.category) + ')</dd>' +
      '<dt>7-day growth</dt><dd class="' + g.c + '">' + g.t + ' → ×' + b.growth_factor.toFixed(3) + '</dd>' +
      '<dt>Running with no token</dt><dd>' + b.age_years.toFixed(1) + ' yrs → ×' + b.maturity_factor.toFixed(3) + '</dd>' +
      '<dt>Chains</dt><dd>' + r.chains.length + ' → ×' + b.breadth_factor.toFixed(3) + '</dd>' +
      '<dt>Listed</dt><dd>' + esc(r.listed_at || '—') + '</dd>' +
      '</dl>' +
      '<h3>Farm plan — ' + esc(r.name) + '</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol>';
    detailEl.hidden = false;
    layoutEl.classList.add('split');
    document.getElementById('dclose').addEventListener('click', function () {
      selected = null; detailEl.hidden = true; layoutEl.classList.remove('split'); render();
    });
    render();
    if (scroll) detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  [q, catSel, chainSel, sortSel, wlBox].forEach(function (el) {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });

  // ---- hash routing: #detail=<slug> and/or #filter=<category> -----------
  function fromHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('filter')) {
      var f = p.get('filter');
      if (cats.indexOf(f) >= 0) { catSel.value = f; }
    }
    if (p.get('q')) q.value = p.get('q');
    render();
    if (p.get('detail')) select(p.get('detail'), false);
  }

  render();
  fromHash();
})();
