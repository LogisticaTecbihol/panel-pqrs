(async function () {
  await AUTH.authReady;

  var _all = [];
  var _usuarios = [];

  var ESTADO_BADGE = { 'Nuevo': 'b-nuevo', 'En proceso': 'b-proceso', 'Resuelto': 'b-resuelto', 'Cerrado': 'b-cerrado' };
  var URGENCIA_BADGE = { 'ALTO': 'b-alerta', 'MEDIO': 'b-medio', 'BAJA': 'b-baja' };
  var TIPO_LABEL = { 'Peticion': 'Petición', 'Queja': 'Queja', 'Reclamo': 'Reclamo', 'Sugerencia': 'Sugerencia' };

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

  function filtrar() {
    var fe = document.getElementById('f-empresa').value;
    var ft = document.getElementById('f-tipo').value;
    var fs = document.getElementById('f-estado').value;
    var fu = document.getElementById('f-urgencia').value;
    var fr = document.getElementById('f-responsable').value;
    var fb = document.getElementById('f-buscar').value.trim().toLowerCase();

    return _all.filter(function (r) {
      if (fe && r.empresa_sigla !== fe) return false;
      if (ft && r.tipo_solicitud !== ft) return false;
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

  function render() {
    var rows = filtrar();

    var stats = { Nuevo: 0, 'En proceso': 0, Resuelto: 0, Cerrado: 0 };
    _all.forEach(function (r) { if (stats[r.estado] !== undefined) stats[r.estado]++; });
    document.getElementById('stats').innerHTML =
      '<div class="sc recibido"><div class="num">' + stats.Nuevo + '</div><div class="lbl">Nuevos</div></div>' +
      '<div class="sc parcial"><div class="num">' + stats['En proceso'] + '</div><div class="lbl">En proceso</div></div>' +
      '<div class="sc entregado"><div class="num">' + stats.Resuelto + '</div><div class="lbl">Resueltos</div></div>' +
      '<div class="sc total"><div class="num">' + _all.length + '</div><div class="lbl">Total</div></div>';

    var tbody = document.getElementById('tbody');
    document.getElementById('count-tag').textContent = rows.length + ' de ' + _all.length;
    document.getElementById('empty-msg').style.display = rows.length ? 'none' : '';

    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td><strong>' + escHtml(r.folio) + '</strong></td>' +
        '<td><span class="sigla-badge sigla-' + r.empresa_sigla + '">' + r.empresa_sigla + '</span></td>' +
        '<td>' + (TIPO_LABEL[r.tipo_solicitud] || r.tipo_solicitud) + '</td>' +
        '<td>' + escHtml(r.area_relacionada) + '</td>' +
        '<td><span class="badge ' + (URGENCIA_BADGE[r.urgencia] || '') + '">' + r.urgencia + '</span></td>' +
        '<td><span class="badge ' + (ESTADO_BADGE[r.estado] || '') + '">' + escHtml(r.estado) + '</span></td>' +
        '<td>' + escHtml(nombreResponsable(r.responsable_id)) + '</td>' +
        '<td>' + fmtDate(r.creado_en) + '</td>' +
        '<td><a class="btn-ver" href="detalle.html?id=' + r.id + '">Ver</a></td>' +
        '</tr>';
    }).join('');
  }

  ['f-empresa', 'f-tipo', 'f-estado', 'f-urgencia', 'f-responsable'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', render);
  });
  document.getElementById('f-buscar').addEventListener('input', render);
  document.getElementById('btn-clear-filters').addEventListener('click', function () {
    ['f-empresa', 'f-tipo', 'f-estado', 'f-urgencia', 'f-responsable'].forEach(function (id) { document.getElementById(id).value = ''; });
    document.getElementById('f-buscar').value = '';
    render();
  });

  cargar();
})();
