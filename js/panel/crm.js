// ══════════════════════════════════════════════════════════════
// CRM de Mercadeo — Leads + Actividades (calendario maestro) + Presupuesto + Indicadores
// ══════════════════════════════════════════════════════════════
// Migrado desde panel-pedidos (crm.js) y reescrito para este panel: cliente Supabase
// directo, sin apiGet/apiPost ni notificaciones, sin rol "comercial" (los comerciales no
// usan este panel: "asignado a" es el catálogo mercadeo_comerciales y mercadeo registra el
// seguimiento). Las transiciones de estado y las fechas (calificación, asignación, cierre,
// seguimiento) las sella la BD (triggers de la migración 0013), no el navegador.
//
// Leads (MKT-P-10): captura -> calificación -> asignación (48 h) -> seguimiento -> cierre
// (convertido / perdido / cierre automático a 90 días sin movimiento, cron de la BD).
// Actividades: eventos/digital/POP/trade con presupuesto; con "aprobada en calendario" forman
// el calendario maestro (base de las reglas de "urgente fuera de calendario" del Tablero).
// Presupuesto: cabecera por empresa/rubro/periodo + gastos; lo ejecutado se suma en el cliente.
(async function () {
  await AUTH.authReady;
  if (!AUTH.getProfile() || !AUTH.hasModule('mercadeo')) return;

  // ── Catálogos (valores en BD = códigos ASCII; aquí las etiquetas) ──
  var ORIGEN = { evento: 'Evento', digital: 'Digital', distribuidor: 'Distribuidor' };
  var CALIF = { caliente: 'Caliente', tibio: 'Tibio', frio: 'Frío' };
  var ESTADO_LEAD = { nuevo: 'Nuevo', calificado: 'Calificado', asignado: 'Asignado', en_seguimiento: 'En seguimiento', cerrado: 'Cerrado' };
  var TIPO_ACT = { eventos: 'Eventos', digital: 'Digital', pop: 'POP', trade: 'Trade', diseno: 'Diseño', otro: 'Otro' };
  var ESTADO_ACT = { planificada: 'Planificada', en_ejecucion: 'En ejecución', cerrada: 'Cerrada', cancelada: 'Cancelada' };
  var TIPO_SEG = { llamada: 'Llamada', visita: 'Visita', email: 'Email', whatsapp: 'WhatsApp', reunion: 'Reunión', otro: 'Otro' };
  var COLOR_CALIF = { caliente: '#c0392b', tibio: '#d97706', frio: '#2563eb' };
  var COLOR_ESTADO_LEAD = { nuevo: '#718096', calificado: '#7c3aed', asignado: '#2563eb', en_seguimiento: '#0891b2', cerrado: '#15803d' };
  var COLOR_TIPO = { eventos: '#c2410c', digital: '#2563eb', pop: '#7c3aed', trade: '#0891b2', diseno: '#be185d', otro: '#718096' };
  var COLOR_ESTADO_ACT = { planificada: '#718096', en_ejecucion: '#2563eb', cerrada: '#15803d', cancelada: '#c0392b' };
  var SIGLAS = EMPRESAS.map(function (e) { return e.sigla; });
  var MAX_CARGA = 500;

  // ── Estado ──
  var leads = [], seguimientos = [], actividades = [], presupuesto = [], gastos = [], comerciales = [], equipo = [];
  var leadById = {}, segPorLead = {}, actById = {}, presById = {}, gastosPorPres = {};
  var ctxId = null, cierreKind = null, tab = 'leads', actEditId = null, presEditId = null, presDetId = null;
  var filtroActividadId = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }

  // ── Presentación ──
  function badge(txt, color) { return '<span class="mk-badge" style="background:' + color + '">' + esc(txt) + '</span>'; }
  function kv(k, vHtml) { return '<div class="mk-kv"><span>' + k + '</span><span>' + vHtml + '</span></div>'; }
  function estadoBadge(l) { return badge(ESTADO_LEAD[l.estado] || l.estado, COLOR_ESTADO_LEAD[l.estado] || '#718096'); }
  function califBadge(l) { return l.calificacion ? badge(CALIF[l.calificacion] || l.calificacion, COLOR_CALIF[l.calificacion] || '#718096') : '<span class="mk-sin">sin calificar</span>'; }
  function empresaChips(arr) {
    arr = arr || [];
    if (SIGLAS.every(function (s) { return arr.indexOf(s) >= 0; })) return '<span class="sigla-badge" style="background:#1a5276;color:#fff">TODO EL HOLDING</span>';
    return arr.filter(function (s) { return SIGLAS.indexOf(s) >= 0; })
      .map(function (s) { return '<span class="sigla-badge sigla-' + s + '">' + s + '</span>'; }).join(' ') || '—';
  }
  function nombreEquipo(id) {
    if (!id) return null;
    var u = equipo.filter(function (x) { return x.id === id; })[0];
    return u ? u.nombre : null;
  }
  function nombreComercial(id) {
    if (!id) return null;
    var c = comerciales.filter(function (x) { return x.id === id; })[0];
    return c ? c.nombre : null;
  }
  function optsHtml(lista, vacio, sel) {
    return (vacio !== null ? '<option value="">' + esc(vacio) + '</option>' : '') + lista.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(sel) ? ' selected' : '') + '>' + esc(o.t) + '</option>';
    }).join('');
  }
  function btnBusy(btn, busy, txt) { if (!btn) return; btn.disabled = busy; if (txt) btn.textContent = txt; }
  function fail(accion, error) { showToast('Error al ' + accion + ': ' + errMsg(error), '#e74c3c'); }

  // ── Horas sin asignar (SLA de 48 h; horas corridas) ──
  function horasSinAsignar(l) {
    if (l.asignado_a || l.estado === 'cerrado') return null;
    var desde = l.fecha_calificacion || l.creado_en;
    if (!desde) return null;
    var ms = Date.now() - new Date(desde).getTime();
    return isNaN(ms) ? null : ms / 3600000;
  }
  function vencido48(l) { var h = horasSinAsignar(l); return h !== null && h > 48; }

  // ══════════════ Carga ══════════════
  async function cargar(primera) {
    try {
      var rs = await Promise.all([
        fetchAll('mercadeo_leads', '*', 'id'),
        fetchAll('mercadeo_leads_seguimiento', '*', 'id'),
        fetchAll('mercadeo_actividades', '*', 'id'),
        fetchAll('mercadeo_presupuesto', '*', 'id'),
        fetchAll('mercadeo_presupuesto_gastos', '*', 'id'),
        fetchAll('mercadeo_comerciales', '*', 'nombre'),
        _sb.rpc('list_equipo_mercadeo'),
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      leads = rs[0].data; seguimientos = rs[1].data; actividades = rs[2].data;
      presupuesto = rs[3].data; gastos = rs[4].data; comerciales = rs[5].data; equipo = rs[6].data || [];
    } catch (err) {
      if (primera) {
        $('estado-carga').innerHTML = 'No se pudieron cargar los datos: ' + esc(errMsg(err)) +
          '<br><button class="btn-primary" style="margin-top:12px" data-act="reintentar">Reintentar</button>';
      } else {
        showToast('Error al actualizar: ' + errMsg(err), '#e74c3c');
      }
      return false;
    }
    indexar();
    $('estado-carga').style.display = 'none';
    $('contenido').style.display = '';
    rellenarSelects();
    renderTodo();
    return true;
  }

  function indexar() {
    leadById = {}; leads.forEach(function (l) { leadById[l.id] = l; });
    segPorLead = {};
    seguimientos.forEach(function (s) { (segPorLead[s.lead_id] = segPorLead[s.lead_id] || []).push(s); });
    Object.keys(segPorLead).forEach(function (k) { segPorLead[k].sort(function (a, b) { return String(b.fecha).localeCompare(String(a.fecha)); }); });
    actById = {}; actividades.forEach(function (a) { actById[a.id] = a; });
    presById = {}; presupuesto.forEach(function (p) { presById[p.id] = p; });
    gastosPorPres = {};
    gastos.forEach(function (g) { (gastosPorPres[g.presupuesto_id] = gastosPorPres[g.presupuesto_id] || []).push(g); });
  }

  function comercialesActivos() { return comerciales.filter(function (c) { return c.activo; }); }
  function equipoActivo() { return equipo.filter(function (u) { return u.activo; }); }

  function rellenarSelects() {
    var opCom = comercialesActivos().map(function (c) { return { v: c.id, t: c.nombre }; });
    var fAsig = $('f-asig'), actual = fAsig.value;
    fAsig.innerHTML = optsHtml([{ v: 'sin', t: 'Sin asignar' }].concat(opCom), 'Todos', actual);
    $('nv-asignado').innerHTML = optsHtml(opCom, 'Sin asignar todavía', '');
    $('carga-asignado').innerHTML = optsHtml(opCom, 'Sin asignar todavía', '');

    var opAct = actividades.slice().sort(function (a, b) { return String(a.nombre).localeCompare(String(b.nombre)); })
      .map(function (a) { return { v: a.id, t: a.nombre }; });
    $('nv-actividad').innerHTML = optsHtml(opAct, 'Sin actividad vinculada', '');

    $('ac-responsable').innerHTML = optsHtml(equipoActivo().map(function (u) { return { v: u.id, t: u.nombre }; }), 'Sin asignar', '');

    var opEmp = SIGLAS.map(function (s) { return { v: s, t: s }; });
    var fpe = $('fp-empresa'), fpActual = fpe.value;
    fpe.innerHTML = optsHtml(opEmp, 'Todas', fpActual);
    $('pr-empresa').innerHTML = optsHtml(opEmp, null, SIGLAS[0]);
  }

  function renderTodo() {
    renderLeads(); renderActividades(); renderPresupuesto(); renderIndicadores();
    cambiarTab(tab);
    if (ctxId) { if (leadById[ctxId]) renderCtx(); else MODAL.close('ctx-overlay'); }
    if (presDetId) { if (presById[presDetId]) renderPresDetalle(); else MODAL.close('prd-overlay'); }
  }

  // ══════════════ Pestañas ══════════════
  function cambiarTab(t) {
    tab = t;
    ['leads', 'actividades', 'presupuesto', 'indicadores'].forEach(function (k) {
      $('tab-' + k).classList.toggle('active', k === t);
      $('tab-' + k).setAttribute('aria-selected', k === t ? 'true' : 'false');
      $('panel-' + k).style.display = k === t ? '' : 'none';
    });
  }

  // ══════════════ Leads ══════════════
  function filtrarLeads() {
    var est = $('f-estado').value, ori = $('f-origen').value, cal = $('f-calif').value, asig = $('f-asig').value;
    var q = norm($('f-txt').value);
    return leads.filter(function (l) {
      if (filtroActividadId && l.actividad_id !== filtroActividadId) return false;
      if (est && l.estado !== est) return false;
      if (ori && l.origen !== ori) return false;
      if (cal && l.calificacion !== cal) return false;
      if (asig === 'sin' && l.asignado_a) return false;
      if (asig && asig !== 'sin' && String(l.asignado_a) !== asig) return false;
      if (q && norm([l.nombre_contacto, l.empresa_contacto, l.producto_interes, l.municipio].join(' ')).indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderLeads() {
    var mes = today().slice(0, 7);
    $('s-nuevos').textContent = leads.filter(function (l) { return String(l.fecha_captura || '').slice(0, 7) === mes; }).length;
    $('s-vencidos').textContent = leads.filter(vencido48).length;
    $('s-seguimiento').textContent = leads.filter(function (l) { return l.estado === 'en_seguimiento'; }).length;
    var lim = Date.now() - 90 * 86400000;
    var asig90 = leads.filter(function (l) { return l.fecha_asignacion && new Date(l.fecha_asignacion).getTime() >= lim; });
    var conv90 = asig90.filter(function (l) { return l.resultado_cierre === 'convertido'; });
    $('s-conversion').textContent = asig90.length ? Math.round(conv90.length / asig90.length * 100) + '%' : '—';
    $('s-conversion-det').textContent = asig90.length ? conv90.length + ' de ' + asig90.length + ' leads asignados' : 'sin leads asignados en 90 días';

    $('f-act-chip').innerHTML = filtroActividadId && actById[filtroActividadId]
      ? '<span class="mk-chip">Actividad: ' + esc(actById[filtroActividadId].nombre) + ' <button data-act="quitar-filtro-actividad" aria-label="Quitar filtro de actividad">✕</button></span>' : '';

    var lista = filtrarLeads().slice().sort(function (a, b) { return b.id - a.id; });
    $('leads-ct').textContent = '(' + lista.length + (lista.length !== leads.length ? ' de ' + leads.length : '') + ')';
    if (!lista.length) {
      $('leads-body').innerHTML = '<tr><td colspan="9" class="empty">' + (leads.length ? 'Ningún lead coincide con los filtros.' : 'Aún no hay leads registrados.') + '</td></tr>';
      return;
    }
    $('leads-body').innerHTML = lista.map(function (l) {
      return '<tr class="mk-click" data-act="lead-ver" data-id="' + esc(l.id) + '">' +
        '<td><strong>' + esc(l.nombre_contacto) + '</strong>' + (l.empresa_contacto ? '<div style="color:#a0aec0;font-size:0.78rem">' + esc(l.empresa_contacto) + '</div>' : '') + '</td>' +
        '<td>' + esc(l.producto_interes || '—') + '</td>' +
        '<td>' + esc(ORIGEN[l.origen] || l.origen) + '</td>' +
        '<td>' + califBadge(l) + '</td>' +
        '<td>' + estadoBadge(l) + (vencido48(l) ? '<div class="mk-warn">⚠ &gt;48 h sin asignar</div>' : '') + '</td>' +
        '<td>' + esc(nombreComercial(l.asignado_a) || '—') + '</td>' +
        '<td>' + esc(fmtDateOnly(l.fecha_captura)) + '</td>' +
        '<td>' + (l.fecha_ultima_interaccion ? esc(fmtDateTime(l.fecha_ultima_interaccion)) : '—') + '</td>' +
        '<td><div class="mk-actions"><button class="btn-ver" data-act="lead-ver" data-id="' + esc(l.id) + '">Ver</button>' +
        '<button class="btn-danger" data-act="lead-eliminar" data-id="' + esc(l.id) + '" aria-label="Eliminar lead">🗑</button></div></td>' +
        '</tr>';
    }).join('');
  }

  function leadDesdeForm() {
    return {
      nombre_contacto: $('nv-nombre').value.trim(),
      empresa_contacto: $('nv-empresa').value.trim(),
      telefono: $('nv-telefono').value.trim(),
      correo: $('nv-correo').value.trim(),
      municipio: $('nv-municipio').value.trim(),
      departamento: $('nv-departamento').value.trim(),
      producto_interes: $('nv-producto').value.trim(),
      origen: $('nv-origen').value,
      actividad_id: $('nv-actividad').value ? Number($('nv-actividad').value) : null,
      autorizacion_datos: $('nv-autorizacion').checked,
      observaciones: $('nv-obs').value.trim(),
    };
  }

  function abrirNuevoLead() {
    $('nuevo-titulo').textContent = '➕ Nuevo lead';
    $('nv-id').value = '';
    ['nv-nombre', 'nv-empresa', 'nv-telefono', 'nv-correo', 'nv-municipio', 'nv-departamento', 'nv-producto', 'nv-obs'].forEach(function (id) { $(id).value = ''; });
    $('nv-origen').value = 'evento';
    $('nv-actividad').value = filtroActividadId ? String(filtroActividadId) : '';
    $('nv-autorizacion').checked = false;
    $('nv-asignado').value = '';
    $('nv-asignar-wrap').style.display = '';
    btnBusy($('nv-ok'), false, 'Guardar');
    MODAL.open('nuevo-overlay', 'nv-nombre');
  }

  function abrirEditarLead() {
    var l = leadById[ctxId];
    if (!l) return;
    $('nuevo-titulo').textContent = '✏️ Editar lead';
    $('nv-id').value = l.id;
    $('nv-nombre').value = l.nombre_contacto || '';
    $('nv-empresa').value = l.empresa_contacto || '';
    $('nv-telefono').value = l.telefono || '';
    $('nv-correo').value = l.correo || '';
    $('nv-municipio').value = l.municipio || '';
    $('nv-departamento').value = l.departamento || '';
    $('nv-producto').value = l.producto_interes || '';
    $('nv-obs').value = l.observaciones || '';
    $('nv-origen').value = l.origen || 'evento';
    $('nv-actividad').value = l.actividad_id ? String(l.actividad_id) : '';
    $('nv-autorizacion').checked = !!l.autorizacion_datos;
    $('nv-asignar-wrap').style.display = 'none';
    btnBusy($('nv-ok'), false, 'Guardar');
    MODAL.open('nuevo-overlay', 'nv-nombre');
  }

  async function guardarLead() {
    var d = leadDesdeForm();
    if (!d.nombre_contacto) { showToast('El nombre del contacto es obligatorio', '#e74c3c'); return; }
    if (!d.autorizacion_datos) { showToast('Falta marcar la autorización de tratamiento de datos (Ley 1581)', '#e74c3c'); return; }
    var id = $('nv-id').value;
    var btn = $('nv-ok');
    btnBusy(btn, true, 'Guardando…');
    var res;
    if (id) {
      res = await _sb.from('mercadeo_leads').update(d).eq('id', Number(id));
    } else {
      if ($('nv-asignado').value) d.asignado_a = Number($('nv-asignado').value);
      res = await _sb.from('mercadeo_leads').insert(d);
    }
    btnBusy(btn, false, 'Guardar');
    if (res.error) { fail('guardar el lead', res.error); return; }
    showToast(id ? '✅ Lead actualizado' : '✅ Lead creado');
    MODAL.close('nuevo-overlay');
    await cargar();
  }

  // ── Detalle del lead ──
  function abrirCtx(id) {
    if (!leadById[id]) return;
    ctxId = id;
    renderCtx();
    MODAL.open('ctx-overlay');
  }

  function renderCtx() {
    var l = leadById[ctxId];
    if (!l) return;
    var abierto = l.estado !== 'cerrado';
    $('ctx-titulo').textContent = (l.nombre_contacto || '—') + (l.empresa_contacto ? ' — ' + l.empresa_contacto : '');
    $('ctx-meta').innerHTML = '<span>' + estadoBadge(l) + '</span><span>' + califBadge(l) + '</span>' +
      '<span>📍 ' + esc(ORIGEN[l.origen] || l.origen) + '</span><span>📅 ' + esc(fmtDateOnly(l.fecha_captura)) + '</span>';

    var h = '';
    if (vencido48(l)) h += '<div class="mk-flag">⚠️ Este lead lleva más de 48 horas (corridas) sin asignarse a un comercial.</div>';

    h += '<div class="mk-ctx-grid">';
    h += '<div class="mk-box"><h4>Datos de contacto</h4>' +
      kv('Teléfono', esc(l.telefono || '—')) + kv('Correo', esc(l.correo || '—')) +
      kv('Municipio', esc(l.municipio || '—')) + kv('Departamento', esc(l.departamento || '—')) +
      kv('Producto de interés', esc(l.producto_interes || '—')) +
      kv('Autorización de datos', l.autorizacion_datos ? '<span class="mk-pill ok">Sí</span>' : '<span class="mk-pill over">No registrada</span>') +
      (l.actividad_id ? kv('Actividad de origen', esc((actById[l.actividad_id] || {}).nombre || ('#' + l.actividad_id))) : '') +
      (l.observaciones ? kv('Observaciones', esc(l.observaciones)) : '') +
      '</div>';

    h += '<div class="mk-box"><h4>Calificación y asignación</h4>';
    if (abierto) {
      h += '<div style="display:flex;gap:6px;margin-bottom:10px">' + ['caliente', 'tibio', 'frio'].map(function (c) {
        var act = l.calificacion === c;
        return '<button class="btn-cancel" data-act="lead-calificar" data-id="' + esc(l.id) + '" data-val="' + c + '" style="padding:6px 14px;' +
          (act ? 'background:' + COLOR_CALIF[c] + ';color:#fff;border-color:' + COLOR_CALIF[c] : '') + '">' + CALIF[c] + '</button>';
      }).join('') + '</div>';
    }
    h += kv('Calificación', califBadge(l));
    h += kv('Asignado a', esc(nombreComercial(l.asignado_a) || 'Sin asignar'));
    if (l.fecha_asignacion) h += kv('Asignado el', esc(fmtDateTime(l.fecha_asignacion)));
    if (abierto) {
      h += '<div style="display:flex;gap:6px;margin-top:10px;align-items:center">' +
        '<select class="ef" id="ctx-asig-sel" style="flex:1" aria-label="Comercial a asignar">' +
        optsHtml(comercialesActivos().map(function (c) { return { v: c.id, t: c.nombre }; }), 'Elegir comercial…', l.asignado_a || '') + '</select>' +
        '<button class="btn-confirm" data-act="lead-asignar" data-id="' + esc(l.id) + '" style="padding:7px 16px">Asignar</button></div>';
    }
    h += '</div></div>';

    var segs = segPorLead[l.id] || [];
    h += '<div class="mk-box" style="margin-top:14px"><h4>Seguimiento (' + segs.length + ')</h4>';
    if (abierto) {
      h += '<div style="display:grid;grid-template-columns:140px 1fr;gap:8px;margin-bottom:8px">' +
        '<select class="ef" id="sg-tipo" aria-label="Tipo de interacción">' + optsHtml(Object.keys(TIPO_SEG).map(function (k) { return { v: k, t: TIPO_SEG[k] }; }), null, 'llamada') + '</select>' +
        '<input class="ef" id="sg-resultado" maxlength="300" placeholder="Resultado (ej. interesado, agenda visita, no contesta…)" aria-label="Resultado"></div>' +
        '<textarea class="ef" id="sg-obs" rows="2" maxlength="1000" style="margin-bottom:8px" placeholder="Observaciones (opcional)" aria-label="Observaciones del seguimiento"></textarea>' +
        '<button class="btn-confirm" data-act="seg-agregar" data-id="' + esc(l.id) + '" style="margin-bottom:10px">➕ Agregar seguimiento</button>';
    }
    h += segs.length ? segs.map(function (s) {
      return '<div style="border-top:1px solid #edf2f7;padding:8px 0;font-size:0.84rem"><strong>' + esc(TIPO_SEG[s.tipo] || s.tipo) + '</strong> · ' + esc(fmtDateTime(s.fecha)) +
        (s.creado_por_nombre ? ' · registrado por ' + esc(s.creado_por_nombre) : '') +
        (s.resultado ? '<div>' + esc(s.resultado) + '</div>' : '') +
        (s.observaciones ? '<div style="color:#718096">' + esc(s.observaciones) + '</div>' : '') + '</div>';
    }).join('') : '<div style="color:#a0aec0;font-size:0.82rem">Sin interacciones registradas todavía.</div>';
    h += '</div>';

    h += '<div class="mk-box" style="margin-top:14px"><h4>Cierre</h4>';
    if (!abierto) {
      if (l.resultado_cierre === 'convertido') h += kv('Resultado', '<span class="mk-pill ok">✅ Convertido</span>') + kv('Valor de venta', esc(fmtMoney(l.valor_venta || 0)));
      else if (l.resultado_cierre === 'perdido') h += kv('Resultado', '<span class="mk-pill over">❌ Perdido</span>') + kv('Motivo', esc(l.motivo_perdida || '—'));
      else h += kv('Resultado', '<span class="mk-pill mid">⏱ Cierre automático (90 días sin movimiento)</span>');
      if (l.fecha_cierre) h += kv('Fecha de cierre', esc(fmtDateTime(l.fecha_cierre)));
    } else {
      h += '<div style="display:flex;gap:8px">' +
        '<button class="btn-confirm" style="background:#15803d" data-act="cierre-abrir" data-kind="convertido">✅ Marcar Convertido</button>' +
        '<button class="btn-danger" style="padding:9px 18px;font-size:0.87rem" data-act="cierre-abrir" data-kind="perdido">❌ Marcar Perdido</button></div>';
    }
    h += '</div>';
    h += auditoriaHtml(l);
    $('ctx-body').innerHTML = h;
  }

  async function calificar(id, val) {
    var res = await _sb.from('mercadeo_leads').update({ calificacion: val }).eq('id', Number(id));
    if (res.error) { fail('calificar', res.error); return; }
    await cargar();
  }

  async function asignar(id) {
    var sel = $('ctx-asig-sel');
    if (!sel || !sel.value) { showToast('Elige un comercial', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_leads').update({ asignado_a: Number(sel.value) }).eq('id', Number(id));
    if (res.error) { fail('asignar', res.error); return; }
    showToast('✅ Lead asignado');
    await cargar();
  }

  async function agregarSeguimiento(id, btn) {
    var tipo = $('sg-tipo').value, resultado = $('sg-resultado').value.trim(), obs = $('sg-obs').value.trim();
    if (!resultado && !obs) { showToast('Escribe el resultado o una observación', '#e74c3c'); return; }
    btnBusy(btn, true);
    var res = await _sb.from('mercadeo_leads_seguimiento').insert({ lead_id: Number(id), tipo: tipo, resultado: resultado, observaciones: obs });
    btnBusy(btn, false);
    if (res.error) { fail('registrar el seguimiento', res.error); return; }
    showToast('✅ Seguimiento agregado');
    await cargar();
  }

  function abrirCierre(kind) {
    cierreKind = kind;
    $('cierre-titulo').textContent = kind === 'convertido' ? '✅ Marcar como Convertido' : '❌ Marcar como Perdido';
    $('cierre-hdr').style.background = kind === 'convertido' ? 'linear-gradient(135deg,#15803d,#22c55e)' : 'linear-gradient(135deg,#b91c1c,#ef4444)';
    $('cierre-campo-valor').style.display = kind === 'convertido' ? '' : 'none';
    $('cierre-campo-motivo').style.display = kind === 'perdido' ? '' : 'none';
    $('cierre-valor').value = '';
    $('cierre-motivo').value = '';
    btnBusy($('cierre-ok'), false, 'Confirmar');
    MODAL.open('cierre-overlay', kind === 'convertido' ? 'cierre-valor' : 'cierre-motivo');
  }

  async function confirmarCierre() {
    if (!ctxId || !cierreKind) return;
    var payload = { estado: 'cerrado', resultado_cierre: cierreKind };
    if (cierreKind === 'convertido') {
      var txt = $('cierre-valor').value.trim();
      var valor = txt ? parseMonto(txt) : 0;
      if (isNaN(valor) || valor < 0) { showToast('El valor de la venta no es un número válido', '#e74c3c'); return; }
      payload.valor_venta = valor;
    } else {
      var motivo = $('cierre-motivo').value.trim();
      if (!motivo) { showToast('Escribe el motivo de la pérdida', '#e74c3c'); return; }
      payload.motivo_perdida = motivo;
    }
    var btn = $('cierre-ok');
    btnBusy(btn, true, 'Procesando…');
    var res = await _sb.from('mercadeo_leads').update(payload).eq('id', ctxId);
    btnBusy(btn, false, 'Confirmar');
    if (res.error) { fail('cerrar el lead', res.error); return; }
    showToast(cierreKind === 'convertido' ? '✅ Lead convertido' : '❌ Lead marcado como perdido');
    MODAL.close('cierre-overlay');
    await cargar();
  }

  async function eliminarLead(id) {
    var l = leadById[id];
    if (!l) return;
    var msg = '¿Eliminar el lead "' + l.nombre_contacto + '"? Esta acción no se puede deshacer.';
    if (l.estado === 'cerrado') {
      msg = '⚠ Este lead ya está CERRADO' +
        (l.resultado_cierre === 'convertido' ? ' como Convertido, con un valor de venta de ' + fmtMoney(l.valor_venta || 0) : (l.resultado_cierre ? ' (' + l.resultado_cierre.replace('_', ' ') + ')' : '')) +
        '. Si lo eliminas se pierde ese registro para siempre. ¿Continuar de todas formas?';
    }
    if (!confirm(msg)) return;
    var res = await _sb.from('mercadeo_leads').delete().eq('id', Number(id)).select('id');
    if (res.error) { fail('eliminar el lead', res.error); return; }
    if (!res.data || !res.data.length) { showToast('No se eliminó: no tienes permiso o el lead ya no existe', '#e74c3c'); return; }
    showToast('🗑 Lead eliminado');
    if (ctxId === Number(id)) MODAL.close('ctx-overlay');
    await cargar();
  }

  // ══════════════ Carga masiva de asistentes ══════════════
  function parseAsistentes(texto) {
    var usoComas = false;
    var filas = texto.split('\n').map(function (x) { return x.replace(/\r$/, ''); }).filter(function (x) { return x.trim().length > 0; });
    var vistos = {}, items = [], duplicados = 0, sinNombre = 0;
    filas.forEach(function (line) {
      var partes;
      if (line.indexOf('\t') >= 0) partes = line.split('\t');
      else { partes = line.split(','); if (partes.length > 1) usoComas = true; }
      partes = partes.map(function (p) { return p.trim(); });
      if (!partes[0]) { sinNombre++; return; }
      var clave = norm(partes[0]) + '|' + norm(partes[1] || partes[2] || '');
      if (vistos[clave]) { duplicados++; return; }
      vistos[clave] = true;
      items.push({ nombre_contacto: partes[0], telefono: partes[1] || '', correo: partes[2] || '', empresa_contacto: partes[3] || '', municipio: partes[4] || '', producto_interes: partes[5] || '' });
    });
    return { items: items, filas: filas.length, duplicados: duplicados, sinNombre: sinNombre, usoComas: usoComas };
  }

  function actualizarPreviewCarga() {
    var r = parseAsistentes($('carga-texto').value);
    var msg = r.items.length + (r.items.length === 1 ? ' asistente detectado' : ' asistentes detectados');
    if (r.sinNombre) msg += ' · ' + r.sinNombre + ' línea(s) sin nombre (se ignoran)';
    if (r.duplicados) msg += ' · ' + r.duplicados + ' duplicado(s) en el pegado (se ignoran)';
    if (r.usoComas) msg += ' · ⚠ se separó por comas: si algún nombre o finca tiene comas, pega desde Excel (tabulación)';
    if (r.items.length > MAX_CARGA) msg += ' · ⚠ supera el máximo de ' + MAX_CARGA;
    $('carga-preview').textContent = msg;
  }

  function abrirCarga(actId) {
    var a = actById[actId];
    if (!a) return;
    $('carga-actividad-id').value = actId;
    $('carga-sub').textContent = a.nombre;
    $('carga-texto').value = '';
    $('carga-autorizacion').checked = false;
    $('carga-asignado').value = '';
    btnBusy($('carga-ok'), false, 'Cargar');
    actualizarPreviewCarga();
    MODAL.open('carga-overlay', 'carga-texto');
  }

  async function confirmarCarga() {
    var actId = Number($('carga-actividad-id').value);
    var r = parseAsistentes($('carga-texto').value);
    if (!r.items.length) { showToast('Pega al menos un asistente con nombre', '#e74c3c'); return; }
    if (r.items.length > MAX_CARGA) { showToast('Máximo ' + MAX_CARGA + ' asistentes por carga', '#e74c3c'); return; }
    if (!$('carga-autorizacion').checked) { showToast('Falta confirmar la autorización de tratamiento de datos (Ley 1581)', '#e74c3c'); return; }
    var asig = $('carga-asignado').value ? Number($('carga-asignado').value) : null;
    var filas = r.items.map(function (it) {
      var f = Object.assign({}, it, { origen: 'evento', actividad_id: actId, autorizacion_datos: true });
      if (asig) f.asignado_a = asig;
      return f;
    });
    var btn = $('carga-ok');
    btnBusy(btn, true, 'Cargando…');
    var res = await _sb.from('mercadeo_leads').insert(filas);
    btnBusy(btn, false, 'Cargar');
    if (res.error) { fail('cargar los asistentes', res.error); return; }
    // La carga de la base de datos de asistentes cuenta como su entrega (KPI de 3 días del manual de Eventos).
    var a = actById[actId];
    if (a && !a.base_datos_entregada) {
      var r2 = await _sb.from('mercadeo_actividades').update({ base_datos_entregada: true, fecha_entrega_base_datos: today() }).eq('id', actId);
      if (r2.error) showToast('Leads cargados, pero no se pudo marcar la base de datos como entregada: ' + errMsg(r2.error), '#e74c3c');
    }
    showToast('✅ ' + filas.length + ' lead(s) cargados');
    MODAL.close('carga-overlay');
    await cargar();
  }

  // ══════════════ Catálogo de comerciales ══════════════
  function renderComerciales() {
    $('com-lista').innerHTML = comerciales.length ? '<table class="mk-mini"><thead><tr><th>Nombre</th><th>Leads</th><th>Activo</th><th></th></tr></thead><tbody>' +
      comerciales.map(function (c) {
        var n = leads.filter(function (l) { return l.asignado_a === c.id; }).length;
        return '<tr><td>' + esc(c.nombre) + '</td><td>' + n + '</td><td>' + (c.activo ? 'Sí' : '<span class="mk-sin">No</span>') + '</td>' +
          '<td><div class="mk-actions"><button class="btn-edit" data-act="com-toggle" data-id="' + esc(c.id) + '">' + (c.activo ? 'Desactivar' : 'Activar') + '</button>' +
          (n === 0 ? '<button class="btn-danger" data-act="com-eliminar" data-id="' + esc(c.id) + '" aria-label="Eliminar comercial">🗑</button>' : '') + '</div></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="no-lines">Aún no hay comerciales.</div>';
  }

  async function agregarComercial() {
    var nombre = $('com-nuevo').value.trim();
    if (!nombre) { showToast('Escribe el nombre del comercial', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_comerciales').insert({ nombre: nombre });
    if (res.error) { showToast(res.error.code === '23505' ? 'Ese comercial ya existe' : 'Error al agregar: ' + errMsg(res.error), '#e74c3c'); return; }
    $('com-nuevo').value = '';
    await cargar();
    renderComerciales();
  }

  async function toggleComercial(id) {
    var c = comerciales.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!c) return;
    var res = await _sb.from('mercadeo_comerciales').update({ activo: !c.activo }).eq('id', c.id);
    if (res.error) { fail('actualizar el comercial', res.error); return; }
    await cargar();
    renderComerciales();
  }

  async function eliminarComercial(id) {
    var c = comerciales.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!c || !confirm('¿Eliminar al comercial "' + c.nombre + '"?')) return;
    var res = await _sb.from('mercadeo_comerciales').delete().eq('id', c.id);
    if (res.error) { fail('eliminar el comercial', res.error); return; }
    await cargar();
    renderComerciales();
  }

  // ══════════════ Actividades (calendario maestro) ══════════════
  function leadsDeActividad(id) { return leads.filter(function (l) { return l.actividad_id === id; }).length; }
  function anticipacionDias(a) { return a.fecha_solicitud && a.fecha_inicio ? diasEntre(a.fecha_solicitud, a.fecha_inicio) : null; }

  function renderActividades() {
    var est = $('fa-estado').value, tipo = $('fa-tipo').value, soloCal = $('fa-cal').checked;
    var lista = actividades.filter(function (a) {
      return (!est || a.estado === est) && (!tipo || a.tipo === tipo) && (!soloCal || a.en_calendario);
    }).sort(function (a, b) { return b.id - a.id; });
    $('actividades-ct').textContent = '(' + lista.length + (lista.length !== actividades.length ? ' de ' + actividades.length : '') + ')';
    if (!lista.length) {
      $('actividades-body').innerHTML = '<tr><td colspan="10" class="empty">' + (actividades.length ? 'Ninguna actividad coincide con los filtros.' : 'Aún no hay actividades registradas.') + '</td></tr>';
      return;
    }
    $('actividades-body').innerHTML = lista.map(function (a) {
      var fechas = (a.fecha_inicio ? fmtDateOnly(a.fecha_inicio) : '—') + (a.fecha_fin && a.fecha_fin !== a.fecha_inicio ? ' – ' + fmtDateOnly(a.fecha_fin) : '');
      var ant = anticipacionDias(a);
      var flag = (a.tipo === 'eventos' && ant !== null && ant < 15) ? '<div class="mk-warn">⚠ solicitada con ' + ant + ' días de anticipación</div>' : '';
      var nl = leadsDeActividad(a.id);
      return '<tr>' +
        '<td><strong>' + esc(a.nombre) + '</strong>' + flag + '</td>' +
        '<td>' + badge(TIPO_ACT[a.tipo] || a.tipo, COLOR_TIPO[a.tipo] || '#718096') + '</td>' +
        '<td>' + empresaChips(a.empresas) + '</td>' +
        '<td>' + esc(fechas) + '</td>' +
        '<td>' + esc(nombreEquipo(a.responsable) || '—') + '</td>' +
        '<td>' + (a.en_calendario ? '<span class="mk-pill ok">✅ Aprobada</span>' : '<span class="mk-sin">fuera de calendario</span>') + '</td>' +
        '<td>' + badge(ESTADO_ACT[a.estado] || a.estado, COLOR_ESTADO_ACT[a.estado] || '#718096') + '</td>' +
        '<td style="text-align:right">' + esc(fmtMoney(a.presupuesto_asignado)) + '</td>' +
        '<td style="text-align:right">' + (nl ? '<a href="#" data-act="act-ver-leads" data-id="' + esc(a.id) + '" style="font-weight:700">' + nl + '</a>' : '0') + '</td>' +
        '<td><div class="mk-actions"><button class="btn-ver" data-act="carga-abrir" data-id="' + esc(a.id) + '">📋 Cargar</button>' +
        '<button class="btn-ver" data-act="act-editar" data-id="' + esc(a.id) + '">Editar</button>' +
        '<button class="btn-danger" data-act="act-eliminar" data-id="' + esc(a.id) + '" aria-label="Eliminar actividad">🗑</button></div></td>' +
        '</tr>';
    }).join('');
  }

  function checksEmpresas(sel) {
    $('ac-empresas-checks').innerHTML = SIGLAS.map(function (s) {
      return '<label><input type="checkbox" class="ac-emp-chk" value="' + s + '"' + (sel.indexOf(s) >= 0 ? ' checked' : '') + '> ' + s + '</label>';
    }).join('') + '<button class="btn-secondary" data-act="act-todas" type="button">Todo el holding</button>';
  }

  function sincronizarBd() { $('ac-bd-fecha-wrap').style.display = $('ac-bd-entregada').checked ? '' : 'none'; }

  function abrirActividad(id) {
    var a = id ? actById[id] : null;
    actEditId = a ? a.id : null;
    $('act-titulo').textContent = a ? '✏️ Editar actividad' : '➕ Nueva actividad';
    $('ac-nombre').value = a ? a.nombre : '';
    $('ac-tipo').value = a ? a.tipo : 'eventos';
    $('ac-estado').value = a ? a.estado : 'planificada';
    $('ac-responsable').value = a && a.responsable ? a.responsable : '';
    $('ac-presupuesto').value = a && a.presupuesto_asignado ? String(a.presupuesto_asignado) : '';
    $('ac-fecha-sol').value = a ? (a.fecha_solicitud || '') : '';
    $('ac-fecha-ini').value = a ? (a.fecha_inicio || '') : '';
    $('ac-fecha-fin').value = a ? (a.fecha_fin || '') : '';
    $('ac-objetivo').value = a ? a.objetivo : '';
    $('ac-obs').value = a ? a.observaciones : '';
    $('ac-calendario').checked = a ? !!a.en_calendario : false;
    $('ac-bd-entregada').checked = a ? !!a.base_datos_entregada : false;
    $('ac-bd-fecha').value = a ? (a.fecha_entrega_base_datos || '') : '';
    checksEmpresas(a ? a.empresas : []);
    sincronizarBd();
    btnBusy($('ac-ok'), false, 'Guardar');
    MODAL.open('act-overlay', 'ac-nombre');
  }

  async function guardarActividad() {
    var nombre = $('ac-nombre').value.trim();
    if (!nombre) { showToast('El nombre de la actividad es obligatorio', '#e74c3c'); return; }
    var empresas = [].slice.call(document.querySelectorAll('.ac-emp-chk:checked')).map(function (c) { return c.value; });
    if (!empresas.length) { showToast('Elige al menos una empresa', '#e74c3c'); return; }
    var ini = $('ac-fecha-ini').value, fin = $('ac-fecha-fin').value;
    if (ini && fin && fin < ini) { showToast('La fecha de fin no puede ser anterior a la de inicio', '#e74c3c'); return; }
    var ptxt = $('ac-presupuesto').value.trim();
    var presu = ptxt ? parseMonto(ptxt) : 0;
    if (isNaN(presu) || presu < 0) { showToast('El presupuesto no es un número válido', '#e74c3c'); return; }
    var bd = $('ac-bd-entregada').checked;
    var d = {
      nombre: nombre, tipo: $('ac-tipo').value, empresas: empresas,
      fecha_solicitud: $('ac-fecha-sol').value || null, fecha_inicio: ini || null, fecha_fin: fin || null,
      responsable: $('ac-responsable').value || null, estado: $('ac-estado').value,
      objetivo: $('ac-objetivo').value.trim(), presupuesto_asignado: presu,
      en_calendario: $('ac-calendario').checked,
      base_datos_entregada: bd, fecha_entrega_base_datos: bd ? ($('ac-bd-fecha').value || today()) : null,
      observaciones: $('ac-obs').value.trim(),
    };
    var btn = $('ac-ok');
    btnBusy(btn, true, 'Guardando…');
    var res = actEditId ? await _sb.from('mercadeo_actividades').update(d).eq('id', actEditId) : await _sb.from('mercadeo_actividades').insert(d);
    btnBusy(btn, false, 'Guardar');
    if (res.error) { fail('guardar la actividad', res.error); return; }
    showToast(actEditId ? '✅ Actividad actualizada' : '✅ Actividad creada');
    MODAL.close('act-overlay');
    await cargar();
  }

  async function eliminarActividad(id) {
    var a = actById[id];
    if (!a) return;
    var nl = leadsDeActividad(a.id);
    if (nl) { showToast('No se puede eliminar: hay ' + nl + ' lead(s) vinculados a esta actividad.', '#e74c3c'); return; }
    if (!confirm('¿Eliminar la actividad "' + a.nombre + '"? Esta acción no se puede deshacer.')) return;
    var res = await _sb.from('mercadeo_actividades').delete().eq('id', a.id);
    if (res.error) {
      showToast(res.error.code === '23503' ? 'No se puede eliminar: hay leads o tareas del tablero vinculados a esta actividad.' : 'Error al eliminar la actividad: ' + errMsg(res.error), '#e74c3c');
      return;
    }
    showToast('🗑 Actividad eliminada');
    await cargar();
  }

  // ══════════════ Presupuesto ══════════════
  function ejecutadoDe(id) { return (gastosPorPres[id] || []).reduce(function (s, g) { return s + (Number(g.valor_ejecutado) || 0); }, 0); }
  function semaforo(pct) {
    if (pct === null) return { cls: 'none', txt: 'sin ejecución' };
    if (pct > 105) return { cls: 'over', txt: pct + '% (sobreejecutado)' };
    if (pct >= 95) return { cls: 'ok', txt: pct + '% (en meta)' };
    return { cls: 'mid', txt: pct + '%' };
  }

  function renderPresupuesto() {
    var emp = $('fp-empresa').value, rubro = $('fp-rubro').value;
    var lista = presupuesto.filter(function (p) { return (!emp || p.empresa === emp) && (!rubro || p.rubro === rubro); })
      .sort(function (a, b) { return String(b.periodo).localeCompare(String(a.periodo)) || String(a.empresa).localeCompare(String(b.empresa)); });
    $('presupuesto-ct').textContent = '(' + lista.length + (lista.length !== presupuesto.length ? ' de ' + presupuesto.length : '') + ')';
    if (!lista.length) {
      $('presupuesto-body').innerHTML = '<tr><td colspan="7" class="empty">' + (presupuesto.length ? 'Ninguna línea coincide con los filtros.' : 'Aún no hay líneas de presupuesto registradas.') + '</td></tr>';
      return;
    }
    $('presupuesto-body').innerHTML = lista.map(function (p) {
      var ej = ejecutadoDe(p.id), pp = Number(p.valor_presupuestado) || 0;
      var sem = semaforo(pp > 0 ? Math.round(ej / pp * 100) : null);
      return '<tr class="mk-click" data-act="pr-ver" data-id="' + esc(p.id) + '">' +
        '<td>' + esc(p.empresa) + '</td><td>' + badge(TIPO_ACT[p.rubro] || p.rubro, COLOR_TIPO[p.rubro] || '#718096') + '</td><td>' + esc(p.periodo) + '</td>' +
        '<td style="text-align:right">' + esc(fmtMoney(pp)) + '</td><td style="text-align:right">' + esc(fmtMoney(ej)) + '</td>' +
        '<td><span class="mk-pill ' + sem.cls + '">' + esc(sem.txt) + '</span></td>' +
        '<td><div class="mk-actions"><button class="btn-ver" data-act="pr-editar" data-id="' + esc(p.id) + '">Editar</button>' +
        '<button class="btn-danger" data-act="pr-eliminar" data-id="' + esc(p.id) + '" aria-label="Eliminar línea">🗑</button></div></td></tr>';
    }).join('');
  }

  function abrirPresupuesto(id) {
    var p = id ? presById[id] : null;
    presEditId = p ? p.id : null;
    $('pr-titulo').textContent = p ? '✏️ Editar línea de presupuesto' : '➕ Nueva línea de presupuesto';
    $('pr-empresa').value = p ? p.empresa : SIGLAS[0];
    $('pr-rubro').value = p ? p.rubro : 'eventos';
    $('pr-periodo').value = p ? p.periodo : today().slice(0, 7);
    $('pr-periodo').setAttribute('placeholder', 'AAAA-MM');
    $('pr-valor').value = p && p.valor_presupuestado ? String(p.valor_presupuestado) : '';
    $('pr-obs').value = p ? p.observaciones : '';
    btnBusy($('pr-ok'), false, 'Guardar');
    MODAL.open('pr-overlay', 'pr-empresa');
  }

  async function guardarPresupuesto() {
    var periodo = $('pr-periodo').value.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) { showToast('El periodo debe ser un mes válido (AAAA-MM, ej. 2026-10)', '#e74c3c'); return; }
    var vtxt = $('pr-valor').value.trim();
    var valor = vtxt ? parseMonto(vtxt) : 0;
    if (isNaN(valor) || valor < 0) { showToast('El valor presupuestado no es un número válido', '#e74c3c'); return; }
    var d = { empresa: $('pr-empresa').value, rubro: $('pr-rubro').value, periodo: periodo, valor_presupuestado: valor, observaciones: $('pr-obs').value.trim() };
    var btn = $('pr-ok');
    btnBusy(btn, true, 'Guardando…');
    var res = presEditId ? await _sb.from('mercadeo_presupuesto').update(d).eq('id', presEditId) : await _sb.from('mercadeo_presupuesto').insert(d);
    btnBusy(btn, false, 'Guardar');
    if (res.error) {
      showToast(res.error.code === '23505' ? 'Ya existe una línea para esa empresa, rubro y periodo' : 'Error al guardar la línea: ' + errMsg(res.error), '#e74c3c');
      return;
    }
    showToast(presEditId ? '✅ Línea actualizada' : '✅ Línea creada');
    MODAL.close('pr-overlay');
    await cargar();
  }

  async function eliminarPresupuesto(id) {
    var p = presById[id];
    if (!p) return;
    var n = (gastosPorPres[p.id] || []).length;
    var msg = n ? 'Esta línea tiene ' + n + ' gasto(s) registrados que también se eliminarán. ¿Continuar?'
      : '¿Eliminar la línea de presupuesto de ' + p.empresa + ' / ' + (TIPO_ACT[p.rubro] || p.rubro) + ' / ' + p.periodo + '?';
    if (!confirm(msg)) return;
    var res = await _sb.from('mercadeo_presupuesto').delete().eq('id', p.id);
    if (res.error) { fail('eliminar la línea', res.error); return; }
    showToast('🗑 Línea eliminada');
    await cargar();
  }

  function abrirPresDetalle(id) {
    if (!presById[id]) return;
    presDetId = presById[id].id;
    renderPresDetalle();
    MODAL.open('prd-overlay');
  }

  function renderPresDetalle() {
    var p = presById[presDetId];
    if (!p) return;
    var lista = (gastosPorPres[p.id] || []).slice().sort(function (a, b) { return String(b.fecha_gasto).localeCompare(String(a.fecha_gasto)); });
    var ej = ejecutadoDe(p.id), pp = Number(p.valor_presupuestado) || 0;
    var sem = semaforo(pp > 0 ? Math.round(ej / pp * 100) : null);
    $('prd-titulo').textContent = p.empresa + ' — ' + (TIPO_ACT[p.rubro] || p.rubro) + ' — ' + p.periodo;
    $('prd-meta').innerHTML = '<span>Presupuestado: ' + esc(fmtMoney(pp)) + '</span><span>Ejecutado: ' + esc(fmtMoney(ej)) + '</span><span class="mk-pill ' + sem.cls + '">' + esc(sem.txt) + '</span>';

    var h = '<div class="mk-box" style="margin-bottom:14px"><h4>Registrar gasto</h4>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px">' +
      '<div><label class="ef-label" for="ga-fecha">Fecha del gasto</label><input class="ef" id="ga-fecha" type="date" value="' + today() + '"></div>' +
      '<div><label class="ef-label" for="ga-valor">Valor ejecutado ($)</label><input class="ef" id="ga-valor" inputmode="numeric" placeholder="Ej. 500.000"></div>' +
      '<div><label class="ef-label" for="ga-legal">Fecha de legalización</label><input class="ef" id="ga-legal" type="date"></div></div>' +
      '<div style="margin-top:8px"><label class="ef-label" for="ga-concepto">Concepto</label><input class="ef" id="ga-concepto" maxlength="300" placeholder="Ej. Alquiler de carpas"></div>' +
      '<div style="margin-top:8px"><label class="ef-label" for="ga-actividad">Actividad relacionada (opcional)</label><select class="ef" id="ga-actividad">' +
      optsHtml(actividades.slice().sort(function (a, b) { return String(a.nombre).localeCompare(String(b.nombre)); }).map(function (a) { return { v: a.id, t: a.nombre }; }), 'Sin actividad', '') + '</select></div>' +
      '<button class="btn-confirm" style="margin-top:10px" data-act="gasto-agregar" data-id="' + esc(p.id) + '">➕ Registrar gasto</button></div>';

    h += '<div class="mk-box"><h4>Gastos registrados (' + lista.length + ')</h4>';
    if (!lista.length) h += '<div style="color:#a0aec0;font-size:0.82rem">Sin gastos registrados todavía.</div>';
    else {
      h += '<div class="table-wrap"><table class="mk-mini"><thead><tr><th>Fecha</th><th>Concepto</th><th>Actividad</th><th style="text-align:right">Valor</th><th>Legalización</th><th></th></tr></thead><tbody>' +
        lista.map(function (g) {
          var dl = g.fecha_legalizacion ? diasEntre(g.fecha_gasto, g.fecha_legalizacion) : null;
          return '<tr><td>' + esc(fmtDateOnly(g.fecha_gasto)) + '</td><td>' + esc(g.concepto || '—') + '</td>' +
            '<td>' + esc(g.actividad_id ? ((actById[g.actividad_id] || {}).nombre || '—') : '—') + '</td>' +
            '<td style="text-align:right">' + esc(fmtMoney(g.valor_ejecutado)) + '</td>' +
            '<td>' + (g.fecha_legalizacion ? esc(fmtDateOnly(g.fecha_legalizacion)) + (dl !== null && dl > 5 ? ' ⚠ ' + dl + ' días' : '') : '<span class="mk-sin">pendiente</span>') + '</td>' +
            '<td><button class="btn-danger" data-act="gasto-eliminar" data-id="' + esc(g.id) + '" aria-label="Eliminar gasto">🗑</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    h += '</div>';
    $('prd-body').innerHTML = h;
  }

  async function agregarGasto(presId) {
    var vtxt = $('ga-valor').value.trim();
    var valor = parseMonto(vtxt);
    if (!vtxt || isNaN(valor) || valor <= 0) { showToast('El valor ejecutado debe ser un número mayor que cero', '#e74c3c'); return; }
    var fecha = $('ga-fecha').value || today(), legal = $('ga-legal').value || null;
    if (legal && legal < fecha) { showToast('La fecha de legalización no puede ser anterior a la del gasto', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_presupuesto_gastos').insert({
      presupuesto_id: Number(presId), actividad_id: $('ga-actividad').value ? Number($('ga-actividad').value) : null,
      fecha_gasto: fecha, valor_ejecutado: valor, concepto: $('ga-concepto').value.trim(), fecha_legalizacion: legal,
    });
    if (res.error) { fail('registrar el gasto', res.error); return; }
    showToast('✅ Gasto registrado');
    await cargar();
  }

  async function eliminarGasto(id) {
    if (!confirm('¿Eliminar este gasto?')) return;
    var res = await _sb.from('mercadeo_presupuesto_gastos').delete().eq('id', Number(id));
    if (res.error) { fail('eliminar el gasto', res.error); return; }
    showToast('🗑 Gasto eliminado');
    await cargar();
  }

  // ══════════════ Indicadores ══════════════
  function promedio(arr) { return arr.length ? Math.round(arr.reduce(function (s, h) { return s + h; }, 0) / arr.length) : null; }

  function renderIndicadores() {
    var mes = today().slice(0, 7);
    var leadsMes = leads.filter(function (l) { return String(l.fecha_captura || '').slice(0, 7) === mes; });

    var hAsig = [];
    leads.forEach(function (l) {
      if (l.fecha_asignacion && l.creado_en) {
        var h = (new Date(l.fecha_asignacion).getTime() - new Date(l.creado_en).getTime()) / 3600000;
        if (h >= 0) hAsig.push(h);
      }
    });
    var hContacto = [];
    leads.forEach(function (l) {
      var segs = segPorLead[l.id];
      if (l.fecha_asignacion && segs && segs.length) {
        var primero = segs[segs.length - 1]; // ordenados de más reciente a más antiguo
        var h = (new Date(primero.fecha).getTime() - new Date(l.fecha_asignacion).getTime()) / 3600000;
        if (h >= 0) hContacto.push(h);
      }
    });
    var pAsig = promedio(hAsig), pCont = promedio(hContacto);
    var totPres = presupuesto.reduce(function (s, p) { return s + (Number(p.valor_presupuestado) || 0); }, 0);
    var totEjec = gastos.reduce(function (s, g) { return s + (Number(g.valor_ejecutado) || 0); }, 0);
    var pctEjec = totPres > 0 ? Math.round(totEjec / totPres * 100) : null;

    $('ind-stats').innerHTML =
      '<div class="sc info"><div class="num">' + leadsMes.length + '</div><div class="lbl">Leads capturados (mes)</div></div>' +
      '<div class="sc recibido"><div class="num">' + (pAsig === null ? '—' : pAsig + ' h') + '</div><div class="lbl">Tiempo promedio de asignación</div></div>' +
      '<div class="sc pend"><div class="num">' + (pCont === null ? '—' : pCont + ' h') + '</div><div class="lbl">Tiempo promedio de 1.er contacto</div></div>' +
      '<div class="sc total"><div class="num">' + (pctEjec === null ? '—' : pctEjec + '%') + '</div><div class="lbl">Ejecución presupuestal total</div><div class="mk-sub">' + esc(fmtMoney(totEjec)) + ' de ' + esc(fmtMoney(totPres)) + '</div></div>';

    var porOrigen = { evento: 0, digital: 0, distribuidor: 0 };
    leadsMes.forEach(function (l) { if (porOrigen[l.origen] !== undefined) porOrigen[l.origen]++; });
    $('ind-origen-body').innerHTML = Object.keys(porOrigen).map(function (o) {
      return '<tr><td>' + esc(ORIGEN[o]) + '</td><td style="text-align:right">' + porOrigen[o] + '</td></tr>';
    }).join('');

    var eventos = actividades.filter(function (a) { return a.tipo === 'eventos' && a.fecha_solicitud && a.fecha_inicio; });
    $('ind-eventos-body').innerHTML = eventos.length ? eventos.map(function (a) {
      var d = anticipacionDias(a);
      return '<tr><td>' + esc(a.nombre) + '</td><td>' + esc(fmtDateOnly(a.fecha_solicitud)) + '</td><td>' + esc(fmtDateOnly(a.fecha_inicio)) + '</td>' +
        '<td style="text-align:right;font-weight:700;color:' + (d !== null && d < 15 ? '#c0392b' : '#15803d') + '">' + (d === null ? '—' : d + ' días') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty" style="padding:16px">Sin eventos con fechas registradas.</td></tr>';
  }

  // ══════════════ Eventos ══════════════
  var ACCIONES = {
    'reintentar': function () { $('estado-carga').textContent = 'Cargando…'; cargar(true); },
    'tab': function (id, el) { cambiarTab(el.getAttribute('data-tab')); },
    'cerrar-modal': function (id, el) { MODAL.close(el.getAttribute('data-modal')); },
    'leads-limpiar': function () {
      ['f-estado', 'f-origen', 'f-calif', 'f-asig'].forEach(function (k) { $(k).value = ''; });
      $('f-txt').value = ''; filtroActividadId = null; renderLeads();
    },
    'quitar-filtro-actividad': function () { filtroActividadId = null; renderLeads(); },
    'lead-nuevo': abrirNuevoLead,
    'lead-guardar': guardarLead,
    'lead-ver': function (id) { abrirCtx(Number(id)); },
    'lead-editar': abrirEditarLead,
    'lead-eliminar': function (id) { eliminarLead(Number(id)); },
    'lead-eliminar-ctx': function () { if (ctxId) eliminarLead(ctxId); },
    'lead-calificar': function (id, el) { calificar(id, el.getAttribute('data-val')); },
    'lead-asignar': function (id) { asignar(id); },
    'seg-agregar': function (id, el) { agregarSeguimiento(id, el); },
    'cierre-abrir': function (id, el) { abrirCierre(el.getAttribute('data-kind')); },
    'lead-cierre-confirmar': confirmarCierre,
    'com-abrir': function () { renderComerciales(); MODAL.open('com-overlay', 'com-nuevo'); },
    'com-agregar': agregarComercial,
    'com-toggle': function (id) { toggleComercial(id); },
    'com-eliminar': function (id) { eliminarComercial(id); },
    'act-nueva': function () { abrirActividad(null); },
    'act-editar': function (id) { abrirActividad(Number(id)); },
    'act-guardar': guardarActividad,
    'act-eliminar': function (id) { eliminarActividad(Number(id)); },
    'act-todas': function () { [].slice.call(document.querySelectorAll('.ac-emp-chk')).forEach(function (c) { c.checked = true; }); },
    'act-ver-leads': function (id) { filtroActividadId = Number(id); cambiarTab('leads'); ['f-estado', 'f-origen', 'f-calif', 'f-asig'].forEach(function (k) { $(k).value = ''; }); $('f-txt').value = ''; renderLeads(); },
    'carga-abrir': function (id) { abrirCarga(Number(id)); },
    'carga-confirmar': confirmarCarga,
    'pr-nuevo': function () { abrirPresupuesto(null); },
    'pr-editar': function (id) { abrirPresupuesto(Number(id)); },
    'pr-guardar': guardarPresupuesto,
    'pr-eliminar': function (id) { eliminarPresupuesto(Number(id)); },
    'pr-ver': function (id) { abrirPresDetalle(Number(id)); },
    'gasto-agregar': function (id) { agregarGasto(id); },
    'gasto-eliminar': function (id) { eliminarGasto(id); },
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACCIONES[el.getAttribute('data-act')];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    fn(el.getAttribute('data-id'), el, e);
  });

  // Filtros en vivo
  ['f-estado', 'f-origen', 'f-calif', 'f-asig'].forEach(function (id) { $(id).addEventListener('change', renderLeads); });
  $('f-txt').addEventListener('input', renderLeads);
  ['fa-estado', 'fa-tipo', 'fa-cal'].forEach(function (id) { $(id).addEventListener('change', renderActividades); });
  ['fp-empresa', 'fp-rubro'].forEach(function (id) { $(id).addEventListener('change', renderPresupuesto); });
  $('carga-texto').addEventListener('input', actualizarPreviewCarga);
  $('ac-bd-entregada').addEventListener('change', sincronizarBd);

  MODAL.onClose = function (id) {
    if (id === 'ctx-overlay') ctxId = null;
    if (id === 'prd-overlay') presDetId = null;
  };

  await cargar(true);
})();
