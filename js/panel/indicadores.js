// ══════════════════════════════════════════════════════════════
// Indicadores de Mercadeo — gestión del Tablero de tareas (solo lectura)
// ══════════════════════════════════════════════════════════════
// Todo se calcula en el cliente con lo que el Tablero ya guarda: mercadeo_tareas (sellos creado_en / confirmada_en /
// entregada_en puestos por el servidor) y el historial de cambios de estado de mercadeo_tarea_bitacora (para el tiempo
// en cada etapa y las cancelaciones/rechazos). Mismo permiso que el Tablero y el CRM (módulo 'mercadeo'); no escribe nada.
// Las definiciones de "a tiempo" y "confirmada en ≤ 24 h" son las mismas de CRM > Indicadores (ver <details> de la página).
(async function () {
  await AUTH.authReady;
  if (!AUTH.getProfile() || !AUTH.hasModule('mercadeo')) return;

  // ── Catálogos (valores en BD = códigos ASCII) ──
  var ETAPAS = ['solicitada', 'confirmada', 'en_produccion', 'en_validacion'];   // columnas "abiertas" del Tablero
  var ETAPA_T = { solicitada: 'Recibido', confirmada: 'Confirmada', en_produccion: 'En producción', en_validacion: 'En validación / aprobación' };
  var ETAPA_COLOR = { solicitada: '#d97706', confirmada: '#2563eb', en_produccion: '#7c3aed', en_validacion: '#0891b2' };
  var TIPOS = { diseno: 'Diseño gráfico', redes: 'Redes sociales y contenido', evento: 'Evento', pop: 'Material POP', campana: 'Campaña', pauta: 'Pauta digital', otro: 'Otro' };
  var ASUNTOS = {
    material_pop: 'Material POP', material_impreso: 'Material impreso', piezas_graficas: 'Piezas gráficas',
    piezas_audiovisuales: 'Piezas audiovisuales', diseno_nuevo_producto: 'Diseño de nuevo producto',
    diseno_ajuste_portafolios: 'Diseño y ajuste de portafolios', diseno_ajuste_institucional: 'Diseño y ajuste de material institucional',
    desarrollo_marca: 'Desarrollo de marca', otros: 'Otros'
  };
  var CLASE_ORDEN = ['calendario', 'soporte_ventas', 'mejora', 'exploratorio'];
  var CLASE_T = { calendario: '1 · Calendario aprobado', soporte_ventas: '2 · Soporte a ventas', mejora: '3 · Mejora / pieza nueva', exploratorio: '4 · Exploratorio' };
  var CLASE_CORTA = { calendario: 'Calendario', soporte_ventas: 'Soporte ventas', mejora: 'Mejora', exploratorio: 'Exploratorio' };
  var CLASE_COLOR = { calendario: '#15803d', soporte_ventas: '#2563eb', mejora: '#a0aec0', exploratorio: '#b794f4' };
  var ORIGEN_T = { panel_pedidos: 'Desde Pedidos', panel_mercadeo: 'Creadas en Mercadeo' };
  var SIGLAS = EMPRESAS.map(function (e) { return e.sigla; });
  // Tareas de eventos de empresas adicionales (Chía Abagó, Tecbihol, Otros; migración 0032).
  var TODAS = SIGLAS.concat(EMPRESAS_EXTRA.map(function (x) { return x.sigla; }));
  var EMPRESA_T = {};
  EMPRESAS_EXTRA.forEach(function (x) { EMPRESA_T[x.sigla] = x.nombre; });
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var VERDE = '#15803d', ROJO = '#e74c3c', GRIS = '#a0aec0';

  // ── Estado ──
  var tareas = [], bitacora = [], equipo = [];
  var visitas = [], cierres = [];          // derivados de la bitácora (ver derivarBitacora)
  var baseEmp = [], base = [], baseIds = {};   // base = tareas que pasan empresa + responsable; baseEmp solo empresa
  var fDesde = '', fHasta = '', fEmp = '', fResp = '', hoy = '';
  var excluidas = 0;                       // tareas marcadas "no contar en indicadores" (pruebas); no entran en ningún cálculo

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function fail(accion, error) { showToast('Error al ' + accion + ': ' + errMsg(error), '#e74c3c'); }

  // ── Fechas y estadística ──
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fechaLocal(ts) { return fmtISO(new Date(ts)); }                // timestamptz -> 'YYYY-MM-DD' en hora local
  function addDias(iso, n) { var d = parseDateOnly(iso); d.setDate(d.getDate() + n); return fmtISO(d); }
  function enRango(f, d, h) { return f >= d && f <= h; }
  function horasEntre(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / 3600000; }
  function horasDesde(ts) { return (Date.now() - new Date(ts).getTime()) / 3600000; }
  function suma(arr) { return arr.reduce(function (s, x) { return s + x; }, 0); }
  function prom(arr) { return arr.length ? suma(arr) / arr.length : null; }
  function ordenar(arr) { return arr.slice().sort(function (a, b) { return a - b; }); }
  function mediana(arr) {
    if (!arr.length) return null;
    var s = ordenar(arr), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function percentil(arr, p) {
    if (!arr.length) return null;
    var s = ordenar(arr);
    return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  }
  function pctDe(n, d) { return d ? Math.round(n / d * 100) : null; }
  function esAbierta(t) { return ETAPAS.indexOf(t.estado) >= 0; }
  function vencida(t) { return esAbierta(t) && !!t.fecha_limite && t.fecha_limite < hoy; }

  // ── Formato ──
  function fmtNum(n, dec) {
    return n === null || n === undefined || isNaN(n) ? '—' : Number(n).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: dec || 0 });
  }
  function fmtN(n) { return fmtNum(n, 0); }
  function fmtPct(p) { return p === null || p === undefined ? '—' : p + '%'; }
  function fmtPP(p) { return fmtNum(p, 0) + ' pp'; }
  function fmtH(h) { return h === null || h === undefined ? '—' : (h < 48 ? fmtNum(h, 1) + ' h' : fmtNum(h / 24, 1) + ' d'); }
  function fmtD(d) { return d === null || d === undefined ? '—' : fmtNum(d, 1) + ' d'; }
  function nombreEquipo(id) {
    var u = equipo.filter(function (x) { return x.id === id; })[0];
    return u ? u.nombre : 'Usuario inactivo';
  }
  function etiquetaMes(k) { return MESES[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4); }

  // Variación contra el periodo anterior. mejor: 'sube' | 'baja' | 'neutro' (qué dirección es buena).
  function delta(cur, prev, fmtVal, mejor, fmtDif) {
    if (cur === null || cur === undefined || prev === null || prev === undefined) return '<span class="ind-delta">Sin comparativo</span>';
    var d = cur - prev;
    if (Math.abs(d) < 1e-9) return '<span class="ind-delta">= igual que antes (' + fmtVal(prev) + ')</span>';
    var bueno = mejor === 'sube' ? d > 0 : mejor === 'baja' ? d < 0 : null;
    return '<span class="ind-delta' + (bueno === null ? '' : bueno ? ' good' : ' bad') + '">' + (d > 0 ? '▲ +' : '▼ −') +
      (fmtDif || fmtVal)(Math.abs(d)) + ' · antes ' + fmtVal(prev) + '</span>';
  }

  // ══════════════ Carga ══════════════
  async function cargar(primera) {
    try {
      var rs = await Promise.all([
        fetchAll('mercadeo_tareas', 'id,titulo,estado,tipo,prioridad,urgente,fuera_calendario,empresas,responsables,fecha_limite,creado_en,confirmada_en,entregada_en,origen,asunto,excluir_indicadores', 'id'),
        fetchAll('mercadeo_tarea_bitacora', 'tarea_id,detalle,creado_en', 'id', function (q) { return q.eq('tipo_evento', 'cambio_estado'); }),
        _sb.rpc('list_equipo_mercadeo'),
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      // Las marcadas como prueba (excluir_indicadores) no cuentan. creado_en lo sella el servidor; sin él no se puede ubicar en un periodo.
      excluidas = rs[0].data.filter(function (t) { return t.excluir_indicadores; }).length;
      tareas = rs[0].data.filter(function (t) { return t.creado_en && !t.excluir_indicadores; });
      bitacora = rs[1].data; equipo = rs[2].data || [];
    } catch (err) {
      if (primera) {
        $('estado-carga').innerHTML = 'No se pudieron cargar los datos: ' + esc(errMsg(err)) +
          '<br><button class="btn-primary" style="margin-top:12px" data-act="reintentar">Reintentar</button>';
      } else {
        showToast('Error al actualizar: ' + errMsg(err), '#e74c3c');
      }
      return false;
    }
    EQUIPO_COLOR.asignar(equipo);
    derivarBitacora();
    $('estado-carga').style.display = 'none';
    $('contenido').style.display = '';
    rellenarFiltros();
    render();
    return true;
  }

  // Del historial de cambios de estado: cuánto estuvo cada tarea en cada etapa (visitas que terminaron) y cuándo se
  // cancelaron o rechazaron. La tarea nace en 'solicitada' (creado_en); cada evento cierra la etapa 'de' y abre la 'a'.
  function derivarBitacora() {
    var porTarea = {};
    bitacora.forEach(function (ev) { (porTarea[ev.tarea_id] = porTarea[ev.tarea_id] || []).push(ev); });
    visitas = []; cierres = [];
    tareas.forEach(function (t) {
      var evs = (porTarea[t.id] || []).slice().sort(function (a, b) { return new Date(a.creado_en) - new Date(b.creado_en); });
      var ini = new Date(t.creado_en).getTime();
      evs.forEach(function (ev) {
        var d = ev.detalle || {}, fin = new Date(ev.creado_en).getTime();
        if (ETAPAS.indexOf(d.de) >= 0 && fin >= ini) visitas.push({ t: t, etapa: d.de, fecha: fechaLocal(ev.creado_en), dias: (fin - ini) / 86400000 });
        if (d.a === 'cancelada' || d.a === 'rechazada') cierres.push({ t: t, fecha: fechaLocal(ev.creado_en), a: d.a });
        ini = fin;
      });
    });
  }

  function optsHtml(pares, sel) {
    return pares.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(sel) ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('');
  }

  function rellenarFiltros() {
    var fe = $('f-empresa'), vE = fe.value;
    fe.innerHTML = '<option value="">Todas</option>' + optsHtml(SIGLAS.map(function (s) { return [s, s]; })
      .concat(EMPRESAS_EXTRA.map(function (x) { return [x.sigla, x.nombre]; })), vE);
    var fr = $('f-resp'), vR = fr.value;
    fr.innerHTML = '<option value="">Todos</option><option value="sin">Sin asignar</option>' +
      optsHtml(equipo.map(function (u) { return [u.id, u.nombre + (u.activo ? '' : ' (inactivo)')]; }), vR);
    fr.value = vR;
    if (!$('f-desde').value) aplicarPreset('mes', true);
  }

  function aplicarPreset(k, sinRender) {
    var h0 = today(), y = Number(h0.slice(0, 4)), m = Number(h0.slice(5, 7)), d, h;
    if (k === 'mes-ant') { d = fmtISO(new Date(y, m - 2, 1)); h = fmtISO(new Date(y, m - 1, 0)); }
    else if (k === '30d') { h = h0; d = addDias(h0, -29); }
    else if (k === 'anio') { d = y + '-01-01'; h = h0; }
    else { d = h0.slice(0, 8) + '01'; h = h0; }   // 'mes'
    $('f-desde').value = d; $('f-hasta').value = h;
    if (!sinRender) render();
  }

  // ══════════════ Cálculo por periodo ══════════════
  function pasaResp(t) {
    if (!fResp) return true;
    if (fResp === 'sin') return !t.responsables.length;
    return t.responsables.indexOf(fResp) >= 0;
  }

  // Indicadores de un periodo [d, h] sobre `base` (los de "foto de hoy" se calculan aparte, en snapshot()).
  function calc(d, h) {
    var recibidas = base.filter(function (t) { return enRango(fechaLocal(t.creado_en), d, h); });
    var entregadas = base.filter(function (t) { return t.entregada_en && enRango(fechaLocal(t.entregada_en), d, h); });
    var conFecha = entregadas.filter(function (t) { return t.fecha_limite; });
    var aTiempo = conFecha.filter(function (t) { return fechaLocal(t.entregada_en) <= t.fecha_limite; });
    var tardias = conFecha.filter(function (t) { return fechaLocal(t.entregada_en) > t.fecha_limite; });
    var confirmadas = recibidas.filter(function (t) { return t.confirmada_en; });
    var hConf = confirmadas.map(function (t) { return horasEntre(t.creado_en, t.confirmada_en); });
    var resueltas = recibidas.filter(function (t) {
      return t.estado !== 'cancelada' && t.estado !== 'rechazada' && (t.confirmada_en || horasDesde(t.creado_en) > 24);
    });
    var confA24 = resueltas.filter(function (t) { return t.confirmada_en && horasEntre(t.creado_en, t.confirmada_en) <= 24; });
    var ciclo = entregadas.map(function (t) { return horasEntre(t.creado_en, t.entregada_en) / 24; });
    var vistos = {}, canc = 0, rech = 0;
    cierres.forEach(function (c) {
      if (!baseIds[c.t.id] || !enRango(c.fecha, d, h) || vistos[c.t.id + c.a]) return;
      vistos[c.t.id + c.a] = 1;
      if (c.a === 'cancelada') canc++; else rech++;
    });
    return {
      d: d, h: h, recibidas: recibidas, entregadas: entregadas, conFecha: conFecha, aTiempo: aTiempo, tardias: tardias,
      pctTiempo: pctDe(aTiempo.length, conFecha.length),
      confirmadas: confirmadas, hConf: hConf, confProm: prom(hConf), confMed: mediana(hConf),
      resueltas: resueltas.length, confA24: confA24.length, pctConf: pctDe(confA24.length, resueltas.length),
      ciclo: ciclo, cicloProm: prom(ciclo), cicloMed: mediana(ciclo), cicloP90: percentil(ciclo, 0.9),
      canc: canc, rech: rech,
    };
  }

  // Foto de hoy (con los filtros de empresa y responsable).
  function snapshot() {
    var abiertas = base.filter(esAbierta);
    var porEtapa = {};
    ETAPAS.forEach(function (e) { porEtapa[e] = abiertas.filter(function (t) { return t.estado === e; }).length; });
    return {
      abiertas: abiertas, vencidas: abiertas.filter(vencida), porEtapa: porEtapa,
      sinResp: abiertas.filter(function (t) { return !t.responsables.length; }).length,
      edades: abiertas.map(function (t) { return horasDesde(t.creado_en) / 24; }),
    };
  }

  // ══════════════ Piezas de dibujo ══════════════
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

  // Conteo + porcentaje del total ("12 (30%)").
  function conPct(n, total) { return fmtN(n) + (total ? ' <small>(' + pctDe(n, total) + '%)</small>' : ''); }

  function mini(pares) {
    return '<div class="ind-mini">' + pares.map(function (p) { return '<div><b>' + p[1] + '</b><span>' + esc(p[0]) + '</span></div>'; }).join('') + '</div>';
  }

  function tabla(cabeceras, filas, vacio) {
    if (!filas.length) return '<div class="mk-sin">' + (vacio || 'Sin datos.') + '</div>';
    return '<div class="table-wrap"><table class="mk-mini"><thead><tr>' + cabeceras.map(function (c) {
      return '<th' + (c.num ? ' class="ind-num"' : '') + '>' + esc(c.t) + '</th>';
    }).join('') + '</tr></thead><tbody>' + filas.join('') + '</tbody></table></div>';
  }

  // Cubetas de una lista de números: cortes [a, b, c] -> ≤a, a–b, b–c, >c.
  function cubetas(valores, cortes, unidad) {
    var res = cortes.map(function () { return 0; }).concat([0]);
    valores.forEach(function (v) {
      var i = 0;
      while (i < cortes.length && v > cortes[i]) i++;
      res[i]++;
    });
    return res.map(function (n, i) {
      var etq = i === 0 ? '≤ ' + cortes[0] + ' ' + unidad : i < cortes.length ? '> ' + cortes[i - 1] + ' a ' + cortes[i] + ' ' + unidad : '> ' + cortes[cortes.length - 1] + ' ' + unidad;
      return { label: etq, n: n };
    });
  }

  // ══════════════ Secciones ══════════════
  function renderKpis(cur, prev, snap) {
    $('ind-kpis').innerHTML =
      tile('info', fmtN(cur.recibidas.length), 'Solicitudes recibidas', '', delta(cur.recibidas.length, prev.recibidas.length, fmtN, 'neutro')) +
      tile('entregado', fmtN(cur.entregadas.length), 'Entregadas', '', delta(cur.entregadas.length, prev.entregadas.length, fmtN, 'sube')) +
      tile('entregado', fmtPct(cur.pctTiempo), 'Entregadas a tiempo', fmtN(cur.aTiempo.length) + ' de ' + fmtN(cur.conFecha.length) + ' con fecha límite',
        delta(cur.pctTiempo, prev.pctTiempo, fmtPct, 'sube', fmtPP)) +
      tile('pend', fmtH(cur.confProm), 'Confirmación promedio', '≤ 24 h: ' + fmtPct(cur.pctConf) + ' (' + fmtN(cur.confA24) + ' de ' + fmtN(cur.resueltas) + ')',
        delta(cur.confProm, prev.confProm, fmtH, 'baja')) +
      tile('total', fmtD(cur.cicloProm), 'Ciclo creación → entrega', 'mediana ' + fmtD(cur.cicloMed) + ' · P90 ' + fmtD(cur.cicloP90),
        delta(cur.cicloProm, prev.cicloProm, fmtD, 'baja')) +
      tile('parcial', fmtN(snap.abiertas.length), 'Abiertas hoy', fmtN(snap.sinResp) + ' sin responsable') +
      tile('alerta', fmtN(snap.vencidas.length), 'Vencidas hoy', fmtPct(pctDe(snap.vencidas.length, snap.abiertas.length)) + ' de las abiertas') +
      tile('recibido', fmtN(cur.canc + cur.rech), 'Canceladas / rechazadas', fmtN(cur.canc) + (cur.canc === 1 ? ' cancelada' : ' canceladas') + ' · ' + fmtN(cur.rech) + (cur.rech === 1 ? ' rechazada' : ' rechazadas'),
        delta(cur.canc + cur.rech, prev.canc + prev.rech, fmtN, 'neutro'));
  }

  function cardTendencia() {
    var y = Number(fHasta.slice(0, 4)), m = Number(fHasta.slice(5, 7)), meses = [], rec = {}, ent = {};
    for (var i = 5; i >= 0; i--) { var dt = new Date(y, m - 1 - i, 1); meses.push(dt.getFullYear() + '-' + pad2(dt.getMonth() + 1)); }
    base.forEach(function (t) {
      var k = fechaLocal(t.creado_en).slice(0, 7);
      rec[k] = (rec[k] || 0) + 1;
      if (t.entregada_en) { var k2 = fechaLocal(t.entregada_en).slice(0, 7); ent[k2] = (ent[k2] || 0) + 1; }
    });
    var max = meses.reduce(function (mx, k) { return Math.max(mx, rec[k] || 0, ent[k] || 0); }, 0);
    function barra(n, cls) {
      var px = n ? Math.max(3, Math.round(n / max * 120)) : 0;
      return '<div class="ind-trend-bar' + cls + '" style="height:' + px + 'px' + (n ? '' : ';min-height:0') + '"><span>' + n + '</span></div>';
    }
    var cuerpo = max
      ? '<div class="ind-key"><span><i style="background:#2471a3"></i>Recibidas</span><span><i style="background:' + VERDE + '"></i>Entregadas</span></div>' +
        '<div class="ind-trend">' + meses.map(function (k) {
          return '<div class="ind-trend-col"><div class="ind-trend-bars">' + barra(rec[k] || 0, '') + barra(ent[k] || 0, ' ent') + '</div><div class="ind-trend-mes">' + esc(etiquetaMes(k)) + '</div></div>';
        }).join('') + '</div>'
      : '<div class="mk-sin">Sin tareas en estos meses.</div>';
    return card('Recibidas vs entregadas por mes', cuerpo, { sub: 'últimos 6 meses hasta “Hasta”', nota: 'No depende del rango de fechas, solo de los filtros de empresa y responsable.' });
  }

  function cardEtapas(snap) {
    var items = ETAPAS.map(function (e) { return { label: ETAPA_T[e], v: snap.porEtapa[e], txt: conPct(snap.porEtapa[e], snap.abiertas.length), color: ETAPA_COLOR[e] }; });
    return card('Tablero hoy: abiertas por etapa', barras(items, 'No hay tareas abiertas.'), { sub: 'foto de hoy' });
  }

  function cardPorClave(titulo, lista, claves, etiqueta, opc) {
    // claves: { codigo: etiqueta }; lista: tareas recibidas; opc.valores(t): códigos en los que cuenta la tarea (puede ser más de uno)
    var cuenta = {};
    lista.forEach(function (t) {
      var ks = opc.valores(t);
      ks.forEach(function (k) { cuenta[k] = (cuenta[k] || 0) + 1; });
    });
    var items = Object.keys(cuenta).map(function (k) {
      return { label: claves[k] || (k === '' ? 'Sin dato' : k), v: cuenta[k], n: cuenta[k], color: opc.color ? opc.color[k] : '' };
    });
    items.sort(function (a, b) { return b.v - a.v; });
    items.forEach(function (i) { i.txt = conPct(i.n, lista.length); });
    return card(titulo, barras(items), { sub: etiqueta, nota: opc.nota });
  }

  function renderVolumen(cur, snap) {
    var rec = cur.recibidas, sub = fmtN(rec.length) + ' recibidas en el periodo';
    var porTipo = cardPorClave('Por tipo de tarea', rec, TIPOS, sub, { valores: function (t) { return [t.tipo]; } });
    var porEmpresa = cardPorClave('Por empresa', rec, EMPRESA_T, sub, { valores: function (t) { return t.empresas.filter(function (s) { return TODAS.indexOf(s) >= 0; }); },
      nota: 'Una tarea de varias empresas cuenta en cada una; los porcentajes pueden sumar más de 100%.' });
    var porClase = cardPorClave('Por clase de prioridad', rec, CLASE_T, sub, { valores: function (t) { return [t.prioridad]; }, color: CLASE_COLOR });
    var porOrigen = cardPorClave('Por origen', rec, ORIGEN_T, sub, { valores: function (t) { return [t.origen || 'panel_mercadeo']; } });
    var dePedidos = rec.filter(function (t) { return t.origen === 'panel_pedidos'; });
    var porAsunto = cardPorClave('Por asunto (solicitudes de Pedidos)', dePedidos, ASUNTOS, fmtN(dePedidos.length) + ' desde Pedidos', { valores: function (t) { return [t.asunto || '']; } });
    $('ind-volumen').innerHTML = cardTendencia() + cardEtapas(snap) + porTipo + porEmpresa + porClase + porOrigen + porAsunto;
  }

  function renderTiempos(cur, snap) {
    // Confirmación
    var bConf = cubetas(cur.hConf, [12, 24, 48], 'h');
    var cConf = card('Tiempo de confirmación',
      mini([['Promedio', fmtH(cur.confProm)], ['Mediana', fmtH(cur.confMed)], ['Confirmadas en ≤ 24 h', fmtPct(cur.pctConf)]]) +
      barras(bConf.map(function (b, i) { return { label: b.label, v: b.n, txt: conPct(b.n, cur.hConf.length), color: i >= 2 ? '#d97706' : '#2471a3' }; }), 'Ninguna tarea recibida se ha confirmado todavía.'),
      { sub: fmtN(cur.confirmadas.length) + ' confirmadas', nota: 'Horas entre la creación y la salida de “Recibido”. Meta del manual: 12–24 h.' });

    // Ciclo
    var bCiclo = cubetas(cur.ciclo, [7, 15, 30], 'd');
    var cCiclo = card('Ciclo: creación → entrega',
      mini([['Promedio', fmtD(cur.cicloProm)], ['Mediana', fmtD(cur.cicloMed)], ['P90', fmtD(cur.cicloP90)]]) +
      barras(bCiclo.map(function (b, i) { return { label: b.label, v: b.n, txt: conPct(b.n, cur.ciclo.length), color: i === 3 ? '#d97706' : '#2471a3' }; }), 'No hay entregas en el periodo.'),
      { sub: fmtN(cur.entregadas.length) + ' entregadas', nota: 'Tareas entregadas dentro del periodo. P90: el 90% se entregó en ese tiempo o menos.' });

    // Tiempo por etapa
    var vs = visitas.filter(function (v) { return baseIds[v.t.id] && enRango(v.fecha, cur.d, cur.h); });
    var items = ETAPAS.map(function (e) {
      var ds = vs.filter(function (v) { return v.etapa === e; }).map(function (v) { return v.dias; });
      var p = prom(ds);
      return { label: ETAPA_T[e], v: p || 0, txt: p === null ? '—' : fmtD(p) + ' <small>(' + ds.length + ')</small>', color: ETAPA_COLOR[e] };
    });
    var cEtapa = card('Tiempo promedio por etapa', barras(items, 'Ninguna tarea cambió de etapa en el periodo.'),
      { sub: 'permanencias terminadas en el periodo', nota: 'Entre paréntesis, cuántas permanencias se promedian. Sale del historial de cambios de estado.' });

    // Antigüedad de las abiertas
    var bEdad = cubetas(snap.edades, [7, 15, 30], 'd');
    var cEdad = card('Antigüedad de las abiertas', barras(bEdad.map(function (b, i) { return { label: b.label, v: b.n, txt: conPct(b.n, snap.edades.length), color: i === 3 ? ROJO : i === 2 ? '#d97706' : '#2471a3' }; }), 'No hay tareas abiertas.'),
      { sub: 'foto de hoy', nota: 'Días desde la creación de cada tarea que sigue abierta.' });

    $('ind-tiempos').innerHTML = cConf + cCiclo + cEtapa + cEdad;
  }

  function renderCumplimiento(cur, snap) {
    var sinFecha = cur.entregadas.length - cur.conFecha.length;
    var tot = cur.entregadas.length;
    function seg(n, color) { return n ? '<i style="width:' + (n / tot * 100).toFixed(2) + '%;background:' + color + '"></i>' : ''; }
    var atraso = cur.tardias.map(function (t) { return diasEntre(t.fecha_limite, fechaLocal(t.entregada_en)); });
    var cEnt = card('Entregas a tiempo vs tardías',
      mini([['A tiempo', fmtPct(cur.pctTiempo)], ['Atraso promedio (tardías)', fmtD(prom(atraso))], ['Mayor atraso', atraso.length ? fmtD(Math.max.apply(null, atraso)) : '—']]) +
      (tot ? '<div class="ind-stack" role="img" aria-label="Entregas a tiempo, tardías y sin fecha límite">' + seg(cur.aTiempo.length, VERDE) + seg(cur.tardias.length, ROJO) + seg(sinFecha, GRIS) + '</div>' +
        '<div class="ind-key"><span><i style="background:' + VERDE + '"></i>A tiempo: ' + fmtN(cur.aTiempo.length) + '</span><span><i style="background:' + ROJO + '"></i>Tardías: ' + fmtN(cur.tardias.length) +
        '</span><span><i style="background:' + GRIS + '"></i>Sin fecha límite: ' + fmtN(sinFecha) + '</span></div>'
        : '<div class="mk-sin">No hay entregas en el periodo.</div>'),
      { sub: fmtN(tot) + ' entregadas', nota: 'A tiempo: se entregó en la fecha límite o antes. Las entregadas sin fecha límite no cuentan en el %.' });

    // Calendario y urgencias (mismas definiciones del CRM)
    var rec = cur.recibidas;
    var dentro = rec.filter(function (t) { return !t.fuera_calendario; }).length;
    var excep = rec.filter(function (t) { return t.urgente && t.fuera_calendario; }).length;
    var urgDentro = rec.filter(function (t) { return t.urgente && !t.fuera_calendario; }).length;
    var cCal = card('Calendario y urgencias', barras([
      { label: 'Dentro del calendario aprobado', v: dentro, txt: conPct(dentro, rec.length), color: VERDE },
      { label: 'Fuera del calendario', v: rec.length - dentro, txt: conPct(rec.length - dentro, rec.length), color: GRIS },
      { label: 'Urgentes fuera de calendario (excepciones)', v: excep, txt: conPct(excep, rec.length), color: ROJO },
      { label: 'Urgentes dentro del calendario', v: urgDentro, txt: conPct(urgDentro, rec.length), color: '#d97706' },
    ]), { sub: fmtN(rec.length) + ' recibidas', nota: 'Las excepciones (urgente fuera de calendario) pueden llevar el aval del Comité o de Gerencia General (opcional).' });

    // Por clase de prioridad
    var filasClase = CLASE_ORDEN.map(function (k) {
      var ent = cur.entregadas.filter(function (t) { return t.prioridad === k; });
      var cf = ent.filter(function (t) { return t.fecha_limite; });
      var at = cf.filter(function (t) { return fechaLocal(t.entregada_en) <= t.fecha_limite; });
      var ab = snap.abiertas.filter(function (t) { return t.prioridad === k; });
      var ve = ab.filter(vencida);
      return '<tr><td><span class="ind-dot" style="background:' + CLASE_COLOR[k] + '"></span>' + esc(CLASE_CORTA[k]) + '</td><td class="ind-num">' + fmtN(ent.length) + '</td>' +
        '<td class="ind-num">' + fmtPct(pctDe(at.length, cf.length)) + '</td><td class="ind-num">' + fmtN(ab.length) + '</td>' +
        '<td class="ind-num' + (ve.length ? ' ind-malo' : '') + '">' + fmtN(ve.length) + '</td></tr>';
    });
    var cClase = card('Cumplimiento por clase de prioridad', tabla(
      [{ t: 'Clase' }, { t: 'Entregadas', num: 1 }, { t: 'A tiempo', num: 1 }, { t: 'Abiertas hoy', num: 1 }, { t: 'Vencidas hoy', num: 1 }], filasClase),
      { sub: 'entregas del periodo · abiertas de hoy' });

    // Vencidas hoy
    var venc = snap.vencidas.map(function (t) { return { t: t, atraso: diasEntre(t.fecha_limite, hoy) }; }).sort(function (a, b) { return b.atraso - a.atraso; });
    var filasV = venc.slice(0, 20).map(function (x) {
      var t = x.t;
      var resp = t.responsables.length ? t.responsables.map(function (id) { return esc(nombreEquipo(id)); }).join(', ') : '<span class="ind-malo">Sin responsable</span>';
      return '<tr><td><a href="mercadeo.html?tarea=' + esc(t.id) + '">#' + esc(t.id) + ' · ' + esc(t.titulo) + '</a></td><td>' + esc(ETAPA_T[t.estado]) + '</td><td>' + resp + '</td>' +
        '<td>' + esc(fmtDateOnly(t.fecha_limite)) + '</td><td class="ind-num ind-malo">' + fmtN(x.atraso) + ' d</td></tr>';
    });
    var cVenc = card('Tareas vencidas hoy', tabla(
      [{ t: 'Tarea' }, { t: 'Etapa' }, { t: 'Responsables' }, { t: 'Fecha límite' }, { t: 'Atraso', num: 1 }], filasV, 'No hay tareas vencidas. 👏') +
      (venc.length > 20 ? '<div class="ind-note">Se muestran las 20 con más atraso de ' + fmtN(venc.length) + '.</div>' : ''),
      { full: true, sub: fmtN(venc.length) + ' vencidas · foto de hoy' });

    $('ind-cumplimiento').innerHTML = cEnt + cCal + cClase + cVenc;
  }

  function filaCarga(lista) {
    var abiertas = lista.filter(esAbierta);
    var ent = lista.filter(function (t) { return t.entregada_en && enRango(fechaLocal(t.entregada_en), fDesde, fHasta); });
    var cf = ent.filter(function (t) { return t.fecha_limite; });
    var at = cf.filter(function (t) { return fechaLocal(t.entregada_en) <= t.fecha_limite; });
    return {
      abiertas: abiertas.length, venc: abiertas.filter(vencida).length,
      rec: lista.filter(function (t) { return enRango(fechaLocal(t.creado_en), fDesde, fHasta); }).length,
      ent: ent.length, pct: pctDe(at.length, cf.length), ciclo: prom(ent.map(function (t) { return horasEntre(t.creado_en, t.entregada_en) / 24; })),
    };
  }

  function renderCarga() {
    var filas = equipo.map(function (u) {
      return { u: u, f: filaCarga(baseEmp.filter(function (t) { return t.responsables.indexOf(u.id) >= 0; })) };
    }).filter(function (x) {
      return x.u.activo || x.f.abiertas || x.f.rec || x.f.ent;   // los inactivos solo si tienen movimiento
    }).sort(function (a, b) { return b.f.abiertas - a.f.abiertas || String(a.u.nombre).localeCompare(String(b.u.nombre)); });
    var sin = { u: null, f: filaCarga(baseEmp.filter(function (t) { return !t.responsables.length; })) };
    filas.push(sin);
    var maxAb = filas.reduce(function (m, x) { return Math.max(m, x.f.abiertas); }, 0);
    var html = filas.map(function (x) {
      var f = x.f;
      var nombre = x.u
        ? '<span class="ind-dot" style="' + EQUIPO_COLOR.estilo(x.u.id) + '"></span>' + esc(x.u.nombre) + (x.u.activo ? '' : ' <span class="mk-sin">(inactivo)</span>')
        : '<span class="ind-dot"></span><em>Sin asignar</em>';
      return '<tr><td>' + nombre + '</td>' +
        '<td><div class="ind-celda-barra"><span class="ind-num" style="min-width:24px">' + fmtN(f.abiertas) + '</span><span class="ind-bar-t"><i style="width:' + (maxAb ? (f.abiertas / maxAb * 100).toFixed(1) : 0) + '%"></i></span></div></td>' +
        '<td class="ind-num' + (f.venc ? ' ind-malo' : '') + '">' + fmtN(f.venc) + '</td><td class="ind-num">' + fmtN(f.rec) + '</td><td class="ind-num">' + fmtN(f.ent) + '</td>' +
        '<td class="ind-num">' + fmtPct(f.pct) + '</td><td class="ind-num">' + fmtD(f.ciclo) + '</td></tr>';
    });
    $('ind-carga').innerHTML = card('Tareas por persona', tabla(
      [{ t: 'Responsable' }, { t: 'Abiertas hoy' }, { t: 'Vencidas hoy', num: 1 }, { t: 'Recibidas', num: 1 }, { t: 'Entregadas', num: 1 }, { t: 'A tiempo', num: 1 }, { t: 'Ciclo prom.', num: 1 }], html),
      { full: true, sub: 'respeta el filtro de empresa; no el de responsable',
        nota: 'Una tarea con varios responsables cuenta en cada uno. “Recibidas” y “Entregadas” son del periodo elegido; “Abiertas” y “Vencidas”, de hoy.' });
  }

  // ══════════════ Render ══════════════
  function render() {
    var d = $('f-desde').value, h = $('f-hasta').value;
    if (!d || !h || d > h) {
      $('ind-periodo').innerHTML = '<span class="ind-malo">Elige un rango de fechas válido (“Desde” no puede ser posterior a “Hasta”).</span>';
      return;
    }
    hoy = today();
    fDesde = d; fHasta = h; fEmp = $('f-empresa').value; fResp = $('f-resp').value;
    baseEmp = tareas.filter(function (t) { return !fEmp || t.empresas.indexOf(fEmp) >= 0; });
    base = baseEmp.filter(pasaResp);
    baseIds = {}; base.forEach(function (t) { baseIds[t.id] = true; });
    var dias = diasEntre(d, h) + 1;
    var pH = addDias(d, -1), pD = addDias(d, -dias);
    var cur = calc(d, h), prev = calc(pD, pH), snap = snapshot();
    $('ind-periodo').textContent = 'Periodo: ' + fmtDateOnly(d) + ' – ' + fmtDateOnly(h) + ' (' + dias + (dias === 1 ? ' día' : ' días') + ') · comparado con ' + fmtDateOnly(pD) + ' – ' + fmtDateOnly(pH) +
      ' · ' + fmtN(base.length) + ' de ' + fmtN(tareas.length) + ' tareas con los filtros actuales' +
      (excluidas ? ' · ' + fmtN(excluidas) + (excluidas === 1 ? ' tarea marcada como prueba no se cuenta' : ' tareas marcadas como prueba no se cuentan') : '');
    renderKpis(cur, prev, snap);
    renderVolumen(cur, snap);
    renderTiempos(cur, snap);
    renderCumplimiento(cur, snap);
    renderCarga();
  }

  // ══════════════ Eventos ══════════════
  var ACCIONES = {
    'reintentar': function () { $('estado-carga').textContent = 'Cargando…'; cargar(true); },
    'actualizar': async function () { if (await cargar(false)) showToast('✅ Datos actualizados'); },
    'preset': function (id) { aplicarPreset(id); },
    'limpiar': function () { $('f-empresa').value = ''; $('f-resp').value = ''; aplicarPreset('mes'); },
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACCIONES[el.getAttribute('data-act')];
    if (fn) fn(el.getAttribute('data-id'), el, e);
  });
  ['f-desde', 'f-hasta', 'f-empresa', 'f-resp'].forEach(function (id) { $(id).addEventListener('change', render); });

  await cargar(true);
})();
