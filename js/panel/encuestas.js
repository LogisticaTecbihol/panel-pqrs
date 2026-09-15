(async function () {
  await AUTH.authReady;

  var _all = [];
  var CAMPOS = [
    'calificacion_calidad_producto',
    'calificacion_atencion_asesor_tecnico',
    'calificacion_atencion_servicio_logistica',
    'calificacion_tiempos_respuesta',
    'calificacion_relacion_calidad_precio',
    'calificacion_satisfaccion_general',
  ];
  var CAMPO_LABEL = {
    calificacion_calidad_producto: 'Calidad producto',
    calificacion_atencion_asesor_tecnico: 'Atención asesor técnico',
    calificacion_atencion_servicio_logistica: 'Atención logística',
    calificacion_tiempos_respuesta: 'Tiempos de respuesta',
    calificacion_relacion_calidad_precio: 'Relación calidad-precio',
    calificacion_satisfaccion_general: 'Satisfacción general',
  };

  async function cargar() {
    var res = await _sb.from('encuestas_satisfaccion').select('*').order('creado_en', { ascending: false });
    if (res.error) { showToast('Error al cargar encuestas: ' + res.error.message, '#e74c3c'); return; }
    _all = res.data || [];
    render();
  }

  function filtrar() {
    var fe = document.getElementById('f-empresa').value;
    var fd = document.getElementById('f-desde').value;
    var fh = document.getElementById('f-hasta').value;
    return _all.filter(function (r) {
      if (fe && r.empresa_sigla !== fe) return false;
      var fecha = r.creado_en.slice(0, 10);
      if (fd && fecha < fd) return false;
      if (fh && fecha > fh) return false;
      return true;
    });
  }

  function estrellas(n) {
    var full = Math.round(n);
    return '<span class="stars">' + '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full) + '</span>';
  }

  function render() {
    var rows = filtrar();

    var kpiHtml = CAMPOS.map(function (campo) {
      var vals = rows.map(function (r) { return r[campo]; }).filter(function (v) { return v != null; });
      var avg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) : 0;
      return '<div class="kpi-card"><div class="num">' + avg.toFixed(1) + '</div>' + estrellas(avg) +
        '<div class="lbl">' + CAMPO_LABEL[campo] + '</div></div>';
    }).join('');
    document.getElementById('kpi-row').innerHTML = kpiHtml;

    document.getElementById('count-tag').textContent = rows.length + ' de ' + _all.length;
    document.getElementById('empty-msg').style.display = rows.length ? 'none' : '';

    document.getElementById('tbody').innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td>' + fmtDate(r.creado_en) + '</td>' +
        '<td><span class="sigla-badge sigla-' + r.empresa_sigla + '">' + r.empresa_sigla + '</span></td>' +
        '<td>' + escHtml(r.municipio) + '</td>' +
        '<td>' + escHtml(r.asesor_nombre || '') + '</td>' +
        '<td>' + escHtml(r.canal_adquisicion === 'Otro' ? (r.canal_adquisicion_otro || 'Otro') : r.canal_adquisicion) + '</td>' +
        '<td>' + r.calificacion_calidad_producto + '</td>' +
        '<td>' + r.calificacion_atencion_asesor_tecnico + '</td>' +
        '<td>' + r.calificacion_atencion_servicio_logistica + '</td>' +
        '<td>' + r.calificacion_tiempos_respuesta + '</td>' +
        '<td>' + r.calificacion_relacion_calidad_precio + '</td>' +
        '<td>' + r.calificacion_satisfaccion_general + '</td>' +
        '<td>' + escHtml(r.comentarios_adicionales || '') + '</td>' +
        '</tr>';
    }).join('');
  }

  ['f-empresa', 'f-desde', 'f-hasta'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', render);
  });
  document.getElementById('btn-clear-filters').addEventListener('click', function () {
    ['f-empresa', 'f-desde', 'f-hasta'].forEach(function (id) { document.getElementById(id).value = ''; });
    render();
  });

  cargar();
})();
