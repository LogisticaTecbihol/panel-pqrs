// Impacto en ventas de un evento de Mercadeo (Eventos > «📈 Ventas»).
//
// Le pide a la Edge Function `impacto-evento` las ventas de Pedidos alrededor del evento (el servidor lee la fecha,
// la empresa, el municipio, el NIT del distribuidor y los productos de la BD; aquí solo se manda el id) y las dibuja:
//   · Evento ya realizado (fecha <= hoy): lo vendido desde el evento contra el MISMO número de días anteriores, para
//     el distribuidor (por NIT), la zona (municipio) y los productos del evento, y contra el resto de la empresa,
//     que hace de CONTROL (descuenta temporada, clima y precios que afectan a todos).
//   · Evento futuro: la LÍNEA BASE (ventas de los últimos 30/60/90 días) para comparar después.
// Es correlación, no causalidad: la pantalla lo dice y marca cuándo la lectura es poco confiable.
// Depende de supabase-client.js (escHtml, fmtMoney, fmtDateOnly), modal.js (MODAL) y del modal #impacto-overlay.
var EVENTO_IMPACTO = (function () {
  // t = título, s = cómo se nombra en una frase, d = qué mide.
  var ALC = {
    distribuidor: { t: 'Distribuidor', s: 'el distribuidor', d: 'Compras del distribuidor del evento. Se cruza por NIT, así que suma todas sus sucursales y nombres.' },
    zona: { t: 'Zona', s: 'la zona', d: 'Todos los clientes del municipio del evento (incluye al distribuidor).' },
    productos_zona: { t: 'Productos del evento, en la zona', s: 'los productos del evento en la zona', d: 'Solo los productos pedidos para el evento, vendidos en ese municipio.' },
    resto: { t: 'Resto de la empresa (control)', s: 'el resto de la empresa', d: 'Ventas de la empresa fuera del distribuidor y de la zona: mide lo que le pasó a todos en las mismas fechas.' },
    productos_resto: { t: 'Productos del evento, fuera de la zona (control)', s: 'esos productos fuera de la zona', d: 'Los mismos productos vendidos fuera del distribuidor y de la zona.' },
  };
  var ESTADO_REALIZADO = ['realizada', 'cerrada'];
  var st = null; // { sb, evento, res, win, serie, cargando, error }

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function pct(v) {
    if (v === null || v === undefined) return '—';
    var n = Math.round(v * 100);
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('es-CO') + ' %';
  }
  function pp(v) {
    if (v === null || v === undefined) return '—';
    var n = Math.round(v * 100);
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('es-CO') + ' pp';
  }
  function clase(v) { return v === null || v === undefined ? '' : v >= 0.1 ? 'ind-ok' : v <= -0.1 ? 'ind-malo' : ''; }
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }
  function alcancePrincipal(res) { return res.alcances.indexOf('distribuidor') >= 0 ? 'distribuidor' : res.alcances.indexOf('zona') >= 0 ? 'zona' : res.alcances[0]; }

  // ── Datos ──
  async function consultar() {
    st.cargando = true; st.error = ''; st.res = null;
    render();
    try {
      var r = await st.sb.functions.invoke('impacto-evento', { body: { evento_id: st.evento.id } });
      if (r.error || !r.data || !r.data.ok) {
        var msg = '';
        try { var j = r.error && r.error.context ? await r.error.context.json() : null; msg = j && j.error ? j.error : ''; } catch (_e) { /* sin cuerpo */ }
        st.error = msg || (r.error ? errMsg(r.error) : 'No se pudo consultar el impacto en ventas.');
      } else {
        st.res = r.data;
        st.win = -1; // la ventana más larga disponible
        st.serie = null;
      }
    } catch (e) {
      st.error = errMsg(e);
    }
    st.cargando = false;
    render();
  }

  // ── Cálculos de lectura ──
  // Ventas por semana COMPLETA antes y después del evento (para saber qué es «normal» en este alcance).
  function semanal(res, alcance) {
    var vals = res.serie.valores[alcance] || [], pre = [], post = [];
    res.serie.bins.forEach(function (b, i) { if (!b.parcial) (b.k < 0 ? pre : post).push(vals[i] || 0); });
    return { pre: pre, post: post };
  }
  function minmax(a) {
    if (!a.length) return null;
    return { min: Math.min.apply(null, a), max: Math.max.apply(null, a) };
  }
  // Por qué la lectura es poco confiable. Nunca hay «confianza alta»: sin un diseño experimental solo es correlación.
  function motivosPocaConfianza(w, a) {
    var m = [];
    if (w.dias < 28) m.push('la ventana es corta (' + plural(w.dias, 'día', 'días') + '; menos de 4 semanas)');
    if (a.pre.pedidos < 5) m.push('antes del evento hubo ' + plural(a.pre.pedidos, 'pedido', 'pedidos') + ' (menos de 5)');
    if (a.post && a.post.pedidos < 3) m.push('después del evento hubo ' + plural(a.post.pedidos, 'pedido', 'pedidos') + ' (menos de 3)');
    if (a.post && a.post.valor > 0 && a.post.mayor / a.post.valor >= 0.5 && a.post.pedidos > 1) m.push('un solo pedido (' + fmtMoney(a.post.mayor) + ') pesa el ' + Math.round(a.post.mayor / a.post.valor * 100) + ' % de lo vendido después');
    if (a.pre.valor > 0 && a.pre.mayor / a.pre.valor >= 0.5 && a.pre.pedidos > 1) m.push('un solo pedido (' + fmtMoney(a.pre.mayor) + ') pesa el ' + Math.round(a.pre.mayor / a.pre.valor * 100) + ' % de lo vendido antes');
    return m;
  }

  // ── Dibujo ──
  function avisoHtml(res) {
    var e = st.evento, h = '';
    var realizado = ESTADO_REALIZADO.indexOf(e.estado) >= 0;
    if (res.fase === 'posterior' && !realizado) {
      h += '<div class="imp-aviso warn"><strong>Confirma que el evento se hizo.</strong> En el panel figura como «' + esc(EVENTO_PDF.ESTADO_T[e.estado] || e.estado) + '», no como «Realizada». Las cifras de abajo cuentan desde la fecha programada.</div>';
    }
    h += '<div class="imp-aviso"><strong>Es una correlación, no una prueba.</strong> Que las ventas suban o bajen después del evento no demuestra que el evento fue la causa: pueden influir la temporada, el clima, otras acciones comerciales o un pedido grande. Por eso se compara contra el resto de la empresa en las mismas fechas.</div>';
    return h;
  }

  function ventanasTabs(res) {
    return '<div class="mk-tabs imp-tabs" role="group" aria-label="Periodo a comparar">' + res.ventanas.map(function (w, i) {
      var txt = res.fase === 'linea_base' ? 'Últimos ' + w.dias + ' días' : (w.completa ? w.dias + ' días' : plural(w.dias, 'día', 'días') + ' (hasta hoy)');
      return '<button type="button" class="mk-tab' + (i === st.win ? ' active' : '') + '" data-imp="win" data-v="' + i + '" aria-pressed="' + (i === st.win) + '">' + esc(txt) + '</button>';
    }).join('') + '</div>';
  }

  function resumenPosterior(res, w) {
    var p = alcancePrincipal(res), a = w.alcances[p], c = a.control, h = '';
    h += '<div class="ind-mini">' +
      '<div><b>' + esc(fmtMoney(a.pre.valor)) + '</b><span>Antes · ' + esc(plural(a.pre.pedidos, 'pedido', 'pedidos')) + '</span></div>' +
      '<div><b>' + esc(fmtMoney(a.post.valor)) + '</b><span>Después · ' + esc(plural(a.post.pedidos, 'pedido', 'pedidos')) + '</span></div>' +
      '<div><b class="' + clase(a.variacion) + '">' + esc(pct(a.variacion)) + '</b><span>' + esc(ALC[p].t) + '</span></div>' +
      '<div><b class="' + clase(c) + '">' + esc(pct(c)) + '</b><span>Resto de la empresa</span></div>' +
      '<div><b class="' + clase(a.neta) + '">' + esc(pp(a.neta)) + '</b><span>Diferencia neta</span></div>' +
      '</div>';

    var motivos = motivosPocaConfianza(w, a), li = [];
    var suj = ALC[p].s, Suj = suj.charAt(0).toUpperCase() + suj.slice(1);
    li.push('<li>' + (a.variacion === null
      ? Suj + ' no tuvo ventas en los ' + w.dias + ' días anteriores, así que la variación no se puede calcular' + (a.post.valor > 0 ? ' (compró después: es un cliente nuevo o reactivado).' : '.')
      : 'En los ' + w.dias + ' días desde el evento, ' + suj + ' vendió <strong>' + esc(fmtMoney(a.post.valor)) + '</strong> contra ' + esc(fmtMoney(a.pre.valor)) + ' en los ' + w.dias + ' anteriores (<strong>' + esc(pct(a.variacion)) + '</strong>).') + '</li>');
    if (c !== null && a.variacion !== null) {
      var n = a.neta, rel = n >= 0.25 ? 'claramente mayor que' : n <= -0.25 ? 'claramente menor que' : 'parecida a';
      var deSuj = suj.replace(/^el /, 'del ').replace(/^(la|los|las) /, 'de $1 ');
      li.push('<li>En las mismas fechas ' + esc(ALC.resto.s) + ' varió <strong>' + esc(pct(c)) + '</strong>: la variación ' + esc(deSuj) + ' fue ' + rel + ' la del resto (diferencia de <strong>' + esc(pp(n)) + '</strong>).</li>');
    } else if (c === null) {
      li.push('<li>El resto de la empresa no tiene ventas comparables en esas fechas: no hay con qué descontar la temporada.</li>');
    }
    var sem = semanal(res, p), rg = minmax(sem.pre);
    if (rg && sem.pre.length >= 4 && w.dias >= 7) {
      var prom = a.post.valor / (w.dias / 7);
      var donde = prom > rg.max ? 'por encima del' : prom < rg.min ? 'por debajo del' : 'dentro del';
      li.push('<li>Su promedio semanal después (<strong>' + esc(fmtMoney(prom)) + '</strong>) queda ' + donde + ' rango de las ' + sem.pre.length + ' semanas anteriores (' + esc(fmtMoney(rg.min)) + ' a ' + esc(fmtMoney(rg.max)) + ').</li>');
    }
    h += '<ul class="imp-lectura">' + li.join('') + '</ul>';
    h += motivos.length
      ? '<div class="imp-conf"><span class="kb-chip warn">Confianza baja</span> porque ' + esc(motivos.join('; ')) + '. Tómalo como una pista, no como un resultado.</div>'
      : '<div class="imp-conf"><span class="kb-chip">Confianza media</span> Hay pedidos suficientes antes y después, pero sigue siendo una correlación.</div>';
    return h;
  }

  function tablaPosterior(res, w) {
    var filas = res.alcances.map(function (k) {
      var a = w.alcances[k], ctl = a.control !== undefined;
      return '<tr><td><strong>' + esc(ALC[k].t) + '</strong><div class="ef-help">' + esc(ALC[k].d) + '</div></td>' +
        '<td class="ind-num">' + esc(fmtMoney(a.pre.valor)) + '<div class="ef-help">' + esc(plural(a.pre.pedidos, 'pedido', 'pedidos')) + ' · ' + esc(plural(a.pre.clientes, 'cliente', 'clientes')) + '</div></td>' +
        '<td class="ind-num">' + esc(fmtMoney(a.post.valor)) + '<div class="ef-help">' + esc(plural(a.post.pedidos, 'pedido', 'pedidos')) + ' · ' + esc(plural(a.post.clientes, 'cliente', 'clientes')) + '</div></td>' +
        '<td class="ind-num"><strong class="' + clase(a.variacion) + '">' + esc(pct(a.variacion)) + '</strong></td>' +
        '<td class="ind-num">' + (ctl ? '<strong class="' + clase(a.neta) + '">' + esc(pp(a.neta)) + '</strong>' : '<span class="ef-help">—</span>') + '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table><thead><tr><th>Alcance</th><th class="ind-num">Antes<br><span class="ef-help">' + esc(fmtDateOnly(w.pre.desde)) + ' – ' + esc(fmtDateOnly(w.pre.hasta)) + '</span></th>' +
      '<th class="ind-num">Después<br><span class="ef-help">' + esc(fmtDateOnly(w.post.desde)) + ' – ' + esc(fmtDateOnly(w.post.hasta)) + '</span></th>' +
      '<th class="ind-num">Variación</th><th class="ind-num" title="Variación del alcance menos la variación de su control (resto de la empresa)">Diferencia neta</th></tr></thead><tbody>' + filas + '</tbody></table></div>';
  }

  function tablaLineaBase(res, w) {
    var filas = res.alcances.map(function (k) {
      var a = w.alcances[k];
      return '<tr><td><strong>' + esc(ALC[k].t) + '</strong><div class="ef-help">' + esc(ALC[k].d) + '</div></td>' +
        '<td class="ind-num">' + esc(fmtMoney(a.pre.valor)) + '</td>' +
        '<td class="ind-num">' + esc(fmtMoney(a.pre.valor / (w.dias / 7))) + '</td>' +
        '<td class="ind-num">' + esc(a.pre.pedidos) + '</td><td class="ind-num">' + esc(a.pre.clientes) + '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table><thead><tr><th>Alcance</th><th class="ind-num">Vendido<br><span class="ef-help">' + esc(fmtDateOnly(w.pre.desde)) + ' – ' + esc(fmtDateOnly(w.pre.hasta)) + '</span></th>' +
      '<th class="ind-num">Promedio semanal</th><th class="ind-num">Pedidos</th><th class="ind-num">Clientes</th></tr></thead><tbody>' + filas + '</tbody></table></div>';
  }

  function graficoHtml(res) {
    var sc = st.serie && res.alcances.indexOf(st.serie) >= 0 ? st.serie : alcancePrincipal(res);
    var bins = res.serie.bins, vals = res.serie.valores[sc] || [];
    var max = Math.max.apply(null, vals.concat([1]));
    var tabs = '<div class="mk-tabs imp-tabs" role="group" aria-label="Alcance del gráfico">' + res.alcances.map(function (k) {
      return '<button type="button" class="mk-tab' + (k === sc ? ' active' : '') + '" data-imp="serie" data-v="' + esc(k) + '" aria-pressed="' + (k === sc) + '">' + esc(ALC[k].t.replace(' (control)', '')) + '</button>';
    }).join('') + '</div>';
    var cols = bins.map(function (b, i) {
      var h = vals[i] > 0 ? Math.max(3, Math.round(vals[i] / max * 100)) : 0;
      var lab = b.k === 0 ? 'Evento' : (b.k > 0 ? '+' + b.k : '−' + Math.abs(b.k));
      return '<div class="imp-col' + (b.k === 0 ? ' ev' : '') + '" title="Semana del ' + esc(fmtDateOnly(b.desde)) + ' al ' + esc(fmtDateOnly(b.hasta)) + (b.parcial ? ' (incompleta)' : '') + ': ' + esc(fmtMoney(vals[i])) + '">' +
        '<div class="imp-bar-w"><div class="imp-bar' + (b.k >= 0 ? ' post' : '') + (b.parcial ? ' parcial' : '') + '" style="height:' + h + '%"></div></div>' +
        '<div class="imp-lab">' + esc(lab) + '</div></div>';
    }).join('');
    return '<h4 class="imp-h">Ventas por semana · ' + esc(ALC[sc].t) + '</h4>' + tabs +
      '<div class="imp-chart" role="img" aria-label="Ventas semanales alrededor del evento">' + cols + '</div>' +
      '<div class="ef-help">Semana 0 = la semana que empieza el día del evento (' + esc(fmtDateOnly(res.ancla)) + '); −1 es la semana anterior. Barra más alta de la serie: ' + esc(fmtMoney(max === 1 ? 0 : max)) + '. Pasa el cursor sobre una barra para ver su valor.' +
      (res.serie.bins.some(function (b) { return b.parcial; }) ? ' La última barra es de una semana incompleta.' : '') + '</div>';
  }

  function calidadHtml(res) {
    var c = res.calidad, h = '';
    if (res.alcances.indexOf('distribuidor') >= 0 && c.zona_sin_nit > 0) {
      h += '<li>' + esc(c.zona_sin_nit) + ' de ' + esc(c.lineas_zona) + ' líneas de pedidos de la zona no tienen NIT en Pedidos: no se pueden asignar al distribuidor (sí cuentan en «Zona»).</li>';
    }
    if (!c.lineas) h += '<li>Pedidos no tiene ventas de esta empresa en el rango leído (' + esc(fmtDateOnly(res.rango_leido && res.rango_leido.desde)) + ' – ' + esc(fmtDateOnly(res.rango_leido && res.rango_leido.hasta)) + ').</li>';
    return h ? '<ul class="imp-lectura imp-calidad">' + h + '</ul>' : '';
  }

  function definicionesHtml() {
    return '<details class="imp-defs"><summary>¿Cómo se calcula?</summary><ul>' +
      '<li><strong>Periodos:</strong> se suma lo vendido desde el día del evento (inclusive) durante N días y se compara con los N días anteriores. Si el evento es reciente, N es lo que lleva transcurrido (ambos periodos con el mismo número de días).</li>' +
      '<li><strong>Cruce:</strong> el distribuidor por NIT sin dígito de verificación (Pedidos guarda al mismo cliente con nombres distintos); la zona por municipio; los productos por nombre sin presentación (GROW GREEN X LITRO = GROW GREEN).</li>' +
      '<li><strong>Qué cuenta:</strong> el valor de las líneas de pedidos de la empresa del evento, sin las anuladas. Es lo pedido, no lo facturado ni lo cobrado.</li>' +
      '<li><strong>Diferencia neta:</strong> variación del alcance menos la variación del resto de la empresa (en puntos porcentuales). Descuenta lo que le pasó a todos en las mismas fechas.</li>' +
      '<li><strong>Límites:</strong> no separa el efecto del evento del de otras acciones (visitas del comercial, promociones, redes) ni de pedidos grandes aislados; con pocos pedidos una sola compra mueve todo.</li>' +
      '</ul></details>';
  }

  function cuerpoHtml() {
    if (st.cargando) return '<div class="empty">Consultando las ventas en Pedidos…</div>';
    if (st.error) return '<div class="empty">⚠ ' + esc(st.error) + '<div style="margin-top:12px"><button type="button" class="btn-confirm" data-imp="reintentar">Reintentar</button></div></div>';
    var d = st.res;
    if (!d) return '';
    if (d.sin_cruce) return '<div class="imp-aviso">' + esc(d.motivo) + '</div>';
    var res = d.cruce;
    if (!res.ventanas.length) return avisoHtml(res) + '<div class="empty">Aún no hay ventas que comparar.</div>';
    if (st.win < 0 || st.win >= res.ventanas.length) st.win = res.ventanas.length - 1;
    var w = res.ventanas[st.win], h = avisoHtml(res);
    if (res.fase === 'linea_base') {
      h += '<h4 class="imp-h">Línea base antes del evento</h4>' +
        '<p class="ef-help" style="margin:0 0 10px">El evento es el ' + esc(fmtDateOnly(st.evento.fecha_evento)) +
        ' y todavía no ocurre. Esto es lo que vendía cada alcance hasta hoy; después del evento vuelve a abrir esta pantalla y se compararán los mismos días contra esta línea.</p>' +
        ventanasTabs(res) + tablaLineaBase(res, w);
    } else {
      h += '<h4 class="imp-h">Qué pasó con las ventas</h4>' + ventanasTabs(res) + resumenPosterior(res, w) +
        '<h4 class="imp-h">Detalle por alcance</h4>' + tablaPosterior(res, w);
    }
    h += graficoHtml(res) + calidadHtml(res) + definicionesHtml();
    h += '<div class="ef-help" style="margin-top:10px">Datos de Pedidos consultados el ' + esc(res.generado_en ? new Date(res.generado_en).toLocaleString('es-CO') : '') + ' (se consultan de nuevo cada vez que abres esta pantalla).</div>';
    return h;
  }

  function render() {
    if (!st) return;
    var e = st.evento, d = st.res && st.res.evento ? st.res.evento : null;
    var lugar = d ? [d.municipio, d.departamento].filter(Boolean).join(', ') : (e.lugar || '');
    $('imp-meta').innerHTML = '<span><strong>EV-' + esc(e.id) + '</strong> · ' + esc(e.nombre || '') + '</span>' +
      '<span>' + esc(etiquetaEmpresa(e.empresa)) + '</span><span>' + esc(fmtDateOnly(e.fecha_evento)) + '</span>' +
      (lugar ? '<span>' + esc(lugar) + '</span>' : '') +
      (d && d.distribuidor ? '<span>Distribuidor: ' + esc(d.distribuidor) + (d.nit ? ' (NIT ' + esc(d.nit) + ')' : '') + '</span>' : '') +
      (d && d.productos && d.productos.length ? '<span>' + esc(plural(d.productos.length, 'producto', 'productos')) + '</span>' : '');
    $('imp-body').innerHTML = cuerpoHtml();
  }

  // Un solo escuchador para los botones de ventana, de alcance del gráfico y «Reintentar».
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('#impacto-overlay [data-imp]') : null;
    if (!el || !st) return;
    var a = el.getAttribute('data-imp'), v = el.getAttribute('data-v');
    if (a === 'win') { st.win = Number(v); render(); }
    else if (a === 'serie') { st.serie = v; render(); }
    else if (a === 'reintentar') consultar();
  });

  return {
    // opts: { sb: cliente de Supabase, evento: fila de mercadeo_eventos }
    abrir: function (opts) {
      if (!opts || !opts.evento) return Promise.resolve();
      st = { sb: opts.sb, evento: opts.evento, res: null, win: -1, serie: null, cargando: true, error: '' };
      MODAL.open('impacto-overlay', 'imp-cerrar');
      return consultar();
    },
    cerrar: function () { MODAL.close('impacto-overlay'); },
  };
})();
