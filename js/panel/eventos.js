// ══════════════════════════════════════════════════════════════
// Eventos de Mercadeo — solicitudes de eventos (formato MC-ISO-FO01, migración 0031)
// ══════════════════════════════════════════════════════════════
// Flujo del Manual de procesos y procedimiento de EVENTOS:
//   Radicada -> En revisión -> Aprobada -> En preparación -> Realizada -> Cerrada
//   (+ Rechazada, solo antes de aprobar; + Cancelada). Rechazada / Cancelada / Cerrada son estados finales.
// Entran por dos puertas: Mercadeo las digita aquí (llegaron por correo) o llegan de panel-pedidos ya
// aprobadas por el jefe del solicitante (Edge Function solicitud-evento-pedidos, origen 'panel_pedidos').
//
// Lo que NO se puede falsificar desde el navegador lo sella la BD (trigger): consecutivo, quién y cuándo
// aprobó, rechazó, canceló, realizó y cerró; origen; la bitácora de sistema. Al APROBAR, el trigger crea
// solo la tarea tipo Evento en el Tablero (mercadeo_tareas.evento_id); al cancelar, la cancela.
// Política de 15 días (Manual de eventos): NO bloquea; la BD calcula dias_anticipacion / extemporanea y aquí
// se muestra como advertencia. Los KPI del manual (oportunidad de la solicitud, 48 h hábiles de revisión,
// retorno de la base de datos de asistentes en 3 días hábiles) se calculan en el cliente, sin festivos.
(async function () {
  await AUTH.authReady;
  if (!AUTH.getProfile() || !AUTH.hasModule('mercadeo')) return;

  var miId = AUTH.getUser().id;
  var esAdmin = AUTH.isAdmin();

  // ── Catálogos (valores en BD = códigos ASCII) ──
  var ESTADO_T = { radicada: 'Radicada', en_revision: 'En revisión', aprobada: 'Aprobada', en_preparacion: 'En preparación', realizada: 'Realizada', cerrada: 'Cerrada', rechazada: 'Rechazada', cancelada: 'Cancelada' };
  var ESTADO_COLOR = { radicada: '#e67e22', en_revision: '#2980b9', aprobada: '#16a085', en_preparacion: '#8e44ad', realizada: '#27ae60', cerrada: '#718096', rechazada: '#c0392b', cancelada: '#a0aec0' };
  var ESTADO_RANK = { radicada: 1, en_revision: 2, aprobada: 3, en_preparacion: 4, realizada: 5, cerrada: 6, rechazada: 7, cancelada: 8 };
  var ABIERTOS = ['radicada', 'en_revision', 'aprobada', 'en_preparacion', 'realizada'];
  var FINALES = ['cerrada', 'rechazada', 'cancelada'];
  var TAREA_T = { solicitada: 'Recibido', confirmada: 'Confirmada', en_produccion: 'En producción', en_validacion: 'En validación / aprobación', entregada: 'Entregada / Publicada', cancelada: 'Cancelada', rechazada: 'Rechazada' };
  var MODALIDAD = { fisico: 'Físico', virtual: 'Virtual', hibrido: 'Híbrido' };
  var OBJETIVOS = [['leads', 'Generar nuevos leads (oportunidades de venta)'], ['relacion_clientes', 'Fortalecer la relación con clientes existentes'], ['lanzamiento', 'Lanzamiento o promoción de un nuevo producto/servicio'], ['posicionamiento', 'Posicionamiento de la marca/empresa'], ['capacitacion', 'Capacitación o educación'], ['trafico_digital', 'Aumentar el tráfico a nuestro sitio web o redes sociales'], ['retencion', 'Retención de clientes']];
  var CANALES = [['email', 'Email marketing (creación de campañas de invitación)'], ['redes', 'Redes sociales (posts, historias, anuncios)'], ['web', 'Blog o sitio web (creación de contenido, landing page)'], ['relaciones_publicas', 'Relaciones públicas (comunicados de prensa)'], ['publicidad_digital', 'Publicidad digital (Google Ads, LinkedIn Ads, etc.)'], ['video', 'Creación de videos promocionales']];
  var MATERIALES = [['banners_redes', 'Banners para redes sociales'], ['diseno_email', 'Diseño de email'], ['invitaciones', 'Invitaciones digitales o impresas'], ['presentacion', 'Presentación de diapositivas'], ['flyers', 'Flyers o folletos'], ['rollups', 'Roll-ups o pendones'], ['merchandising', 'Diseño para materiales de merchandising']];
  var LOGISTICA = [['registros', 'Apoyo en la gestión de registros (plataforma, base de datos)'], ['coordinacion_logistica', 'Coordinación con el área de logística para el evento'], ['plataforma_virtual', 'Apoyo en la configuración de la plataforma de evento virtual'], ['presencia_mercadeo', 'Se solicita presencia de Mercadeo']];
  // Listas con «Otro/a» ALINEADAS con el formulario de Solicitudes de Eventos de panel-pedidos (mismas opciones y misma regla): al elegir
  // «Otros/Otra» aparece un campo obligatorio (3 a `max` caracteres) y lo que se guarda es el texto escrito en lugar de «Otros/Otra».
  // Al abrir un evento, un valor que no está en la lista (p. ej. de antes del cambio) vuelve a mostrarse como «Otros/Otra» + texto.
  var LISTAS = {
    area: { sel: 'e-sol-area', otra: 'e-sol-area-otra', box: 'e-sol-area-otra-box', otro: 'Otros', max: 120,
      opciones: ['Comercial', 'Cartera', 'Contabilidad', 'Administrativo'] },
    plataforma: { sel: 'e-plataforma', otra: 'e-plataforma-otra', box: 'e-plataforma-otra-box', otro: 'Otra', max: 100,
      opciones: ['Zoom', 'Microsoft Teams', 'Google Meet', 'YouTube Live', 'Facebook Live'],
      alias: { teams: 'Microsoft Teams', meet: 'Google Meet', youtube: 'YouTube Live', facebook: 'Facebook Live' } },
    seg: { sel: 'e-seg', otra: 'e-seg-otra', box: 'e-seg-otra-box', otro: 'Otros', max: 100,
      opciones: ['Agricultor', 'Agrónomos', 'Dueños de almacén', 'Mostrador', 'Distribuidor'] }
  };
  // Etiquetas de campos para el historial de cambios.
  var CAMPO_T = {
    empresa: 'empresa', empresa_otra: 'nombre de la empresa', nombre: 'nombre del evento', solicitante_nombre: 'solicitante', solicitante_area: 'área', solicitante_correo: 'correo', solicitante_telefono: 'teléfono',
    fecha_limite_aprobacion: 'fecha límite de aprobación', fecha_radicacion: 'fecha de radicación', fecha_evento: 'fecha del evento', hora_inicio: 'hora de inicio', hora_fin: 'hora de fin',
    modalidad: 'modalidad', lugar: 'lugar', plataforma: 'plataforma', presupuesto_estimado: 'presupuesto estimado', total_solicitado: 'total solicitado a Mercadeo',
    total_invitados: 'total de invitados', asistentes_presencial: 'asistentes presenciales', asistentes_virtual: 'asistentes virtuales',
    bd_asistentes_fecha: 'fecha de la base de datos de asistentes', bd_no_aplica: 'base de datos «no aplica»', descripcion: 'descripción', objetivos: 'objetivos', objetivos_otro: 'otros objetivos',
    publico_objetivo: 'público objetivo', segmento_demografico: 'segmento demográfico', segmento_profesional: 'segmentación profesional', nivel_conocimiento: 'nivel de conocimiento',
    canales: 'canales de promoción', canales_otro: 'otros canales', materiales: 'materiales', materiales_otro: 'otros materiales', logistica: 'logística', logistica_otro: 'otra logística', desglose_gastos: 'desglose de gastos'
  };
  var SIGLAS = EMPRESAS.map(function (e) { return e.sigla; });
  var MAX_ARCHIVO = 25 * 1024 * 1024;
  var DIAS_MINIMOS = 15;

  // ── Estado ──
  var eventos = [], eventoById = {}, tareaDeEvento = {};
  var editId = null, orig = null, recargaTimer = null, motivoModo = null;
  var paso = 1, visitados = {};   // paso visible del modal (1-6) y pasos ya vistos (solo ellos muestran ✓ / !)

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function fail(accion, error) { showToast('Error al ' + accion + ': ' + errMsg(error), '#e74c3c'); }
  function optsHtml(pares, sel) {
    return pares.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(sel) ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('');
  }
  // Las 5 del holding + las adicionales de los eventos (Chía Abagó, Tecbihol, Otros).
  var TODAS = SIGLAS.concat(EMPRESAS_EXTRA.map(function (x) { return x.sigla; }));
  function empresaChips(arr) {
    return (arr || []).filter(function (s) { return TODAS.indexOf(s) >= 0; }).map(function (s) { return '<span class="sigla-badge sigla-' + s + '">' + esc(etiquetaEmpresa(s)) + '</span>'; }).join(' ');
  }
  // Chip de la empresa de un evento; con «Otros», el nombre escrito va debajo.
  function empresaDeEvento(e) {
    return empresaChips([e.empresa]) + (e.empresa === 'OTROS' && e.empresa_otra ? '<div class="ef-help">' + esc(e.empresa_otra) + '</div>' : '');
  }
  function badge(txt, color) { return '<span class="mk-badge" style="background:' + esc(color) + '">' + esc(txt) + '</span>'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function esFinal(e) { return !!e && FINALES.indexOf(e.estado) >= 0; }
  function hhmm(t) { return t ? String(t).slice(0, 5) : ''; }
  function numStr(v) { return v === null || v === undefined ? '' : String(v); }
  function fmtMonto(v) { return Number(v) ? Number(v).toLocaleString('es-CO') : ''; }
  function refEv(e) { return 'EV-' + e.id; }

  // ── Días / horas hábiles (lunes a viernes; sin festivos) ──
  function horasHabiles(desde, hasta) {
    var a = new Date(desde), b = new Date(hasta);
    if (isNaN(a) || isNaN(b) || b <= a) return 0;
    var total = 0, cur = new Date(a);
    while (cur < b) {
      var finDia = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      var fin = finDia < b ? finDia : b;
      var dow = cur.getDay();
      if (dow !== 0 && dow !== 6) total += (fin - cur) / 3600000;
      cur = fin;
    }
    return total;
  }
  function sumarDiasHabiles(iso, n) {
    var d = parseDateOnly(iso);
    if (!d) return null;
    while (n > 0) {
      d.setDate(d.getDate() + 1);
      var w = d.getDay();
      if (w !== 0 && w !== 6) n--;
    }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function sumarDias(iso, n) {
    var d = parseDateOnly(iso);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtHoras(h) { return h < 48 ? Math.floor(h) + ' h' : Math.floor(h / 24) + ' d'; }

  // Plazo de entrega de la base de datos de asistentes: 3 días hábiles tras el evento.
  function plazoBD(e) { return sumarDiasHabiles(e.fecha_evento, 3); }
  function bdPendiente(e) { return e.estado === 'realizada' && !e.bd_asistentes_fecha && !e.bd_no_aplica; }

  // ══════════════ Carga ══════════════
  async function cargar(primera) {
    try {
      var rs = await Promise.all([
        fetchAll('mercadeo_eventos', '*', 'id'),
        fetchAll('mercadeo_tareas', 'id,evento_id,estado', 'id', function (q) { return q.not('evento_id', 'is', null); }),
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      eventos = rs[0].data;
      tareaDeEvento = {};
      rs[1].data.forEach(function (t) { tareaDeEvento[t.evento_id] = t; });
    } catch (err) {
      if (primera) {
        $('estado-carga').innerHTML = 'No se pudieron cargar los datos: ' + esc(errMsg(err)) +
          '<br><button class="btn-primary" style="margin-top:12px" data-act="reintentar">Reintentar</button>';
      } else {
        showToast('Error al actualizar: ' + errMsg(err), '#e74c3c');
      }
      return false;
    }
    eventoById = {}; eventos.forEach(function (e) { eventoById[e.id] = e; });
    $('estado-carga').style.display = 'none';
    $('contenido').style.display = '';
    rellenarFiltros();
    render();
    if (editId && eventoById[editId] && MODAL.isOpen('evento-overlay')) { renderAcciones(eventoById[editId]); cargarDetalle(editId); }
    return true;
  }

  function programarRecarga() {
    clearTimeout(recargaTimer);
    recargaTimer = setTimeout(function () { cargar(false); }, 400);
  }

  function rellenarFiltros() {
    var fe = $('f-empresa'), vE = fe.value;
    fe.innerHTML = '<option value="">Todas</option>' + optsHtml(SIGLAS.map(function (s) { return [s, s]; })
      .concat(EMPRESAS_EXTRA.map(function (x) { return [x.sigla, x.nombre]; })), vE);
    var fs = $('f-estado'), vS = fs.value || 'abiertos';
    fs.innerHTML = optsHtml([['abiertos', 'Abiertos (sin cerrar)'], ['finalizados', 'Cerrados, rechazados y cancelados'], ['', 'Todos']].concat(
      Object.keys(ESTADO_T).map(function (k) { return [k, ESTADO_T[k]]; })), vS);
    fs.value = vS;
  }

  // ══════════════ Lista ══════════════
  function filtrar() {
    var emp = $('f-empresa').value, est = $('f-estado').value, org = $('f-origen').value;
    var desde = $('f-desde').value, hasta = $('f-hasta').value, q = norm($('f-buscar').value), soloExt = $('f-ext').checked;
    return eventos.filter(function (e) {
      if (est === 'abiertos' && ABIERTOS.indexOf(e.estado) < 0) return false;
      if (est === 'finalizados' && FINALES.indexOf(e.estado) < 0) return false;
      if (est && est !== 'abiertos' && est !== 'finalizados' && e.estado !== est) return false;
      if (emp && e.empresa !== emp) return false;
      if (org && e.origen !== org) return false;
      if (desde && e.fecha_evento < desde) return false;
      if (hasta && e.fecha_evento > hasta) return false;
      if (soloExt && !e.extemporanea) return false;
      if (q && norm(e.nombre + ' ' + e.solicitante_nombre + ' ' + e.solicitante_area + ' ' + e.lugar + ' ' + e.plataforma + ' ' + e.empresa_otra + ' ' + refEv(e)).indexOf(q) < 0) return false;
      return true;
    });
  }

  function ordenar(lista) {
    var abiertos = $('f-estado').value === 'abiertos';
    return lista.slice().sort(function (a, b) {
      if (abiertos) {
        // Lo que espera respuesta primero; luego por fecha del evento más próxima.
        var ra = ESTADO_RANK[a.estado] <= 2 ? 0 : 1, rb = ESTADO_RANK[b.estado] <= 2 ? 0 : 1;
        if (ra !== rb) return ra - rb;
        if (a.fecha_evento !== b.fecha_evento) return a.fecha_evento < b.fecha_evento ? -1 : 1;
      }
      return b.id - a.id;
    });
  }

  function atencionHtml(e) {
    var hoy = today(), partes = [];
    if ((e.estado === 'radicada' || e.estado === 'en_revision')) {
      if (!e.respondida_en) {
        var h = horasHabiles(e.creado_en, new Date());
        partes.push('<span class="kb-chip' + (h > 48 ? ' warn' : '') + '" title="El Líder de Mercadeo debe responder en máximo 48 horas hábiles">⏱ ' + fmtHoras(h) + ' hábiles sin respuesta</span>');
      }
      if (e.fecha_limite_aprobacion) {
        var vencida = e.fecha_limite_aprobacion < hoy;
        partes.push('<span class="kb-chip' + (vencida ? ' urg' : '') + '" title="Fecha en que el solicitante necesita la respuesta">' + (vencida ? '⚠ Aprobación vencida ' : '📅 Aprobar antes del ') + esc(fmtDateOnly(e.fecha_limite_aprobacion)) + '</span>');
      }
    }
    if (bdPendiente(e)) {
      var p = plazoBD(e);
      partes.push('<span class="kb-chip' + (p < hoy ? ' urg' : '') + '" title="La base de datos de asistentes debe llegar en máximo 3 días hábiles tras el evento">' +
        (p < hoy ? '⚠ BD de asistentes vencida (' : '📋 BD de asistentes hasta el ') + esc(fmtDateOnly(p)) + (p < hoy ? ')' : '') + '</span>');
    }
    var t = tareaDeEvento[e.id];
    if (t) partes.push('<span class="kb-chip" title="Tarea del Tablero ligada al evento">🗂 Tarea #' + esc(t.id) + ' · ' + esc(TAREA_T[t.estado] || t.estado) + '</span>');
    return partes.join(' ') || '<span class="mk-sin">—</span>';
  }

  function render() {
    renderStats();
    var lista = ordenar(filtrar());
    $('ev-ct').textContent = '(' + lista.length + (lista.length !== eventos.length ? ' de ' + eventos.length : '') + ')';
    if (!lista.length) {
      $('ev-body').innerHTML = '<tr><td colspan="8" class="empty">' + (eventos.length ? 'Ninguna solicitud coincide con los filtros.' : 'Aún no hay solicitudes de eventos. Registra la primera con el botón de arriba.') + '</td></tr>';
      return;
    }
    $('ev-body').innerHTML = lista.map(function (e) {
      var ped = e.origen === 'panel_pedidos' ? ' <span class="kb-chip" title="Solicitud enviada desde panel-pedidos' + (e.origen_numero ? ' (SE-' + esc(e.origen_numero) + ')' : '') + '">📥 Pedidos</span>' : '';
      var ant = e.extemporanea
        ? '<span class="kb-chip warn" title="Se pidió con menos de ' + DIAS_MINIMOS + ' días de anticipación (solo advertencia)">⚠ ' + esc(e.dias_anticipacion) + ' d</span>'
        : '<span class="kb-chip" title="Días de anticipación">✓ ' + esc(e.dias_anticipacion) + ' d</span>';
      return '<tr class="mk-click" data-act="evento-abrir" data-id="' + esc(e.id) + '">' +
        '<td><strong>' + esc(refEv(e)) + '</strong>' + ped + '</td>' +
        '<td><strong>' + esc(e.nombre) + '</strong><div class="ef-help">' + esc(e.solicitante_nombre) + (e.solicitante_area ? ' · ' + esc(e.solicitante_area) : '') + '</div></td>' +
        '<td>' + empresaDeEvento(e) + '</td>' +
        '<td>' + esc(fmtDateOnly(e.fecha_evento)) + (e.hora_inicio ? ' · ' + esc(hhmm(e.hora_inicio)) : '') +
          '<div class="ef-help">' + esc(MODALIDAD[e.modalidad] || e.modalidad) + (e.lugar ? ' · ' + esc(e.lugar) : '') + '</div></td>' +
        '<td>' + ant + '</td>' +
        '<td>' + badge(ESTADO_T[e.estado] || e.estado, ESTADO_COLOR[e.estado] || '#718096') + '</td>' +
        '<td>' + atencionHtml(e) + '</td>' +
        '<td><div class="mk-actions"><button class="btn-ver" data-act="evento-pdf" data-id="' + esc(e.id) + '" title="Ver todas las especificaciones de la solicitud en PDF" aria-label="Ver PDF de ' + esc(refEv(e)) + '">📄 PDF</button>' +
        '<button class="btn-ver" data-act="evento-abrir" data-id="' + esc(e.id) + '">' + (esFinal(e) ? 'Ver' : 'Abrir') + '</button></div></td>' +
        '</tr>';
    }).join('');
  }

  // ══════════════ Indicadores del encabezado ══════════════
  function renderStats() {
    var hoy = today(), mes = hoy.slice(0, 7);
    var porAtender = eventos.filter(function (e) { return e.estado === 'radicada' || e.estado === 'en_revision'; });
    var sinResp = porAtender.filter(function (e) { return !e.respondida_en && horasHabiles(e.creado_en, new Date()) > 48; });
    var en30 = sumarDias(hoy, 30);
    var proximos = eventos.filter(function (e) { return (e.estado === 'aprobada' || e.estado === 'en_preparacion') && e.fecha_evento >= hoy && e.fecha_evento <= en30; });

    // Oportunidad: solicitudes radicadas este mes (sin las retiradas por el solicitante) con >= 15 días de anticipación.
    var delMes = eventos.filter(function (e) { return String(e.fecha_radicacion || '').slice(0, 7) === mes && !(e.estado === 'cancelada' && e.origen === 'panel_pedidos'); });
    var aTiempo = delMes.filter(function (e) { return !e.extemporanea; }).length;

    // Retorno de la BD: eventos realizados/cerrados en los últimos 90 días; cuentan los que ya la entregaron o ya vencieron.
    var desde90 = sumarDias(hoy, -90);
    var exigibles = eventos.filter(function (e) {
      if (e.estado !== 'realizada' && e.estado !== 'cerrada') return false;
      if (e.bd_no_aplica || e.fecha_evento < desde90) return false;
      return !!e.bd_asistentes_fecha || plazoBD(e) < hoy;
    });
    var retorno = exigibles.filter(function (e) { return e.bd_asistentes_fecha && e.bd_asistentes_fecha <= plazoBD(e); }).length;
    var bdVencidas = eventos.filter(function (e) { return bdPendiente(e) && plazoBD(e) < hoy; }).length;

    function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; }
    $('ev-stats').innerHTML =
      '<div class="sc recibido"><div class="num">' + porAtender.length + '</div><div class="lbl">Por atender</div><div class="mk-sub">' +
        (sinResp.length ? sinResp.length + ' sin respuesta &gt; 48 h hábiles' : 'todas dentro de las 48 h hábiles') + '</div></div>' +
      '<div class="sc info"><div class="num">' + proximos.length + '</div><div class="lbl">Eventos en los próximos 30 días</div><div class="mk-sub">aprobados o en preparación</div></div>' +
      '<div class="sc total"><div class="num">' + pct(aTiempo, delMes.length) + '</div><div class="lbl">Oportunidad en la solicitud</div><div class="mk-sub">' +
        (delMes.length ? aTiempo + ' de ' + delMes.length + ' con ≥ ' + DIAS_MINIMOS + ' días (este mes)' : 'sin solicitudes este mes') + '</div></div>' +
      '<div class="sc ' + (bdVencidas ? 'alerta' : 'entregado') + '"><div class="num">' + pct(retorno, exigibles.length) + '</div><div class="lbl">Retorno de la base de datos</div><div class="mk-sub">' +
        (bdVencidas ? bdVencidas + ' con plazo vencido · ' : '') + (exigibles.length ? retorno + ' de ' + exigibles.length + ' en ≤ 3 días hábiles' : 'sin eventos para medir') + '</div></div>';
  }

  // ══════════════ Formulario ══════════════
  function checksHtml(id, catalogo, sel, bloqueado) {
    $(id).innerHTML = catalogo.map(function (c) {
      return '<label><input type="checkbox" class="' + id + '-chk" value="' + esc(c[0]) + '"' + (sel.indexOf(c[0]) >= 0 ? ' checked' : '') + (bloqueado ? ' disabled' : '') + '> ' + esc(c[1]) + '</label>';
    }).join('');
  }
  function marcados(id) { return [].slice.call(document.querySelectorAll('.' + id + '-chk:checked')).map(function (c) { return c.value; }); }

  function listaLlenar(L) {
    $(L.sel).innerHTML = '<option value="">— Seleccionar —</option>' + L.opciones.concat([L.otro]).map(function (o) {
      return '<option value="' + esc(o) + '">' + esc(o) + '</option>';
    }).join('');
  }
  function listaActualizar(L) {
    var otro = $(L.sel).value === L.otro;
    $(L.box).style.display = otro ? '' : 'none';
    if (otro && !$(L.otra).disabled && document.activeElement === $(L.sel)) $(L.otra).focus();
  }
  function listaPoner(L, valor) {
    var v = String(valor || '').trim(), k = v.toLowerCase();
    var oficial = L.opciones.filter(function (o) { return o.toLowerCase() === k; })[0] || (L.alias && L.alias[k]) || '';
    if (!v) { $(L.sel).value = ''; $(L.otra).value = ''; }
    else if (oficial) { $(L.sel).value = oficial; $(L.otra).value = ''; }
    else { $(L.sel).value = L.otro; $(L.otra).value = v === L.otro ? '' : v; }
    listaActualizar(L);
  }
  function listaValor(L) {
    var v = $(L.sel).value;
    return v === L.otro ? $(L.otra).value.trim().replace(/\s+/g, ' ') : v;
  }
  function listaEsOtro(L) { return $(L.sel).value === L.otro; }

  // ── Lugar: municipio + departamento (lista oficial, js/shared/colombia-geo.js), distribuidor/cliente + NIT y finca ──
  // `lugar` se guarda como el texto armado con esas partes (igual que lo arma panel-pedidos).
  function lugarTexto(d) {
    var p = [];
    if (d.lugar_municipio) p.push(d.lugar_municipio + (d.lugar_departamento ? ', ' + d.lugar_departamento : ''));
    if (d.lugar_distribuidor) p.push('Distribuidor/cliente: ' + d.lugar_distribuidor + (d.lugar_distribuidor_nit ? ' (NIT ' + d.lugar_distribuidor_nit + ')' : ''));
    if (d.lugar_finca) p.push('Finca: ' + d.lugar_finca);
    return p.join(' · ').slice(0, 300);
  }
  // ¿El municipio pertenece a ese departamento de la lista oficial?
  function geoValido(muni, depto) {
    return !!(muni && depto && COLOMBIA_DEPTOS_MUNIS[depto] && COLOMBIA_DEPTOS_MUNIS[depto].indexOf(muni) >= 0);
  }
  // Resuelve un municipio escrito a mano (sin tildes, en mayúsculas…) al par oficial; null si no hay un único candidato.
  function geoPar(muni, depto) {
    var limpio = function (s) { return _normSearch(s).replace(/\s*d\.?\s*c\.?\s*$/, ''); };
    var m = limpio(muni), dp = _normSearch(depto), hallados = [];
    if (!m) return null;
    Object.keys(COLOMBIA_DEPTOS_MUNIS).forEach(function (dep) {
      COLOMBIA_DEPTOS_MUNIS[dep].forEach(function (nom) { if (limpio(nom) === m) hallados.push({ municipio: nom, departamento: dep }); });
    });
    if (dp) {
      var enDep = hallados.filter(function (h) { return _normSearch(h.departamento) === dp; });
      if (enDep.length === 1) return enDep[0];
    }
    return hallados.length === 1 ? hallados[0] : null;
  }
  // Al salir de los campos: si lo escrito corresponde a un único municipio/departamento oficial, se deja con su ortografía oficial.
  function canonizarGeo() {
    var mEl = $('e-municipio'), dEl = $('e-depto');
    if (dEl.value.trim()) dEl.value = normalizarDepartamento(dEl.value.trim());
    var m = mEl.value.trim(), d = dEl.value.trim();
    if (!m || geoValido(m, d)) return;
    var p = geoPar(m, d);
    if (p) { mEl.value = p.municipio; dEl.value = p.departamento; }
  }

  function modalidadActual() { var r = document.querySelector('input[name="e-mod"]:checked'); return r ? r.value : ''; }
  // Con la empresa «Otros» aparece el campo para escribir el nombre.
  function actualizarEmpresaOtra() {
    var otros = $('e-empresa').value === 'OTROS';
    $('e-empresa-otra-box').style.display = otros ? '' : 'none';
    if (otros && !$('e-empresa-otra').disabled && document.activeElement === $('e-empresa')) $('e-empresa-otra').focus();
  }

  function actualizarModalidad() {
    var m = modalidadActual();
    $('e-lugar-box').style.display = m === 'fisico' || m === 'hibrido' || !m ? '' : 'none';
    $('e-plataforma-box').style.display = m === 'virtual' || m === 'hibrido' ? '' : 'none';
  }

  function actualizarAnticipacion() {
    var rad = $('e-radicacion').value, ev = $('e-fecha').value;
    var el = $('e-anticipacion');
    if (!rad || !ev) { el.innerHTML = ''; return; }
    var d = diasEntre(rad, ev);
    if (d === null) { el.innerHTML = ''; return; }
    if (d < 0) { el.innerHTML = '<span class="mk-warn">La fecha del evento es anterior a la fecha en que llegó la solicitud.</span>'; return; }
    el.innerHTML = d < DIAS_MINIMOS
      ? '<span class="mk-warn">⚠ Anticipación de ' + d + ' días: la política pide mínimo ' + DIAS_MINIMOS + ' días calendario (es una advertencia, no impide registrarla).</span>'
      : 'Anticipación: ' + d + ' días ✓';
  }

  // Desglose de gastos: filas concepto / valor.
  function filaGastoHtml(concepto, valor) {
    return '<div class="ev-gasto"><input class="ef ev-g-con" maxlength="120" placeholder="Concepto (p. ej. refrigerios)" aria-label="Concepto del gasto" value="' + esc(concepto) + '">' +
      '<input class="ef ev-g-val" inputmode="decimal" placeholder="Valor" aria-label="Valor del gasto" value="' + esc(valor ? fmtMonto(valor) : '') + '">' +
      '<button type="button" class="btn-danger" data-act="gasto-quitar" aria-label="Quitar línea">🗑</button></div>';
  }
  function pintarDesglose(lineas, bloqueado) {
    $('e-desglose').innerHTML = (lineas || []).map(function (l) { return filaGastoHtml(l.concepto, l.valor); }).join('');
    if (bloqueado) [].slice.call($('e-desglose').querySelectorAll('input,button')).forEach(function (n) { n.disabled = true; });
    actualizarPresupuesto();
  }
  function leerDesglose() {
    var out = [], error = null;
    [].slice.call(document.querySelectorAll('#e-desglose .ev-gasto')).forEach(function (f) {
      var con = f.querySelector('.ev-g-con').value.trim(), txt = f.querySelector('.ev-g-val').value.trim();
      if (!con && !txt) return;
      var val = txt ? parseMonto(txt) : 0;
      if (!con) { error = 'Cada línea del desglose de gastos necesita un concepto'; return; }
      if (isNaN(val)) { error = 'El valor de «' + con + '» en el desglose no es un número'; return; }
      out.push({ concepto: con, valor: val });
    });
    return { lineas: out, error: error };
  }
  function actualizarPresupuesto() {
    var est = parseMonto($('e-presupuesto').value), sol = parseMonto($('e-solicitado').value);
    var des = leerDesglose().lineas, suma = des.reduce(function (a, l) { return a + l.valor; }, 0);
    $('e-desglose-total').textContent = des.length ? 'Suma del desglose: ' + fmtMoney(suma) : '';
    var avisos = [];
    if (!isNaN(est) && !isNaN(sol) && sol > est) avisos.push('⚠ Lo solicitado a Mercadeo supera el presupuesto estimado del evento.');
    if (!isNaN(est) && est > 0 && des.length && Math.abs(suma - est) > 0.5) avisos.push('El desglose suma ' + fmtMoney(suma) + ' y el presupuesto estimado es ' + fmtMoney(est) + '.');
    $('e-presupuesto-help').innerHTML = avisos.map(function (a) { return '<span class="mk-warn" style="font-weight:600">' + esc(a) + '</span>'; }).join('<br>');
  }

  function bloquearForm(bloq) {
    [].slice.call($('evento-overlay').querySelectorAll('.mbody .ef, .mbody input[type="radio"], .mbody input[type="checkbox"]')).forEach(function (n) {
      if (n.id === 'e-coment-txt' || n.id === 'e-resp-txt' || n.id === 'e-files' || n.id === 'e-files-nuevo') return;
      n.disabled = bloq;
    });
    [].slice.call($('e-desglose').querySelectorAll('input,button')).forEach(function (n) { n.disabled = bloq; });
    var add = document.querySelector('[data-act="gasto-agregar"]');
    if (add) add.disabled = bloq;
  }

  function llenarForm(e) {
    var nuevo = !e;
    $('e-sol-nombre').value = nuevo ? '' : e.solicitante_nombre;
    listaPoner(LISTAS.area, nuevo ? '' : e.solicitante_area);
    $('e-sol-correo').value = nuevo ? '' : e.solicitante_correo;
    $('e-sol-tel').value = nuevo ? '' : e.solicitante_telefono;
    $('e-limite').value = nuevo || !e.fecha_limite_aprobacion ? '' : e.fecha_limite_aprobacion;
    $('e-radicacion').value = nuevo ? today() : e.fecha_radicacion;
    $('e-radicacion').max = today();
    $('e-empresa').innerHTML = '<option value="">Elegir…</option>' + optsHtml(EMPRESAS.map(function (x) { return [x.sigla, x.sigla + ' — ' + x.nombre]; })
      .concat(EMPRESAS_EXTRA.map(function (x) { return [x.sigla, x.sigla === 'OTROS' ? 'Otros (escribir el nombre)' : x.nombre]; })), nuevo ? '' : e.empresa);
    $('e-empresa-otra').value = nuevo ? '' : (e.empresa_otra || '');
    $('e-nombre').value = nuevo ? '' : e.nombre;
    $('e-desc').value = nuevo ? '' : e.descripcion;
    $('e-fecha').value = nuevo ? '' : e.fecha_evento;
    $('e-hora-ini').value = nuevo ? '' : hhmm(e.hora_inicio);
    $('e-hora-fin').value = nuevo ? '' : hhmm(e.hora_fin);
    var mod = nuevo ? 'fisico' : e.modalidad;
    $('e-modalidad').innerHTML = Object.keys(MODALIDAD).map(function (k) {
      return '<label><input type="radio" name="e-mod" value="' + k + '"' + (k === mod ? ' checked' : '') + '> ' + MODALIDAD[k] + '</label>';
    }).join('');
    $('e-municipio').value = nuevo ? '' : (e.lugar_municipio || '');
    $('e-depto').value = nuevo ? '' : (e.lugar_departamento || '');
    $('e-dist').value = nuevo ? '' : (e.lugar_distribuidor || '');
    $('e-dist-nit').value = nuevo ? '' : (e.lugar_distribuidor_nit || '');
    $('e-finca').value = nuevo ? '' : (e.lugar_finca || '');
    // Eventos de antes del cambio traen un lugar en texto libre: se muestra para que se complete municipio y departamento.
    var previoLugar = !nuevo && e.lugar && !e.lugar_municipio && e.modalidad !== 'virtual';
    $('e-lugar-previo').style.display = previoLugar ? '' : 'none';
    $('e-lugar-previo').textContent = previoLugar ? 'Lugar registrado antes: «' + e.lugar + '». Completa los campos de arriba.' : '';
    listaPoner(LISTAS.plataforma, nuevo ? '' : e.plataforma);
    checksHtml('e-objetivos', OBJETIVOS, nuevo ? [] : e.objetivos);
    $('e-objetivos-otro').value = nuevo ? '' : e.objetivos_otro;
    $('e-publico').value = nuevo ? '' : e.publico_objetivo;
    listaPoner(LISTAS.seg, nuevo ? '' : e.segmento_profesional);
    // El segmento demográfico y el nivel de conocimiento ya no se piden; si un evento anterior los trae, se muestran (solo lectura) y se conservan.
    var segPrevio = nuevo ? [] : [e.segmento_demografico ? 'Segmento demográfico: ' + e.segmento_demografico : '', e.nivel_conocimiento ? 'Nivel de conocimiento: ' + e.nivel_conocimiento : ''].filter(Boolean);
    $('e-seg-previo').style.display = segPrevio.length ? '' : 'none';
    $('e-seg-previo').textContent = segPrevio.length ? 'Datos anteriores — ' + segPrevio.join(' · ') : '';
    $('e-invitados').value = nuevo ? '' : numStr(e.total_invitados);
    $('e-asis-pres').value = nuevo ? '' : numStr(e.asistentes_presencial);
    $('e-asis-virt').value = nuevo ? '' : numStr(e.asistentes_virtual);
    checksHtml('e-canales', CANALES, nuevo ? [] : e.canales);
    $('e-canales-otro').value = nuevo ? '' : e.canales_otro;
    checksHtml('e-materiales', MATERIALES, nuevo ? [] : e.materiales);
    $('e-materiales-otro').value = nuevo ? '' : e.materiales_otro;
    checksHtml('e-logistica', LOGISTICA, nuevo ? [] : e.logistica);
    $('e-logistica-otro').value = nuevo ? '' : e.logistica_otro;
    $('e-presupuesto').value = nuevo ? '' : fmtMonto(e.presupuesto_estimado);
    $('e-solicitado').value = nuevo ? '' : fmtMonto(e.total_solicitado);
    pintarDesglose(nuevo ? [] : e.desglose_gastos, false);
    $('e-bd-fecha').value = nuevo || !e.bd_asistentes_fecha ? '' : e.bd_asistentes_fecha;
    $('e-bd-na').checked = !nuevo && !!e.bd_no_aplica;
    actualizarModalidad();
    actualizarEmpresaOtra();
    actualizarAnticipacion();
  }

  function enteroOpc(id) {
    var v = $(id).value.trim();
    return v === '' ? null : Number(v);
  }

  function leerForm() {
    var gastos = leerDesglose();
    var est = parseMonto($('e-presupuesto').value), sol = parseMonto($('e-solicitado').value);
    // El lugar solo cuenta si el evento es presencial (físico o híbrido); en uno virtual se descarta aunque haya texto en los campos.
    var mod = modalidadActual(), presencial = mod === 'fisico' || mod === 'hibrido';
    var campo = function (id) { return presencial ? $(id).value.trim().replace(/\s+/g, ' ') : ''; };
    var lug = {
      lugar_municipio: campo('e-municipio'), lugar_departamento: campo('e-depto'),
      lugar_distribuidor: campo('e-dist'), lugar_distribuidor_nit: campo('e-dist-nit'), lugar_finca: campo('e-finca')
    };
    var d = {
      empresa: $('e-empresa').value,
      empresa_otra: $('e-empresa').value === 'OTROS' ? $('e-empresa-otra').value.trim().replace(/\s+/g, ' ') : '',
      solicitante_nombre: $('e-sol-nombre').value.trim(), solicitante_area: listaValor(LISTAS.area),
      solicitante_correo: $('e-sol-correo').value.trim(), solicitante_telefono: $('e-sol-tel').value.trim(),
      fecha_limite_aprobacion: $('e-limite').value || null,
      nombre: $('e-nombre').value.trim(), descripcion: $('e-desc').value.trim(),
      fecha_evento: $('e-fecha').value, hora_inicio: $('e-hora-ini').value || null, hora_fin: $('e-hora-fin').value || null,
      modalidad: mod, lugar: lugarTexto(lug), lugar_municipio: lug.lugar_municipio, lugar_departamento: lug.lugar_departamento,
      lugar_distribuidor: lug.lugar_distribuidor, lugar_distribuidor_nit: lug.lugar_distribuidor_nit, lugar_finca: lug.lugar_finca,
      plataforma: listaValor(LISTAS.plataforma),
      objetivos: marcados('e-objetivos'), objetivos_otro: $('e-objetivos-otro').value.trim(),
      publico_objetivo: $('e-publico').value.trim(),
      segmento_profesional: listaValor(LISTAS.seg),   // reemplaza a segmento demográfico, segmentación profesional y nivel de conocimiento
      total_invitados: enteroOpc('e-invitados'), asistentes_presencial: enteroOpc('e-asis-pres'), asistentes_virtual: enteroOpc('e-asis-virt'),
      canales: marcados('e-canales'), canales_otro: $('e-canales-otro').value.trim(),
      materiales: marcados('e-materiales'), materiales_otro: $('e-materiales-otro').value.trim(),
      logistica: marcados('e-logistica'), logistica_otro: $('e-logistica-otro').value.trim(),
      presupuesto_estimado: $('e-presupuesto').value.trim() === '' ? 0 : est,
      total_solicitado: $('e-solicitado').value.trim() === '' ? 0 : sol,
      desglose_gastos: gastos.lineas,
    };
    var e = editId ? eventoById[editId] : null;
    // La fecha de llegada de una solicitud de Pedidos la fija el puente; la de una digitada aquí, Mercadeo.
    if (!e || e.origen === 'panel_mercadeo') d.fecha_radicacion = $('e-radicacion').value;
    if (e && (e.estado === 'realizada' || e.estado === 'cerrada')) {
      d.bd_no_aplica = $('e-bd-na').checked;
      d.bd_asistentes_fecha = d.bd_no_aplica ? null : ($('e-bd-fecha').value || null);
    }
    d._errGastos = gastos.error;
    // Solo para validar (los campos con «_» no se guardan): qué listas están en «Otros/Otra».
    d._areaOtros = listaEsOtro(LISTAS.area); d._plataformaOtra = listaEsOtro(LISTAS.plataforma); d._segOtros = listaEsOtro(LISTAS.seg);
    return d;
  }

  // ── Pasos del modal ──
  // 1 Solicitante · 2 Evento · 3 Objetivos y público · 4 Requerimientos · 5 Presupuesto · 6 Actividades (checklist) · 7 Aprobación y seguimiento.
  // La navegación es libre (también se usa para revisar eventos ya existentes); al guardar se revisan todos los pasos y se lleva al
  // primero con error. En la barra, un paso ya visto muestra ✓ si está completo o ! si le falta algo.
  var PASOS = [
    { n: 1, t: 'Solicitante' },
    { n: 2, t: 'Evento' },
    { n: 3, t: 'Objetivos y público' },
    { n: 4, t: 'Requerimientos' },
    { n: 5, t: 'Presupuesto' },
    { n: 6, t: 'Actividades' },
    { n: 7, t: 'Aprobación y seguimiento' },
  ];

  // Error (texto) de un paso, o null si está completo.
  function validarPaso(d, n) {
    if (n === 1) {
      if (!d.empresa) return 'Elige la empresa';
      if (d.empresa === 'OTROS' && (d.empresa_otra.length < 3 || d.empresa_otra.length > 100)) return 'Escribe el nombre de la empresa (entre 3 y 100 caracteres)';
      if (d.solicitante_nombre.length < 2) return 'Escribe el nombre del solicitante';
      if (d._areaOtros && (d.solicitante_area.length < 3 || d.solicitante_area.length > LISTAS.area.max)) return 'Escribe el departamento o área (entre 3 y ' + LISTAS.area.max + ' caracteres)';
      if (d.fecha_radicacion !== undefined) {
        if (!d.fecha_radicacion) return 'Indica la fecha en que llegó la solicitud';
        if (d.fecha_radicacion > today()) return 'La fecha en que llegó la solicitud no puede ser futura';
      }
    }
    if (n === 2) {
      if (d.nombre.length < 3) return 'El nombre del evento debe tener al menos 3 caracteres';
      if (d.descripcion.length < 10) return 'La descripción del evento debe tener al menos 10 caracteres';
      if (!d.fecha_evento) return 'Indica la fecha del evento';
      if (d.fecha_radicacion && d.fecha_evento < d.fecha_radicacion) return 'La fecha del evento no puede ser anterior a la fecha en que llegó la solicitud';
      if (d.hora_inicio && d.hora_fin && d.hora_fin <= d.hora_inicio) return 'La hora de fin debe ser posterior a la de inicio';
      if (d.fecha_limite_aprobacion && d.fecha_limite_aprobacion > d.fecha_evento) return 'La fecha límite de aprobación no puede ser posterior a la fecha del evento';
      if (!d.modalidad) return 'Elige la modalidad: físico, virtual o híbrido';
      if (d.modalidad === 'fisico' || d.modalidad === 'hibrido') {
        if (!d.lugar_municipio || !d.lugar_departamento) return 'Indica el municipio y el departamento del evento';
        if (!geoValido(d.lugar_municipio, d.lugar_departamento)) return 'Elige el municipio y el departamento de la lista oficial (el municipio debe pertenecer al departamento)';
        if (d.lugar_distribuidor_nit && !d.lugar_distribuidor) return 'Escribe el nombre del distribuidor o cliente del NIT';
      }
      if (d.modalidad === 'virtual' || d.modalidad === 'hibrido') {
        if (d._plataformaOtra && (d.plataforma.length < 3 || d.plataforma.length > LISTAS.plataforma.max)) return 'Escribe el nombre de la plataforma (entre 3 y ' + LISTAS.plataforma.max + ' caracteres)';
        if (!d.plataforma) return 'Indica la plataforma del evento virtual';
      }
    }
    if (n === 3) {
      if (d._segOtros && (d.segmento_profesional.length < 3 || d.segmento_profesional.length > LISTAS.seg.max)) return 'Escribe la segmentación (entre 3 y ' + LISTAS.seg.max + ' caracteres)';
      var enteros = [['total_invitados', 'El total de invitados'], ['asistentes_presencial', 'Los asistentes presenciales'], ['asistentes_virtual', 'Los asistentes virtuales']];
      for (var i = 0; i < enteros.length; i++) {
        var v = d[enteros[i][0]];
        if (v !== null && (!Number.isInteger(v) || v < 0 || v > 100000)) return enteros[i][1] + ' debe ser un número entero entre 0 y 100000';
      }
    }
    if (n === 5) {
      if (d._errGastos) return d._errGastos;
      if (isNaN(d.presupuesto_estimado) || isNaN(d.total_solicitado)) return 'El presupuesto y el total solicitado deben ser números';
    }
    return null;
  }

  // Revisa todos los pasos: si alguno tiene error, lleva a ese paso, lo avisa y devuelve false.
  function revisar(d) {
    for (var n = 1; n <= PASOS.length; n++) {
      var msg = validarPaso(d, n);
      if (msg) { marcarTodosVisitados(); mostrarPaso(n); showToast(msg, '#e74c3c'); return false; }
    }
    return true;
  }

  function marcarTodosVisitados() { PASOS.forEach(function (p) { visitados[p.n] = true; }); }

  function renderPasos() {
    var d = leerForm(), final = esFinal(editId ? eventoById[editId] : null);
    $('e-pasos').innerHTML = PASOS.map(function (p) {
      var est = p.n === paso ? 'actual' : (visitados[p.n] ? (!final && validarPaso(d, p.n) ? 'error' : 'ok') : '');
      var marca = est === 'ok' ? '✓' : est === 'error' ? '!' : String(p.n);
      return '<li class="' + est + '"><button type="button" data-act="paso-ir" data-id="' + p.n + '"' + (est === 'actual' ? ' aria-current="step"' : '') +
        ' title="' + esc(p.t) + (est === 'error' ? ' — falta completar algo' : '') + '"><span class="num">' + marca + '</span><span class="txt">' + esc(p.t) + '</span></button></li>';
    }).join('');
  }

  function mostrarPaso(n, scroll) {
    n = Math.max(1, Math.min(PASOS.length, n));
    paso = n;
    visitados[n] = true;
    [].slice.call(document.querySelectorAll('#evento-overlay .ev-paso')).forEach(function (s) {
      s.style.display = Number(s.getAttribute('data-paso')) === n ? '' : 'none';
    });
    $('e-anterior').style.visibility = n === 1 ? 'hidden' : 'visible';
    $('e-siguiente').style.visibility = n === PASOS.length ? 'hidden' : 'visible';
    $('e-paso-txt').textContent = 'Paso ' + n + ' de ' + PASOS.length + ' · ' + PASOS[n - 1].t;
    renderPasos();
    if (scroll) $('e-pasos').scrollIntoView({ block: 'nearest' });
  }

  // Valores de la fila en el mismo formato que leerForm() (para detectar qué cambió).
  function comoForm(e) {
    var o = {};
    Object.keys(e).forEach(function (k) { o[k] = e[k]; });
    o.hora_inicio = e.hora_inicio ? hhmm(e.hora_inicio) : null;
    o.hora_fin = e.hora_fin ? hhmm(e.hora_fin) : null;
    o.presupuesto_estimado = Number(e.presupuesto_estimado) || 0;
    o.total_solicitado = Number(e.total_solicitado) || 0;
    o.desglose_gastos = (e.desglose_gastos || []).map(function (l) { return { concepto: l.concepto, valor: Number(l.valor) }; });
    return o;
  }
  function igual(a, b) {
    if (Array.isArray(a) && Array.isArray(b) && typeof a[0] !== 'object' && typeof b[0] !== 'object') return JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function diferencias(d) {
    var base = comoForm(orig), diff = {};
    Object.keys(d).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      if (!igual(d[k], base[k])) diff[k] = d[k];
    });
    return diff;
  }

  // ══════════════ Modal del evento ══════════════
  function abrirEvento(id) {
    var e = id ? eventoById[id] : null;
    editId = e ? e.id : null;
    orig = e ? JSON.parse(JSON.stringify(e)) : null;
    $('evento-titulo').textContent = e ? refEv(e) + ' · ' + e.nombre : '➕ Nueva solicitud de evento';
    $('evento-meta').innerHTML = e ? '<span>' + esc(ESTADO_T[e.estado]) + '</span><span>' + esc(etiquetaEmpresa(e.empresa)) + (e.empresa === 'OTROS' && e.empresa_otra ? ' · ' + esc(e.empresa_otra) : '') + '</span>' : '<span>Estado inicial: Radicada</span>';
    llenarForm(e);
    var final = esFinal(e);
    bloquearForm(final);
    // La fecha en que llegó una solicitud de Pedidos la fija el puente.
    var deMercadeo = !e || e.origen === 'panel_mercadeo';
    $('e-radicacion').disabled = final || !deMercadeo;
    $('e-radicacion-help').textContent = deMercadeo
      ? 'Por defecto hoy; si el correo llegó antes, pon esa fecha (cuenta para la política de 15 días).'
      : 'La fijó panel-pedidos al recibir la solicitud; no se cambia.';
    renderBanderas(e);
    renderOrigen(e);
    renderAprobacion(e);
    renderAcciones(e);
    $('e-nuevo-files').style.display = e ? 'none' : '';
    $('e-files-nuevo').value = '';
    $('e-extra').style.display = e ? '' : 'none';
    $('e-guardar').style.display = final ? 'none' : '';
    $('e-guardar').disabled = false; $('e-guardar').textContent = e ? 'Guardar cambios' : 'Registrar solicitud';
    $('e-eliminar').style.display = e && esAdmin ? '' : 'none';
    $('e-pdf').style.display = e ? '' : 'none';
    var enBD = !!e && (e.estado === 'realizada' || e.estado === 'cerrada');
    $('e-bd-box').style.display = enBD ? '' : 'none';
    if (enBD) {
      $('e-bd-ayuda').textContent = 'El comercial debe entregar la base de datos de los asistentes en máximo 3 días hábiles tras el evento (plazo: ' + fmtDateOnly(plazoBD(e)) + '). Para cerrar el evento registra la fecha en que llegó, o márcala como «no aplica».';
      $('e-bd-fecha').disabled = final || $('e-bd-na').checked;
    }
    $('e-resp-box').style.display = e && e.origen === 'panel_pedidos' && !final ? '' : 'none';
    $('e-resp-txt').value = '';
    $('e-coment-txt').value = '';
    $('e-chk-nueva').value = '';
    cargarChecklist(e ? e.id : null);
    if (e) {
      renderTarea(e);
      $('e-bitacora').innerHTML = '<div class="mk-sin">Cargando…</div>'; $('e-adjuntos').innerHTML = '';
      $('e-audit').innerHTML = auditoriaHtml(e);
      cargarDetalle(e.id);
    }
    visitados = {};
    if (e) marcarTodosVisitados();   // un evento ya registrado está completo: todos los pasos como vistos
    mostrarPaso(1);
    MODAL.open('evento-overlay', 'e-sol-nombre');
  }

  function renderBanderas(e) {
    var hoy = today(), html = '';
    if (e && e.extemporanea && !esFinal(e)) {
      html += '<div class="mk-flag">⚠️ Solicitado con <strong>' + esc(e.dias_anticipacion) + ' días</strong> de anticipación: la política pide mínimo ' + DIAS_MINIMOS +
        ' días calendario (material POP, diseño o presencia de Mercadeo). Es una advertencia: el Líder de Mercadeo decide si lo aprueba.</div>';
    }
    if (e && (e.estado === 'radicada' || e.estado === 'en_revision') && e.fecha_limite_aprobacion && e.fecha_limite_aprobacion < hoy) {
      html += '<div class="mk-flag" style="background:#fee2e2;color:#991b1b">⏰ La fecha límite de aprobación que pidió el solicitante (' + esc(fmtDateOnly(e.fecha_limite_aprobacion)) + ') ya pasó.</div>';
    }
    if (e && bdPendiente(e) && plazoBD(e) < hoy) {
      html += '<div class="mk-flag" style="background:#fee2e2;color:#991b1b">⏰ La base de datos de asistentes debía llegar el ' + esc(fmtDateOnly(plazoBD(e))) + ' (3 días hábiles tras el evento) y aún no se registra.</div>';
    }
    if (e && e.estado === 'rechazada') {
      html += '<div class="mk-flag" style="background:#fee2e2;color:#991b1b">❌ Rechazada por <strong>' + esc(e.rechazado_por_nombre || '—') + '</strong>' + (e.rechazado_en ? ' el ' + esc(fmtDateTime(e.rechazado_en)) : '') +
        '.<br><strong>Motivo:</strong> ' + esc(e.motivo_rechazo || '—') + '</div>';
    }
    if (e && e.estado === 'cancelada') {
      html += '<div class="mk-flag" style="background:#e2e8f0;color:#4a5568">🚫 Cancelada por <strong>' + esc(e.cancelado_por_nombre || '—') + '</strong>' + (e.cancelado_en ? ' el ' + esc(fmtDateTime(e.cancelado_en)) : '') +
        '.<br><strong>Motivo:</strong> ' + esc(e.motivo_cancelacion || '—') + '</div>';
    }
    $('e-flags').innerHTML = html;
  }

  function renderOrigen(e) {
    var box = $('e-origen');
    if (!e || e.origen !== 'panel_pedidos') { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML = '<h4>📥 Solicitud desde Pedidos</h4><div class="form-grid cols2" style="margin-bottom:0">' +
      '<div><span class="ef-label">N° en Pedidos</span>' + esc(e.origen_numero ? 'SE-' + e.origen_numero : '—') + '</div>' +
      '<div><span class="ef-label">Enviada por</span>' + esc(e.enviado_por_nombre || '—') + '</div>' +
      '<div><span class="ef-label">Aprobada en Pedidos por</span>' + esc(e.aprobada_origen_por_nombre || '—') + (e.aprobada_origen_en ? ' · ' + esc(fmtDateTime(e.aprobada_origen_en)) : '') + '</div>' +
      '<div><span class="ef-label">Llegó a Mercadeo</span>' + esc(fmtDateTime(e.creado_en)) + '</div></div>';
  }

  // Sección 6 del formato: firmas / aprobación.
  function renderAprobacion(e) {
    var box = $('e-aprobacion');
    if (!e) { box.innerHTML = '<div class="ef-help">Al registrar la solicitud queda en «Radicada». El Líder de Mercadeo la evalúa (máximo 48 horas hábiles) y la aprueba o la rechaza; la aprobación se registra aquí con su nombre y hora.</div>'; return; }
    var resp = e.respondida_en ? esc(fmtDateTime(e.respondida_en)) + ' (' + fmtHoras(horasHabiles(e.creado_en, e.respondida_en)) + ' hábiles)' : '<span class="mk-sin">sin respuesta todavía</span>';
    var lineas = [
      ['Nombre y firma del solicitante', esc(e.solicitante_nombre) + (e.origen === 'panel_pedidos' ? ' <span class="mk-sin">(aprobada en Pedidos por ' + esc(e.aprobada_origen_por_nombre || '—') + ')</span>' : '')],
      ['Primera respuesta de Mercadeo', resp],
      ['Firma de aprobación (Mercadeo)', e.aprobado_por_nombre ? esc(e.aprobado_por_nombre) + ' · ' + esc(fmtDateTime(e.aprobado_en)) : '<span class="mk-sin">pendiente</span>'],
    ];
    if (e.realizado_en) lineas.push(['Marcado como realizado', esc(fmtDateTime(e.realizado_en))]);
    if (e.cerrado_en) lineas.push(['Cerrado', esc(fmtDateTime(e.cerrado_en))]);
    box.innerHTML = lineas.map(function (l) { return '<div class="mk-kv"><span>' + l[0] + '</span><span>' + l[1] + '</span></div>'; }).join('');
  }

  function renderTarea(e) {
    var box = $('e-tarea-box'), t = tareaDeEvento[e.id];
    if (t) {
      box.style.display = '';
      box.innerHTML = '<h4>🗂️ Tarea en el Tablero</h4>Tarea #' + esc(t.id) + ' · estado: <strong>' + esc(TAREA_T[t.estado] || t.estado) + '</strong> · ' +
        '<a href="mercadeo.html?tarea=' + encodeURIComponent(t.id) + '" style="font-weight:700">Abrir en el Tablero</a>' +
        '<div class="ef-help">Se creó sola al aprobar el evento (brief con los materiales y la logística pedidos). El diseño y la producción se gestionan allí; si se cancela el evento, se cancela la tarea.</div>';
    } else if (ABIERTOS.indexOf(e.estado) >= 0 && ESTADO_RANK[e.estado] <= 2) {
      box.style.display = '';
      box.innerHTML = '<h4>🗂️ Tarea en el Tablero</h4><span class="mk-sin">Se crea sola, con el brief del formato, cuando se aprueba el evento.</span>';
    } else {
      box.style.display = 'none';
      box.innerHTML = '';
    }
  }

  // Botones de cambio de estado según el estado actual.
  function renderAcciones(e) {
    var box = $('e-acciones');
    if (!e) { box.innerHTML = ''; return; }
    function b(act, txt, cls) { return '<button type="button" class="' + (cls || 'btn-secondary') + '" data-act="' + act + '">' + txt + '</button>'; }
    var h = '';
    switch (e.estado) {
      case 'radicada': h = b('est-en_revision', '▶ Poner en revisión') + b('est-aprobada', '✅ Aprobar', 'btn-confirm') + b('motivo-rechazar', '❌ Rechazar', 'btn-danger') + b('motivo-cancelar', '🚫 Cancelar evento'); break;
      case 'en_revision': h = b('est-aprobada', '✅ Aprobar', 'btn-confirm') + b('motivo-rechazar', '❌ Rechazar', 'btn-danger') + b('motivo-cancelar', '🚫 Cancelar evento'); break;
      case 'aprobada': h = b('est-en_preparacion', '🛠 Pasar a preparación', 'btn-confirm') + b('est-realizada', '✔ Marcar realizado') + b('motivo-cancelar', '🚫 Cancelar evento'); break;
      case 'en_preparacion': h = b('est-realizada', '✔ Marcar realizado', 'btn-confirm') + b('est-aprobada', '↩ Volver a Aprobada') + b('motivo-cancelar', '🚫 Cancelar evento'); break;
      case 'realizada': h = b('est-cerrada', '🔒 Cerrar evento', 'btn-confirm') + b('est-en_preparacion', '↩ Volver a preparación') + b('motivo-cancelar', '🚫 Cancelar evento'); break;
      default: h = '';
    }
    box.innerHTML = h;
  }

  // ══════════════ Guardar / cambiar de estado ══════════════
  // Avisa en la campanita de Pedidos a quien hizo la solicitud. No bloquea ni deshace nada: si falla, el
  // cambio ya quedó guardado y solo se informa.
  async function avisarSolicitante(eventoId, evento, origen) {
    if (origen !== 'panel_pedidos') return;
    try {
      var r = await _sb.functions.invoke('notificar-evento-solicitante', { body: { evento_id: eventoId, evento: evento } });
      var ok = r && !r.error && r.data && r.data.ok;
      if (!ok) {
        var msg = '';
        try { var j = r.error && r.error.context ? await r.error.context.json() : null; msg = j && j.error ? j.error : ''; } catch (_e) { /* sin cuerpo */ }
        showToast('El cambio se guardó, pero no se pudo avisar al solicitante' + (msg ? ': ' + msg : ''), '#e67e22');
      }
    } catch (e) {
      showToast('El cambio se guardó, pero no se pudo avisar al solicitante', '#e67e22');
    }
  }

  async function guardarEvento() {
    var d = leerForm();
    if (!revisar(d)) return;
    var btn = $('e-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    var res, nuevoId = editId, etiqueta = editId ? 'Guardar cambios' : 'Registrar solicitud';
    if (editId) {
      var diff = diferencias(d);
      if (!Object.keys(diff).length) { btn.disabled = false; btn.textContent = etiqueta; showToast('No hay cambios que guardar'); return; }
      res = await _sb.from('mercadeo_eventos').update(diff).eq('id', editId).select('id');
      if (!res.error && (!res.data || !res.data.length)) res = { error: { message: 'No se guardó: no tienes permiso o el evento ya no existe', code: '42501' } };
    } else {
      var fila = {}; Object.keys(d).forEach(function (k) { if (k.charAt(0) !== '_') fila[k] = d[k]; });
      res = await _sb.from('mercadeo_eventos').insert(fila).select('id').single();
      if (!res.error) nuevoId = res.data.id;
    }
    btn.disabled = false; btn.textContent = etiqueta;
    if (res.error) { fail('guardar la solicitud', res.error); return; }
    if (!editId) await subirArchivos(nuevoId, $('e-files-nuevo').files);
    showToast(editId ? '✅ Solicitud actualizada' : '✅ Solicitud registrada como EV-' + nuevoId);
    MODAL.close('evento-overlay');
    await cargar(false);
  }

  // Cambia de estado guardando a la vez lo editado en el formulario (una sola escritura, atómica).
  async function cambiarEstado(nuevo, extra) {
    var e = eventoById[editId];
    if (!e) return;
    var d = leerForm();
    if (!revisar(d)) return;
    if (nuevo === 'cerrada') {
      if (!d.bd_asistentes_fecha && !d.bd_no_aplica) {
        showToast('Para cerrar el evento registra la fecha en que llegó la base de datos de asistentes, o márcala como «no aplica»', '#e74c3c');
        return;
      }
    }
    if (nuevo === 'aprobada' && ESTADO_RANK[e.estado] <= 2) {
      var aviso = e.extemporanea ? '\n\n⚠ Esta solicitud llegó con ' + e.dias_anticipacion + ' días de anticipación (la política pide ' + DIAS_MINIMOS + ').' : '';
      if (!confirm('¿Aprobar el evento «' + e.nombre + '»?\n\nSe creará sola una tarea tipo Evento en el Tablero con los materiales y la logística pedidos.' + aviso)) return;
    }
    if (nuevo === 'cerrada' && !confirm('¿Cerrar el evento «' + e.nombre + '»? Un evento cerrado ya no se puede modificar.')) return;
    var diff = diferencias(d);
    diff.estado = nuevo;
    if (extra) Object.keys(extra).forEach(function (k) { diff[k] = extra[k]; });
    var res = await _sb.from('mercadeo_eventos').update(diff).eq('id', e.id).select('id');
    if (res.error || !res.data || !res.data.length) {
      if (res.error) fail('cambiar el estado', res.error); else showToast('No se pudo cambiar el estado: no tienes permiso o el evento ya no existe', '#e74c3c');
      return false;
    }
    var origen = e.origen, id = e.id;
    showToast(nuevo === 'aprobada' ? '✅ Evento aprobado; se creó la tarea en el Tablero' : '✅ Estado: ' + ESTADO_T[nuevo]);
    MODAL.close('motivo-overlay');
    MODAL.close('evento-overlay');
    avisarSolicitante(id, nuevo === 'rechazada' ? 'rechazo' : 'estado', origen);
    await cargar(false);
    return true;
  }

  // ── Rechazar / cancelar (motivo obligatorio) ──
  function abrirMotivo(modo) {
    var e = eventoById[editId];
    if (!e) return;
    motivoModo = modo;
    var rech = modo === 'rechazar';
    $('motivo-titulo').textContent = rech ? '❌ Rechazar solicitud' : '🚫 Cancelar evento';
    $('m-detalle').textContent = refEv(e) + ' · ' + e.nombre;
    $('m-label').textContent = rech ? 'Motivo del rechazo *' : 'Motivo de la cancelación *';
    $('m-ayuda').textContent = rech
      ? 'El solicitante recibe un aviso con este motivo' + (e.origen === 'panel_pedidos' ? ' y podrá corregir la solicitud y reenviarla desde Pedidos' : '') + '. El rechazo es definitivo para esta solicitud.'
      : 'La cancelación es definitiva' + (tareaDeEvento[e.id] ? ' y cancela también la tarea #' + tareaDeEvento[e.id].id + ' del Tablero si sigue abierta' : '') + '.';
    $('m-confirmar').textContent = rech ? '❌ Rechazar' : '🚫 Cancelar evento';
    $('m-motivo').value = '';
    $('m-confirmar').disabled = false;
    MODAL.open('motivo-overlay', 'm-motivo');
  }

  async function confirmarMotivo() {
    var motivo = $('m-motivo').value.trim();
    if (motivo.length < 3) { showToast('Escribe el motivo (mínimo 3 caracteres)', '#e74c3c'); return; }
    var btn = $('m-confirmar');
    btn.disabled = true;
    var ok;
    if (motivoModo === 'rechazar') ok = await cambiarEstadoSimple('rechazada', { motivo_rechazo: motivo });
    else ok = await cambiarEstadoSimple('cancelada', { motivo_cancelacion: motivo });
    if (!ok) btn.disabled = false;
  }

  // Rechazar / cancelar no arrastra lo editado en el formulario: solo cambia el estado con su motivo.
  async function cambiarEstadoSimple(nuevo, campos) {
    var e = eventoById[editId];
    if (!e) return false;
    var upd = { estado: nuevo };
    Object.keys(campos).forEach(function (k) { upd[k] = campos[k]; });
    var res = await _sb.from('mercadeo_eventos').update(upd).eq('id', e.id).select('id');
    if (res.error || !res.data || !res.data.length) {
      if (res.error) fail('cambiar el estado', res.error); else showToast('No se pudo cambiar el estado: no tienes permiso o el evento ya no existe', '#e74c3c');
      return false;
    }
    showToast(nuevo === 'rechazada' ? '✅ Solicitud rechazada' + (e.origen === 'panel_pedidos' ? '; se avisará al solicitante' : '') : '✅ Evento cancelado');
    var origen = e.origen, id = e.id;
    MODAL.close('motivo-overlay');
    MODAL.close('evento-overlay');
    avisarSolicitante(id, nuevo === 'rechazada' ? 'rechazo' : 'estado', origen);
    await cargar(false);
    return true;
  }

  async function eliminarEvento() {
    if (!editId || !esAdmin) return;
    var e = eventoById[editId];
    if (!confirm('¿Eliminar definitivamente ' + (e ? refEv(e) + ' «' + e.nombre + '»' : 'el evento') + '? Se borran también sus comentarios, adjuntos e historial. Normalmente conviene cancelarlo en lugar de eliminarlo.')) return;
    var ad = await _sb.from('mercadeo_evento_adjuntos').select('storage_path').eq('evento_id', editId);
    if (!ad.error && ad.data && ad.data.length) {
      await _sb.storage.from('mercadeo-adjuntos').remove(ad.data.map(function (a) { return a.storage_path; }));
    }
    var res = await _sb.from('mercadeo_eventos').delete().eq('id', editId).select('id');
    if (res.error) { fail('eliminar el evento', res.error); return; }
    if (!res.data || !res.data.length) { showToast('No se eliminó: solo un administrador puede borrar eventos', '#e74c3c'); return; }
    showToast('🗑 Evento eliminado');
    MODAL.close('evento-overlay');
    await cargar(false);
  }

  // ══════════════ Adjuntos y bitácora ══════════════
  function nombreSeguro(n) { return String(n).replace(/[^a-zA-Z0-9._-]/g, '_'); }

  async function subirArchivos(eventoId, files) {
    var ok = 0, errores = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > MAX_ARCHIVO) { errores.push(f.name + ' (supera 25 MB)'); continue; }
      var path = 'evento_' + eventoId + '/' + Date.now() + '-' + i + '-' + nombreSeguro(f.name);
      var up = await _sb.storage.from('mercadeo-adjuntos').upload(path, f, { cacheControl: '3600', upsert: false });
      if (up.error) { errores.push(f.name + ' (' + errMsg(up.error) + ')'); continue; }
      var ins = await _sb.from('mercadeo_evento_adjuntos').insert({ evento_id: eventoId, storage_path: path, nombre_original: f.name, tipo_mime: f.type || null, tamano_bytes: f.size, subido_por: miId });
      if (ins.error) { await _sb.storage.from('mercadeo-adjuntos').remove([path]); errores.push(f.name + ' (' + errMsg(ins.error) + ')'); continue; }
      ok++;
    }
    if (errores.length) showToast('No se pudo subir: ' + errores.join(', '), '#e74c3c');
    else if (ok) showToast('✅ ' + ok + ' archivo(s) adjuntado(s)');
    return ok;
  }

  function fmtTam(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((b || 0) / 1024)) + ' KB'; }

  async function cargarDetalle(id) {
    var rs = await Promise.all([
      _sb.from('mercadeo_evento_adjuntos').select('*').eq('evento_id', id).order('id', { ascending: true }),
      _sb.from('mercadeo_evento_bitacora').select('*').eq('evento_id', id).order('id', { ascending: false }),
    ]);
    if (editId !== id) return;   // se cerró o cambió de evento mientras cargaba
    if (rs[0].error || rs[1].error) { $('e-bitacora').innerHTML = '<div class="mk-warn">No se pudo cargar el historial: ' + esc(errMsg(rs[0].error || rs[1].error)) + '</div>'; return; }
    var ads = rs[0].data;
    $('e-adjuntos').innerHTML = ads.length ? ads.map(function (a) {
      return '<div class="adjunto-item"><span>📎 ' + esc(a.nombre_original || 'archivo') + ' <span class="tag">' + esc(fmtTam(a.tamano_bytes)) + '</span>' +
        (a.subido_por_nombre && !a.subido_por ? ' <span class="tag">' + esc(a.subido_por_nombre) + '</span>' : '') + '</span>' +
        '<span class="mk-actions"><button class="btn-ver" data-act="adj-abrir" data-path="' + esc(a.storage_path) + '">Abrir</button>' +
        '<button class="btn-danger" data-act="adj-eliminar" data-id="' + esc(a.id) + '" data-path="' + esc(a.storage_path) + '" aria-label="Eliminar adjunto">🗑</button></span></div>';
    }).join('') : '<div class="mk-sin">Sin adjuntos.</div>';
    $('e-bitacora').innerHTML = rs[1].data.length ? rs[1].data.map(evHtml).join('') : '<div class="mk-sin">Sin actividad registrada.</div>';
  }

  // ══════════════ Checklist de actividades (migración 0036) ══════════════
  // El gestor agrega varias actividades para cumplir los requerimientos del evento: texto libre, casilla de «hecha», responsable del equipo,
  // fecha límite y notas. Cada cambio se guarda al instante (no depende del botón Guardar del formulario). Solo se escribe mientras el evento
  // está En revisión … Realizada (la BD lo exige); después queda de solo lectura. El solicitante ve únicamente el avance, en Pedidos.
  var CHK_ESTADOS = ['en_revision', 'aprobada', 'en_preparacion', 'realizada'];
  var checklist = [], equipo = [], chkOcupado = false;

  function chkEditable(e) { return !!e && CHK_ESTADOS.indexOf(e.estado) >= 0; }
  function etiquetaDe(catalogo, k) { var c = catalogo.filter(function (x) { return x[0] === k; })[0]; return c ? c[1] : k; }

  async function cargarChecklist(id) {
    checklist = [];
    renderChecklist();
    if (!id) return;
    var rs = await Promise.all([
      _sb.from('mercadeo_evento_checklist').select('*').eq('evento_id', id).order('id', { ascending: true }),
      equipo.length ? Promise.resolve({ data: equipo }) : _sb.rpc('list_equipo_mercadeo'),
    ]);
    if (editId !== id) return;
    if (rs[0].error) { $('e-chk-aviso').innerHTML = '<span class="mk-warn">No se pudo cargar el checklist: ' + esc(errMsg(rs[0].error)) + '</span>'; return; }
    checklist = rs[0].data;
    if (!rs[1].error && rs[1].data) equipo = rs[1].data;
    renderChecklist();
  }

  function filaChk(a, edit) {
    var dis = edit ? '' : ' disabled';
    var resp = '<option value="">Sin responsable</option>' + equipo.filter(function (u) { return u.activo || u.id === a.responsable_id; })
      .map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.id === a.responsable_id ? ' selected' : '') + '>' + esc(u.nombre) + '</option>'; }).join('');
    var pie = a.hecha
      ? '✔ Hecha por ' + esc(a.hecha_por_nombre || '—') + (a.hecha_en ? ' el ' + esc(fmtDateTime(a.hecha_en)) : '')
      : 'Agregada por ' + esc(a.creado_por_nombre || '—') + (a.creado_en ? ' el ' + esc(fmtDateTime(a.creado_en)) : '');
    return '<div class="ev-chk-item' + (a.hecha ? ' hecha' : '') + '" data-chk="' + esc(a.id) + '">' +
      '<div class="ev-chk-fila"><input type="checkbox" data-f="hecha"' + (a.hecha ? ' checked' : '') + dis + ' aria-label="Marcar la actividad como hecha">' +
      '<input class="ef ev-chk-desc" data-f="descripcion" maxlength="300" value="' + esc(a.descripcion) + '"' + dis + ' aria-label="Actividad">' +
      (edit ? '<button type="button" class="btn-danger" data-act="chk-eliminar" data-id="' + esc(a.id) + '" aria-label="Eliminar actividad">🗑</button>' : '') + '</div>' +
      '<div class="ev-chk-meta"><select class="ef" data-f="responsable_id"' + dis + ' aria-label="Responsable">' + resp + '</select>' +
      '<input class="ef" type="date" data-f="fecha_limite" value="' + esc(a.fecha_limite || '') + '"' + dis + ' aria-label="Fecha límite"></div>' +
      '<textarea class="ef ev-chk-notas" data-f="notas" rows="2" maxlength="1000" placeholder="Notas (texto libre)" aria-label="Notas"' + dis + '>' + esc(a.notas || '') + '</textarea>' +
      '<div class="ev-chk-pie">' + pie + (a.origen_clave ? ' · sugerida desde lo solicitado' : '') + '</div></div>';
  }

  function resumenChk() {
    var hechas = checklist.filter(function (a) { return a.hecha; }).length, total = checklist.length;
    $('e-chk-resumen').textContent = total ? hechas + ' de ' + total + ' hechas' : 'Sin actividades todavía';
    $('e-chk-bar').style.width = total ? Math.round(hechas / total * 100) + '%' : '0%';
  }

  function renderChecklist() {
    var e = editId ? eventoById[editId] : null, edit = chkEditable(e);
    $('e-chk-nuevo').style.display = e ? 'none' : '';
    $('e-chk-box').style.display = e ? '' : 'none';
    if (!e) return;
    resumenChk();
    $('e-chk-lista').innerHTML = checklist.length ? checklist.map(function (a) { return filaChk(a, edit); }).join('')
      : '<div class="mk-sin">Aún no hay actividades. Agrégalas arriba o usa «Sugerir desde lo solicitado».</div>';
    $('e-chk-nueva').disabled = $('e-chk-agregar').disabled = $('e-chk-sugerir').disabled = !edit;
    $('e-chk-aviso').textContent = edit ? '' : (e.estado === 'radicada'
      ? 'Pasa el evento a «En revisión» para armar el checklist de actividades.'
      : 'El evento está «' + (ESTADO_T[e.estado] || e.estado) + '»: el checklist queda de solo lectura.');
  }

  async function agregarActividad() {
    var e = editId ? eventoById[editId] : null;
    if (!chkEditable(e) || chkOcupado) return;
    var txt = $('e-chk-nueva').value.trim().replace(/\s+/g, ' ');
    if (txt.length < 3) { showToast('Describe la actividad (mínimo 3 caracteres)', '#e74c3c'); $('e-chk-nueva').focus(); return; }
    chkOcupado = true;
    var res = await _sb.from('mercadeo_evento_checklist').insert({ evento_id: e.id, descripcion: txt }).select('*').single();
    chkOcupado = false;
    if (res.error) { fail('agregar la actividad', res.error); return; }
    if (editId !== e.id) return;
    checklist.push(res.data);
    $('e-chk-nueva').value = '';
    renderChecklist();
    $('e-chk-nueva').focus();
  }

  // Una actividad por cada canal, material y logística que pidió el solicitante (y sus «Otros»); solo las que aún no están.
  function sugerenciasChk(e) {
    var out = [];
    var add = function (clave, prefijo, texto) { out.push({ clave: clave, texto: (prefijo + texto).slice(0, 300) }); };
    (e.canales || []).forEach(function (k) { add('canal:' + k, 'Canal de promoción: ', etiquetaDe(CANALES, k)); });
    if (e.canales_otro) add('canal_otro', 'Canal de promoción (otro): ', e.canales_otro);
    (e.materiales || []).forEach(function (k) { add('material:' + k, 'Material: ', etiquetaDe(MATERIALES, k)); });
    if (e.materiales_otro) add('material_otro', 'Material (otro): ', e.materiales_otro);
    (e.logistica || []).forEach(function (k) { add('logistica:' + k, 'Logística: ', etiquetaDe(LOGISTICA, k)); });
    if (e.logistica_otro) add('logistica_otro', 'Logística (otra): ', e.logistica_otro);
    return out;
  }

  async function sugerirActividades() {
    var e = editId ? eventoById[editId] : null;
    if (!chkEditable(e) || chkOcupado) return;
    var todas = sugerenciasChk(e);
    if (!todas.length) { showToast('El solicitante no marcó canales, materiales ni logística'); return; }
    var existentes = {}; checklist.forEach(function (a) { if (a.origen_clave) existentes[a.origen_clave] = true; });
    var nuevas = todas.filter(function (s) { return !existentes[s.clave]; });
    if (!nuevas.length) { showToast('Ya están todas las actividades sugeridas'); return; }
    chkOcupado = true;
    var res = await _sb.from('mercadeo_evento_checklist')
      .insert(nuevas.map(function (s) { return { evento_id: e.id, descripcion: s.texto, origen_clave: s.clave }; })).select('*');
    chkOcupado = false;
    if (res.error) { fail('crear las actividades sugeridas', res.error); return; }
    if (editId !== e.id) return;
    checklist = checklist.concat(res.data).sort(function (a, b) { return a.id - b.id; });
    renderChecklist();
    showToast('✅ Se agregaron ' + res.data.length + ' actividad' + (res.data.length === 1 ? '' : 'es') + ' sugerida' + (res.data.length === 1 ? '' : 's'));
  }

  async function guardarActividad(id, campo, el) {
    var a = checklist.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    if (chkOcupado) { renderChecklist(); showToast('Se está guardando otro cambio; vuelve a intentarlo'); return; }
    var val;
    if (campo === 'hecha') val = el.checked;
    else if (campo === 'descripcion') {
      val = el.value.trim().replace(/\s+/g, ' ');
      if (val.length < 3) { showToast('La actividad necesita al menos 3 caracteres', '#e74c3c'); el.value = a.descripcion; return; }
    } else if (campo === 'responsable_id' || campo === 'fecha_limite') val = el.value || null;
    else val = el.value.trim();   // notas
    if (val === (a[campo] === undefined ? null : a[campo]) || (campo === 'notas' && val === (a.notas || ''))) return;
    var upd = {}; upd[campo] = val;
    chkOcupado = true;
    var res = await _sb.from('mercadeo_evento_checklist').update(upd).eq('id', id).select('*').maybeSingle();
    chkOcupado = false;
    if (res.error || !res.data) {
      if (res.error) fail('guardar la actividad', res.error); else showToast('No se guardó: no tienes permiso o la actividad ya no existe', '#e74c3c');
      renderChecklist();
      return;
    }
    checklist = checklist.map(function (x) { return x.id === id ? res.data : x; });
    // «Hecha» cambia el aspecto de la fila y el avance; lo demás se guarda sin redibujar (para no quitarle el foco a quien sigue escribiendo).
    if (campo === 'hecha') renderChecklist(); else resumenChk();
  }

  async function eliminarActividad(id) {
    var a = checklist.filter(function (x) { return x.id === id; })[0];
    if (!a || chkOcupado || !confirm('¿Eliminar la actividad «' + a.descripcion + '»?')) return;
    chkOcupado = true;
    var res = await _sb.from('mercadeo_evento_checklist').delete().eq('id', id).select('id');
    chkOcupado = false;
    if (res.error || !res.data || !res.data.length) {
      if (res.error) fail('eliminar la actividad', res.error); else showToast('No se eliminó: no tienes permiso o ya no existe', '#e74c3c');
      return;
    }
    checklist = checklist.filter(function (x) { return x.id !== id; });
    renderChecklist();
  }

  // PDF con todas las especificaciones de la solicitud (lo ya guardado), su estado y el checklist de actividades (js/panel/eventos-pdf.js).
  async function verPdf(id) {
    var e = id ? eventoById[id] : null;
    if (!e) return;
    // La pestaña se abre ya, dentro del clic, para que el navegador no la bloquee; se llena cuando el PDF está listo.
    var w = window.open('', '_blank');
    if (w) { try { w.document.title = 'PDF ' + refEv(e); w.document.body.innerHTML = '<p style="font-family:sans-serif;padding:24px;color:#4a5568">Generando el PDF…</p>'; } catch (_e) { /* sin acceso a la pestaña */ } }
    try {
      var rs = await Promise.all([
        _sb.from('mercadeo_evento_checklist').select('*').eq('evento_id', id).order('id', { ascending: true }),
        _sb.from('mercadeo_evento_adjuntos').select('nombre_original,tamano_bytes').eq('evento_id', id).order('id', { ascending: true }),
        equipo.length ? Promise.resolve({ data: equipo }) : _sb.rpc('list_equipo_mercadeo'),
      ]);
      if (rs[0].error) throw rs[0].error;
      if (rs[1].error) throw rs[1].error;
      if (!rs[2].error && rs[2].data) equipo = rs[2].data;
      var perfil = AUTH.getProfile() || {};
      var doc = EVENTO_PDF.solicitud({
        e: e,
        cat: { OBJETIVOS: OBJETIVOS, CANALES: CANALES, MATERIALES: MATERIALES, LOGISTICA: LOGISTICA },
        estado: ESTADO_T[e.estado] || e.estado,
        empresa: etiquetaEmpresa(e.empresa) + (e.empresa === 'OTROS' && e.empresa_otra ? ': ' + e.empresa_otra : ''),
        checklist: rs[0].data, adjuntos: rs[1].data, equipo: equipo,
        generadoPor: perfil.nombre || perfil.email || '', ahora: new Date(),
      });
      if (w) w.location.href = doc.output('bloburl');
      else doc.save(EVENTO_PDF.nombreArchivo(e));   // el navegador bloqueó la pestaña: se descarga
    } catch (err) {
      if (w) w.close();
      fail('generar el PDF', err);
    }
  }

  function listaTxt(arr) { return (arr && arr.length) ? arr.map(esc).join(', ') : '—'; }
  function valorCampo(k, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'modalidad') return esc(MODALIDAD[v] || v);
    if (k === 'empresa') return esc(etiquetaEmpresa(v));
    if (k.indexOf('fecha') === 0 || k === 'bd_asistentes_fecha') return esc(fmtDateOnly(v));
    if (k === 'hora_inicio' || k === 'hora_fin') return esc(hhmm(v));
    if (k === 'presupuesto_estimado' || k === 'total_solicitado') return esc(fmtMoney(v));
    if (k === 'bd_no_aplica') return v ? 'sí' : 'no';
    return esc(v);
  }
  function evTexto(ev) {
    var d = ev.detalle || {};
    switch (ev.tipo_evento) {
      case 'creacion':
        if (d.origen === 'panel_pedidos') {
          return 'Solicitud recibida desde Pedidos' + (d.numero_origen ? ' (<strong>SE-' + esc(d.numero_origen) + '</strong>)' : '') +
            (d.enviado_por ? ' · enviada por <strong>' + esc(d.enviado_por) + '</strong>' : '') +
            (d.aprobada_origen_por ? ' · aprobada en Pedidos por <strong>' + esc(d.aprobada_origen_por) + '</strong>' : '') +
            (d.extemporanea ? ' · ⚠ con ' + esc(d.dias_anticipacion) + ' días de anticipación' : '');
        }
        return 'Registró la solicitud' + (d.extemporanea ? ' · ⚠ con ' + esc(d.dias_anticipacion) + ' días de anticipación' : '');
      case 'cambio_estado': return 'Cambió el estado: <strong>' + esc(ESTADO_T[d.de] || d.de) + '</strong> → <strong>' + esc(ESTADO_T[d.a] || d.a) + '</strong>' +
        (d.motivo ? ' · <strong>Motivo:</strong> ' + esc(d.motivo) : '');
      case 'cambio_datos':
        return 'Modificó: ' + Object.keys(d).map(function (k) {
          var v = d[k], nombre = CAMPO_T[k] || k;
          if (v && typeof v === 'object' && 'de' in v) return nombre + ' (' + valorCampo(k, v.de) + ' → ' + valorCampo(k, v.a) + ')';
          return nombre;
        }).join('; ');
      case 'comentario': return '💬 ' + esc(d.texto);
      case 'respuesta_solicitante': return '📣 Respuesta al solicitante: ' + esc(d.texto);
      case 'observacion_solicitante':
        return '💬 <strong>Observación ' + (d.como === 'aprobador' ? 'del aprobador' : 'del solicitante') + ':</strong> <span style="white-space:pre-wrap">' + esc(d.texto) + '</span>';
      case 'actividad': return '☑️ Actividad ' + ({ agregada: 'agregada', completada: 'completada ✔', reabierta: 'reabierta', eliminada: 'eliminada' }[d.accion] || esc(d.accion)) + ': ' + esc(d.texto);
      case 'adjunto_agregado': return 'Adjuntó el archivo <strong>' + esc(d.nombre) + '</strong>';
      case 'adjunto_eliminado': return 'Eliminó el adjunto <strong>' + esc(d.nombre) + '</strong>';
      case 'tarea_creada': return '🗂️ Se creó la tarea <a href="mercadeo.html?tarea=' + encodeURIComponent(d.tarea_id) + '"><strong>#' + esc(d.tarea_id) + '</strong></a> en el Tablero';
      default: return esc(ev.tipo_evento);
    }
  }
  function evHtml(ev) {
    return '<div class="bitacora-item"><div>' + evTexto(ev) + '</div><div class="meta">' + esc(ev.usuario_nombre || 'Sistema') + ' · ' + esc(fmtDateTime(ev.creado_en)) + '</div></div>';
  }

  async function comentar() {
    var txt = $('e-coment-txt').value.trim();
    if (!txt) { showToast('Escribe el comentario', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_evento_bitacora').insert({ evento_id: editId, tipo_evento: 'comentario', detalle: { texto: txt } });
    if (res.error) { fail('comentar', res.error); return; }
    $('e-coment-txt').value = '';
    cargarDetalle(editId);
  }

  // Mensaje de Mercadeo que el solicitante ve en «Mis solicitudes» de panel-pedidos.
  async function responder() {
    var txt = $('e-resp-txt').value.trim();
    if (!txt) { showToast('Escribe la respuesta', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_evento_bitacora').insert({ evento_id: editId, tipo_evento: 'respuesta_solicitante', detalle: { texto: txt } });
    if (res.error) { fail('responder al solicitante', res.error); return; }
    $('e-resp-txt').value = '';
    showToast('✅ Respuesta enviada al solicitante');
    cargarDetalle(editId);
    avisarSolicitante(editId, 'respuesta', 'panel_pedidos');
  }

  async function abrirAdjunto(path) {
    var res = await _sb.storage.from('mercadeo-adjuntos').createSignedUrl(path, 3600);
    if (res.error || !res.data) { fail('abrir el archivo', res.error || { message: 'sin URL' }); return; }
    window.open(res.data.signedUrl, '_blank', 'noopener');
  }

  async function eliminarAdjunto(id, path) {
    if (!confirm('¿Eliminar este adjunto?')) return;
    var res = await _sb.from('mercadeo_evento_adjuntos').delete().eq('id', Number(id)).select('id');
    if (res.error) { fail('eliminar el adjunto', res.error); return; }
    if (!res.data || !res.data.length) { showToast('No se eliminó el adjunto', '#e74c3c'); return; }
    await _sb.storage.from('mercadeo-adjuntos').remove([path]);
    cargarDetalle(editId);
  }

  // ══════════════ Eventos de la página ══════════════
  var ACCIONES = {
    'reintentar': function () { $('estado-carga').textContent = 'Cargando…'; cargar(true); },
    'limpiar': function () {
      ['f-empresa', 'f-origen', 'f-desde', 'f-hasta', 'f-buscar'].forEach(function (k) { $(k).value = ''; });
      $('f-estado').value = 'abiertos'; $('f-ext').checked = false; render();
    },
    'evento-nuevo': function () { abrirEvento(null); },
    'paso-ir': function (id) { mostrarPaso(Number(id), true); },
    'paso-ant': function () { mostrarPaso(paso - 1, true); },
    'paso-sig': function () { mostrarPaso(paso + 1, true); },
    'evento-abrir': function (id) { abrirEvento(Number(id)); },
    'evento-pdf': function (id) { verPdf(Number(id) || editId); },   // desde la fila (con id) o desde el pie del modal (evento abierto)
    'chk-agregar': function () { agregarActividad(); },
    'chk-sugerir': function () { sugerirActividades(); },
    'chk-eliminar': function (id) { eliminarActividad(Number(id)); },
    'evento-guardar': guardarEvento,
    'evento-eliminar': eliminarEvento,
    'cerrar-modal': function () { MODAL.close('evento-overlay'); },
    'motivo-rechazar': function () { abrirMotivo('rechazar'); },
    'motivo-cancelar': function () { abrirMotivo('cancelar'); },
    'motivo-confirmar': confirmarMotivo,
    'motivo-cerrar': function () { MODAL.close('motivo-overlay'); },
    'gasto-agregar': function () {
      $('e-desglose').insertAdjacentHTML('beforeend', filaGastoHtml('', ''));
      var filas = $('e-desglose').querySelectorAll('.ev-g-con');
      if (filas.length) filas[filas.length - 1].focus();
    },
    'gasto-quitar': function (id, el) { var f = el.closest('.ev-gasto'); if (f) f.remove(); actualizarPresupuesto(); },
    'comentar': comentar,
    'responder': responder,
    'adj-abrir': function (id, el) { abrirAdjunto(el.getAttribute('data-path')); },
    'adj-eliminar': function (id, el) { eliminarAdjunto(id, el.getAttribute('data-path')); },
  };
  ['en_revision', 'aprobada', 'en_preparacion', 'realizada', 'cerrada'].forEach(function (est) {
    ACCIONES['est-' + est] = function () { cambiarEstado(est); };
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    // El botón «Abrir» de la fila ya está dentro de una fila clicable: no se procesa dos veces.
    if (el.tagName === 'TR' && e.target.closest('button')) return;
    var fn = ACCIONES[el.getAttribute('data-act')];
    if (fn) fn(el.getAttribute('data-id'), el, e);
  });

  // Filtros en vivo
  ['f-empresa', 'f-estado', 'f-origen', 'f-desde', 'f-hasta', 'f-ext'].forEach(function (id) { $(id).addEventListener('change', render); });
  $('f-buscar').addEventListener('input', render);

  // Formulario: reglas en vivo
  $('e-modalidad').addEventListener('change', actualizarModalidad);
  $('e-empresa').addEventListener('change', actualizarEmpresaOtra);
  // Listas con «Otro/a» y lugar (alineados con Solicitudes de Eventos de panel-pedidos)
  Object.keys(LISTAS).forEach(function (k) {
    listaLlenar(LISTAS[k]);
    $(LISTAS[k].sel).addEventListener('change', function () { listaActualizar(LISTAS[k]); });
  });
  setupGeoAutocomplete($('e-depto'), $('e-municipio'));
  $('e-municipio').addEventListener('change', canonizarGeo);
  $('e-depto').addEventListener('change', canonizarGeo);
  ['e-fecha', 'e-radicacion'].forEach(function (id) { $(id).addEventListener('change', actualizarAnticipacion); });
  ['e-presupuesto', 'e-solicitado'].forEach(function (id) { $(id).addEventListener('input', actualizarPresupuesto); });
  $('e-desglose').addEventListener('input', actualizarPresupuesto);
  // Checklist: cada campo se guarda al cambiarlo; Enter en el cuadro de «nueva actividad» la agrega.
  $('e-chk-lista').addEventListener('change', function (ev) {
    var el = ev.target, campo = el.getAttribute('data-f'), item = el.closest ? el.closest('.ev-chk-item') : null;
    if (campo && item) guardarActividad(Number(item.getAttribute('data-chk')), campo, el);
  });
  $('e-chk-nueva').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); agregarActividad(); } });
  $('e-bd-na').addEventListener('change', function () { $('e-bd-fecha').disabled = this.checked; if (this.checked) $('e-bd-fecha').value = ''; });
  $('e-files').addEventListener('change', async function () {
    if (!editId || !this.files.length) return;
    await subirArchivos(editId, this.files);
    this.value = '';
    cargarDetalle(editId);
  });
  MODAL.onClose = function (id) { if (id === 'evento-overlay') { editId = null; orig = null; } };

  // Actualización en vivo entre las personas del equipo
  try {
    _sb.channel('mercadeo-eventos').on('postgres_changes', { event: '*', schema: 'public', table: 'mercadeo_eventos' }, programarRecarga).subscribe();
  } catch (e) { /* sin Realtime: queda la recarga al volver a la pestaña */ }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) programarRecarga(); });

  await cargar(true);

  // Enlace directo desde la campanita: ?evento=<id> abre ese evento.
  var eventoParam = Number(new URLSearchParams(location.search).get('evento'));
  if (eventoParam && eventoById[eventoParam]) {
    if (FINALES.indexOf(eventoById[eventoParam].estado) >= 0) { $('f-estado').value = ''; render(); }
    abrirEvento(eventoParam);
  }
})();
