// ══════════════════════════════════════════════════════════════
// Encuesta de Satisfacción — pestañas Respuestas e Indicadores (solo lectura)
// ══════════════════════════════════════════════════════════════
// Los indicadores se calculan en el cliente con encuestas_satisfaccion (misma RLS: admin, gestor, lector).
// Los filtros de empresa y fechas son compartidos por las dos pestañas. Definiciones en el <details> de la página.
(async function () {
  await AUTH.authReady;

  var _all = [];
  var tab = location.hash === '#indicadores' ? 'indicadores' : 'respuestas';
  var hayPrev = false;                     // true cuando hay "Desde" y "Hasta" y por tanto periodo anterior comparable

  var GENERAL = 'calificacion_satisfaccion_general';
  var CAMPOS = [
    'calificacion_calidad_producto',
    'calificacion_atencion_asesor_tecnico',
    'calificacion_atencion_servicio_logistica',
    'calificacion_tiempos_respuesta',
    'calificacion_relacion_calidad_precio',
    GENERAL,
  ];
  var DIMS = CAMPOS.filter(function (c) { return c !== GENERAL; });   // las cinco preguntas específicas
  var CAMPO_LABEL = {
    calificacion_calidad_producto: 'Calidad producto',
    calificacion_atencion_asesor_tecnico: 'Atención asesor técnico',
    calificacion_atencion_servicio_logistica: 'Atención logística',
    calificacion_tiempos_respuesta: 'Tiempos de respuesta',
    calificacion_relacion_calidad_precio: 'Relación calidad-precio',
    calificacion_satisfaccion_general: 'Satisfacción general',
  };
  var CAMPO_CORTO = {
    calificacion_calidad_producto: 'Producto',
    calificacion_atencion_asesor_tecnico: 'Asesor técnico',
    calificacion_atencion_servicio_logistica: 'Logística',
    calificacion_tiempos_respuesta: 'Tiempos',
    calificacion_relacion_calidad_precio: 'Precio',
    calificacion_satisfaccion_general: 'General',
  };

  // Meta de satisfacción (promedio 1–5): verde ≥ META, ámbar ≥ META_MEDIA, rojo por debajo.
  var META = 4.5, META_MEDIA = 4.0;
  var MIN_N = 5;                           // menos respuestas que esto: el promedio de un segmento es poco representativo
  var MAX_ALERTAS = 25;
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var VERDE = '#15803d', AMBAR = '#d97706', ROJO = '#c0392b';
  var COLOR_NIVEL = { ok: VERDE, med: AMBAR, bajo: ROJO };
  var CLS_TXT = { ok: 'ind-ok', med: 'ind-med', bajo: 'ind-malo', '': '' };
  var CLS_TILE = { ok: 'entregado', med: 'recibido', bajo: 'alerta', '': 'info' };
  var COLOR_ESTRELLA = ['#c0392b', '#e67e22', '#cbd5e0', '#68a77a', '#15803d'];   // calificación 1 → 5

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }

  // ── Fechas y estadística ──
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fechaLocal(ts) { return fmtISO(new Date(ts)); }               // timestamptz -> 'YYYY-MM-DD' en hora local
  function addDias(iso, n) { var d = parseDateOnly(iso); d.setDate(d.getDate() + n); return fmtISO(d); }
  function suma(arr) { return arr.reduce(function (s, x) { return s + x; }, 0); }
  function prom(arr) { return arr.length ? suma(arr) / arr.length : null; }
  function pctDe(n, d) { return d ? Math.round(n / d * 100) : null; }

  // ── Formato ──
  function fmtNum(n, dec) {
    return n === null || n === undefined || isNaN(n) ? '—' : Number(n).toLocaleString('es-CO', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  function fmtN(n) { return fmtNum(n, 0); }
  function fmtProm(n) { return fmtNum(n, 2); }
  function fmtPct(p) { return p === null || p === undefined ? '—' : p + '%'; }
  function fmtPP(p) { return fmtNum(p, 0) + ' pp'; }

  // Variación contra el periodo anterior. mejor: 'sube' | 'baja' | 'neutro' (qué dirección es buena).
  function delta(cur, prev, fmtVal, mejor, fmtDif) {
    if (!hayPrev) return '';
    if (cur === null || cur === undefined || prev === null || prev === undefined) return '<span class="ind-delta">Sin comparativo</span>';
    var d = cur - prev;
    if (Math.abs(d) < 1e-9) return '<span class="ind-delta">= igual que antes (' + fmtVal(prev) + ')</span>';
    var bueno = mejor === 'sube' ? d > 0 : mejor === 'baja' ? d < 0 : null;
    return '<span class="ind-delta' + (bueno === null ? '' : bueno ? ' good' : ' bad') + '">' + (d > 0 ? '▲ +' : '▼ −') +
      (fmtDif || fmtVal)(Math.abs(d)) + ' · antes ' + fmtVal(prev) + '</span>';
  }

  // Semáforo contra la meta: '' (sin dato) | 'ok' | 'med' | 'bajo'
  function nivel(p) { return p === null || p === undefined ? '' : p >= META ? 'ok' : p >= META_MEDIA ? 'med' : 'bajo'; }

  // ══════════════ Carga ══════════════
  async function cargar() {
    var res = await fetchAll('encuestas_satisfaccion', '*', 'id');   // fetchAll: PostgREST corta en 1000 filas sin avisar
    if (res.error) { showToast('Error al cargar encuestas: ' + res.error.message, '#e74c3c'); return; }
    _all = (res.data || []).sort(function (a, b) { return new Date(b.creado_en) - new Date(a.creado_en); });
    _all.forEach(function (r) { r._f = fechaLocal(r.creado_en); });   // misma fecha local que muestra la tabla
    render();
  }

  // ══════════════ Filtros ══════════════
  function filtrarEmpresa() {
    var fe = $('f-empresa').value;
    return fe ? _all.filter(function (r) { return r.empresa_sigla === fe; }) : _all;
  }

  function enPeriodo(rows, d, h) {
    return rows.filter(function (r) { return (!d || r._f >= d) && (!h || r._f <= h); });
  }

  function filtrar() { return enPeriodo(filtrarEmpresa(), $('f-desde').value, $('f-hasta').value); }

  function aplicarPreset(k) {
    var h0 = today(), d = '', h = '';
    if (k === '90d') { d = addDias(h0, -89); h = h0; }
    else if (k === '12m') { d = addDias(h0, -364); h = h0; }
    else if (k === 'anio') { d = h0.slice(0, 4) + '-01-01'; h = h0; }
    $('f-desde').value = d; $('f-hasta').value = h;   // 'todo': sin fechas
    render();
  }

  // ══════════════ Pestañas ══════════════
  function mostrarTab() {
    ['respuestas', 'indicadores'].forEach(function (k) {
      $('tab-' + k).classList.toggle('active', k === tab);
      $('tab-' + k).setAttribute('aria-selected', k === tab ? 'true' : 'false');
      $('panel-' + k).style.display = k === tab ? '' : 'none';
    });
  }

  function cambiarTab(t) {
    tab = t === 'indicadores' ? 'indicadores' : 'respuestas';
    mostrarTab();
    try { history.replaceState(null, '', tab === 'indicadores' ? '#indicadores' : location.pathname + location.search); } catch (e) { /* sin historial: no pasa nada */ }
    render();
  }

  // ══════════════ Pestaña Respuestas ══════════════
  function estrellas(n) {
    var full = Math.round(n);
    return '<span class="stars">' + '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full) + '</span>';
  }

  function canalDe(r) { return r.canal_adquisicion === 'Otro' ? (r.canal_adquisicion_otro || 'Otro') : r.canal_adquisicion; }

  function renderRespuestas() {
    var rows = filtrar();

    var kpiHtml = CAMPOS.map(function (campo) {
      var vals = rows.map(function (r) { return r[campo]; }).filter(function (v) { return v != null; });
      var avg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) : 0;
      return '<div class="kpi-card"><div class="num">' + avg.toFixed(1) + '</div>' + estrellas(avg) +
        '<div class="lbl">' + CAMPO_LABEL[campo] + '</div></div>';
    }).join('');
    $('kpi-row').innerHTML = kpiHtml;

    $('count-tag').textContent = rows.length + ' de ' + _all.length;
    $('empty-msg').style.display = rows.length ? 'none' : '';

    $('tbody').innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td>' + fmtDate(r.creado_en) + '</td>' +
        '<td><span class="sigla-badge sigla-' + r.empresa_sigla + '">' + r.empresa_sigla + '</span></td>' +
        '<td>' + escHtml(r.municipio) + '</td>' +
        '<td>' + escHtml(r.asesor_nombre || '') + '</td>' +
        '<td>' + escHtml(canalDe(r)) + '</td>' +
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

  // ══════════════ Pestaña Indicadores: cálculo ══════════════
  // Resumen de un conjunto de respuestas: por pregunta, n, promedio, % satisfechos (4-5), % insatisfechos (1-2) y distribución 1→5.
  function resumen(rows) {
    var o = { n: rows.length, dims: {} };
    CAMPOS.forEach(function (c) {
      var vals = rows.map(function (r) { return r[c]; }).filter(function (v) { return v >= 1 && v <= 5; });
      var dist = [0, 0, 0, 0, 0];
      vals.forEach(function (v) { dist[v - 1]++; });
      o.dims[c] = {
        n: vals.length, prom: prom(vals), dist: dist,
        nSat: dist[3] + dist[4], nInsat: dist[0] + dist[1],
        sat: pctDe(dist[3] + dist[4], vals.length), insat: pctDe(dist[0] + dist[1], vals.length),
      };
    });
    o.gen = o.dims[GENERAL];
    o.conComentario = rows.filter(function (r) { return r.comentarios_adicionales && r.comentarios_adicionales.trim(); }).length;
    o.bajas = rows.filter(function (r) { return CAMPOS.some(function (c) { return r[c] != null && r[c] <= 2; }); });   // conserva el orden (recientes primero)
    return o;
  }

  // Pregunta específica con el mejor (signo > 0) o peor (signo < 0) promedio; null si no hay datos.
  function extremo(res, signo) {
    var mejor = null;
    DIMS.forEach(function (c) {
      var p = res.dims[c].prom;
      if (p === null) return;
      if (mejor === null || (signo > 0 ? p > res.dims[mejor].prom : p < res.dims[mejor].prom)) mejor = c;
    });
    return mejor;
  }

  // Agrupa respuestas por una etiqueta (sin distinguir mayúsculas ni tildes); conserva la primera grafía vista.
  function segmentos(rows, etiquetaDe) {
    var mapa = {}, orden = [];
    rows.forEach(function (r) {
      var et = etiquetaDe(r), k = norm(et).trim();
      if (!mapa[k]) { mapa[k] = { label: et, rows: [] }; orden.push(k); }
      mapa[k].rows.push(r);
    });
    return orden.map(function (k) { return mapa[k]; });
  }

  // ══════════════ Piezas de dibujo (mismas que Indicadores de Mercadeo) ══════════════
  function tile(cls, num, lbl, sub, dlt) {
    return '<div class="sc ' + cls + '"><div class="num">' + num + '</div><div class="lbl">' + lbl + '</div><div class="mk-sub">' + (sub || '') + '</div>' + (dlt || '') + '</div>';
  }

  function card(titulo, cuerpo, opc) {
    opc = opc || {};
    return '<div class="card' + (opc.full ? ' full' : '') + '"><div class="card-head"><h3>' + esc(titulo) + '</h3>' +
      (opc.sub ? '<span class="mk-sub">' + opc.sub + '</span>' : '') + '</div><div class="mbody">' + cuerpo +
      (opc.nota ? '<div class="ind-note">' + opc.nota + '</div>' : '') + '</div></div>';
  }

  // items: [{ label, v (largo de la barra), txt (HTML del valor), color }]
  function barras(items, vacio) {
    var max = items.reduce(function (m, i) { return Math.max(m, i.v); }, 0);
    if (!max) return '<div class="mk-sin">' + (vacio || 'Sin datos en el periodo.') + '</div>';
    return '<div class="ind-bars">' + items.map(function (i) {
      return '<div class="ind-bar-row"><span class="ind-bar-l" title="' + esc(i.label) + '">' + esc(i.label) + '</span>' +
        '<span class="ind-bar-t"><i style="width:' + (i.v / max * 100).toFixed(1) + '%;' + (i.color ? 'background:' + i.color : '') + '"></i></span>' +
        '<span class="ind-bar-v">' + i.txt + '</span></div>';
    }).join('') + '</div>';
  }

  function conPct(n, total) { return fmtN(n) + (total ? ' <small>(' + pctDe(n, total) + '%)</small>' : ''); }

  function tabla(cabeceras, filas, vacio) {
    if (!filas.length) return '<div class="mk-sin">' + (vacio || 'Sin datos.') + '</div>';
    return '<div class="table-wrap"><table class="mk-mini"><thead><tr>' + cabeceras.map(function (c) {
      return '<th' + (c.num ? ' class="ind-num"' : '') + '>' + esc(c.t) + '</th>';
    }).join('') + '</tr></thead><tbody>' + filas.join('') + '</tbody></table></div>';
  }

  // Barra apilada con la distribución de calificaciones 1 → 5.
  function pila(dist, total) {
    if (!total) return '—';
    var txt = dist.map(function (n, i) { return (i + 1) + ' ★: ' + n; }).join(', ');
    return '<div class="ind-stack enc-stack" role="img" aria-label="Distribución de calificaciones — ' + esc(txt) + '">' +
      dist.map(function (n, i) {
        return n ? '<i title="' + (i + 1) + ' ★: ' + n + ' (' + pctDe(n, total) + '%)" style="width:' + (n / total * 100).toFixed(2) + '%;background:' + COLOR_ESTRELLA[i] + '"></i>' : '';
      }).join('') + '</div>';
  }

  // ══════════════ Pestaña Indicadores: secciones ══════════════
  function renderKpis(cur, prev) {
    var g = cur.gen, gp = prev.gen, nv = nivel(g.prom);
    var fuerte = extremo(cur, 1), debil = extremo(cur, -1);
    var html =
      tile('info', fmtN(cur.n), 'Respuestas', fmtN(cur.conComentario) + ' con comentario', delta(cur.n, prev.n, fmtN, 'neutro')) +
      tile(CLS_TILE[nv], fmtProm(g.prom), 'Satisfacción general', 'meta ≥ ' + fmtNum(META, 1) + ' de 5', delta(g.prom, gp.prom, fmtProm, 'sube')) +
      tile('entregado', fmtPct(g.sat), 'Satisfechos (4-5)', fmtN(g.nSat) + ' de ' + fmtN(g.n), delta(g.sat, gp.sat, fmtPct, 'sube', fmtPP)) +
      tile('alerta', fmtPct(g.insat), 'Insatisfechos (1-2)', fmtN(g.nInsat) + ' de ' + fmtN(g.n), delta(g.insat, gp.insat, fmtPct, 'baja', fmtPP));
    if (fuerte) html += tile('entregado', fmtProm(cur.dims[fuerte].prom), 'Dimensión más fuerte', esc(CAMPO_CORTO[fuerte]),
      delta(cur.dims[fuerte].prom, prev.dims[fuerte].prom, fmtProm, 'sube'));
    if (debil) html += tile(CLS_TILE[nivel(cur.dims[debil].prom)], fmtProm(cur.dims[debil].prom), 'Dimensión más débil', esc(CAMPO_CORTO[debil]),
      delta(cur.dims[debil].prom, prev.dims[debil].prom, fmtProm, 'sube'));
    html += tile('alerta', fmtN(cur.bajas.length), 'Con alguna calificación baja', fmtPct(pctDe(cur.bajas.length, cur.n)) + ' de las respuestas (1 o 2)',
      delta(cur.bajas.length, prev.bajas.length, fmtN, 'baja'));
    $('ind-kpis').innerHTML = html;
  }

  // Promedio mensual de la satisfacción general, 12 meses hasta el mes de "Hasta" (o el actual). Escala 1–5 (la base de la barra es 1).
  function cardTendencia(baseEmp, hasta) {
    var ref = hasta || today();
    var y = Number(ref.slice(0, 4)), m = Number(ref.slice(5, 7)), meses = [], acc = {};
    for (var i = 11; i >= 0; i--) { var dt = new Date(y, m - 1 - i, 1); meses.push(dt.getFullYear() + '-' + pad2(dt.getMonth() + 1)); }
    baseEmp.forEach(function (r) { var k = r._f.slice(0, 7); (acc[k] = acc[k] || []).push(r[GENERAL]); });
    function barra(vals) {
      if (!vals) return '<div class="ind-trend-bar uno" style="height:0;min-height:0"></div>';
      var p = prom(vals), px = Math.max(3, Math.round((p - 1) / 4 * 120));
      return '<div class="ind-trend-bar uno" style="height:' + px + 'px;background:' + COLOR_NIVEL[nivel(p)] + '"><span>' + fmtNum(p, 1) + '</span></div>';
    }
    var hay = meses.some(function (k) { return acc[k]; });
    var cuerpo = hay
      ? '<div class="ind-key"><span><i style="background:' + VERDE + '"></i>≥ ' + fmtNum(META, 1) + '</span><span><i style="background:' + AMBAR + '"></i>' + fmtNum(META_MEDIA, 1) + ' a ' + fmtNum(META, 1) +
        '</span><span><i style="background:' + ROJO + '"></i>&lt; ' + fmtNum(META_MEDIA, 1) + '</span></div>' +
        '<div class="ind-trend enc-trend">' + meses.map(function (k) {
          var v = acc[k];
          return '<div class="ind-trend-col"><div class="ind-trend-bars">' + barra(v) + '</div><div class="ind-trend-mes">' +
            esc(MESES[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4)) + '<br><small>' + (v ? 'n=' + v.length : '—') + '</small></div></div>';
        }).join('') + '</div>'
      : '<div class="mk-sin">Sin respuestas en estos meses.</div>';
    return card('Satisfacción general por mes', cuerpo, { full: true, sub: '12 meses hasta ' + (hasta ? 'la fecha “Hasta”' : 'hoy'),
      nota: 'Promedio mensual de la pregunta de satisfacción general (escala 1–5). Debajo de cada mes, el número de respuestas. No depende del rango de fechas, solo del filtro de empresa.' });
  }

  function cardDistribucion(cur) {
    var g = cur.gen;
    var color = [ROJO, ROJO, AMBAR, VERDE, VERDE];
    var items = [4, 3, 2, 1, 0].map(function (i) { return { label: (i + 1) + ' ★', v: g.dist[i], txt: conPct(g.dist[i], g.n), color: color[i] }; });
    return card('Distribución de la satisfacción general', barras(items), { sub: fmtN(g.n) + ' respuestas',
      nota: '4 y 5: satisfechos · 3: neutro · 1 y 2: insatisfechos.' });
  }

  function cardDimensiones(cur, prev) {
    var cab = [{ t: 'Pregunta' }, { t: 'Promedio', num: 1 }];
    if (hayPrev) cab.push({ t: 'vs. periodo anterior' });
    cab.push({ t: 'Satisfechos (4-5)', num: 1 }, { t: 'Insatisfechos (1-2)', num: 1 }, { t: 'Distribución 1 → 5' });
    var filas = CAMPOS.map(function (c) {
      var d = cur.dims[c], dp = prev.dims[c];
      return '<tr><td>' + esc(CAMPO_LABEL[c]) + (c === GENERAL ? ' <span class="mk-sin">(global)</span>' : '') + '</td>' +
        '<td class="ind-num ' + CLS_TXT[nivel(d.prom)] + '">' + fmtProm(d.prom) + '</td>' +
        (hayPrev ? '<td>' + delta(d.prom, dp.prom, fmtProm, 'sube') + '</td>' : '') +
        '<td class="ind-num">' + fmtPct(d.sat) + '</td>' +
        '<td class="ind-num' + (d.insat ? ' ind-malo' : '') + '">' + fmtPct(d.insat) + '</td>' +
        '<td>' + pila(d.dist, d.n) + '</td></tr>';
    });
    var leyenda = '<div class="ind-key">' + COLOR_ESTRELLA.map(function (col, i) { return '<span><i style="background:' + col + '"></i>' + (i + 1) + ' ★</span>'; }).join('') + '</div>';
    return card('Calificación por pregunta', leyenda + tabla(cab, filas), { full: true, sub: fmtN(cur.n) + ' respuestas',
      nota: 'El color del promedio compara contra la meta de ' + fmtNum(META, 1) + ' (ámbar desde ' + fmtNum(META_MEDIA, 1) + ').' });
  }

  // Tabla de un segmento: respuestas, satisfacción general promedio y % de satisfechos. Orden: más respuestas primero.
  function cardSegmento(titulo, colEtiqueta, rows, etiquetaDe, htmlEtiqueta) {
    var segs = segmentos(rows, etiquetaDe).map(function (s) { s.res = resumen(s.rows); return s; });
    segs.sort(function (a, b) { return b.res.n - a.res.n || String(a.label).localeCompare(String(b.label), 'es'); });
    var hayPoca = false;
    var filas = segs.map(function (s) {
      var g = s.res.gen, poca = s.res.n < MIN_N;
      if (poca) hayPoca = true;
      return '<tr><td>' + (htmlEtiqueta ? htmlEtiqueta(s.label) : esc(s.label)) + '</td><td class="ind-num">' + fmtN(s.res.n) + '</td>' +
        '<td class="ind-num ' + (poca ? 'ind-poca' : CLS_TXT[nivel(g.prom)]) + '"' + (poca ? ' title="Menos de ' + MIN_N + ' respuestas: poco representativo"' : '') + '>' + fmtProm(g.prom) + '</td>' +
        '<td class="ind-num' + (poca ? ' ind-poca' : '') + '">' + fmtPct(g.sat) + '</td></tr>';
    });
    var cuerpo = '<div class="enc-scroll">' + tabla([{ t: colEtiqueta }, { t: 'Resp.', num: 1 }, { t: 'Prom. general', num: 1 }, { t: '% satisf.', num: 1 }], filas) + '</div>';
    return card(titulo, cuerpo, { sub: fmtN(segs.length) + (segs.length === 1 ? ' grupo' : ' grupos'),
      nota: 'Resp.: respuestas. Prom. general: promedio de la pregunta de satisfacción general. % satisf.: respuestas con 4 o 5 en esa pregunta.' +
        (hayPoca ? ' En gris: menos de ' + MIN_N + ' respuestas, poco representativo.' : '') });
  }

  function cardAlertas(cur) {
    var bajas = cur.bajas;
    var filas = bajas.slice(0, MAX_ALERTAS).map(function (r) {
      var chips = CAMPOS.filter(function (c) { return r[c] != null && r[c] <= 2; }).map(function (c) {
        return '<span class="enc-chip">' + esc(CAMPO_CORTO[c]) + ' ' + esc(r[c]) + '</span>';
      }).join('');
      return '<tr><td>' + esc(fmtDate(r.creado_en)) + '</td>' +
        '<td><span class="sigla-badge sigla-' + esc(r.empresa_sigla) + '">' + esc(r.empresa_sigla) + '</span></td>' +
        '<td>' + esc(r.municipio) + '</td><td>' + esc(r.asesor_nombre || '') + '</td><td>' + esc(canalDe(r)) + '</td>' +
        '<td>' + chips + '</td><td class="ind-num">' + esc(r[GENERAL]) + '</td>' +
        '<td class="enc-coment">' + esc(r.comentarios_adicionales || '') + '</td></tr>';
    });
    var cuerpo = tabla([{ t: 'Fecha' }, { t: 'Empresa' }, { t: 'Municipio' }, { t: 'Asesor' }, { t: 'Canal' }, { t: 'Calificaciones bajas' }, { t: 'General', num: 1 }, { t: 'Comentarios' }],
      filas, 'Ninguna respuesta con calificación de 1 o 2. 👏') +
      (bajas.length > MAX_ALERTAS ? '<div class="ind-note">Se muestran las ' + MAX_ALERTAS + ' más recientes de ' + fmtN(bajas.length) + '. Afina con los filtros de fecha o empresa.</div>' : '');
    return card('Respuestas con calificación baja (1 o 2)', cuerpo, { full: true, sub: fmtN(bajas.length) + ' de ' + fmtN(cur.n) + ' respuestas' });
  }

  // ══════════════ Pestaña Indicadores: render ══════════════
  function renderIndicadores() {
    var d = $('f-desde').value, h = $('f-hasta').value, baseEmp = filtrarEmpresa();
    var aviso = $('ind-periodo');
    if (d && h && d > h) {
      aviso.innerHTML = '<span class="ind-malo">Elige un rango de fechas válido (“Desde” no puede ser posterior a “Hasta”).</span>';
      $('ind-vacio').style.display = 'none'; $('ind-contenido').style.display = 'none';
      return;
    }
    var rows = enPeriodo(baseEmp, d, h);
    hayPrev = !!(d && h);
    var prevRows = [], pD = '', pH = '', dias = 0;
    if (hayPrev) {
      dias = diasEntre(d, h) + 1;
      pH = addDias(d, -1); pD = addDias(d, -dias);
      prevRows = enPeriodo(baseEmp, pD, pH);
    }
    var txt = (d || h) ? 'Periodo: ' + (d ? fmtDateOnly(d) : 'desde el inicio') + ' – ' + (h ? fmtDateOnly(h) : 'hoy') : 'Periodo: todo el histórico';
    txt += hayPrev
      ? ' (' + dias + (dias === 1 ? ' día' : ' días') + ') · comparado con ' + fmtDateOnly(pD) + ' – ' + fmtDateOnly(pH) + ' (' + fmtN(prevRows.length) + ' respuestas)'
      : ' · sin comparativo: elige “Desde” y “Hasta” para compararlo con el periodo anterior';
    aviso.textContent = txt + ' · ' + fmtN(rows.length) + ' de ' + fmtN(_all.length) + ' respuestas con los filtros actuales';

    if (!rows.length) { $('ind-vacio').style.display = ''; $('ind-contenido').style.display = 'none'; return; }
    $('ind-vacio').style.display = 'none'; $('ind-contenido').style.display = '';

    var cur = resumen(rows), prev = resumen(prevRows);
    renderKpis(cur, prev);
    $('ind-resumen').innerHTML = cardTendencia(baseEmp, h) + cardDistribucion(cur);
    $('ind-dim').innerHTML = cardDimensiones(cur, prev);
    $('ind-seg').innerHTML =
      cardSegmento('Por empresa', 'Empresa', rows, function (r) { return r.empresa_sigla; }, function (s) { return '<span class="sigla-badge sigla-' + esc(s) + '">' + esc(s) + '</span>'; }) +
      cardSegmento('Por canal de adquisición', 'Canal', rows, function (r) { return r.canal_adquisicion; }) +
      cardSegmento('Por asesor', 'Asesor', rows, function (r) { return (r.asesor_nombre || '').trim() || 'Sin asesor'; }) +
      cardSegmento('Por municipio', 'Municipio', rows, function (r) { return (r.municipio || '').trim() || 'Sin municipio'; });
    $('ind-alertas').innerHTML = cardAlertas(cur);
  }

  function render() {
    if (tab === 'indicadores') renderIndicadores(); else renderRespuestas();
  }

  // ══════════════ Eventos ══════════════
  var ACCIONES = {
    'tab': function (id, el) { cambiarTab(el.getAttribute('data-tab')); },
    'preset': function (id) { aplicarPreset(id); },
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACCIONES[el.getAttribute('data-act')];
    if (fn) fn(el.getAttribute('data-id'), el, e);
  });
  ['f-empresa', 'f-desde', 'f-hasta'].forEach(function (id) {
    $(id).addEventListener('change', render);
  });
  $('btn-clear-filters').addEventListener('click', function () {
    ['f-empresa', 'f-desde', 'f-hasta'].forEach(function (id) { $(id).value = ''; });
    render();
  });

  mostrarTab();
  cargar();
})();
