(async function () {
  await AUTH.authReady;

  var _all = [];
  var _usuarios = [];

  var ESTADO_BADGE = { 'Nuevo': 'b-nuevo', 'En proceso': 'b-proceso', 'Resuelto': 'b-resuelto', 'Cerrado': 'b-cerrado' };
  var URGENCIA_BADGE = { 'ALTO': 'b-alerta', 'MEDIO': 'b-medio', 'BAJA': 'b-baja' };
  var URGENCIA_RANK = { 'ALTO': 3, 'MEDIO': 2, 'BAJA': 1 };
  var ESTADO_RANK = { 'Nuevo': 1, 'En proceso': 2, 'Resuelto': 3, 'Cerrado': 4 };

  var _sortKey = 'creado_en';
  var _sortDir = 'desc';
  var _tab = 'actuales';

  async function cargar() {
    var [usuariosRes, pqrsRes] = await Promise.all([
      _sb.from('usuarios_pqrs').select('id, nombre, email').eq('activo', true),
      _sb.from('pqrs').select('*').order('creado_en', { ascending: false }),
    ]);

    if (pqrsRes.error) { showToast('Error al cargar PQRS: ' + pqrsRes.error.message, '#e74c3c'); return; }

    _usuarios = usuariosRes.data || [];
    _all = pqrsRes.data || [];

    var selResp = document.getElementById('f-responsable');
    _usuarios.forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.id; opt.textContent = u.nombre || u.email;
      selResp.appendChild(opt);
    });

    var params = new URLSearchParams(location.search);
    var folio = params.get('folio');
    if (folio) document.getElementById('f-buscar').value = folio;

    render();
  }

  function nombreResponsable(id) {
    var u = _usuarios.filter(function (x) { return x.id === id; })[0];
    return u ? (u.nombre || u.email) : '';
  }

  function porPestana() {
    return _all.filter(function (r) { return _tab === 'historico' ? r.es_historico : !r.es_historico; });
  }

  function filtrar() {
    var fe = document.getElementById('f-empresa').value;
    var ft = document.getElementById('f-tipo').value;
    var fa = document.getElementById('f-area').value;
    var fs = document.getElementById('f-estado').value;
    var fu = document.getElementById('f-urgencia').value;
    var fr = document.getElementById('f-responsable').value;
    var fb = document.getElementById('f-buscar').value.trim().toLowerCase();

    return porPestana().filter(function (r) {
      if (fe && r.empresa_sigla !== fe) return false;
      if (ft && r.tipo_solicitud !== ft) return false;
      if (fa && r.area_relacionada !== fa) return false;
      if (fs && r.estado !== fs) return false;
      if (fu && r.urgencia !== fu) return false;
      if (fr && r.responsable_id !== fr) return false;
      if (fb) {
        var hay = (r.folio + ' ' + r.contacto + ' ' + (r.nombre_completo || '') + ' ' + r.descripcion).toLowerCase();
        if (hay.indexOf(fb) === -1) return false;
      }
      return true;
    });
  }

  function ordenar(rows) {
    var key = _sortKey;
    var dir = _sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va, vb;
      if (key === 'urgencia') { va = URGENCIA_RANK[a.urgencia] || 0; vb = URGENCIA_RANK[b.urgencia] || 0; }
      else if (key === 'estado') { va = ESTADO_RANK[a.estado] || 0; vb = ESTADO_RANK[b.estado] || 0; }
      else if (key === 'responsable') { va = nombreResponsable(a.responsable_id).toLowerCase(); vb = nombreResponsable(b.responsable_id).toLowerCase(); }
      else if (key === 'creado_en') { va = new Date(a.creado_en).getTime(); vb = new Date(b.creado_en).getTime(); }
      else { va = (a[key] || '').toString().toLowerCase(); vb = (b[key] || '').toString().toLowerCase(); }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function actualizarIconosOrden() {
    document.querySelectorAll('thead th.sortable').forEach(function (th) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.getAttribute('data-sort') === _sortKey) th.classList.add(_sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    });
  }

  function render() {
    var base = porPestana();
    var rows = ordenar(filtrar());

    var stats = { Nuevo: 0, 'En proceso': 0, Resuelto: 0, Cerrado: 0 };
    base.forEach(function (r) { if (stats[r.estado] !== undefined) stats[r.estado]++; });
    document.getElementById('stats').innerHTML =
      '<div class="sc recibido"><div class="num">' + stats.Nuevo + '</div><div class="lbl">Nuevos</div></div>' +
      '<div class="sc parcial"><div class="num">' + stats['En proceso'] + '</div><div class="lbl">En proceso</div></div>' +
      '<div class="sc entregado"><div class="num">' + stats.Resuelto + '</div><div class="lbl">Resueltos</div></div>' +
      '<div class="sc total"><div class="num">' + base.length + '</div><div class="lbl">Total</div></div>';

    var tbody = document.getElementById('tbody');
    document.getElementById('count-tag').textContent = rows.length + ' de ' + base.length;
    document.getElementById('empty-msg').style.display = rows.length ? 'none' : '';

    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td><strong>' + escHtml(r.folio) + '</strong></td>' +
        '<td><span class="sigla-badge sigla-' + r.empresa_sigla + '">' + r.empresa_sigla + '</span></td>' +
        '<td>' + escHtml(r.nombre_completo || '') + '</td>' +
        '<td>' + escHtml(r.tipo_solicitud) + '</td>' +
        '<td>' + escHtml(r.area_relacionada) + '</td>' +
        '<td>' + escHtml(r.producto_lote || '') + '</td>' +
        '<td><span class="badge ' + (URGENCIA_BADGE[r.urgencia] || '') + '">' + r.urgencia + '</span></td>' +
        '<td><span class="badge ' + (ESTADO_BADGE[r.estado] || '') + '">' + escHtml(r.estado) + '</span></td>' +
        '<td>' + escHtml(nombreResponsable(r.responsable_id)) + '</td>' +
        '<td>' + fmtDate(r.creado_en) + '</td>' +
        '<td><a class="btn-ver" href="detalle.html?id=' + r.id + '">Ver</a></td>' +
        '</tr>';
    }).join('');
  }

  ['f-empresa', 'f-tipo', 'f-area', 'f-estado', 'f-urgencia', 'f-responsable'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', render);
  });
  document.getElementById('f-buscar').addEventListener('input', render);
  document.getElementById('btn-clear-filters').addEventListener('click', function () {
    ['f-empresa', 'f-tipo', 'f-area', 'f-estado', 'f-urgencia', 'f-responsable'].forEach(function (id) { document.getElementById(id).value = ''; });
    document.getElementById('f-buscar').value = '';
    render();
  });

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      _tab = btn.getAttribute('data-tab');
      render();
    });
  });

  document.querySelectorAll('thead th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (_sortKey === key) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortKey = key;
        _sortDir = key === 'creado_en' ? 'desc' : 'asc';
      }
      actualizarIconosOrden();
      render();
    });
  });
  actualizarIconosOrden();

  cargar();
})();
