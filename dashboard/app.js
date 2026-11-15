// Token Launch Radar — dashboard logic. Reads window.RADAR (written by
// main.ts into data.js), renders the board, the filters and the detail panel.
// No network: every number comes from the snapshot the program already read.
(function () {
  var R = window.RADAR;
  var rows = R.rows;
  var meta = R.meta;
  var maxVal = rows.length ? rows[0].implied_value_usd : 1;

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function fmtTvl(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    return '$' + (n / 1e6).toFixed(1) + 'M';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // header stats
  document.getElementById('stat-rows').textContent = rows.length;
  document.getElementById('stat-watch').textContent = meta.watchlist_covered + ' / ' + meta.watchlist_total;
  document.getElementById('stat-total').textContent = fmtUsd(meta.total_implied_usd);
  document.getElementById('stat-asof').textContent = meta.as_of;
  document.getElementById('count-all').textContent = rows.length;
  document.getElementById('count-watch').textContent = meta.watchlist_covered;

  // multiples table
  var mtb = document.querySelector('#mult-table tbody');
  R.multiples.forEach(function (m) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + esc(m.category) + '</td><td>' + m.observations + '</td>' +
      '<td>' + (m.median === null ? '—' : m.median.toFixed(3)) + '</td>' +
      '<td>' + m.multiple.toFixed(3) + '</td>' +
      '<td><span class="dot ' + m.confidence + '"></span>' + m.confidence + '</td>';
    mtb.appendChild(tr);
  });
  document.getElementById('method-toggle').addEventListener('click', function () {
    var p = document.getElementById('method-panel');
    p.classList.toggle('hidden');
    this.textContent = p.classList.contains('hidden') ? 'Method & multiples ▾' : 'Method & multiples ▴';
  });

  // board
  var state = { filter: 'all', q: '' };
  var tbody = document.querySelector('#board tbody');
  var empty = document.getElementById('empty');

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.filter === 'watch' && !r.watchlist) return false;
      if (state.filter === 'top' && r.rank > 25) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
  }

  function render() {
    var list = visibleRows();
    tbody.innerHTML = '';
    empty.classList.toggle('hidden', list.length > 0);
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.dataset.slug = r.slug;
      var chg = r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%';
      var chgCls = r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      var barPct = Math.max(2, Math.round(100 * r.implied_value_usd / maxVal));
      tr.innerHTML =
        '<td class="c-rank">' + r.rank + '</td>' +
        '<td class="c-name">' + esc(r.name) +
          (r.watchlist ? '<span class="badge-watch">★ watchlist</span>' : '') +
          '<small>' + esc(r.slug) + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</small></td>' +
        '<td class="c-cat">' + esc(r.category || '—') + '</td>' +
        '<td class="c-tvl">' + fmtTvl(r.tvl_usd) + '</td>' +
        '<td class="c-chg ' + chgCls + '">' + chg + '</td>' +
        '<td class="c-val"><span class="val-num">' + fmtUsd(r.implied_value_usd) + '</span>' +
          '<div class="val-bar"><i style="width:' + barPct + '%"></i></div></td>' +
        '<td class="c-mult">' + r.factors.multiple.toFixed(3) +
          '<span class="dot ' + r.factors.confidenceLabel + '" title="confidence: ' + r.factors.confidenceLabel + ' (n=' + r.factors.catObs + ')"></span></td>' +
        '<td class="c-farm"><button type="button">Farm plan</button></td>';
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tbody.appendChild(tr);
    });
  }

  function setFilter(f, btn) {
    state.filter = f;
    document.querySelectorAll('.filter').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    render();
  }
  document.getElementById('f-all').addEventListener('click', function () { setFilter('all', this); });
  document.getElementById('f-watch').addEventListener('click', function () { setFilter('watch', this); });
  document.getElementById('f-top').addEventListener('click', function () { setFilter('top', this); });
  document.getElementById('search').addEventListener('input', function () {
    state.q = this.value;
    render();
  });

  // detail panel
  var detail = document.getElementById('detail');
  function openDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    document.querySelectorAll('#board tbody tr').forEach(function (tr) {
      tr.classList.toggle('selected', tr.dataset.slug === slug);
    });
    document.getElementById('d-name').textContent = '#' + r.rank + ' ' + r.name;
    document.getElementById('d-meta').textContent =
      (r.category || 'Uncategorized') + ' · ' + r.chains.join(', ') +
      ' · TVL ' + fmtTvl(r.tvl_usd) + ' · listed ' + (r.listed_at || 'unknown') +
      (r.watchlist ? ' · ★ on the house watchlist' : '');
    var f = r.factors;
    var confWhy = f.confidenceLabel === 'high' ? f.catObs + ' token observations in this category'
      : f.confidenceLabel === 'medium' ? f.catObs + ' token observations — some evidence'
      : f.confidenceLabel === 'low' ? 'only ' + f.catObs + ' token observation — shrunk hard toward the median'
      : 'no token observation in this category — global median used';
    var fb = document.querySelector('#d-factors tbody');
    fb.innerHTML =
      '<tr><td>TVL</td><td>' + fmtTvl(r.tvl_usd) + '</td><td>sealed snapshot, ' + meta.as_of + '</td></tr>' +
      '<tr><td>Category multiple</td><td>' + f.multiple.toFixed(3) + '×</td><td>' + esc(confWhy) + '</td></tr>' +
      '<tr><td>Growth</td><td>' + f.growth.toFixed(3) + '×</td><td>7-day TVL change ' + (r.change_7d === null ? 'unreported' : r.change_7d.toFixed(1) + '%') + '</td></tr>' +
      '<tr><td>Maturity</td><td>' + f.maturity.toFixed(3) + '×</td><td>listed ' + (r.listed_at || 'unknown') + '</td></tr>' +
      '<tr><td>Breadth</td><td>' + f.breadth.toFixed(3) + '×</td><td>' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '</td></tr>' +
      '<tr><td>Confidence</td><td>' + f.confidence.toFixed(2) + '×</td><td>' + f.confidenceLabel + ' evidence — the honest discount</td></tr>';
    document.getElementById('d-equation').textContent =
      fmtTvl(r.tvl_usd) + ' × ' + f.multiple.toFixed(3) + ' × ' + f.growth.toFixed(3) +
      ' × ' + f.maturity.toFixed(3) + ' × ' + f.breadth.toFixed(3) + ' × ' + f.confidence.toFixed(2) +
      ' = ' + fmtUsd(r.implied_value_usd);
    var ol = document.getElementById('d-steps');
    ol.innerHTML = '';
    r.farm_steps.forEach(function (s) {
      var li = document.createElement('li');
      li.textContent = s;
      ol.appendChild(li);
    });
    detail.classList.remove('hidden');
  }
  document.getElementById('detail-close').addEventListener('click', function () {
    detail.classList.add('hidden');
    document.querySelectorAll('#board tbody tr').forEach(function (tr) { tr.classList.remove('selected'); });
  });

  render();

  // screenshot modes: ?shot=board (default), ?shot=detail, ?shot=watchlist
  var shot = new URLSearchParams(location.search).get('shot');
  if (shot === 'detail') {
    openDetail(rows[0].slug);
    window.scrollTo(0, 0);
  } else if (shot === 'watchlist') {
    setFilter('watch', document.getElementById('f-watch'));
    window.scrollTo(0, 0);
  }
})();
