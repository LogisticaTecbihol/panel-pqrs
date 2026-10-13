// ══════════════════════════════════════════════════════════════
// SST — Sistema de Gestión de Seguridad y Salud en el Trabajo (Res. 312 de 2019)
// FASE 0: base del módulo = Empresas + Trabajadores + Evidencias (enlaces a Drive).
// FASE 1: autoevaluación de estándares mínimos + plan de mejoramiento.
// FASE 2: plan anual de trabajo (cronograma mensual programado/ejecutado) + programa de capacitación.
// FASE 3: eventos (accidentes, incidentes, condiciones inseguras, enfermedad laboral), acciones e indicadores.
// ══════════════════════════════════════════════════════════════
// Mismo patrón que crm.js/mercadeo.js: cliente Supabase directo, la seguridad real es la RLS
// (user_has_module_pqrs('sst'), migración 0015) y las reglas de negocio las sella el servidor:
// el grupo de estándares (7/21/60) de cada empresa lo calcula un trigger, no este script
// (aquí solo se muestra una vista previa). Las evidencias NO se suben: permanecen en Google
// Drive y la BD guarda el enlace + metadatos. Nada se borra desde aquí: las empresas se
// desactivan, los trabajadores se retiran y las evidencias se marcan "retirada".
(async function () {
  await AUTH.authReady;
  if (!AUTH.getProfile() || !AUTH.hasModule('sst')) return;

  // ── Catálogos (valores en BD = códigos ASCII; aquí las etiquetas) ──
  var CLASES = ['I', 'II', 'III', 'IV', 'V'];
  var TIPO_DOC = { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', PEP: 'PEP', PPT: 'PPT', PAS: 'Pasaporte', OTRO: 'Otro' };
  var VINCULACION = { contrato_trabajo: 'Contrato de trabajo', prestacion_servicios: 'Prestación de servicios', aprendiz: 'Aprendiz', otro: 'Otro' };
  var TIPO_EVID = { politica: 'Política', procedimiento: 'Procedimiento', formato: 'Formato', registro: 'Registro', acta: 'Acta',
    informe: 'Informe', certificado: 'Certificado', foto: 'Foto', documento: 'Documento', otro: 'Otro' };
  var ESTADO_ENLACE = { ok: 'Enlace activo', por_revisar: 'Por revisar', retirada: 'Retirada' };
  var COLOR_ENLACE = { ok: '#15803d', por_revisar: '#d97706', retirada: '#718096' };
  var DRIVE_RE = /^https:\/\/(drive|docs)\.google\.com\/\S+$/i;
  var DIAS_AVISO = 30;

  // ── Estado ──
  var empresas = [], trabajadores = [], evidencias = [];
  var empresaById = {};
  var estandares = [], autoevals = [], aeItems = [], planes = [];
  var estandarById = {}, autoById = {}, itemById = {}, itemsPorAuto = {}, planPorAuto = {}, planById = {};
  var tab = 'empresas', editEmpId = null, editTrId = null, editEvId = null;
  var aeId = null;       // autoevaluación abierta en el detalle
  var evlCtx = null;     // { tipo, id, titulo } del registro cuyas evidencias se listan
  var evEntidad = null;  // { tipo, id, empresa_id, titulo } al crear una evidencia desde un estándar o una actividad
  var pmEditId = null, pmAutoId = null;
  // Fase 2: plan anual de trabajo y capacitaciones
  var planesAnual = [], planActs = [], planGrupos = [], caps = [], sesiones = [], asistentes = [], indMes = [];
  var planAnualById = {}, actById = {}, actsPorPlan = {}, capById = {}, sesById = {}, sesPorCap = {}, asisPorSes = {};
  var plSel = null;                 // plan anual abierto en la pestaña
  var plDatosKey = null, plDatosAbierto = null;
  var paEditId = null, paPlanId = null;
  var cpEditId = null, cpCtx = null; // tema: id en edición y { empresa_id, vigencia } al crear
  var cslCapId = null;              // tema cuyas sesiones se listan
  var csEditId = null, csCapId = null;
  var capInit = false;

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function badge(txt, color) { return '<span class="mk-badge" style="background:' + color + ';white-space:nowrap">' + esc(txt) + '</span>'; }
  function optsHtml(lista, vacio, sel) {
    return (vacio !== null ? '<option value="">' + esc(vacio) + '</option>' : '') + lista.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(sel) ? ' selected' : '') + '>' + esc(o.t) + '</option>';
    }).join('');
  }
  function mapOpts(obj) { return Object.keys(obj).map(function (k) { return { v: k, t: obj[k] }; }); }
  function btnBusy(btn, busy) { if (btn) btn.disabled = busy; }
  function fail(accion, error) { showToast('Error al ' + accion + ': ' + errMsg(error), '#e74c3c'); }
  function nombreEmpresa(id) { var e = empresaById[id]; return e ? e.nombre : '—'; }
  function valOrNull(id) { var v = $(id).value.trim(); return v === '' ? null : v; }

  // Vista previa del grupo de estándares (Res. 312, art. 3). La fuente de verdad es el trigger de la BD.
  function grupoPrevio(clases, n) {
    if (clases.indexOf('IV') >= 0 || clases.indexOf('V') >= 0) return '60';
    if (n <= 10) return '7';
    if (n <= 50) return '21';
    return '60';
  }
  function grupoBadge(g) { return badge(g + ' estándares', g === '7' ? '#2563eb' : g === '21' ? '#7c3aed' : '#be185d'); }

  function esActivo(t) { return !t.fecha_retiro || t.fecha_retiro > today(); }
  function safeUrl(u) { return DRIVE_RE.test(String(u || '').trim()) ? String(u).trim() : null; }

  // Estado de vigencia de una evidencia: null = sin vigencia o retirada.
  function vigencia(e) {
    if (!e.vigente_hasta || e.estado_enlace === 'retirada') return null;
    var d = diasEntre(today(), e.vigente_hasta);
    if (d === null) return null;
    if (d < 0) return { clase: 'over', txt: 'Vencida hace ' + (-d) + ' d', vence: true };
    if (d <= DIAS_AVISO) return { clase: 'mid', txt: 'Vence en ' + d + ' d', vence: true };
    return { clase: 'ok', txt: 'Vigente', vence: false };
  }

  // ══════════════ Carga ══════════════
  async function cargar(primera) {
    try {
      var rs = await Promise.all([
        fetchAll('sst_empresas', '*', 'nombre'),
        fetchAll('sst_trabajadores', '*', 'nombre'),
        fetchAll('sst_evidencias', '*', 'id'),
        fetchAll('sst_estandares', '*', 'orden'),
        fetchAll('sst_autoevaluaciones_resumen', '*', 'id'),
        fetchAll('sst_autoeval_items', '*', 'id'),
        fetchAll('sst_plan_mejora', '*', 'id'),
        fetchAll('sst_planes_resumen', '*', 'id'),
        fetchAll('sst_plan_actividades_calc', '*', 'orden'),
        fetchAll('sst_plan_grupo_resumen', '*', 'plan_id'),
        fetchAll('sst_capacitaciones_resumen', '*', 'id'),
        fetchAll('sst_cap_sesiones', '*', 'fecha'),
        fetchAll('sst_cap_asistentes', '*', 'id'),
        fetchAll('sst_cap_indicadores_mes', '*', 'mes'),
        fetchAll('sst_eventos_resumen', '*', 'fecha_evento'),
        fetchAll('sst_acciones_calc', '*', 'fecha_limite'),
        fetchAll('sst_indicadores_mes', '*', 'mes'),
        fetchAll('sst_indicadores_anio', '*', 'vigencia'),
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      empresas = rs[0].data; trabajadores = rs[1].data; evidencias = rs[2].data;
      estandares = rs[3].data; autoevals = rs[4].data; aeItems = rs[5].data; planes = rs[6].data;
      planesAnual = rs[7].data; planActs = rs[8].data; planGrupos = rs[9].data; caps = rs[10].data;
      sesiones = rs[11].data; asistentes = rs[12].data; indMes = rs[13].data;
      eventosR = rs[14].data; accionesC = rs[15].data; indAt = rs[16].data; indAnio = rs[17].data;
    } catch (err) {
      if (primera) {
        $('estado-carga').innerHTML = 'No se pudieron cargar los datos: ' + esc(errMsg(err)) +
          '<br><button class="btn-primary" style="margin-top:12px" data-act="reintentar">Reintentar</button>';
      } else {
        showToast('Error al actualizar: ' + errMsg(err), '#e74c3c');
      }
      return false;
    }
    empresaById = {}; empresas.forEach(function (e) { empresaById[e.id] = e; });
    estandarById = {}; estandares.forEach(function (e) { estandarById[e.id] = e; });
    autoById = {}; autoevals.forEach(function (a) { autoById[a.id] = a; });
    itemById = {}; itemsPorAuto = {};
    aeItems.forEach(function (i) { itemById[i.id] = i; (itemsPorAuto[i.autoeval_id] = itemsPorAuto[i.autoeval_id] || []).push(i); });
    Object.keys(itemsPorAuto).forEach(function (k) {
      itemsPorAuto[k].sort(function (a, b) { return (estandarById[a.estandar_id] ? estandarById[a.estandar_id].orden : 0) - (estandarById[b.estandar_id] ? estandarById[b.estandar_id].orden : 0); });
    });
    planById = {}; planPorAuto = {};
    planes.forEach(function (p) { planById[p.id] = p; (planPorAuto[p.autoeval_id] = planPorAuto[p.autoeval_id] || []).push(p); });
    planAnualById = {}; planesAnual.forEach(function (p) { planAnualById[p.id] = p; });
    actById = {}; actsPorPlan = {};
    planActs.forEach(function (a) { actById[a.id] = a; (actsPorPlan[a.plan_id] = actsPorPlan[a.plan_id] || []).push(a); });
    Object.keys(actsPorPlan).forEach(function (k) { actsPorPlan[k].sort(function (a, b) { return a.orden - b.orden || a.id - b.id; }); });
    capById = {}; caps.forEach(function (c) { capById[c.id] = c; });
    sesById = {}; sesPorCap = {}; asisPorSes = {};
    sesiones.forEach(function (s) { sesById[s.id] = s; (sesPorCap[s.capacitacion_id] = sesPorCap[s.capacitacion_id] || []).push(s); });
    Object.keys(sesPorCap).forEach(function (k) { sesPorCap[k].sort(function (a, b) { return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : b.id - a.id; }); });
    asistentes.forEach(function (a) { (asisPorSes[a.sesion_id] = asisPorSes[a.sesion_id] || []).push(a); });
    eventoById = {}; eventosR.forEach(function (e) { eventoById[e.id] = e; });
    accionById = {}; accionesPorEvento = {};
    accionesC.forEach(function (a) {
      accionById[a.id] = a;
      if (a.evento_id) (accionesPorEvento[a.evento_id] = accionesPorEvento[a.evento_id] || []).push(a);
    });
    $('estado-carga').style.display = 'none';
    $('contenido').style.display = '';
    rellenarFiltros();
    renderTodo();
    return true;
  }

  function rellenarFiltros() {
    var op = empresas.map(function (e) { return { v: e.id, t: e.nombre }; });
    ['ft-empresa', 'fv-empresa', 'fa-empresa'].forEach(function (id) {
      var el = $(id), actual = el.value;
      el.innerHTML = optsHtml(op, 'Todas', actual);
    });
    var cfe = $('cf-empresa'), cfActual = cfe.value;
    cfe.innerHTML = optsHtml(op, null, cfActual);
    if (!capInit) { iniciarFiltroCap(); capInit = true; }
    rellenarFiltrosF3(op);
    var ftipo = $('fv-tipo'), actualTipo = ftipo.value;
    ftipo.innerHTML = optsHtml(mapOpts(TIPO_EVID), 'Todos', actualTipo);
  }

  function renderTodo() {
    renderStats(); renderEmpresas(); renderTrabajadores(); renderAutoevals(); renderPlan(); renderCapacitaciones(); renderEvidencias();
    renderEventos(); renderAcciones(); renderIndicadores();
    cambiarTab(tab);
    if (evtId) { if (eventoById[evtId]) renderEventoDerivado(); else MODAL.close('evt-overlay'); }
    if (aeId) { if (autoById[aeId]) renderAutoDetalle(); else MODAL.close('ae-overlay'); }
    if (cslCapId) { if (capById[cslCapId]) renderSesionesLista(); else MODAL.close('cs-lista-overlay'); }
    if (evlCtx) renderEvl();
  }

  function cambiarTab(t) {
    tab = t;
    ['empresas', 'trabajadores', 'autoevaluacion', 'plan', 'capacitaciones', 'eventos', 'acciones', 'indicadores', 'evidencias'].forEach(function (k) {
      $('tab-' + k).classList.toggle('active', k === t);
      $('tab-' + k).setAttribute('aria-selected', k === t ? 'true' : 'false');
      $('panel-' + k).style.display = k === t ? '' : 'none';
    });
  }

  function renderStats() {
    $('s-empresas').textContent = empresas.filter(function (e) { return e.activa; }).length;
    $('s-trabajadores').textContent = trabajadores.filter(esActivo).length;
    var vivas = evidencias.filter(function (e) { return e.estado_enlace !== 'retirada'; });
    $('s-evidencias').textContent = vivas.length;
    $('s-vencen').textContent = vivas.filter(function (e) { var v = vigencia(e); return v && v.vence; }).length;
    // Plan anual y capacitaciones de la vigencia en curso: actividades vencidas o del mes.
    var y = parseInt(today().slice(0, 4), 10), n = 0;
    planesAnual.forEach(function (p) { if (p.vigencia === y) n += (p.n_vencidas || 0) + (p.n_este_mes || 0); });
    caps.forEach(function (c) { if (c.vigencia === y && (c.semaforo === 'vencida' || c.semaforo === 'este_mes')) n++; });
    $('s-plan').textContent = n;
  }

  // ══════════════ Empresas ══════════════
  function renderEmpresas() {
    $('empresas-ct').textContent = '(' + empresas.length + ')';
    if (!empresas.length) {
      $('empresas-body').innerHTML = '<tr><td colspan="8"><div class="empty">Aún no hay empresas. Crea la primera con «Nueva empresa».</div></td></tr>';
      return;
    }
    $('empresas-body').innerHTML = empresas.map(function (e) {
      var reg = trabajadores.filter(function (t) { return t.empresa_id === e.id && esActivo(t); }).length;
      var difiere = reg !== e.num_trabajadores;
      return '<tr class="mk-click" data-act="emp-editar" data-id="' + esc(e.id) + '">' +
        '<td><strong>' + esc(e.nombre) + '</strong>' + (e.actividades ? '<div class="mk-sin" style="font-style:normal">' + esc(e.actividades) + '</div>' : '') + '</td>' +
        '<td>' + esc(e.nit) + '</td>' +
        '<td>' + esc(e.arl) + '</td>' +
        '<td>' + e.clases_riesgo.map(function (c) { return '<span class="sigla-badge" style="background:#e8f1f8;color:#1a5276">' + esc(c) + '</span>'; }).join(' ') + '</td>' +
        '<td style="text-align:right">' + esc(e.num_trabajadores) +
          '<div class="mk-sub" style="font-size:0.72rem;color:' + (difiere ? '#92400e' : '#718096') + '">' + reg + ' registrados' + (difiere ? ' ⚠' : '') + '</div></td>' +
        '<td>' + grupoBadge(e.grupo_estandares) + '</td>' +
        '<td>' + badge(e.activa ? 'Activa' : 'Inactiva', e.activa ? '#15803d' : '#718096') + '</td>' +
        '<td><button class="btn-ver" data-act="emp-editar" data-id="' + esc(e.id) + '">Editar</button></td>' +
        '</tr>';
    }).join('');
  }

  function previsualizarGrupo() {
    var clases = CLASES.filter(function (c) { return $('e-clase-' + c).checked; });
    var n = parseInt($('e-num').value, 10);
    var el = $('e-grupo');
    if (!clases.length || isNaN(n) || n < 0) { el.textContent = 'Indica las clases de riesgo y el número de trabajadores para ver los estándares aplicables.'; return; }
    el.textContent = 'Estándares mínimos aplicables según la Res. 312 de 2019: ' + grupoPrevio(clases, n) + '. (El sistema lo confirma al guardar.)';
  }

  function abrirEmpresa(id) {
    editEmpId = id || null;
    var e = id ? empresaById[id] : null;
    $('emp-titulo').textContent = e ? 'Editar empresa' : 'Nueva empresa';
    $('e-nombre').value = e ? e.nombre : '';
    $('e-nit').value = e ? e.nit : '';
    $('e-arl').value = e ? e.arl : '';
    $('e-num').value = e ? e.num_trabajadores : '';
    $('e-estado').value = e && !e.activa ? '0' : '1';
    $('e-actividades').value = e ? e.actividades : '';
    $('e-obs').value = e ? e.observaciones : '';
    $('e-clases').innerHTML = CLASES.map(function (c) {
      return '<label><input type="checkbox" id="e-clase-' + c + '" value="' + c + '"' + (e && e.clases_riesgo.indexOf(c) >= 0 ? ' checked' : '') + '> Clase ' + c + '</label>';
    }).join('');
    $('e-aud').innerHTML = e ? auditoriaHtml(e) : '';
    previsualizarGrupo();
    MODAL.open('emp-overlay', 'e-nombre');
  }

  async function guardarEmpresa() {
    var nombre = $('e-nombre').value.trim();
    var clases = CLASES.filter(function (c) { return $('e-clase-' + c).checked; });
    var numTxt = $('e-num').value.trim();
    var n = Number(numTxt);
    if (nombre.length < 2) { showToast('Escribe la razón social', '#e74c3c'); return; }
    if (!clases.length) { showToast('Marca al menos una clase de riesgo', '#e74c3c'); return; }
    if (numTxt === '' || !isFinite(n) || n < 0 || Math.floor(n) !== n) { showToast('El número de trabajadores debe ser un entero mayor o igual a 0', '#e74c3c'); return; }
    var fila = {
      nombre: nombre, nit: $('e-nit').value.trim(), arl: $('e-arl').value.trim(),
      clases_riesgo: clases, num_trabajadores: n, activa: $('e-estado').value === '1',
      actividades: $('e-actividades').value.trim(), observaciones: $('e-obs').value.trim(),
    };
    var btn = $('e-ok'); btnBusy(btn, true);
    var res = editEmpId ? await _sb.from('sst_empresas').update(fila).eq('id', editEmpId) : await _sb.from('sst_empresas').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar la empresa', res.error); return; }
    MODAL.close('emp-overlay');
    showToast(editEmpId ? 'Empresa actualizada' : 'Empresa creada');
    await cargar(false);
  }

  // ══════════════ Trabajadores ══════════════
  function filtrarTrabajadores() {
    var emp = $('ft-empresa').value, est = $('ft-estado').value, q = norm($('ft-txt').value);
    return trabajadores.filter(function (t) {
      if (emp && String(t.empresa_id) !== emp) return false;
      if (est === 'activos' && !esActivo(t)) return false;
      if (est === 'retirados' && esActivo(t)) return false;
      if (q && norm([t.nombre, t.numero_documento, t.cargo].join(' ')).indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderTrabajadores() {
    var lista = filtrarTrabajadores();
    $('trabajadores-ct').textContent = '(' + lista.length + ')';
    if (!lista.length) {
      $('trabajadores-body').innerHTML = '<tr><td colspan="8"><div class="empty">' +
        (trabajadores.length ? 'Ningún trabajador coincide con los filtros.' : 'Aún no hay trabajadores registrados.') + '</div></td></tr>';
      return;
    }
    $('trabajadores-body').innerHTML = lista.map(function (t) {
      return '<tr class="mk-click" data-act="tr-editar" data-id="' + esc(t.id) + '">' +
        '<td><strong>' + esc(t.nombre) + '</strong></td>' +
        '<td>' + esc(t.tipo_documento) + ' ' + esc(t.numero_documento) + '</td>' +
        '<td>' + esc(nombreEmpresa(t.empresa_id)) + '</td>' +
        '<td>' + esc(t.cargo) + '</td>' +
        '<td>' + esc(VINCULACION[t.tipo_vinculacion] || t.tipo_vinculacion) + '</td>' +
        '<td>' + esc(fmtDateOnly(t.fecha_ingreso)) + '</td>' +
        '<td>' + (esActivo(t) ? '<span class="mk-sin">activo</span>' : esc(fmtDateOnly(t.fecha_retiro))) + '</td>' +
        '<td><button class="btn-ver" data-act="tr-editar" data-id="' + esc(t.id) + '">Editar</button></td>' +
        '</tr>';
    }).join('');
  }

  function abrirTrabajador(id) {
    if (!empresas.length) { showToast('Primero crea una empresa', '#e74c3c'); return; }
    editTrId = id || null;
    var t = id ? trabajadores.filter(function (x) { return x.id === id; })[0] : null;
    $('tr-titulo').textContent = t ? 'Editar trabajador' : 'Nuevo trabajador';
    var activas = empresas.filter(function (e) { return e.activa || (t && e.id === t.empresa_id); });
    var emp0 = t ? t.empresa_id : ($('ft-empresa').value || (activas[0] && activas[0].id));
    $('t-empresa').innerHTML = optsHtml(activas.map(function (e) { return { v: e.id, t: e.nombre }; }), null, emp0);
    $('t-nombre').value = t ? t.nombre : '';
    $('t-tipodoc').innerHTML = optsHtml(mapOpts(TIPO_DOC), null, t ? t.tipo_documento : 'CC');
    $('t-numdoc').value = t ? t.numero_documento : '';
    $('t-cargo').value = t ? t.cargo : '';
    $('t-vinc').innerHTML = optsHtml(mapOpts(VINCULACION), null, t ? t.tipo_vinculacion : 'contrato_trabajo');
    $('t-ingreso').value = t && t.fecha_ingreso ? t.fecha_ingreso : '';
    $('t-retiro').value = t && t.fecha_retiro ? t.fecha_retiro : '';
    $('t-aud').innerHTML = t ? auditoriaHtml(t) : '';
    MODAL.open('tr-overlay', 't-nombre');
  }

  async function guardarTrabajador() {
    var nombre = $('t-nombre').value.trim(), doc = $('t-numdoc').value.trim();
    var ingreso = valOrNull('t-ingreso'), retiro = valOrNull('t-retiro');
    if (nombre.length < 3) { showToast('Escribe el nombre completo', '#e74c3c'); return; }
    if (doc.length < 3) { showToast('Escribe el número de documento', '#e74c3c'); return; }
    if (ingreso && retiro && retiro < ingreso) { showToast('La fecha de retiro no puede ser anterior a la de ingreso', '#e74c3c'); return; }
    var fila = {
      empresa_id: Number($('t-empresa').value), nombre: nombre, tipo_documento: $('t-tipodoc').value, numero_documento: doc,
      cargo: $('t-cargo').value.trim(), tipo_vinculacion: $('t-vinc').value, fecha_ingreso: ingreso, fecha_retiro: retiro,
    };
    var btn = $('t-ok'); btnBusy(btn, true);
    var res = editTrId ? await _sb.from('sst_trabajadores').update(fila).eq('id', editTrId) : await _sb.from('sst_trabajadores').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar el trabajador', res.error); return; }
    MODAL.close('tr-overlay');
    showToast(editTrId ? 'Trabajador actualizado' : 'Trabajador registrado');
    await cargar(false);
  }

  // ══════════════ Evidencias ══════════════
  function filtrarEvidencias() {
    var emp = $('fv-empresa').value, tipo = $('fv-tipo').value, est = $('fv-estado').value, vig = $('fv-vigencia').value;
    var q = norm($('fv-txt').value);
    return evidencias.filter(function (e) {
      if (emp && String(e.empresa_id) !== emp) return false;
      if (tipo && e.tipo !== tipo) return false;
      if (est === 'activas' && e.estado_enlace === 'retirada') return false;
      if (est && est !== 'activas' && e.estado_enlace !== est) return false;
      if (vig === 'vencen') { var v = vigencia(e); if (!v || !v.vence) return false; }
      if (q && norm([e.titulo, e.codigo_documento, e.version].join(' ')).indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderEvidencias() {
    var lista = filtrarEvidencias();
    $('evidencias-ct').textContent = '(' + lista.length + ')';
    if (!lista.length) {
      $('evidencias-body').innerHTML = '<tr><td colspan="9"><div class="empty">' +
        (evidencias.length ? 'Ninguna evidencia coincide con los filtros.' : 'Aún no hay evidencias registradas.') + '</div></td></tr>';
      return;
    }
    $('evidencias-body').innerHTML = lista.map(function (e) {
      var url = safeUrl(e.url), v = vigencia(e);
      return '<tr>' +
        '<td><strong>' + esc(e.titulo) + '</strong>' + (respaldaTxt(e) ? '<div class="mk-sin" style="font-style:normal">↳ ' + esc(respaldaTxt(e)) + '</div>' : '') + '</td>' +
        '<td>' + esc(nombreEmpresa(e.empresa_id)) + '</td>' +
        '<td>' + esc(TIPO_EVID[e.tipo] || e.tipo) + '</td>' +
        '<td>' + esc(e.codigo_documento) + '</td>' +
        '<td>' + esc(e.version) + '</td>' +
        '<td>' + esc(fmtDateOnly(e.fecha_documento)) + '</td>' +
        '<td>' + (e.vigente_hasta ? esc(fmtDateOnly(e.vigente_hasta)) + (v ? ' <span class="mk-pill ' + v.clase + '">' + esc(v.txt) + '</span>' : '') : '<span class="mk-sin">—</span>') + '</td>' +
        '<td>' + badge(ESTADO_ENLACE[e.estado_enlace] || e.estado_enlace, COLOR_ENLACE[e.estado_enlace] || '#718096') + '</td>' +
        '<td><div class="mk-actions">' +
          (url ? '<a class="btn-ver" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Abrir ↗</a>' : '<span class="mk-sin">enlace no válido</span>') +
          '<button class="btn-edit" data-act="ev-editar" data-id="' + esc(e.id) + '">Editar</button></div></td>' +
        '</tr>';
    }).join('');
  }

  // A qué respalda una evidencia ('' si es general o el registro ya no existe).
  function respaldaTxt(e) {
    if (e.entidad_tipo === 'autoeval_item') {
      var it = itemById[e.entidad_id], a = it && autoById[it.autoeval_id], est = it && estandarById[it.estandar_id];
      return a && est ? 'Autoevaluación ' + a.vigencia + ' · ' + est.codigo + ' ' + est.nombre : '(estándar eliminado)';
    }
    if (e.entidad_tipo === 'plan_mejora') {
      var p = planById[e.entidad_id], pa = p && autoById[p.autoeval_id];
      return pa ? 'Plan de mejoramiento ' + pa.vigencia + ' · ' + p.actividad.slice(0, 60) : '(actividad eliminada)';
    }
    if (e.entidad_tipo === 'plan') {
      var pl = planAnualById[e.entidad_id];
      return pl ? 'Plan anual ' + pl.vigencia + ' (documento firmado)' : '(plan eliminado)';
    }
    if (e.entidad_tipo === 'plan_actividad') {
      var ac = actById[e.entidad_id];
      return ac ? 'Plan anual ' + ac.vigencia + ' · ' + (ac.item_codigo ? ac.item_codigo + ' ' : '') + ac.actividad.slice(0, 60) : '(actividad eliminada)';
    }
    if (e.entidad_tipo === 'cap_sesion') {
      var se = sesById[e.entidad_id], cp = se && capById[se.capacitacion_id];
      return se && cp ? 'Capacitación ' + fmtDateOnly(se.fecha) + ' · ' + cp.tema.slice(0, 60) : '(sesión eliminada)';
    }
    if (e.entidad_tipo === 'evento') {
      var ev = eventoById[e.entidad_id];
      return ev ? tituloEvento(ev) : '(evento eliminado)';
    }
    if (e.entidad_tipo === 'accion') {
      var ac = accionById[e.entidad_id];
      return ac ? 'Acción: ' + ac.descripcion.slice(0, 70) : '(acción eliminada)';
    }
    return '';
  }

  // abrirEvidencia(id) edita; abrirEvidencia(null, entidad) crea una evidencia que respalda un estándar o una actividad.
  function abrirEvidencia(id, entidad) {
    if (!empresas.length) { showToast('Primero crea una empresa', '#e74c3c'); return; }
    editEvId = id || null;
    evEntidad = !id && entidad ? entidad : null;
    var e = id ? evidencias.filter(function (x) { return x.id === id; })[0] : null;
    $('ev-titulo').textContent = e ? 'Editar evidencia' : 'Nueva evidencia';
    var ctxTxt = e ? respaldaTxt(e) : (evEntidad ? evEntidad.titulo : '');
    $('v-contexto').style.display = ctxTxt ? '' : 'none';
    $('v-contexto').textContent = ctxTxt ? 'Respalda: ' + ctxTxt : '';
    var activas = empresas.filter(function (x) { return x.activa || (e && x.id === e.empresa_id) || (evEntidad && x.id === evEntidad.empresa_id); });
    var emp0 = e ? e.empresa_id : (evEntidad ? evEntidad.empresa_id : ($('fv-empresa').value || (activas[0] && activas[0].id)));
    $('v-empresa').innerHTML = optsHtml(activas.map(function (x) { return { v: x.id, t: x.nombre }; }), null, emp0);
    $('v-empresa').disabled = !!(e && e.entidad_tipo !== 'general') || !!evEntidad;
    $('v-titulo').value = e ? e.titulo : '';
    $('v-url').value = e ? e.url : '';
    $('v-tipo').innerHTML = optsHtml(mapOpts(TIPO_EVID), null, e ? e.tipo : 'documento');
    $('v-codigo').value = e ? e.codigo_documento : '';
    $('v-version').value = e ? e.version : '';
    $('v-estado').innerHTML = optsHtml(mapOpts(ESTADO_ENLACE), null, e ? e.estado_enlace : 'ok');
    $('v-fecha').value = e && e.fecha_documento ? e.fecha_documento : '';
    $('v-vigente').value = e && e.vigente_hasta ? e.vigente_hasta : '';
    $('v-obs').value = e ? e.observaciones : '';
    $('v-aud').innerHTML = e ? auditoriaHtml(e) : '';
    MODAL.open('ev-overlay', 'v-titulo');
  }

  async function guardarEvidencia() {
    var titulo = $('v-titulo').value.trim(), url = $('v-url').value.trim();
    var fecha = valOrNull('v-fecha'), vigente = valOrNull('v-vigente');
    if (titulo.length < 3) { showToast('Escribe el título de la evidencia', '#e74c3c'); return; }
    if (!safeUrl(url)) { showToast('El enlace debe ser de drive.google.com o docs.google.com (https)', '#e74c3c'); return; }
    if (fecha && vigente && vigente < fecha) { showToast('«Vigente hasta» no puede ser anterior a la fecha del documento', '#e74c3c'); return; }
    var fila = {
      empresa_id: Number($('v-empresa').value), titulo: titulo, url: url, tipo: $('v-tipo').value,
      codigo_documento: $('v-codigo').value.trim(), version: $('v-version').value.trim(),
      fecha_documento: fecha, vigente_hasta: vigente, estado_enlace: $('v-estado').value, observaciones: $('v-obs').value.trim(),
    };
    if (!editEvId && evEntidad) { fila.entidad_tipo = evEntidad.tipo; fila.entidad_id = evEntidad.id; }
    var btn = $('v-ok'); btnBusy(btn, true);
    var res = editEvId ? await _sb.from('sst_evidencias').update(fila).eq('id', editEvId) : await _sb.from('sst_evidencias').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar la evidencia', res.error); return; }
    MODAL.close('ev-overlay');
    showToast(editEvId ? 'Evidencia actualizada' : 'Evidencia registrada');
    await cargar(false);
  }

  // ══════════════ Autoevaluación (Res. 312/2019) ══════════════
  // El puntaje, la banda y el plazo del reporte a la ARL los calcula la vista sst_autoevaluaciones_resumen
  // (servidor); aquí solo se muestran. Los pesos de los 7 estándares NO están confirmados
  // (pesos_verificados = false): toda cifra se rotula como referencial.
  var RESULTADO = { pendiente: 'Pendiente', cumple: 'Cumple', no_cumple: 'No cumple' };
  var COLOR_RESULTADO = { pendiente: '#718096', cumple: '#15803d', no_cumple: '#c0392b' };
  var BANDA = { critico: 'Crítico', moderado: 'Moderadamente aceptable', aceptable: 'Aceptable' };
  var COLOR_BANDA = { critico: '#c0392b', moderado: '#d97706', aceptable: '#15803d' };
  var ESTADO_AE = { borrador: 'Borrador', cerrada: 'Cerrada' };
  var COLOR_AE = { borrador: '#d97706', cerrada: '#15803d' };
  var ESTADO_PLAN = { pendiente: 'Pendiente', en_curso: 'En curso', cumplida: 'Cumplida', cancelada: 'Cancelada' };
  var COLOR_PLAN = { pendiente: '#718096', en_curso: '#2563eb', cumplida: '#15803d', cancelada: '#a0aec0' };
  var NOTA_REFERENCIAL = 'Puntaje REFERENCIAL: la ponderación de cada estándar todavía no está confirmada (la Res. 312 solo publica la Tabla de Valores de 60 ítems); hoy todos pesan igual. Verifica la calificación en la aplicación del Ministerio antes de registrarla.';

  function evidenciasDe(tipo, id) {
    return evidencias.filter(function (e) { return e.entidad_tipo === tipo && e.entidad_id === id && e.estado_enlace !== 'retirada'; });
  }
  function fmtPuntaje(p) {
    return p === null || p === undefined ? '—' : Number(p).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' %';
  }
  function bandaBadge(a) { return a.banda ? badge(BANDA[a.banda], COLOR_BANDA[a.banda]) : '<span class="mk-sin">sin calcular</span>'; }
  function implicaBanda(a) {
    var lim = a.fecha_limite_reporte_arl ? fmtDateOnly(a.fecha_limite_reporte_arl) : '';
    if (a.banda === 'critico') return 'Crítico (menos de 60 %): tener de inmediato el plan de mejoramiento disponible para el Ministerio del Trabajo, enviar el reporte de avances a la ARL en máximo 3 meses (límite ' + lim + ') y esperar seguimiento anual y plan de visita del Ministerio.';
    if (a.banda === 'moderado') return 'Moderadamente aceptable (entre 60 % y 85 %): plan de mejoramiento disponible para el Ministerio, reporte de avances a la ARL en máximo 6 meses (límite ' + lim + ') y plan de visita del Ministerio.';
    if (a.banda === 'aceptable') return 'Aceptable (más de 85 %): mantener la calificación y las evidencias a disposición del Ministerio e incluir en el plan anual las mejoras que resulten de la evaluación.';
    return 'Califica los estándares para ver el resultado.';
  }

  function reporteInfo(a) {
    if (a.estado !== 'cerrada') return '<span class="mk-sin">—</span>';
    if (!a.fecha_limite_reporte_arl) return '<span class="mk-sin">' + (a.banda === 'aceptable' ? 'No aplica (aceptable)' : '—') + '</span>';
    if (a.reporte_avances_arl_en) return 'Enviado ' + esc(fmtDateOnly(a.reporte_avances_arl_en));
    var d = diasEntre(today(), a.fecha_limite_reporte_arl);
    var pill = d === null ? '' : d < 0 ? '<span class="mk-pill over">Vencido hace ' + (-d) + ' d</span>'
      : d <= DIAS_AVISO ? '<span class="mk-pill mid">Vence en ' + d + ' d</span>' : '<span class="mk-pill ok">En plazo</span>';
    return 'Límite ' + esc(fmtDateOnly(a.fecha_limite_reporte_arl)) + ' ' + pill;
  }

  function filtrarAutoevals() {
    var emp = $('fa-empresa').value, est = $('fa-estado').value;
    return autoevals.filter(function (a) {
      if (emp && String(a.empresa_id) !== emp) return false;
      if (est && a.estado !== est) return false;
      return true;
    }).sort(function (x, y) { return y.vigencia - x.vigencia || String(nombreEmpresa(x.empresa_id)).localeCompare(String(nombreEmpresa(y.empresa_id))); });
  }

  function renderAutoevals() {
    var lista = filtrarAutoevals();
    $('autoevaluaciones-ct').textContent = '(' + lista.length + ')';
    if (!lista.length) {
      $('autoevaluaciones-body').innerHTML = '<tr><td colspan="9"><div class="empty">' +
        (autoevals.length ? 'Ninguna autoevaluación coincide con los filtros.' : 'Aún no hay autoevaluaciones. Crea la primera con «Nueva autoevaluación».') + '</div></td></tr>';
      return;
    }
    $('autoevaluaciones-body').innerHTML = lista.map(function (a) {
      return '<tr class="mk-click" data-act="ae-abrir" data-id="' + esc(a.id) + '">' +
        '<td><strong>' + esc(nombreEmpresa(a.empresa_id)) + '</strong></td>' +
        '<td>' + esc(a.vigencia) + '</td>' +
        '<td>' + esc(fmtDateOnly(a.fecha_evaluacion)) + '</td>' +
        '<td>' + grupoBadge(a.grupo_estandares) + '</td>' +
        '<td>' + badge(ESTADO_AE[a.estado] || a.estado, COLOR_AE[a.estado] || '#718096') + '</td>' +
        '<td style="text-align:right"><strong>' + esc(fmtPuntaje(a.puntaje)) + '</strong>' +
          '<div class="mk-sub" style="font-size:0.72rem;color:#718096">' + esc(a.items_cumple) + ' de ' + esc(a.items_total) + ' cumplen' +
          (a.items_pendientes ? ' · ' + esc(a.items_pendientes) + ' pendientes' : '') + '</div>' +
          (a.pesos_verificados ? '' : '<div style="font-size:0.7rem;color:#92400e">referencial</div>') + '</td>' +
        '<td>' + (a.items_pendientes ? '<span class="mk-sin">en curso</span>' : bandaBadge(a)) + '</td>' +
        '<td>' + reporteInfo(a) + '</td>' +
        '<td><button class="btn-ver" data-act="ae-abrir" data-id="' + esc(a.id) + '">Abrir</button></td>' +
        '</tr>';
    }).join('');
  }

  // ── Nueva autoevaluación ──
  function actualizarNuevaAuto() {
    var empId = Number($('an-empresa').value), vig = parseInt($('an-vigencia').value, 10);
    var emp = empresaById[empId], aviso = '', bloquea = false;
    if (emp) {
      var hayCatalogo = estandares.some(function (e) { return e.grupo === emp.grupo_estandares && e.activo; });
      aviso = 'Esta empresa evalúa el grupo de ' + emp.grupo_estandares + ' estándares.';
      if (!hayCatalogo) { aviso += ' Aún no está cargado el catálogo de ese grupo: no se puede crear la autoevaluación.'; bloquea = true; }
      var dup = autoevals.filter(function (a) { return a.empresa_id === empId && a.vigencia === vig; })[0];
      if (dup) { aviso += ' Ya existe la autoevaluación ' + vig + ' de esta empresa (está ' + (ESTADO_AE[dup.estado] || dup.estado).toLowerCase() + ').'; bloquea = true; }
      // Sugerir los firmantes de la última autoevaluación de la empresa.
      var previa = autoevals.filter(function (a) { return a.empresa_id === empId; }).sort(function (x, y) { return y.vigencia - x.vigencia; })[0];
      if (previa && !$('an-empleador').dataset.tocado) $('an-empleador').value = previa.empleador_nombre || '';
      if (previa && !$('an-responsable').dataset.tocado) $('an-responsable').value = previa.responsable_nombre || '';
    }
    $('an-grupo').textContent = aviso;
    $('an-ok').disabled = bloquea;
  }

  function abrirNuevaAuto() {
    var activas = empresas.filter(function (e) { return e.activa; });
    if (!activas.length) { showToast('Primero crea una empresa activa', '#e74c3c'); return; }
    var emp0 = $('fa-empresa').value || activas[0].id;
    $('an-empresa').innerHTML = optsHtml(activas.map(function (e) { return { v: e.id, t: e.nombre }; }), null, emp0);
    $('an-vigencia').value = new Date().getFullYear();
    $('an-fecha').value = today();
    $('an-empleador').value = ''; $('an-responsable').value = '';
    delete $('an-empleador').dataset.tocado; delete $('an-responsable').dataset.tocado;
    actualizarNuevaAuto();
    MODAL.open('ae-nueva-overlay', 'an-empresa');
  }

  async function crearAuto() {
    var empId = Number($('an-empresa').value), vig = parseInt($('an-vigencia').value, 10), fecha = $('an-fecha').value;
    if (!empId) { showToast('Elige la empresa', '#e74c3c'); return; }
    if (isNaN(vig) || vig < 2019 || vig > 2100) { showToast('La vigencia debe ser un año entre 2019 y 2100', '#e74c3c'); return; }
    if (!fecha) { showToast('Indica la fecha de la evaluación', '#e74c3c'); return; }
    var btn = $('an-ok'); btnBusy(btn, true);
    var res = await _sb.from('sst_autoevaluaciones').insert({
      empresa_id: empId, vigencia: vig, fecha_evaluacion: fecha,
      empleador_nombre: $('an-empleador').value.trim(), responsable_nombre: $('an-responsable').value.trim(),
    });
    btnBusy(btn, false);
    if (res.error) { fail('crear la autoevaluación', res.error); return; }
    MODAL.close('ae-nueva-overlay');
    showToast('Autoevaluación creada');
    await cargar(false);
    var nueva = autoevals.filter(function (a) { return a.empresa_id === empId && a.vigencia === vig; })[0];
    if (nueva) abrirAuto(nueva.id);
  }

  // ── Detalle ──
  function abrirAuto(id) {
    aeId = id;
    renderAutoDetalle();
    MODAL.open('ae-overlay');
  }

  function renderAutoDetalle() {
    var a = autoById[aeId];
    if (!a) return;
    var emp = empresaById[a.empresa_id] || { nombre: '—' };
    var borrador = a.estado === 'borrador';
    var items = itemsPorAuto[a.id] || [];
    var plan = planPorAuto[a.id] || [];
    var body = $('ae-body'), scroll = body.scrollTop;

    $('ae-titulo').textContent = 'Autoevaluación ' + a.vigencia + ' — ' + emp.nombre;
    $('ae-meta').innerHTML = '<span>' + esc(a.grupo_estandares) + ' estándares mínimos</span>' +
      '<span>Evaluada el ' + esc(fmtDateOnly(a.fecha_evaluacion)) + '</span>' +
      '<span>' + esc(ESTADO_AE[a.estado] || a.estado) + (a.cerrada_en ? ' por ' + esc(a.cerrada_por_nombre || '—') + ' el ' + esc(fmtDateTime(a.cerrada_en)) : '') + '</span>';

    var h = '';
    if (!a.pesos_verificados) h += '<div class="mk-flag">⚠ ' + esc(NOTA_REFERENCIAL) + '</div>';

    // Resultado + qué implica
    h += '<div class="mk-ctx-grid">' +
      '<div class="mk-box"><h4>Resultado' + (borrador ? ' (borrador)' : '') + '</h4>' +
        '<div style="font-size:2rem;font-weight:700">' + esc(fmtPuntaje(a.puntaje)) + '</div>' +
        '<div style="margin:4px 0 8px">' + (a.items_pendientes ? '<span class="mk-sin">faltan ' + esc(a.items_pendientes) + ' estándar(es) por calificar</span>' : bandaBadge(a)) + '</div>' +
        '<div class="mk-kv"><span>Cumplen</span><span>' + esc(a.items_cumple) + '</span></div>' +
        '<div class="mk-kv"><span>No cumplen</span><span>' + esc(a.items_no_cumple) + '</span></div>' +
        '<div class="mk-kv"><span>Pendientes</span><span>' + esc(a.items_pendientes) + '</span></div></div>' +
      '<div class="mk-box"><h4>Qué implica (Res. 312, art. 28)</h4><div style="font-size:0.84rem;line-height:1.45">' + esc(a.items_pendientes ? 'Califica todos los estándares para ver el resultado y lo que implica.' : implicaBanda(a)) + '</div></div>' +
      '</div>';

    // Estándares
    h += '<div class="mk-box" style="margin-bottom:14px"><h4>Calificación por estándar</h4>' +
      '<div class="table-wrap"><table class="mk-mini" style="min-width:820px"><thead><tr><th>Código</th><th style="min-width:240px">Estándar</th><th>Resultado</th><th>Evidencias</th><th style="min-width:170px">Observaciones</th><th></th></tr></thead><tbody>' +
      items.map(function (i) {
        var est = estandarById[i.estandar_id] || { codigo: '?', nombre: '(estándar no disponible)', criterio: '', verificacion: '', ciclo: '' };
        var nEv = evidenciasDe('autoeval_item', i.id).length;
        return '<tr>' +
          '<td><strong>' + esc(est.codigo) + '</strong><div class="mk-sin">' + esc(est.ciclo) + '</div></td>' +
          '<td><strong>' + esc(est.nombre) + '</strong>' +
            '<details style="margin-top:3px"><summary style="cursor:pointer;color:#1a5276;font-size:0.76rem">Criterio y modo de verificación</summary>' +
            '<div style="font-size:0.76rem;color:#4a5568;margin-top:4px"><strong>Criterio:</strong> ' + esc(est.criterio) + '</div>' +
            '<div style="font-size:0.76rem;color:#4a5568;margin-top:3px"><strong>Verificación:</strong> ' + esc(est.verificacion) + '</div></details></td>' +
          '<td>' + (borrador
            ? '<select class="ef" style="min-width:118px" data-chg="ae-item-resultado" data-id="' + esc(i.id) + '" aria-label="Resultado de ' + esc(est.codigo) + '">' +
              optsHtml(mapOpts(RESULTADO), null, i.resultado) + '</select>'
            : badge(RESULTADO[i.resultado] || i.resultado, COLOR_RESULTADO[i.resultado] || '#718096')) + '</td>' +
          '<td><button class="btn-secondary" data-act="evl-abrir" data-tipo="autoeval_item" data-id="' + esc(i.id) + '">🔗 ' + nEv + '</button></td>' +
          '<td>' + (borrador
            ? '<input class="ef" data-chg="ae-item-obs" data-id="' + esc(i.id) + '" maxlength="500" value="' + esc(i.observaciones) + '" aria-label="Observaciones de ' + esc(est.codigo) + '">'
            : esc(i.observaciones)) + '</td>' +
          '<td>' + (i.resultado === 'no_cumple' ? '<button class="btn-edit" data-act="pm-nuevo-item" data-id="' + esc(i.id) + '">➕ Plan</button>' : '') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div></div>';

    // Plan de mejoramiento
    var hayNoCumple = items.some(function (i) { return i.resultado === 'no_cumple'; });
    h += '<div class="mk-box" style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
      '<h4 style="margin:0">Plan de mejoramiento</h4><button class="btn-primary sm" data-act="pm-nuevo">➕ Actividad</button></div>';
    if (!plan.length && (hayNoCumple || a.banda === 'critico' || a.banda === 'moderado')) {
      h += '<div class="mk-flag">Hay estándares que no cumplen o el resultado exige plan: registra aquí las actividades (con responsable, plazo y recursos) y sus soportes.</div>';
    }
    if (!plan.length) {
      h += '<div class="empty" style="padding:16px">Sin actividades en el plan.</div>';
    } else {
      h += '<div class="table-wrap"><table class="mk-mini" style="min-width:820px"><thead><tr><th style="min-width:220px">Actividad</th><th>Estándar</th><th>Responsable</th><th>Plazo</th><th>Recursos</th><th>Estado</th><th>Soportes</th><th></th></tr></thead><tbody>' +
        plan.map(function (p) {
          var it = p.item_id ? itemById[p.item_id] : null, est = it ? estandarById[it.estandar_id] : null;
          var vencida = p.plazo && (p.estado === 'pendiente' || p.estado === 'en_curso') && p.plazo < today();
          return '<tr>' +
            '<td>' + esc(p.actividad) + '</td>' +
            '<td>' + esc(est ? est.codigo : '—') + '</td>' +
            '<td>' + esc(p.responsable) + '</td>' +
            '<td>' + esc(fmtDateOnly(p.plazo)) + (vencida ? ' <span class="mk-pill over">Vencida</span>' : '') + '</td>' +
            '<td>' + esc(p.recursos) + '</td>' +
            '<td>' + badge(ESTADO_PLAN[p.estado] || p.estado, COLOR_PLAN[p.estado] || '#718096') + (p.fecha_cumplimiento ? '<div class="mk-sin">' + esc(fmtDateOnly(p.fecha_cumplimiento)) + '</div>' : '') + '</td>' +
            '<td><button class="btn-secondary" data-act="evl-abrir" data-tipo="plan_mejora" data-id="' + esc(p.id) + '">🔗 ' + evidenciasDe('plan_mejora', p.id).length + '</button></td>' +
            '<td><button class="btn-edit" data-act="pm-editar" data-id="' + esc(p.id) + '">Editar</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>';
    }
    h += '</div>';

    // Datos de la evaluación y firmas
    h += '<div class="mk-box" style="margin-bottom:14px"><h4>Datos de la evaluación y firmas</h4>';
    if (borrador) {
      h += '<div class="form-grid cols2" style="margin-bottom:10px">' +
        '<div><label class="ef-label" for="ae-f-fecha">Fecha de la evaluación</label><input class="ef" id="ae-f-fecha" type="date" value="' + esc(a.fecha_evaluacion) + '"></div>' +
        '<div></div>' +
        '<div><label class="ef-label" for="ae-f-empleador">Empleador o representante legal</label><input class="ef" id="ae-f-empleador" maxlength="200" value="' + esc(a.empleador_nombre) + '"></div>' +
        '<div><label class="ef-label" for="ae-f-responsable">Responsable del SG-SST</label><input class="ef" id="ae-f-responsable" maxlength="200" value="' + esc(a.responsable_nombre) + '"></div>' +
        '<div style="grid-column:1/-1"><label class="ef-label" for="ae-f-obs">Observaciones generales</label><textarea class="ef" id="ae-f-obs" rows="2" maxlength="1000">' + esc(a.observaciones) + '</textarea></div></div>' +
        '<button class="btn-secondary" data-act="ae-guardar-datos">Guardar datos</button>';
    } else {
      h += '<div class="mk-kv"><span>Fecha de la evaluación</span><span>' + esc(fmtDateOnly(a.fecha_evaluacion)) + '</span></div>' +
        '<div class="mk-kv"><span>Empleador o representante legal</span><span>' + esc(a.empleador_nombre || '—') + '</span></div>' +
        '<div class="mk-kv"><span>Responsable del SG-SST</span><span>' + esc(a.responsable_nombre || '—') + '</span></div>' +
        (a.observaciones ? '<div class="mk-kv"><span>Observaciones</span><span>' + esc(a.observaciones) + '</span></div>' : '');
    }
    h += '</div>';

    // Seguimiento del reporte (arts. 26 y 28)
    h += '<div class="mk-box"><h4>Seguimiento del reporte</h4>';
    if (borrador) {
      h += '<div class="ef-help">Se habilita al cerrar la autoevaluación: aquí se registra cuándo se envió la copia y el reporte de avances a la ARL y cuándo se registró en la aplicación del Ministerio del Trabajo.</div>';
    } else {
      h += '<div class="form-grid" style="margin-bottom:10px">' +
        '<div><label class="ef-label" for="ae-f-copia">Copia a la ARL (autoevaluación y plan)</label><input class="ef" id="ae-f-copia" type="date" value="' + esc(a.copia_arl_en || '') + '"></div>' +
        '<div><label class="ef-label" for="ae-f-reporte">Reporte de avances a la ARL' + (a.fecha_limite_reporte_arl ? ' (límite ' + esc(fmtDateOnly(a.fecha_limite_reporte_arl)) + ')' : '') + '</label><input class="ef" id="ae-f-reporte" type="date" value="' + esc(a.reporte_avances_arl_en || '') + '"></div>' +
        '<div><label class="ef-label" for="ae-f-registro">Registro en la aplicación del Ministerio</label><input class="ef" id="ae-f-registro" type="date" value="' + esc(a.registro_ministerio_en || '') + '"></div></div>' +
        '<button class="btn-secondary" data-act="ae-guardar-fechas">Guardar fechas</button>';
    }
    h += '</div>' + auditoriaHtml(a);

    body.innerHTML = h;
    body.scrollTop = scroll;
    $('ae-btn-cerrar').style.display = borrador ? '' : 'none';
    $('ae-btn-reabrir').style.display = !borrador && AUTH.isAdmin() ? '' : 'none';
  }

  async function actualizarAuto(campos, okMsg, accion) {
    var res = await _sb.from('sst_autoevaluaciones').update(campos).eq('id', aeId);
    if (res.error) { fail(accion, res.error); await cargar(false); return false; }
    if (okMsg) showToast(okMsg);
    await cargar(false);
    return true;
  }

  async function cambiarResultadoItem(el) {
    var res = await _sb.from('sst_autoeval_items').update({ resultado: el.value }).eq('id', Number(el.getAttribute('data-id')));
    if (res.error) fail('guardar la calificación', res.error);
    await cargar(false);
  }
  async function cambiarObsItem(el) {
    var res = await _sb.from('sst_autoeval_items').update({ observaciones: el.value.trim() }).eq('id', Number(el.getAttribute('data-id')));
    if (res.error) fail('guardar la observación', res.error);
    await cargar(false);
  }

  function guardarDatosAuto() {
    var fecha = $('ae-f-fecha').value;
    if (!fecha) { showToast('Indica la fecha de la evaluación', '#e74c3c'); return; }
    actualizarAuto({
      fecha_evaluacion: fecha, empleador_nombre: $('ae-f-empleador').value.trim(),
      responsable_nombre: $('ae-f-responsable').value.trim(), observaciones: $('ae-f-obs').value.trim(),
    }, 'Datos guardados', 'guardar los datos');
  }
  function guardarFechasAuto() {
    actualizarAuto({
      copia_arl_en: valOrNull('ae-f-copia'), reporte_avances_arl_en: valOrNull('ae-f-reporte'), registro_ministerio_en: valOrNull('ae-f-registro'),
    }, 'Fechas guardadas', 'guardar las fechas');
  }
  function cerrarAuto() {
    var a = autoById[aeId];
    if (!a) return;
    if (a.items_pendientes) { showToast('Faltan ' + a.items_pendientes + ' estándar(es) por calificar', '#e74c3c'); return; }
    if (!window.confirm('¿Cerrar la autoevaluación ' + a.vigencia + '?\n\nLa calificación quedará congelada y solo un administrador podrá reabrirla.' + (a.pesos_verificados ? '' : '\n\nRecuerda: el puntaje es referencial (pesos sin confirmar).'))) return;
    actualizarAuto({ estado: 'cerrada' }, 'Autoevaluación cerrada', 'cerrar la autoevaluación');
  }
  function reabrirAuto() {
    var a = autoById[aeId];
    if (!a || !window.confirm('¿Reabrir la autoevaluación ' + a.vigencia + '? Volverá a ser un borrador editable.')) return;
    actualizarAuto({ estado: 'borrador' }, 'Autoevaluación reabierta', 'reabrir la autoevaluación');
  }

  function generarPdfAuto() {
    var a = autoById[aeId];
    if (!a) return;
    try {
      var emp = empresaById[a.empresa_id] || {};
      var items = (itemsPorAuto[a.id] || []).map(function (i) {
        return { item: i, estandar: estandarById[i.estandar_id], evidencias: evidenciasDe('autoeval_item', i.id) };
      }).filter(function (r) { return r.estandar; });
      var plan = (planPorAuto[a.id] || []).map(function (p) {
        var it = p.item_id ? itemById[p.item_id] : null, est = it ? estandarById[it.estandar_id] : null;
        return { plan: p, codigo: est ? est.codigo : '', evidencias: evidenciasDe('plan_mejora', p.id) };
      });
      var doc = SST_PDF.autoevaluacion({ empresa: emp, auto: a, items: items, plan: plan, ahora: new Date() });
      doc.save(SST_PDF.nombreArchivo(emp, a));
    } catch (err) {
      showToast('No se pudo generar el PDF: ' + (err && err.message ? err.message : err), '#e74c3c');
    }
  }

  // ── Evidencias de un estándar o de una actividad del plan ──
  function abrirEvl(tipo, id) {
    var titulo, empresaId;
    if (tipo === 'autoeval_item') {
      var it = itemById[id], a = it && autoById[it.autoeval_id], est = it && estandarById[it.estandar_id];
      if (!a || !est) return;
      titulo = 'Autoevaluación ' + a.vigencia + ' · ' + est.codigo + ' ' + est.nombre; empresaId = a.empresa_id;
    } else if (tipo === 'plan') {
      var pln = planAnualById[id];
      if (!pln) return;
      titulo = 'Plan anual ' + pln.vigencia + ' · documento firmado'; empresaId = pln.empresa_id;
    } else if (tipo === 'plan_actividad') {
      var ac = actById[id], pac = ac && planAnualById[ac.plan_id];
      if (!pac) return;
      titulo = 'Plan anual ' + pac.vigencia + ' · ' + (ac.item_codigo ? ac.item_codigo + ' ' : '') + ac.actividad.slice(0, 60); empresaId = pac.empresa_id;
    } else if (tipo === 'cap_sesion') {
      var se = sesById[id], cp = se && capById[se.capacitacion_id];
      if (!cp) return;
      titulo = 'Capacitación ' + fmtDateOnly(se.fecha) + ' · ' + cp.tema.slice(0, 60); empresaId = cp.empresa_id;
    } else if (tipo === 'evento') {
      var evt = eventoById[id];
      if (!evt) return;
      titulo = tituloEvento(evt); empresaId = evt.empresa_id;
    } else if (tipo === 'accion') {
      var acn = accionById[id];
      if (!acn) return;
      titulo = 'Acción: ' + acn.descripcion.slice(0, 70); empresaId = acn.empresa_id;
    } else {
      var p = planById[id], pa = p && autoById[p.autoeval_id];
      if (!pa) return;
      titulo = 'Plan de mejoramiento ' + pa.vigencia + ' · ' + p.actividad.slice(0, 60); empresaId = pa.empresa_id;
    }
    evlCtx = { tipo: tipo, id: id, titulo: titulo, empresa_id: empresaId };
    renderEvl();
    MODAL.open('evl-overlay');
  }
  function renderEvl() {
    if (!evlCtx) return;
    $('evl-titulo').textContent = evlCtx.titulo;
    var lista = evidenciasDe(evlCtx.tipo, evlCtx.id);
    $('evl-body').innerHTML = !lista.length
      ? '<div class="empty" style="padding:24px">Aún no hay enlaces. Agrega el documento o la carpeta de Drive que respalda este registro.</div>'
      : '<table class="mk-mini"><thead><tr><th>Título</th><th>Tipo</th><th>Código</th><th>Enlace</th><th></th></tr></thead><tbody>' +
        lista.map(function (e) {
          var url = safeUrl(e.url);
          return '<tr><td><strong>' + esc(e.titulo) + '</strong></td><td>' + esc(TIPO_EVID[e.tipo] || e.tipo) + '</td><td>' + esc(e.codigo_documento) + '</td>' +
            '<td>' + badge(ESTADO_ENLACE[e.estado_enlace] || e.estado_enlace, COLOR_ENLACE[e.estado_enlace] || '#718096') + '</td>' +
            '<td><div class="mk-actions">' + (url ? '<a class="btn-ver" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Abrir ↗</a>' : '') +
            '<button class="btn-edit" data-act="ev-editar" data-id="' + esc(e.id) + '">Editar</button></div></td></tr>';
        }).join('') + '</tbody></table>';
  }

  // ── Plan de mejoramiento ──
  function abrirPlan(id, autoId, itemId) {
    var p = id ? planById[id] : null;
    pmEditId = id || null;
    pmAutoId = p ? p.autoeval_id : autoId;
    var items = itemsPorAuto[pmAutoId] || [];
    var a = autoById[pmAutoId];
    var itSel = p ? p.item_id : (itemId || null);
    var estSel = itSel && itemById[itSel] ? estandarById[itemById[itSel].estandar_id] : null;
    $('pm-titulo').textContent = p ? 'Editar actividad del plan' : 'Nueva actividad del plan';
    $('pm-actividad').value = p ? p.actividad : (estSel ? 'Subsanar: ' + estSel.nombre : '');
    $('pm-item').innerHTML = optsHtml(items.map(function (i) {
      var e = estandarById[i.estandar_id] || { codigo: '?', nombre: '' };
      return { v: i.id, t: e.codigo + ' · ' + e.nombre };
    }), 'Sin estándar específico', itSel || '');
    $('pm-responsable').value = p ? p.responsable : (a ? a.responsable_nombre : '');
    $('pm-plazo').value = p && p.plazo ? p.plazo : '';
    $('pm-recursos').value = p ? p.recursos : '';
    $('pm-estado').innerHTML = optsHtml(mapOpts(ESTADO_PLAN), null, p ? p.estado : 'pendiente');
    $('pm-cumplimiento').value = p && p.fecha_cumplimiento ? p.fecha_cumplimiento : '';
    $('pm-obs').value = p ? p.observaciones : '';
    $('pm-aud').innerHTML = p ? auditoriaHtml(p) : '';
    MODAL.open('pm-overlay', 'pm-actividad');
  }

  async function guardarPlan() {
    var actividad = $('pm-actividad').value.trim();
    if (actividad.length < 3) { showToast('Describe la actividad del plan', '#e74c3c'); return; }
    var itemId = $('pm-item').value ? Number($('pm-item').value) : null;
    var fila = {
      item_id: itemId, actividad: actividad, responsable: $('pm-responsable').value.trim(), plazo: valOrNull('pm-plazo'),
      recursos: $('pm-recursos').value.trim(), estado: $('pm-estado').value, observaciones: $('pm-obs').value.trim(),
    };
    if (!pmEditId) fila.autoeval_id = pmAutoId;
    var btn = $('pm-ok'); btnBusy(btn, true);
    var res = pmEditId ? await _sb.from('sst_plan_mejora').update(fila).eq('id', pmEditId) : await _sb.from('sst_plan_mejora').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar la actividad', res.error); return; }
    MODAL.close('pm-overlay');
    showToast(pmEditId ? 'Actividad actualizada' : 'Actividad agregada al plan');
    await cargar(false);
  }

  // ══════════════ Fase 2: Plan anual de trabajo ══════════════
  // El avance, lo esperado a la fecha y el semáforo los calculan las vistas sst_plan_actividades_calc /
  // sst_planes_resumen / sst_plan_grupo_resumen (servidor); aquí solo se muestran. Las alertas son solo en pantalla.
  var MES3 = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  var MES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var CICLOS = { planear: 'Planear', hacer: 'Hacer', verificar: 'Verificar', actuar: 'Actuar' };
  var SEMAFORO = {
    ejecutada: ['Ejecutada', '#15803d'], vencida: ['Vencida', '#c0392b'], este_mes: ['Del mes', '#d97706'], al_dia: ['Al día', '#2563eb'],
    sin_programar: ['Sin programar', '#718096'], no_aplica: ['No aplica', '#a0aec0'], inactiva: ['Inactivo', '#a0aec0'],
  };
  var ESTADO_SESION = { programada: 'Programada', realizada: 'Realizada', cancelada: 'Cancelada' };
  var COLOR_SESION = { programada: '#2563eb', realizada: '#15803d', cancelada: '#a0aec0' };
  var MODALIDADES = { presencial: 'Presencial', virtual: 'Virtual', mixta: 'Mixta' };

  function semBadge(s) { var x = SEMAFORO[s] || [s, '#718096']; return badge(x[0], x[1]); }
  function fmtPct1(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' %'; }
  function fmtNum(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: 3 }); }
  function nums(arr) { return (arr || []).map(Number); }
  // Mes de referencia de una vigencia: 13 = ya pasó, 0 = futura, 1-12 = mes en curso (igual que sst_mes_ref en el servidor).
  function mesRef(vig) {
    var y = parseInt(today().slice(0, 4), 10), m = parseInt(today().slice(5, 7), 10);
    return vig < y ? 13 : vig > y ? 0 : m;
  }
  function mesesHead() { return '<span class="sst-mes-head">' + MES3.map(function (m) { return '<span>' + m + '</span>'; }).join('') + '</span>'; }
  // Cuadrícula de 12 meses: P programado, E ejecutado, rojo = programado vencido. Con `accion`, los meses P/E son clicables.
  function mesesHtml(prog, ejec, vig, semaforo, accion, id) {
    var P = nums(prog), E = nums(ejec), ref = mesRef(vig), out = '<span class="sst-meses">';
    for (var m = 1; m <= 12; m++) {
      var p = P.indexOf(m) >= 0, e = E.indexOf(m) >= 0;
      var cls = e ? 'e' : p ? (semaforo === 'vencida' && m < ref ? 'v' : 'p') : '';
      var click = accion && (p || e);
      out += '<span class="sst-m ' + cls + (click ? ' click' : '') + (m === ref ? ' ahora' : '') + '"' +
        (click ? ' data-act="' + accion + '" data-id="' + esc(id) + '" data-mes="' + m + '" role="button" title="' + (e ? 'Quitar la ejecución de ' : 'Marcar como ejecutado en ') + MES_LARGO[m - 1] + '"'
               : ' title="' + MES_LARGO[m - 1] + (p ? ' (programado)' : '') + (e ? ' (ejecutado)' : '') + '"') + '>' + (e ? 'E' : p ? 'P' : '·') + '</span>';
    }
    return out + '</span>';
  }
  function barraHtml(pct, esp) {
    if (pct === null || pct === undefined) return '<span class="mk-sin">—</span>';
    return '<div class="sst-bar" title="Ejecutado ' + esc(fmtPct1(pct)) + (esp !== null && esp !== undefined ? ' · esperado a la fecha ' + esc(fmtPct1(esp)) : '') + '">' +
      '<i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i>' +
      (esp !== null && esp !== undefined ? '<b style="left:' + Math.max(0, Math.min(100, esp)) + '%"></b>' : '') + '</div>';
  }

  function planesOrdenados() {
    return planesAnual.slice().sort(function (a, b) {
      return b.vigencia - a.vigencia || String(nombreEmpresa(a.empresa_id)).localeCompare(String(nombreEmpresa(b.empresa_id)));
    });
  }
  function planPorDefecto(lista) {
    var y = parseInt(today().slice(0, 4), 10);
    return lista.filter(function (p) { return p.vigencia === y; })[0] || lista[0];
  }

  function renderPlan() {
    var lista = planesOrdenados(), sel = $('pl-plan');
    if (!lista.length) {
      plSel = null; sel.innerHTML = '';
      $('pl-vacio').style.display = ''; $('pl-contenido').style.display = 'none';
      return;
    }
    if (!plSel || !planAnualById[plSel]) plSel = planPorDefecto(lista).id;
    sel.innerHTML = optsHtml(lista.map(function (p) { return { v: p.id, t: nombreEmpresa(p.empresa_id) + ' — ' + p.vigencia }; }), null, plSel);
    $('pl-vacio').style.display = 'none'; $('pl-contenido').style.display = '';
    $('pa-th-meses').innerHTML = mesesHead();
    renderPlanResumen(); renderPlanDatos(); renderPlanFiltros(); renderActividades();
  }

  function sumaCiclo(planId, ciclo) {
    var t = 0, e = 0, x = 0, nv = 0, nm = 0;
    planGrupos.forEach(function (g) {
      if (g.plan_id !== planId || g.ciclo !== ciclo) return;
      t += Number(g.peso_total); e += Number(g.peso_ejecutado); x += Number(g.peso_esperado); nv += g.n_vencidas; nm += g.n_este_mes;
    });
    return { total: t, pct: t > 0 ? 100 * e / t : null, esp: t > 0 ? 100 * x / t : null, nv: nv, nm: nm };
  }

  function planFaltantes(p) {
    var f = [];
    if (!p.objetivo) f.push('objetivos');
    if (!p.metas) f.push('metas');
    if (!p.recursos) f.push('recursos');
    if (!p.firmado_en) f.push('firma del empleador');
    if (!evidenciasDe('plan', p.id).length) f.push('enlace al plan firmado en Drive');
    return f;
  }

  function renderPlanResumen() {
    var p = planAnualById[plSel];
    var h = '';
    var falt = planFaltantes(p);
    if (falt.length) {
      h += '<div class="mk-flag">Para cumplir el estándar «Plan Anual de Trabajo» (firmado por el empleador, con objetivos, metas, responsabilidades, recursos y cronograma) todavía falta: <strong>' + esc(falt.join(', ')) + '</strong>. Las responsabilidades y el cronograma salen de las actividades.</div>';
    }
    h += '<div class="mk-ctx-grid">' +
      '<div class="mk-box"><h4>Cumplimiento del plan ' + esc(p.vigencia) + ' — ' + esc(nombreEmpresa(p.empresa_id)) + '</h4>' +
        '<div style="font-size:2rem;font-weight:700">' + esc(fmtPct1(p.cumplimiento)) + '</div>' +
        '<div style="margin:4px 0 8px">' + barraHtml(p.cumplimiento === null ? null : Number(p.cumplimiento), p.esperado === null ? null : Number(p.esperado)) +
          '<div class="mk-sub" style="font-size:0.74rem;color:#718096;margin-top:3px">Esperado a la fecha según el cronograma: <strong>' + esc(fmtPct1(p.esperado)) + '</strong> (la marca naranja de la barra)</div></div>' +
        '<div class="mk-kv"><span>Actividades que aplican</span><span>' + esc(p.n_aplica) + '</span></div>' +
        '<div class="mk-kv"><span>Ejecutadas</span><span>' + esc(p.n_ejecutadas) + '</span></div>' +
        '<div class="mk-kv"><span>Vencidas</span><span style="color:' + (p.n_vencidas ? '#c0392b' : 'inherit') + '">' + esc(p.n_vencidas) + '</span></div>' +
        '<div class="mk-kv"><span>Del mes en curso</span><span>' + esc(p.n_este_mes) + '</span></div>' +
        '<div class="mk-kv"><span>Sin programar</span><span>' + esc(p.n_sin_programar) + '</span></div>' +
        '<div class="mk-kv"><span>No aplican</span><span>' + esc(p.n_no_aplica) + '</span></div></div>' +
      '<div class="mk-box"><h4>Avance por ciclo PHVA</h4>' +
        Object.keys(CICLOS).map(function (c) {
          var s = sumaCiclo(p.id, c);
          return '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:0.84rem"><strong>' + esc(CICLOS[c]) + '</strong>' +
            '<span>' + esc(fmtPct1(s.pct)) + (s.nv ? ' · <span style="color:#c0392b">' + s.nv + ' vencidas</span>' : '') + (s.nm ? ' · ' + s.nm + ' del mes' : '') + '</span></div>' +
            barraHtml(s.pct, s.esp) + '</div>';
        }).join('') + '</div></div>';
    $('pl-resumen').innerHTML = h;
  }

  function renderPlanDatos() {
    var p = planAnualById[plSel];
    var key = p.id + '|' + p.modificado_en + '|' + evidenciasDe('plan', p.id).length;
    if (key === plDatosKey) return;           // no pisar lo que la persona está escribiendo
    plDatosKey = key;
    var falt = planFaltantes(p);
    var abierto = plDatosAbierto === null ? falt.length > 0 : plDatosAbierto;
    $('pl-datos').innerHTML = '<div class="mk-box" style="margin:14px 0"><details id="pl-det"' + (abierto ? ' open' : '') + '>' +
      '<summary style="cursor:pointer;font-weight:700">Datos del plan, firma y soporte' + (falt.length ? ' ' + badge('Falta: ' + falt.length, '#d97706') : ' ' + badge('Completo', '#15803d')) + '</summary>' +
      '<div class="form-grid cols2" style="margin:10px 0">' +
        '<div><label class="ef-label" for="pd-codigo">Código del documento</label><input class="ef" id="pd-codigo" maxlength="60" placeholder="Ej. SST-TEC-MT0001" value="' + esc(p.codigo_documento) + '"></div>' +
        '<div><label class="ef-label" for="pd-version">Versión</label><input class="ef" id="pd-version" maxlength="30" value="' + esc(p.version) + '"></div>' +
        '<div><label class="ef-label" for="pd-fecha">Fecha del documento</label><input class="ef" id="pd-fecha" type="date" value="' + esc(p.fecha_documento || '') + '"></div>' +
        '<div><label class="ef-label" for="pd-firmado">Firmado por el empleador el</label><input class="ef" id="pd-firmado" type="date" value="' + esc(p.firmado_en || '') + '"></div>' +
        '<div style="grid-column:1/-1"><label class="ef-label" for="pd-objetivo">Objetivos</label><textarea class="ef" id="pd-objetivo" rows="2" maxlength="2000">' + esc(p.objetivo) + '</textarea></div>' +
        '<div style="grid-column:1/-1"><label class="ef-label" for="pd-metas">Metas</label><textarea class="ef" id="pd-metas" rows="2" maxlength="2000">' + esc(p.metas) + '</textarea></div>' +
        '<div style="grid-column:1/-1"><label class="ef-label" for="pd-recursos">Recursos (humanos, técnicos, financieros)</label><textarea class="ef" id="pd-recursos" rows="2" maxlength="2000">' + esc(p.recursos) + '</textarea></div>' +
        '<div><label class="ef-label" for="pd-empleador">Empleador o representante legal (firma)</label><input class="ef" id="pd-empleador" maxlength="200" value="' + esc(p.empleador_nombre) + '"></div>' +
        '<div><label class="ef-label" for="pd-responsable">Responsable del SG-SST (firma)</label><input class="ef" id="pd-responsable" maxlength="200" value="' + esc(p.responsable_nombre) + '"></div>' +
        '<div style="grid-column:1/-1"><label class="ef-label" for="pd-obs">Observaciones</label><input class="ef" id="pd-obs" maxlength="1000" value="' + esc(p.observaciones) + '"></div></div>' +
      '<div class="mk-actions"><button class="btn-secondary" data-act="pd-guardar">Guardar datos del plan</button>' +
        '<button class="btn-secondary" data-act="evl-abrir" data-tipo="plan" data-id="' + esc(p.id) + '">🔗 Plan firmado en Drive (' + evidenciasDe('plan', p.id).length + ')</button></div>' +
      auditoriaHtml(p) + '</details></div>';
    var det = $('pl-det');
    if (det) det.addEventListener('toggle', function () { plDatosAbierto = det.open; });
  }

  function renderPlanFiltros() {
    var acts = actsPorPlan[plSel] || [], gSel = $('pf-grupo'), actual = gSel.value, vistos = {}, op = [];
    acts.forEach(function (a) { if (a.grupo && !vistos[a.grupo]) { vistos[a.grupo] = 1; op.push({ v: a.grupo, t: a.grupo }); } });
    gSel.innerHTML = optsHtml(op, 'Todos', vistos[actual] ? actual : '');
  }

  function filtrarActs() {
    var ciclo = $('pf-ciclo').value, grupo = $('pf-grupo').value, est = $('pf-estado').value, mes = Number($('pf-mes').value), q = norm($('pf-txt').value);
    return (actsPorPlan[plSel] || []).filter(function (a) {
      if (ciclo && a.ciclo !== ciclo) return false;
      if (grupo && a.grupo !== grupo) return false;
      if (est === 'no_aplica') { if (a.aplica) return false; }
      else {
        if (!a.aplica) return false;
        if (est === 'atencion') { if (a.semaforo !== 'vencida' && a.semaforo !== 'este_mes') return false; }
        else if (est === 'sin_soporte') { if (!(a.n_ejec > 0 && !evidenciasDe('plan_actividad', a.id).length)) return false; }
        else if (est && a.semaforo !== est) return false;
      }
      if (mes && nums(a.meses_programados).indexOf(mes) < 0) return false;
      if (q && norm([a.actividad, a.item_codigo, a.item_nombre, a.responsable].join(' ')).indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderActividades() {
    if (!plSel) return;
    var todas = actsPorPlan[plSel] || [], lista = filtrarActs();
    $('pa-ct').textContent = '(' + lista.length + (lista.length !== todas.length ? ' de ' + todas.length : '') + ')';
    if (!lista.length) {
      $('pa-body').innerHTML = '<tr><td colspan="9"><div class="empty">' + (todas.length ? 'Ninguna actividad coincide con los filtros.' : 'Este plan aún no tiene actividades. Agrega la primera con «Actividad».') + '</div></td></tr>';
      return;
    }
    var p = planAnualById[plSel], itemPrevio = null;
    $('pa-body').innerHTML = lista.map(function (a) {
      var nEv = evidenciasDe('plan_actividad', a.id).length;
      var sinSoporte = a.aplica && a.n_ejec > 0 && !nEv;
      var itemKey = a.item_codigo + '|' + a.item_nombre, titItem = itemKey !== itemPrevio && a.item_nombre;
      itemPrevio = itemKey;
      return '<tr' + (a.aplica ? '' : ' style="opacity:0.6"') + '>' +
        '<td><strong>' + esc(a.item_codigo) + '</strong></td>' +
        '<td>' + (titItem ? '<div class="mk-sin" style="font-style:normal;font-weight:700;color:#1a5276;margin-bottom:2px">' + esc(a.item_nombre) + '</div>' : '') +
          '<div class="sst-clamp" title="' + esc(a.actividad) + '">' + esc(a.actividad) + '</div>' +
          (a.aplica ? '' : '<div class="mk-sin">No aplica: ' + esc(a.motivo_no_aplica) + '</div>') + '</td>' +
        '<td>' + esc(a.responsable) + '</td>' +
        '<td style="text-align:right">' + esc(fmtNum(a.peso)) + '</td>' +
        '<td>' + (a.aplica ? mesesHtml(a.meses_programados, a.meses_ejecutados, p.vigencia, a.semaforo, 'pa-mes', a.id) : '<span class="mk-sin">—</span>') + '</td>' +
        '<td style="text-align:right">' + (a.avance === null || a.avance === undefined ? '—' : Math.round(Number(a.avance) * 100) + ' %') + '</td>' +
        '<td>' + semBadge(a.semaforo) + '</td>' +
        '<td><button class="btn-secondary" data-act="evl-abrir" data-tipo="plan_actividad" data-id="' + esc(a.id) + '">🔗 ' + nEv + '</button>' +
          (sinSoporte ? '<div style="font-size:0.7rem;color:#92400e">sin soporte</div>' : '') + '</td>' +
        '<td><button class="btn-edit" data-act="pa-editar" data-id="' + esc(a.id) + '">Editar</button></td>' +
        '</tr>';
    }).join('');
  }

  async function alternarMes(id, mes) {
    var a = actById[id];
    if (!a) return;
    var E = nums(a.meses_ejecutados), i = E.indexOf(mes);
    if (i >= 0) E.splice(i, 1); else E.push(mes);
    var res = await _sb.from('sst_plan_actividades').update({ meses_ejecutados: E }).eq('id', id);
    if (res.error) fail('marcar el mes', res.error);
    await cargar(false);
  }

  // ── Datos del plan ──
  async function guardarDatosPlan() {
    var p = planAnualById[plSel];
    if (!p) return;
    var res = await _sb.from('sst_planes').update({
      codigo_documento: $('pd-codigo').value.trim(), version: $('pd-version').value.trim(), fecha_documento: valOrNull('pd-fecha'),
      firmado_en: valOrNull('pd-firmado'), objetivo: $('pd-objetivo').value.trim(), metas: $('pd-metas').value.trim(),
      recursos: $('pd-recursos').value.trim(), empleador_nombre: $('pd-empleador').value.trim(),
      responsable_nombre: $('pd-responsable').value.trim(), observaciones: $('pd-obs').value.trim(),
    }).eq('id', p.id);
    if (res.error) { fail('guardar los datos del plan', res.error); return; }
    showToast('Datos del plan guardados');
    plDatosKey = null;
    await cargar(false);
  }

  // ── Nuevo plan (vacío o copiado de otra vigencia) ──
  function actualizarNuevoPlan() {
    var empId = Number($('pn-empresa').value), vig = parseInt($('pn-vigencia').value, 10), aviso = '', bloquea = false;
    var previos = planesAnual.filter(function (p) { return p.empresa_id === empId; }).sort(function (a, b) { return b.vigencia - a.vigencia; });
    var yaLleno = $('pn-origen').options.length > 0, actual = $('pn-origen').value;
    var conservar = yaLleno && (actual === '' || (planAnualById[actual] && planAnualById[actual].empresa_id === empId));
    $('pn-origen').innerHTML = optsHtml(previos.map(function (p) { return { v: p.id, t: 'Copiar el plan ' + p.vigencia + ' (' + p.n_actividades + ' actividades)' }; }), 'Empezar vacío', conservar ? actual : (previos[0] ? previos[0].id : ''));
    if (isNaN(vig) || vig < 2019 || vig > 2100) { aviso = 'La vigencia debe ser un año entre 2019 y 2100.'; bloquea = true; }
    else if (previos.some(function (p) { return p.vigencia === vig; })) { aviso = 'Ya existe el plan ' + vig + ' de esta empresa.'; bloquea = true; }
    else if ($('pn-origen').value) {
      var o = planAnualById[$('pn-origen').value];
      if (o && o.vigencia === vig) { aviso = 'La vigencia nueva debe ser distinta de la del plan de origen.'; bloquea = true; }
      else aviso = 'Se copiará el plan ' + (o ? o.vigencia : '') + ' a la vigencia ' + vig + ' con los meses programados y sin lo ejecutado.';
    } else aviso = 'Se creará un plan vacío; después agregas las actividades.';
    $('pn-aviso').textContent = aviso;
    $('pn-ok').disabled = bloquea;
  }
  function abrirNuevoPlan() {
    var activas = empresas.filter(function (e) { return e.activa; });
    if (!activas.length) { showToast('Primero crea una empresa activa', '#e74c3c'); return; }
    var emp0 = plSel && planAnualById[plSel] ? planAnualById[plSel].empresa_id : activas[0].id;
    $('pn-empresa').innerHTML = optsHtml(activas.map(function (e) { return { v: e.id, t: e.nombre }; }), null, emp0);
    var previos = planesAnual.filter(function (p) { return p.empresa_id === emp0; });
    var max = previos.reduce(function (m, p) { return Math.max(m, p.vigencia); }, 0);
    $('pn-vigencia').value = max ? max + 1 : new Date().getFullYear();
    $('pn-origen').innerHTML = '';
    actualizarNuevoPlan();
    MODAL.open('pl-nuevo-overlay', 'pn-empresa');
  }
  async function crearPlan() {
    var empId = Number($('pn-empresa').value), vig = parseInt($('pn-vigencia').value, 10), origen = $('pn-origen').value;
    if (!empId) { showToast('Elige la empresa', '#e74c3c'); return; }
    if (isNaN(vig) || vig < 2019 || vig > 2100) { showToast('La vigencia debe ser un año entre 2019 y 2100', '#e74c3c'); return; }
    var btn = $('pn-ok'); btnBusy(btn, true);
    var res = origen ? await _sb.rpc('sst_plan_copiar', { p_plan_origen: Number(origen), p_vigencia: vig })
                     : await _sb.from('sst_planes').insert({ empresa_id: empId, vigencia: vig });
    btnBusy(btn, false);
    if (res.error) { fail('crear el plan', res.error); return; }
    MODAL.close('pl-nuevo-overlay');
    showToast(origen ? 'Plan copiado' : 'Plan creado');
    await cargar(false);
    var nuevo = planesAnual.filter(function (p) { return p.empresa_id === empId && p.vigencia === vig; })[0];
    if (nuevo) { plSel = nuevo.id; plDatosKey = null; plDatosAbierto = null; renderPlan(); }
    cambiarTab('plan');
  }

  // ── Actividad del plan ──
  function responsablesConocidos() {
    var vistos = {}, op = [];
    planActs.forEach(function (a) { var r = String(a.responsable || '').trim(); if (r && !vistos[r]) { vistos[r] = 1; op.push(r); } });
    return op.sort();
  }
  function filaMesesEdicion(P, E) {
    return MES_LARGO.map(function (nombre, i) {
      var m = i + 1;
      return '<div><strong>' + esc(nombre) + '</strong>' +
        '<label><input type="checkbox" id="pa-p-' + m + '"' + (P.indexOf(m) >= 0 ? ' checked' : '') + '> Programada</label>' +
        '<label><input type="checkbox" id="pa-e-' + m + '"' + (E.indexOf(m) >= 0 ? ' checked' : '') + '> Ejecutada</label></div>';
    }).join('');
  }
  function abrirActividad(id) {
    var a = id ? actById[id] : null;
    var plan = planAnualById[a ? a.plan_id : plSel];
    if (!plan) return;
    paEditId = id || null; paPlanId = plan.id;
    $('pa-titulo').textContent = a ? 'Editar actividad' : 'Nueva actividad';
    $('pa-meta').innerHTML = '<span>' + esc(nombreEmpresa(plan.empresa_id)) + '</span><span>Plan ' + esc(plan.vigencia) + '</span>';
    $('pa-ciclo').value = a ? a.ciclo : ($('pf-ciclo').value || 'hacer');
    $('pa-grupo').value = a ? a.grupo : '';
    $('pa-item-codigo').value = a ? a.item_codigo : '';
    $('pa-item-nombre').value = a ? a.item_nombre : '';
    $('pa-actividad').value = a ? a.actividad : '';
    $('pa-responsable').value = a ? a.responsable : '';
    $('pa-peso').value = a ? a.peso : '0.5';
    $('pa-aplica').value = !a || a.aplica ? '1' : '0';
    $('pa-motivo').value = a ? a.motivo_no_aplica : '';
    $('pa-motivo-box').style.display = $('pa-aplica').value === '1' ? 'none' : '';
    $('pa-obs').value = a ? a.observaciones : '';
    $('pa-meses').innerHTML = filaMesesEdicion(a ? nums(a.meses_programados) : [], a ? nums(a.meses_ejecutados) : []);
    var grupos = {}, dl = [];
    (actsPorPlan[plan.id] || []).forEach(function (x) { if (x.grupo && !grupos[x.grupo]) { grupos[x.grupo] = 1; dl.push(x.grupo); } });
    $('pa-grupos').innerHTML = dl.map(function (g) { return '<option value="' + esc(g) + '">'; }).join('');
    $('pa-responsables').innerHTML = responsablesConocidos().map(function (r) { return '<option value="' + esc(r) + '">'; }).join('');
    $('pa-aud').innerHTML = a ? auditoriaHtml(a) : '';
    var be = $('pa-btn-evid');
    be.style.display = a ? '' : 'none';
    if (a) be.textContent = '🔗 Soportes (' + evidenciasDe('plan_actividad', a.id).length + ')';
    MODAL.open('pa-overlay', 'pa-actividad');
  }
  async function guardarActividad() {
    var actividad = $('pa-actividad').value.trim();
    if (actividad.length < 3) { showToast('Describe la actividad', '#e74c3c'); return; }
    var peso = Number($('pa-peso').value);
    if ($('pa-peso').value.trim() === '' || !isFinite(peso) || peso < 0 || peso > 100) { showToast('El peso debe estar entre 0 y 100', '#e74c3c'); return; }
    var aplica = $('pa-aplica').value === '1', motivo = $('pa-motivo').value.trim();
    if (!aplica && motivo.length < 3) { showToast('Indica el motivo por el que la actividad no aplica', '#e74c3c'); return; }
    var P = [], E = [];
    for (var m = 1; m <= 12; m++) { if ($('pa-p-' + m).checked) P.push(m); if ($('pa-e-' + m).checked) E.push(m); }
    var fila = {
      ciclo: $('pa-ciclo').value, grupo: $('pa-grupo').value.trim(), item_codigo: $('pa-item-codigo').value.trim(), item_nombre: $('pa-item-nombre').value.trim(),
      actividad: actividad, responsable: $('pa-responsable').value.trim(), peso: peso, aplica: aplica, motivo_no_aplica: aplica ? '' : motivo,
      meses_programados: P, meses_ejecutados: E, observaciones: $('pa-obs').value.trim(),
    };
    if (!paEditId) fila.plan_id = paPlanId;
    var btn = $('pa-ok'); btnBusy(btn, true);
    var res = paEditId ? await _sb.from('sst_plan_actividades').update(fila).eq('id', paEditId) : await _sb.from('sst_plan_actividades').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar la actividad', res.error); return; }
    MODAL.close('pa-overlay');
    showToast(paEditId ? 'Actividad actualizada' : 'Actividad agregada al plan');
    await cargar(false);
  }

  function generarPdfPlan() {
    var p = planAnualById[plSel];
    if (!p) return;
    try {
      var emp = empresaById[p.empresa_id] || {};
      var doc = SST_PDF.planAnual({
        empresa: emp, plan: p, actividades: actsPorPlan[p.id] || [],
        capacitaciones: caps.filter(function (c) { return c.empresa_id === p.empresa_id && c.vigencia === p.vigencia; }), ahora: new Date(),
      });
      doc.save(SST_PDF.nombrePlan(emp, p));
    } catch (err) {
      showToast('No se pudo generar el PDF: ' + (err && err.message ? err.message : err), '#e74c3c');
    }
  }

  // ══════════════ Fase 2: Capacitaciones ══════════════
  function iniciarFiltroCap() {
    var y = parseInt(today().slice(0, 4), 10);
    var emp = caps.length ? caps[0].empresa_id : ((empresas.filter(function (e) { return e.activa; })[0] || empresas[0] || {}).id);
    if (emp !== undefined && emp !== null) $('cf-empresa').value = emp;
    var vigs = caps.filter(function (c) { return c.empresa_id === emp; }).map(function (c) { return c.vigencia; });
    $('cf-vigencia').value = vigs.indexOf(y) >= 0 || !vigs.length ? y : Math.max.apply(null, vigs);
  }
  function capContexto() { return { emp: Number($('cf-empresa').value), vig: parseInt($('cf-vigencia').value, 10) }; }

  function capsFiltradas() {
    var c = capContexto(), est = $('cf-estado').value;
    return caps.filter(function (x) {
      if (x.empresa_id !== c.emp || x.vigencia !== c.vig) return false;
      if (est === 'inactiva') return !x.activa;
      if (!x.activa) return false;
      if (est === 'atencion') return x.semaforo === 'vencida' || x.semaforo === 'este_mes';
      return !est || x.semaforo === est;
    });
  }

  function renderCapacitaciones() {
    var c = capContexto();
    $('cp-th-meses').innerHTML = mesesHead();
    var ind = indMes.filter(function (i) { return i.empresa_id === c.emp && i.vigencia === c.vig; }).sort(function (a, b) { return a.mes - b.mes; });
    var h = '';
    if (ind.length) {
      var ref = mesRef(c.vig), tp = 0, te = 0, tpA = 0, teA = 0, tc = 0, ta = 0;
      ind.forEach(function (i) {
        tp += i.programadas; te += i.ejecutadas_programadas; tc += i.convocados; ta += i.asistentes;
        if (i.mes <= ref) { tpA += i.programadas; teA += i.ejecutadas_programadas; }
      });
      var pc = function (n, d) { return d > 0 ? 100 * n / d : null; };
      h += '<div class="mk-ctx-grid"><div class="mk-box"><h4>Cumplimiento del programa ' + esc(c.vig) + '</h4>' +
        '<div style="font-size:2rem;font-weight:700">' + esc(fmtPct1(pc(teA, tpA))) + '</div>' +
        '<div class="mk-sub" style="font-size:0.78rem;color:#718096;margin:2px 0 8px">a la fecha: ' + teA + ' de ' + tpA + ' temas programados hasta ahora (por mes)</div>' +
        '<div class="mk-kv"><span>Todo el año</span><span>' + te + ' de ' + tp + ' (' + esc(fmtPct1(pc(te, tp))) + ')</span></div></div>' +
        '<div class="mk-box"><h4>Cobertura</h4>' +
        '<div style="font-size:2rem;font-weight:700">' + esc(fmtPct1(pc(ta, tc))) + '</div>' +
        '<div class="mk-sub" style="font-size:0.78rem;color:#718096;margin:2px 0 8px">asistentes / convocados en las sesiones realizadas</div>' +
        '<div class="mk-kv"><span>Convocados</span><span>' + tc + '</span></div><div class="mk-kv"><span>Asistentes</span><span>' + ta + '</span></div></div></div>';
      h += '<div class="mk-box" style="margin-bottom:14px"><h4>Indicadores por mes</h4><div class="table-wrap"><table class="mk-mini sst-ind"><thead><tr><th>Indicador</th>' +
        MES3.map(function (m, i) { return '<th' + (i + 1 === ref ? ' style="background:#fffbeb"' : '') + '>' + m + '</th>'; }).join('') + '<th>Año</th></tr></thead><tbody>' +
        filaInd('Temas programados', ind, function (i) { return i.programadas; }, tp, ref) +
        filaInd('Temas ejecutados', ind, function (i) { return i.ejecutadas_programadas; }, te, ref) +
        filaInd('Cumplimiento', ind, function (i) { return i.programadas > 0 ? Math.round(100 * i.ejecutadas_programadas / i.programadas) + ' %' : '—'; }, pc(te, tp) === null ? '—' : Math.round(pc(te, tp)) + ' %', ref) +
        filaInd('Convocados', ind, function (i) { return i.convocados; }, tc, ref) +
        filaInd('Asistentes', ind, function (i) { return i.asistentes; }, ta, ref) +
        filaInd('Cobertura', ind, function (i) { return i.convocados > 0 ? Math.round(100 * i.asistentes / i.convocados) + ' %' : '—'; }, pc(ta, tc) === null ? '—' : Math.round(pc(ta, tc)) + ' %', ref) +
        '</tbody></table></div></div>';
    }
    $('cp-resumen').innerHTML = h;

    var lista = capsFiltradas();
    $('cp-ct').textContent = '(' + lista.length + ')';
    if (!lista.length) {
      $('cp-body').innerHTML = '<tr><td colspan="7"><div class="empty">' + (isNaN(c.vig) ? 'Indica la vigencia.' : caps.some(function (x) { return x.empresa_id === c.emp && x.vigencia === c.vig; })
        ? 'Ningún tema coincide con el filtro.' : 'Aún no hay temas para esta empresa y vigencia. Crea el primero con «Nuevo tema» o copia un plan anual de otra vigencia.') + '</div></td></tr>';
      return;
    }
    $('cp-body').innerHTML = lista.map(function (x) {
      return '<tr' + (x.activa ? '' : ' style="opacity:0.6"') + '>' +
        '<td><strong>' + esc(x.tema) + '</strong>' + (x.dirigido_a || x.entregable ? '<div class="mk-sin" style="font-style:normal">' + esc([x.dirigido_a, x.entregable].filter(Boolean).join(' · ')) + '</div>' : '') + '</td>' +
        '<td>' + esc(x.responsable) + '</td>' +
        '<td>' + mesesHtml(x.meses_programados, x.meses_ejecutados, x.vigencia, x.semaforo, null, x.id) + '</td>' +
        '<td>' + esc(x.sesiones_realizadas) + ' realizada(s)' + (x.sesiones_programadas ? '<div class="mk-sin">' + esc(x.sesiones_programadas) + ' programada(s)</div>' : '') + '</td>' +
        '<td style="text-align:right">' + esc(fmtPct1(x.cobertura)) + (x.convocados ? '<div class="mk-sub" style="font-size:0.72rem;color:#718096">' + x.asistentes + ' de ' + x.convocados + '</div>' : '') + '</td>' +
        '<td>' + semBadge(x.semaforo) + '</td>' +
        '<td><div class="mk-actions"><button class="btn-secondary" data-act="cs-lista" data-id="' + esc(x.id) + '">📋 Sesiones</button>' +
          '<button class="btn-edit" data-act="cp-editar" data-id="' + esc(x.id) + '">Editar</button></div></td>' +
        '</tr>';
    }).join('');
  }
  function filaInd(nombre, ind, fn, total, ref) {
    return '<tr><td>' + esc(nombre) + '</td>' + ind.map(function (i) {
      return '<td' + (i.mes === ref ? ' style="background:#fffbeb"' : '') + '>' + esc(fn(i)) + '</td>';
    }).join('') + '<td><strong>' + esc(total) + '</strong></td></tr>';
  }

  // ── Tema de capacitación ──
  function abrirTema(id) {
    var c = capContexto();
    var x = id ? capById[id] : null;
    if (!x && (!c.emp || isNaN(c.vig))) { showToast('Elige la empresa y la vigencia', '#e74c3c'); return; }
    cpEditId = id || null;
    cpCtx = x ? { empresa_id: x.empresa_id, vigencia: x.vigencia } : { empresa_id: c.emp, vigencia: c.vig };
    $('cp-titulo').textContent = x ? 'Editar tema de capacitación' : 'Nuevo tema de capacitación';
    $('cp-meta').innerHTML = '<span>' + esc(nombreEmpresa(cpCtx.empresa_id)) + '</span><span>Vigencia ' + esc(cpCtx.vigencia) + '</span>';
    $('cp-tema').value = x ? x.tema : '';
    $('cp-dirigido').value = x ? x.dirigido_a : '';
    $('cp-responsable').value = x ? x.responsable : '';
    $('cp-entregable').value = x ? x.entregable : 'Registro de formación';
    $('cp-horas').value = x && x.horas_previstas ? x.horas_previstas : '';
    $('cp-activa').value = x && !x.activa ? '0' : '1';
    $('cp-obs').value = x ? x.observaciones : '';
    var P = x ? nums(x.meses_programados) : [];
    $('cp-meses').innerHTML = MES3.map(function (m, i) {
      return '<label><input type="checkbox" id="cp-m-' + (i + 1) + '"' + (P.indexOf(i + 1) >= 0 ? ' checked' : '') + '> ' + m + '</label>';
    }).join('');
    $('cp-aud').innerHTML = x ? auditoriaHtml(x) : '';
    MODAL.open('cp-overlay', 'cp-tema');
  }
  async function guardarTema() {
    var tema = $('cp-tema').value.trim();
    if (tema.length < 3) { showToast('Escribe el tema de la capacitación', '#e74c3c'); return; }
    var horasTxt = $('cp-horas').value.trim(), horas = horasTxt === '' ? null : Number(horasTxt);
    if (horas !== null && (!isFinite(horas) || horas <= 0 || horas > 99)) { showToast('Las horas previstas deben estar entre 0 y 99', '#e74c3c'); return; }
    var P = [];
    for (var m = 1; m <= 12; m++) if ($('cp-m-' + m).checked) P.push(m);
    var fila = {
      tema: tema, dirigido_a: $('cp-dirigido').value.trim(), responsable: $('cp-responsable').value.trim(), entregable: $('cp-entregable').value.trim(),
      horas_previstas: horas, meses_programados: P, activa: $('cp-activa').value === '1', observaciones: $('cp-obs').value.trim(),
    };
    if (!cpEditId) { fila.empresa_id = cpCtx.empresa_id; fila.vigencia = cpCtx.vigencia; }
    var btn = $('cp-ok'); btnBusy(btn, true);
    var res = cpEditId ? await _sb.from('sst_capacitaciones').update(fila).eq('id', cpEditId) : await _sb.from('sst_capacitaciones').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar el tema', res.error); return; }
    MODAL.close('cp-overlay');
    showToast(cpEditId ? 'Tema actualizado' : 'Tema agregado al programa');
    await cargar(false);
  }

  // ── Sesiones de un tema ──
  function abrirSesionesLista(capId) {
    cslCapId = capId;
    renderSesionesLista();
    MODAL.open('cs-lista-overlay');
  }
  function asistenciaDe(sesId) {
    var rows = asisPorSes[sesId] || [], asi = rows.filter(function (r) { return r.asistio; }).length;
    return { conv: rows.length, asi: asi, pct: rows.length ? Math.round(100 * asi / rows.length) : null };
  }
  function renderSesionesLista() {
    var cap = capById[cslCapId];
    if (!cap) return;
    $('cs-lista-titulo').textContent = cap.tema.length > 110 ? cap.tema.slice(0, 107) + '…' : cap.tema;
    $('cs-lista-meta').innerHTML = '<span>' + esc(nombreEmpresa(cap.empresa_id)) + '</span><span>Vigencia ' + esc(cap.vigencia) + '</span>' +
      '<span>Programado: ' + esc(nums(cap.meses_programados).map(function (m) { return MES3[m - 1]; }).join(', ') || 'sin meses') + '</span>';
    var lista = sesPorCap[cap.id] || [];
    $('cs-lista-body').innerHTML = !lista.length
      ? '<div class="empty" style="padding:24px">Aún no hay sesiones. Programa la primera con «Nueva sesión».</div>'
      : '<div class="table-wrap"><table class="mk-mini" style="min-width:700px"><thead><tr><th>Fecha</th><th>Estado</th><th>Horas</th><th>Instructor</th><th>Asistencia</th><th>Planilla firmada</th><th></th></tr></thead><tbody>' +
        lista.map(function (s) {
          var a = asistenciaDe(s.id);
          return '<tr><td><strong>' + esc(fmtDateOnly(s.fecha)) + '</strong></td>' +
            '<td>' + badge(ESTADO_SESION[s.estado] || s.estado, COLOR_SESION[s.estado] || '#718096') + '</td>' +
            '<td>' + esc(s.horas || '') + '</td><td>' + esc(s.instructor) + '</td>' +
            '<td>' + (a.conv ? esc(a.asi) + ' de ' + esc(a.conv) + ' (' + a.pct + ' %)' : '<span class="mk-sin">sin convocados</span>') + '</td>' +
            '<td><button class="btn-secondary" data-act="evl-abrir" data-tipo="cap_sesion" data-id="' + esc(s.id) + '">🔗 ' + evidenciasDe('cap_sesion', s.id).length + '</button>' +
              (s.estado === 'realizada' && !evidenciasDe('cap_sesion', s.id).length ? '<div style="font-size:0.7rem;color:#92400e">sin planilla firmada</div>' : '') + '</td>' +
            '<td><div class="mk-actions"><button class="btn-edit" data-act="cs-editar" data-id="' + esc(s.id) + '">Editar</button>' +
              '<button class="btn-secondary" data-act="cs-planilla-id" data-id="' + esc(s.id) + '">📄 Planilla</button></div></td></tr>';
        }).join('') + '</tbody></table></div>';
  }

  // ── Sesión: datos + convocados y asistencia ──
  function trabajadoresDeSesion(cap, sesId) {
    var existentes = {};
    (asisPorSes[sesId] || []).forEach(function (a) { existentes[a.trabajador_id] = a; });
    return trabajadores.filter(function (t) { return t.empresa_id === cap.empresa_id && (esActivo(t) || existentes[t.id]); })
      .sort(function (a, b) { return String(a.nombre).localeCompare(String(b.nombre)); });
  }
  function abrirSesion(id, capId) {
    var s = id ? sesById[id] : null;
    csEditId = id || null; csCapId = s ? s.capacitacion_id : capId;
    var cap = capById[csCapId];
    if (!cap) return;
    var hoy = today(), y = parseInt(hoy.slice(0, 4), 10);
    $('cs-titulo').textContent = s ? 'Editar sesión' : 'Nueva sesión';
    $('cs-meta').innerHTML = '<span>' + esc(cap.tema.length > 90 ? cap.tema.slice(0, 87) + '…' : cap.tema) + '</span><span>' + esc(nombreEmpresa(cap.empresa_id)) + '</span>';
    $('cs-fecha').min = cap.vigencia + '-01-01'; $('cs-fecha').max = cap.vigencia + '-12-31';
    $('cs-fecha').value = s ? s.fecha : (cap.vigencia === y ? hoy : cap.vigencia + '-01-15');
    $('cs-estado').value = s ? s.estado : 'programada';
    $('cs-horas').value = s && s.horas ? s.horas : (cap.horas_previstas || '');
    $('cs-modalidad').value = s ? s.modalidad : 'presencial';
    $('cs-instructor').value = s ? s.instructor : (cap.responsable || '');
    $('cs-lugar').value = s ? s.lugar : '';
    $('cs-obs').value = s ? s.observaciones : '';
    $('cs-aud').innerHTML = s ? auditoriaHtml(s) : '';
    var existentes = {};
    (s ? asisPorSes[s.id] || [] : []).forEach(function (a) { existentes[a.trabajador_id] = a; });
    var lista = trabajadoresDeSesion(cap, s ? s.id : null);
    var bloqueaQuitar = s && s.estado !== 'programada' && !AUTH.isAdmin();
    $('cs-asis').innerHTML = !lista.length
      ? '<tr><td colspan="4"><div class="empty" style="padding:14px">La empresa no tiene trabajadores activos registrados.</div></td></tr>'
      : lista.map(function (t) {
        var ex = existentes[t.id], conv = s ? !!ex : true, asi = ex ? !!ex.asistio : false;
        return '<tr><td><strong>' + esc(t.nombre) + '</strong>' + (esActivo(t) ? '' : ' <span class="mk-sin">(retirado)</span>') + '</td><td>' + esc(t.cargo) + '</td>' +
          '<td style="text-align:center"><input type="checkbox" id="cs-c-' + t.id + '" data-chg="cs-conv" data-id="' + t.id + '"' + (conv ? ' checked' : '') + (ex && bloqueaQuitar ? ' disabled' : '') + ' aria-label="Convocado: ' + esc(t.nombre) + '"></td>' +
          '<td style="text-align:center"><input type="checkbox" id="cs-a-' + t.id + '" data-chg="cs-asi" data-id="' + t.id + '"' + (asi ? ' checked' : '') + ' aria-label="Asistió: ' + esc(t.nombre) + '"></td></tr>';
      }).join('');
    $('cs-btn-planilla').style.display = s ? '' : 'none';
    var be = $('cs-btn-evid');
    be.style.display = s ? '' : 'none';
    if (s) be.textContent = '🔗 Planilla firmada (' + evidenciasDe('cap_sesion', s.id).length + ')';
    aplicarEstadoSesion();
    MODAL.open('cs-overlay', 'cs-fecha');
  }
  // Ayudas según el estado elegido (el servidor valida lo mismo).
  function aplicarEstadoSesion() {
    var est = $('cs-estado').value, aviso = $('cs-aviso'), ayuda = $('cs-asis-ayuda');
    var cancelada = est === 'cancelada';
    var cajas = $('cs-asis').querySelectorAll('input[type=checkbox]');
    Array.prototype.forEach.call(cajas, function (c) {
      if (cancelada) { c.dataset.eraDisabled = c.disabled ? '1' : ''; c.disabled = true; }
      else if (c.dataset.eraDisabled !== undefined) { c.disabled = c.dataset.eraDisabled === '1'; delete c.dataset.eraDisabled; }
    });
    var hayAsi = Array.prototype.some.call($('cs-asis').querySelectorAll('input[id^="cs-a-"]'), function (c) { return c.checked; });
    var msg = '';
    if (est === 'realizada' && $('cs-fecha').value > today()) msg = 'La fecha es futura: una sesión solo se puede marcar como realizada cuando ya ocurrió.';
    else if (est === 'realizada' && !hayAsi) msg = 'Marca quiénes asistieron: se necesita al menos un asistente para dar la sesión por realizada.';
    else if (cancelada) msg = 'Una sesión cancelada congela la lista de asistencia y no cuenta como realizada.';
    aviso.style.display = msg ? '' : 'none'; aviso.textContent = msg;
    ayuda.innerHTML = 'Imprime la planilla antes de la sesión para recoger las firmas. <a href="#" data-act="cs-todos">Marcar a todos los convocados como asistentes</a>.';
  }
  function cambiarConvocado(el) {
    if (!el.checked) { var a = $('cs-a-' + el.getAttribute('data-id')); if (a && !a.disabled) a.checked = false; }
    aplicarEstadoSesion();
  }
  function cambiarAsistio(el) {
    if (el.checked) { var c = $('cs-c-' + el.getAttribute('data-id')); if (c && !c.disabled) c.checked = true; }
    aplicarEstadoSesion();
  }
  function marcarTodosAsistentes() {
    Array.prototype.forEach.call($('cs-asis').querySelectorAll('input[id^="cs-c-"]'), function (c) {
      if (!c.checked) return;
      var a = $('cs-a-' + c.getAttribute('data-id'));
      if (a && !a.disabled) a.checked = true;
    });
    aplicarEstadoSesion();
  }

  async function guardarSesion() {
    var cap = capById[csCapId];
    if (!cap) return;
    var s = csEditId ? sesById[csEditId] : null;
    var fecha = $('cs-fecha').value, estado = $('cs-estado').value;
    if (!fecha) { showToast('Indica la fecha de la sesión', '#e74c3c'); return; }
    if (fecha.slice(0, 4) !== String(cap.vigencia)) { showToast('La fecha debe estar dentro de la vigencia ' + cap.vigencia, '#e74c3c'); return; }
    var horasTxt = $('cs-horas').value.trim(), horas = horasTxt === '' ? null : Number(horasTxt);
    if (horas !== null && (!isFinite(horas) || horas <= 0 || horas > 99)) { showToast('La duración debe estar entre 0 y 99 horas', '#e74c3c'); return; }
    var trabs = trabajadoresDeSesion(cap, s ? s.id : null), conv = [], asi = 0;
    trabs.forEach(function (t) {
      var c = $('cs-c-' + t.id), a = $('cs-a-' + t.id);
      conv.push({ id: t.id, conv: !!(c && c.checked), asi: !!(a && a.checked && c && c.checked) });
      if (a && a.checked && c && c.checked) asi++;
    });
    if (estado === 'realizada') {
      if (fecha > today()) { showToast('No se puede marcar como realizada una sesión con fecha futura', '#e74c3c'); return; }
      if (!asi) { showToast('Para dar la sesión por realizada marca al menos un asistente', '#e74c3c'); return; }
    }
    var campos = { fecha: fecha, horas: horas, instructor: $('cs-instructor').value.trim(), modalidad: $('cs-modalidad').value, lugar: $('cs-lugar').value.trim(), observaciones: $('cs-obs').value.trim() };
    var btn = $('cs-ok'); btnBusy(btn, true);
    try {
      var id = csEditId;
      if (!id) {
        // La sesión nace «programada» (o «cancelada»): pasa a «realizada» al final, cuando ya tiene asistentes.
        var ins = await _sb.from('sst_cap_sesiones').insert(Object.assign({ capacitacion_id: csCapId, estado: estado === 'cancelada' ? 'cancelada' : 'programada' }, campos)).select('id').single();
        if (ins.error) throw ins.error;
        id = ins.data.id;
      } else if (s.estado === 'cancelada' && estado !== 'cancelada') {
        var re = await _sb.from('sst_cap_sesiones').update({ estado: 'programada' }).eq('id', id);   // descongela la lista
        if (re.error) throw re.error;
      }
      if (estado !== 'cancelada') {
        var actuales = {};
        (asisPorSes[id] || []).forEach(function (a) { actuales[a.trabajador_id] = a; });
        var nuevos = [], cambios = [], quitar = [];
        conv.forEach(function (c) {
          var ex = actuales[c.id];
          if (c.conv && !ex) nuevos.push({ sesion_id: id, trabajador_id: c.id, asistio: c.asi });
          else if (c.conv && ex && !!ex.asistio !== c.asi) cambios.push({ id: ex.id, asistio: c.asi });
          else if (!c.conv && ex) quitar.push(ex.id);
        });
        if (quitar.length) { var rd = await _sb.from('sst_cap_asistentes').delete().in('id', quitar); if (rd.error) throw rd.error; }
        if (nuevos.length) { var ri = await _sb.from('sst_cap_asistentes').insert(nuevos); if (ri.error) throw ri.error; }
        for (var i = 0; i < cambios.length; i++) {
          var ru = await _sb.from('sst_cap_asistentes').update({ asistio: cambios[i].asistio }).eq('id', cambios[i].id);
          if (ru.error) throw ru.error;
        }
      }
      var rs = await _sb.from('sst_cap_sesiones').update(Object.assign({ estado: estado }, campos)).eq('id', id);
      if (rs.error) throw rs.error;
    } catch (err) {
      btnBusy(btn, false);
      fail('guardar la sesión', err);
      await cargar(false);
      return;
    }
    btnBusy(btn, false);
    MODAL.close('cs-overlay');
    showToast(s ? 'Sesión actualizada' : 'Sesión registrada');
    await cargar(false);
  }

  function generarPlanilla(sesId) {
    var s = sesById[sesId], cap = s && capById[s.capacitacion_id];
    if (!cap) return;
    try {
      var emp = empresaById[cap.empresa_id] || {}, rows = asisPorSes[s.id] || [], tById = {};
      trabajadores.forEach(function (t) { tById[t.id] = t; });
      var convocados = rows.map(function (r) { return { trabajador: tById[r.trabajador_id], asistio: r.asistio }; }).filter(function (c) { return c.trabajador; });
      if (!convocados.length) convocados = trabajadores.filter(function (t) { return t.empresa_id === cap.empresa_id && esActivo(t); }).map(function (t) { return { trabajador: t, asistio: false }; });
      convocados.sort(function (a, b) { return String(a.trabajador.nombre).localeCompare(String(b.trabajador.nombre)); });
      var doc = SST_PDF.planilla({ empresa: emp, capacitacion: cap, sesion: s, convocados: convocados, ahora: new Date() });
      doc.save(SST_PDF.nombrePlanilla(emp, s));
    } catch (err) {
      showToast('No se pudo generar el PDF: ' + (err && err.message ? err.message : err), '#e74c3c');
    }
  }

  function rellenarFiltrosF3(op) {
    [['fe-empresa', 'Todas'], ['fc-empresa', 'Todas']].forEach(function (p) {
      var el = $(p[0]), actual = el.value;
      el.innerHTML = optsHtml(op, p[1], actual);
    });
    var anios = {};
    eventosR.forEach(function (e) { anios[String(e.fecha_evento).slice(0, 4)] = 1; });
    var fa = $('fe-anio'), act = fa.value;
    fa.innerHTML = optsHtml(Object.keys(anios).sort().reverse().map(function (y) { return { v: y, t: y }; }), 'Todos', anios[act] ? act : '');
    rellenarIndicadores();
  }

  // ══════════════ Fase 3: Eventos (accidentes, incidentes, condiciones inseguras, enfermedad laboral) ══════════════
  // Los plazos legales, su estado y los indicadores los calculan las vistas del servidor (sst_eventos_resumen,
  // sst_acciones_calc, sst_indicadores_mes/anio); aquí solo se muestran. NO se capturan datos médicos: el FURAT, la
  // investigación firmada y la lección aprendida permanecen en Drive (evidencias).
  var TIPO_EVT = { accidente: 'Accidente de trabajo', incidente: 'Incidente', condicion_insegura: 'Condición o acto inseguro', enfermedad_laboral: 'Enfermedad laboral' };
  var COLOR_TIPO_EVT = { accidente: '#c0392b', incidente: '#d97706', condicion_insegura: '#2563eb', enfermedad_laboral: '#7c3aed' };
  var ESTADO_EVT = { abierto: 'Abierto', en_investigacion: 'En investigación', investigado: 'Investigado', cerrado: 'Cerrado', anulado: 'Anulado' };
  var COLOR_ESTADO_EVT = { abierto: '#d97706', en_investigacion: '#2563eb', investigado: '#0e7490', cerrado: '#15803d', anulado: '#a0aec0' };
  var COLOR_GRAVEDAD = { leve: '#718096', grave: '#d97706', mortal: '#c0392b' };
  var PLAZO_EVT = { cumplido: ['Cumplido', '#15803d'], tarde: ['Tarde', '#d97706'], vencido: ['Vencido', '#c0392b'], pendiente: ['Pendiente', '#2563eb'] };
  var ORDEN_PLAZO = ['vencido', 'pendiente', 'tarde', 'cumplido'];
  var ORIGEN_ACC = { evento: 'Evento', resultado_sgsst: 'Resultado del SG-SST', revision_direccion: 'Revisión por la dirección', auditoria: 'Auditoría', inspeccion: 'Inspección', otro: 'Otro' };
  var TIPO_ACC = { correctiva: 'Correctiva', preventiva: 'Preventiva', mejora: 'De mejora' };
  var ESTADO_ACC = { abierta: 'Abierta', en_curso: 'En curso', en_verificacion: 'En verificación', cerrada: 'Cerrada', cancelada: 'Cancelada' };
  var SEMAFORO_ACC = { vencida: ['Vencida', '#c0392b'], por_vencer: ['Vence pronto', '#d97706'], al_dia: ['Al día', '#2563eb'], cerrada: ['Cerrada', '#15803d'], cancelada: ['Cancelada', '#a0aec0'] };
  var NIVEL_CONTROL = { fuente: 'En la fuente', medio: 'En el medio', trabajador: 'En el trabajador', proceso: 'En el proceso' };

  var eventosR = [], accionesC = [], indAt = [], indAnio = [];
  var eventoById = {}, accionById = {}, accionesPorEvento = {};
  var evtId = null, accId = null, accCtx = null;

  function peorPlazo(lista) {
    var vistos = lista.filter(function (x) { return x && x !== 'na'; });
    if (!vistos.length) return 'na';
    for (var i = 0; i < ORDEN_PLAZO.length; i++) if (vistos.indexOf(ORDEN_PLAZO[i]) >= 0) return ORDEN_PLAZO[i];
    return 'na';
  }
  function plazoPill(etiqueta, estado, limite) {
    if (!estado || estado === 'na') return '';
    var p = PLAZO_EVT[estado] || [estado, '#718096'];
    return '<div style="margin-bottom:2px;white-space:nowrap"><span class="mk-badge" style="background:' + p[1] + '">' + esc(p[0]) + '</span> <span style="font-size:0.74rem;color:#4a5568">' +
      esc(etiqueta) + (limite ? ' · límite ' + esc(fmtDateOnly(limite)) : '') + '</span></div>';
  }
  function eventoActivo(e) { return e.estado !== 'cerrado' && e.estado !== 'anulado'; }
  function eventoVencido(e) {
    return eventoActivo(e) && (peorPlazo([e.plazo_reporte_arl, e.plazo_reporte_eps, e.plazo_territorial, e.plazo_investigacion, e.plazo_informe_arl]) === 'vencido' || e.n_acciones_vencidas > 0);
  }
  function tituloEvento(e) {
    return (TIPO_EVT[e.tipo] || e.tipo) + ' del ' + fmtDateOnly(e.fecha_evento) + (e.trabajador_nombre ? ' · ' + e.trabajador_nombre : '');
  }

  function renderEventosStat() {
    var n = eventosR.filter(eventoVencido).length + accionesC.filter(function (a) { return a.semaforo === 'vencida'; }).length;
    $('s-eventos').textContent = n;
  }

  function filtrarEventos() {
    var emp = $('fe-empresa').value, tipo = $('fe-tipo').value, est = $('fe-estado').value, anio = $('fe-anio').value, q = norm($('fe-txt').value);
    return eventosR.filter(function (e) {
      if (emp && String(e.empresa_id) !== emp) return false;
      if (tipo && e.tipo !== tipo) return false;
      if (anio && String(e.fecha_evento).slice(0, 4) !== anio) return false;
      if (est === 'activos' && !eventoActivo(e)) return false;
      if (est === 'vencidos' && !eventoVencido(e)) return false;
      if ((est === 'cerrado' || est === 'anulado') && e.estado !== est) return false;
      if (q && norm([e.descripcion, e.trabajador_nombre, e.lugar].join(' ')).indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return a.fecha_evento < b.fecha_evento ? 1 : a.fecha_evento > b.fecha_evento ? -1 : b.id - a.id; });
  }

  function renderEventos() {
    renderEventosStat();
    var lista = filtrarEventos();
    $('eventos-ct').textContent = '(' + lista.length + ')';
    if (!lista.length) {
      $('eventos-body').innerHTML = '<tr><td colspan="8"><div class="empty">' + (eventosR.length ? 'Ningún evento coincide con los filtros.' : 'Aún no hay eventos registrados. Es una buena noticia; cuando ocurra uno, regístralo con «Registrar evento».') + '</div></td></tr>';
      return;
    }
    $('eventos-body').innerHTML = lista.map(function (e) {
      var plazos = '';
      if (e.tipo === 'accidente') {
        plazos += plazoPill('FURAT ARL y EPS', peorPlazo([e.plazo_reporte_arl, e.plazo_reporte_eps]), e.limite_reporte_arl);
        if (e.plazo_territorial !== 'na') plazos += plazoPill('Dirección Territorial', e.plazo_territorial, e.limite_territorial);
      }
      if (e.tipo === 'accidente' || e.tipo === 'incidente') plazos += plazoPill('Investigación', e.plazo_investigacion, e.limite_investigacion);
      if (e.plazo_informe_arl !== 'na') plazos += plazoPill('Informe a la ARL', e.plazo_informe_arl, e.limite_informe_arl);
      if (!plazos) plazos = '<span class="mk-sin">—</span>';
      return '<tr class="mk-click" data-act="evt-abrir" data-id="' + esc(e.id) + '"' + (e.estado === 'anulado' ? ' style="opacity:0.6"' : '') + '>' +
        '<td style="white-space:nowrap">' + esc(fmtDateOnly(e.fecha_evento)) + '</td>' +
        '<td>' + badge(TIPO_EVT[e.tipo] || e.tipo, COLOR_TIPO_EVT[e.tipo] || '#718096') + (e.gravedad ? '<div style="margin-top:3px">' + badge(e.gravedad.charAt(0).toUpperCase() + e.gravedad.slice(1), COLOR_GRAVEDAD[e.gravedad] || '#718096') + '</div>' : '') + '</td>' +
        '<td>' + (e.trabajador_nombre ? esc(e.trabajador_nombre) + '<div class="mk-sin" style="font-style:normal">' + esc(e.trabajador_cargo || '') + '</div>' : '<span class="mk-sin">—</span>') + '</td>' +
        '<td><div class="sst-clamp" title="' + esc(e.descripcion) + '">' + esc(e.descripcion) + '</div>' + (e.lugar ? '<div class="mk-sin" style="font-style:normal">' + esc(e.lugar) + '</div>' : '') + '</td>' +
        '<td>' + plazos + '</td>' +
        '<td>' + badge(ESTADO_EVT[e.estado] || e.estado, COLOR_ESTADO_EVT[e.estado] || '#718096') + '</td>' +
        '<td style="text-align:center">' + (e.n_acciones ? esc(e.n_acciones - e.n_acciones_abiertas) + ' de ' + esc(e.n_acciones) + ' cerradas' + (e.n_acciones_vencidas ? '<div style="color:#c0392b;font-size:0.72rem">' + esc(e.n_acciones_vencidas) + ' vencida(s)</div>' : '') : '<span class="mk-sin">sin acciones</span>') + '</td>' +
        '<td><button class="btn-ver" data-act="evt-abrir" data-id="' + esc(e.id) + '">Abrir</button></td></tr>';
    }).join('');
  }

  // ── Modal del evento ──
  function trabajadoresParaEvento(empId, actualId) {
    return trabajadores.filter(function (t) { return t.empresa_id === empId && (esActivo(t) || t.id === actualId); })
      .sort(function (a, b) { return String(a.nombre).localeCompare(String(b.nombre)); });
  }
  function llenarTrabajadoresEvento(empId, sel) {
    $('evt-trabajador').innerHTML = optsHtml(trabajadoresParaEvento(empId, sel).map(function (t) { return { v: t.id, t: t.nombre + (t.cargo ? ' — ' + t.cargo : '') }; }), '— Sin trabajador —', sel || '');
  }
  function esGrave() { return $('evt-tipo').value === 'accidente' && ['grave', 'mortal'].indexOf($('evt-gravedad').value) >= 0; }
  function aplicarTipoEvento() {
    var tipo = $('evt-tipo').value;
    Array.prototype.forEach.call($('evt-overlay').querySelectorAll('[data-tipos]'), function (el) {
      el.style.display = el.getAttribute('data-tipos').split(',').indexOf(tipo) >= 0 ? '' : 'none';
    });
    var grave = esGrave();
    $('evt-terr-box').style.display = grave ? '' : 'none';
    $('evt-informe-box').style.display = grave ? '' : 'none';
    $('evt-prof-box').style.display = grave ? '' : 'none';
    $('evt-trabajador-lbl').textContent = tipo === 'accidente' || tipo === 'enfermedad_laboral' ? 'Trabajador *' : 'Trabajador (si aplica)';
  }

  function abrirEvento(id) {
    var e = id ? eventoById[id] : null;
    if (!e && !empresas.some(function (x) { return x.activa; })) { showToast('Primero crea una empresa activa', '#e74c3c'); return; }
    evtId = id || null;
    var activas = empresas.filter(function (x) { return x.activa || (e && x.id === e.empresa_id); });
    var emp0 = e ? e.empresa_id : Number($('fe-empresa').value) || (activas[0] && activas[0].id);
    $('evt-titulo').textContent = e ? 'Evento: ' + (TIPO_EVT[e.tipo] || e.tipo) : 'Registrar evento';
    $('evt-meta').innerHTML = e ? '<span>' + esc(nombreEmpresa(e.empresa_id)) + '</span><span>' + esc(ESTADO_EVT[e.estado] || e.estado) + '</span>' +
      (e.cerrado_en ? '<span>Cerrado el ' + esc(fmtDateOnly(e.cerrado_en)) + '</span>' : '') : '';
    $('evt-empresa').innerHTML = optsHtml(activas.map(function (x) { return { v: x.id, t: x.nombre }; }), null, emp0);
    $('evt-empresa').disabled = !!e;
    $('evt-tipo').value = e ? e.tipo : 'accidente';
    $('evt-tipo').disabled = !!e;
    $('evt-fecha').value = e ? e.fecha_evento : today();
    $('evt-hora').value = e && e.hora_evento ? String(e.hora_evento).slice(0, 5) : '';
    llenarTrabajadoresEvento(emp0, e ? e.trabajador_id : null);
    $('evt-gravedad').value = e && e.gravedad ? e.gravedad : '';
    $('evt-tipo-acc').value = e && e.tipo_accidente ? e.tipo_accidente : '';
    $('evt-mecanismo').value = e && e.mecanismo ? e.mecanismo : '';
    $('evt-agente').value = e && e.agente ? e.agente : '';
    $('evt-dentro').value = e && e.dentro_empresa !== null && e.dentro_empresa !== undefined ? (e.dentro_empresa ? '1' : '0') : '';
    $('evt-lugar').value = e ? e.lugar : '';
    $('evt-descripcion').value = e ? e.descripcion : '';
    $('evt-dias-inc').value = e ? e.dias_incapacidad : 0;
    $('evt-dias-carg').value = e ? e.dias_cargados : 0;
    $('evt-caso-hasta').value = e && e.caso_hasta ? e.caso_hasta : '';
    $('evt-ref').value = e ? e.referencia_reporte : '';
    $('evt-rep-arl').value = e && e.fecha_reporte_arl ? e.fecha_reporte_arl : '';
    $('evt-rep-eps').value = e && e.fecha_reporte_eps ? e.fecha_reporte_eps : '';
    $('evt-rep-terr').value = e && e.fecha_reporte_territorial ? e.fecha_reporte_territorial : '';
    $('evt-fecha-inv').value = e && e.fecha_investigacion ? e.fecha_investigacion : '';
    $('evt-informe-arl').value = e && e.informe_enviado_arl_en ? e.informe_enviado_arl_en : '';
    $('evt-equipo').value = e ? e.equipo_investigador : '';
    $('evt-prof').value = e ? e.profesional_licencia_sst : '';
    $('evt-causas-inm').value = e ? e.causas_inmediatas : '';
    $('evt-causas-bas').value = e ? e.causas_basicas : '';
    var ti = e ? e.tipos_causa_inmediata || [] : [], tb = e ? e.tipos_causa_basica || [] : [];
    $('evt-ti-acto').checked = ti.indexOf('acto_subestandar') >= 0; $('evt-ti-cond').checked = ti.indexOf('condicion_subestandar') >= 0;
    $('evt-tb-pers').checked = tb.indexOf('factor_personal') >= 0; $('evt-tb-trab').checked = tb.indexOf('factor_trabajo') >= 0;
    $('evt-leccion').value = e ? e.leccion_aprendida : '';
    $('evt-leccion-soc').value = e && e.leccion_socializada_en ? e.leccion_socializada_en : '';
    $('evt-obs').value = e ? e.observaciones : '';
    $('evt-aud').innerHTML = e ? auditoriaHtml(e) : '';
    aplicarTipoEvento();
    renderEventoDerivado();
    MODAL.open('evt-overlay', 'evt-fecha');
  }

  // Lo que depende del servidor (plazos, acciones, botones según el estado) se repinta sin tocar lo que se está escribiendo.
  function renderEventoDerivado() {
    var e = evtId ? eventoById[evtId] : null;
    var aviso = $('evt-aviso');
    if (!e) {
      aviso.style.display = 'none';
      $('evt-plazos-rep').innerHTML = ''; $('evt-plazos-inv').innerHTML = '';
      $('evt-acciones').innerHTML = '<div class="mk-sin">Guarda el evento para poder agregarle acciones y soportes.</div>';
      $('evt-btn-accion').style.display = 'none';
      ['evt-btn-evid', 'evt-btn-reabrir', 'evt-btn-anular', 'evt-btn-iniciar', 'evt-btn-investigado', 'evt-btn-cerrar'].forEach(function (id) { $(id).style.display = 'none'; });
      return;
    }
    $('evt-titulo').textContent = 'Evento: ' + (TIPO_EVT[e.tipo] || e.tipo);
    var msgs = [];
    if (e.estado === 'anulado') msgs.push('Evento anulado' + (e.motivo_anulacion ? ': ' + e.motivo_anulacion : '') + '. Solo un administrador puede modificarlo.');
    if (e.tipo === 'accidente' && eventoActivo(e) && !evidenciasDe('evento', e.id).length) msgs.push('Falta enlazar el FURAT (y luego la investigación firmada) como evidencia desde Drive.');
    aviso.style.display = msgs.length ? '' : 'none';
    aviso.textContent = msgs.join(' ');
    $('evt-plazos-rep').innerHTML = (e.tipo === 'accidente'
      ? plazoPill('FURAT a la ARL (2 días hábiles, sin descontar festivos)', e.plazo_reporte_arl, e.limite_reporte_arl) +
        plazoPill('FURAT a la EPS (2 días hábiles)', e.plazo_reporte_eps, e.limite_reporte_arl) +
        plazoPill('Dirección Territorial, graves y mortales (2 días hábiles)', e.plazo_territorial, e.limite_territorial) : '');
    $('evt-plazos-inv').innerHTML = plazoPill('Investigación (15 días siguientes al evento)', e.plazo_investigacion, e.limite_investigacion) +
      plazoPill('Informe de la investigación a la ARL, graves y mortales (15 días)', e.plazo_informe_arl, e.limite_informe_arl);
    var accs = accionesPorEvento[e.id] || [];
    var puedeAgregar = eventoActivo(e);
    $('evt-btn-accion').style.display = puedeAgregar ? '' : 'none';
    $('evt-acciones').innerHTML = !accs.length
      ? '<div class="mk-sin">Aún sin acciones. ' + (e.tipo === 'accidente' || e.tipo === 'incidente' ? 'La investigación exige al menos una medida de intervención (Res. 1401, art. 12).' : 'Registra qué se va a hacer, quién y para cuándo.') + '</div>'
      : '<div class="table-wrap"><table class="mk-mini" style="min-width:560px"><thead><tr><th>Acción</th><th>Responsable</th><th>Fecha límite</th><th>Estado</th><th></th></tr></thead><tbody>' +
        accs.map(function (a) {
          var s = SEMAFORO_ACC[a.semaforo] || [a.semaforo, '#718096'];
          return '<tr><td>' + esc(a.descripcion) + '</td><td>' + esc(a.responsable) + '</td><td>' + esc(fmtDateOnly(a.fecha_limite)) + '</td>' +
            '<td>' + badge(ESTADO_ACC[a.estado] || a.estado, a.estado === 'cerrada' ? '#15803d' : a.estado === 'cancelada' ? '#a0aec0' : '#2563eb') +
            (a.estado !== 'cerrada' && a.estado !== 'cancelada' && a.semaforo === 'vencida' ? ' <span class="mk-pill over">' + esc(s[0]) + '</span>' : '') + '</td>' +
            '<td><button class="btn-edit" data-act="acc-editar" data-id="' + esc(a.id) + '">Editar</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    var admin = AUTH.isAdmin();
    var invest = e.tipo === 'accidente' || e.tipo === 'incidente';
    $('evt-btn-evid').style.display = '';
    $('evt-btn-evid').textContent = '🔗 FURAT e investigación en Drive (' + evidenciasDe('evento', e.id).length + ')';
    $('evt-btn-iniciar').style.display = invest && e.estado === 'abierto' ? '' : 'none';
    $('evt-btn-investigado').style.display = invest && (e.estado === 'abierto' || e.estado === 'en_investigacion') ? '' : 'none';
    $('evt-btn-cerrar').style.display = eventoActivo(e) && (!invest || e.estado === 'investigado') ? '' : 'none';
    $('evt-btn-anular').style.display = e.estado !== 'anulado' ? '' : 'none';
    $('evt-btn-reabrir').style.display = admin && (e.estado === 'cerrado' || e.estado === 'anulado') ? '' : 'none';
  }

  function recogerEvento() {
    var ti = [], tb = [];
    if ($('evt-ti-acto').checked) ti.push('acto_subestandar');
    if ($('evt-ti-cond').checked) ti.push('condicion_subestandar');
    if ($('evt-tb-pers').checked) tb.push('factor_personal');
    if ($('evt-tb-trab').checked) tb.push('factor_trabajo');
    var dentro = $('evt-dentro').value;
    return {
      fecha_evento: $('evt-fecha').value, hora_evento: valOrNull('evt-hora'),
      trabajador_id: $('evt-trabajador').value ? Number($('evt-trabajador').value) : null,
      gravedad: $('evt-gravedad').value || null, tipo_accidente: $('evt-tipo-acc').value || null,
      mecanismo: $('evt-mecanismo').value || null, agente: $('evt-agente').value || null,
      dentro_empresa: dentro === '' ? null : dentro === '1', lugar: $('evt-lugar').value.trim(),
      descripcion: $('evt-descripcion').value.trim(),
      dias_incapacidad: parseInt($('evt-dias-inc').value, 10) || 0, dias_cargados: parseInt($('evt-dias-carg').value, 10) || 0,
      caso_hasta: valOrNull('evt-caso-hasta'),
      referencia_reporte: $('evt-ref').value.trim(), fecha_reporte_arl: valOrNull('evt-rep-arl'), fecha_reporte_eps: valOrNull('evt-rep-eps'),
      fecha_reporte_territorial: valOrNull('evt-rep-terr'),
      fecha_investigacion: valOrNull('evt-fecha-inv'), informe_enviado_arl_en: valOrNull('evt-informe-arl'),
      equipo_investigador: $('evt-equipo').value.trim(), profesional_licencia_sst: $('evt-prof').value.trim(),
      causas_inmediatas: $('evt-causas-inm').value.trim(), causas_basicas: $('evt-causas-bas').value.trim(),
      tipos_causa_inmediata: ti, tipos_causa_basica: tb,
      leccion_aprendida: $('evt-leccion').value.trim(), leccion_socializada_en: valOrNull('evt-leccion-soc'),
      observaciones: $('evt-obs').value.trim(),
    };
  }

  async function guardarEvento(nuevoEstado, motivoAnulacion) {
    var tipo = $('evt-tipo').value, f = recogerEvento();
    if (!f.fecha_evento) { showToast('Indica la fecha del evento', '#e74c3c'); return; }
    if (f.descripcion.length < 3) { showToast('Describe qué pasó', '#e74c3c'); return; }
    if (tipo === 'accidente' && !f.gravedad) { showToast('Indica la gravedad del accidente', '#e74c3c'); return; }
    if ((tipo === 'accidente' || tipo === 'enfermedad_laboral') && !f.trabajador_id) { showToast('Indica el trabajador', '#e74c3c'); return; }
    if (nuevoEstado) f.estado = nuevoEstado;
    if (motivoAnulacion) f.motivo_anulacion = motivoAnulacion;
    var btns = ['evt-ok', 'evt-btn-iniciar', 'evt-btn-investigado', 'evt-btn-cerrar'].map($);
    btns.forEach(function (b) { btnBusy(b, true); });
    var res, nuevoId = evtId;
    if (evtId) res = await _sb.from('sst_eventos').update(f).eq('id', evtId);
    else {
      f.empresa_id = Number($('evt-empresa').value); f.tipo = tipo;
      res = await _sb.from('sst_eventos').insert(f).select('id').single();
      if (!res.error && res.data) nuevoId = res.data.id;
    }
    btns.forEach(function (b) { btnBusy(b, false); });
    if (res.error) { fail('guardar el evento', res.error); return; }
    showToast(evtId ? (nuevoEstado ? 'Evento ' + (ESTADO_EVT[nuevoEstado] || nuevoEstado).toLowerCase() : 'Evento actualizado') : 'Evento registrado');
    var eraNuevo = !evtId;
    await cargar(false);
    if (eraNuevo && nuevoId) abrirEvento(nuevoId);
    else if (evtId && eventoById[evtId]) renderEventoDerivado();
  }

  function anularEvento() {
    var m = window.prompt('Motivo de la anulación del evento (por ejemplo, registro duplicado o error de digitación):', '');
    if (m === null) return;
    if (m.trim().length < 3) { showToast('Indica el motivo de la anulación', '#e74c3c'); return; }
    guardarEvento('anulado', m.trim());
  }

  // ══════════════ Fase 3: Acciones correctivas, preventivas y de mejora ══════════════
  function filtrarAcciones() {
    var emp = $('fc-empresa').value, origen = $('fc-origen').value, alerta = $('fc-alerta').value, q = norm($('fc-txt').value), cerradas = $('fc-cerradas').value === '1';
    return accionesC.filter(function (a) {
      if (emp && String(a.empresa_id) !== emp) return false;
      if (origen && a.origen !== origen) return false;
      if (alerta && a.semaforo !== alerta) return false;
      if (!cerradas && (a.estado === 'cerrada' || a.estado === 'cancelada')) return false;
      if (q && norm([a.descripcion, a.responsable, a.hallazgo].join(' ')).indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return a.fecha_limite < b.fecha_limite ? -1 : a.fecha_limite > b.fecha_limite ? 1 : a.id - b.id; });
  }

  function tarjetaAccion(a) {
    var s = SEMAFORO_ACC[a.semaforo] || [a.semaforo, '#718096'];
    var ev = a.evento_id ? eventoById[a.evento_id] : null;
    var btns = '';
    if (a.estado === 'abierta') btns += '<button class="btn-secondary" data-act="acc-mover" data-id="' + esc(a.id) + '" data-estado="en_curso">▶ Iniciar</button>';
    if (a.estado === 'en_curso') btns += '<button class="btn-secondary" data-act="acc-mover" data-id="' + esc(a.id) + '" data-estado="en_verificacion">✔ Ejecutada</button>';
    btns += '<button class="btn-edit" data-act="acc-editar" data-id="' + esc(a.id) + '">Abrir</button>';
    return '<div class="sst-card ' + esc(a.semaforo) + '">' +
      '<div style="margin-bottom:4px">' + badge(ORIGEN_ACC[a.origen] || a.origen, '#4a5568') + ' ' + badge(TIPO_ACC[a.tipo] || a.tipo, '#718096') + '</div>' +
      '<div class="sst-clamp" style="max-width:none" title="' + esc(a.descripcion) + '">' + esc(a.descripcion) + '</div>' +
      '<div class="sst-card-meta">' + esc(a.responsable) + ' · límite ' + esc(fmtDateOnly(a.fecha_limite)) +
        (a.estado !== 'cerrada' && a.estado !== 'cancelada' ? ' <span class="mk-pill ' + (a.semaforo === 'vencida' ? 'over' : a.semaforo === 'por_vencer' ? 'mid' : 'ok') + '">' + esc(s[0]) + '</span>' : '') + '</div>' +
      (ev ? '<div class="sst-card-meta">↳ <a href="#" data-act="evt-abrir" data-id="' + esc(ev.id) + '">' + esc(tituloEvento(ev)) + '</a></div>' : '') +
      '<div class="sst-card-btns">' + btns + '</div></div>';
  }

  function renderAcciones() {
    var lista = filtrarAcciones(), mostrarCerradas = $('fc-cerradas').value === '1';
    $('acciones-ct').textContent = '(' + lista.length + ')';
    var cols = ['abierta', 'en_curso', 'en_verificacion'].concat(mostrarCerradas ? ['cerrada', 'cancelada'] : []);
    if (!lista.length && !accionesC.length) {
      $('acciones-tablero').innerHTML = '<div class="empty">Aún no hay acciones. Se crean desde un evento o con «Nueva acción».</div>';
      return;
    }
    $('acciones-tablero').innerHTML = '<div class="sst-kanban">' + cols.map(function (c) {
      var items = lista.filter(function (a) { return a.estado === c; });
      return '<div class="sst-col"><h4><span>' + esc(ESTADO_ACC[c]) + '</span><span>' + items.length + '</span></h4>' +
        (items.length ? items.map(tarjetaAccion).join('') : '<div class="mk-sin" style="font-size:0.78rem">Sin acciones</div>') + '</div>';
    }).join('') + '</div>';
  }

  function aplicarOrigenAccion() {
    $('acc-evento-box').style.display = $('acc-origen').value === 'evento' ? '' : 'none';
  }
  function llenarEventosAccion(empId, sel) {
    var op = eventosR.filter(function (e) { return e.empresa_id === empId && (eventoActivo(e) || e.id === sel); })
      .sort(function (a, b) { return a.fecha_evento < b.fecha_evento ? 1 : -1; })
      .map(function (e) { return { v: e.id, t: tituloEvento(e) + ' — ' + String(e.descripcion).slice(0, 50) }; });
    $('acc-evento').innerHTML = optsHtml(op, 'Selecciona el evento…', sel || '');
  }
  function aplicarEstadoAccion() {
    var est = $('acc-estado').value;
    $('acc-cancel-box').style.display = est === 'cancelada' ? '' : 'none';
    if ((est === 'en_verificacion' || est === 'cerrada') && !$('acc-ejecucion').value) $('acc-ejecucion').value = today();
    if (est === 'cerrada' && !$('acc-verificacion').value) $('acc-verificacion').value = today();
  }

  // abrirAccion(id) edita; abrirAccion(null, { evento_id, empresa_id }) crea una acción (opcionalmente de un evento).
  function abrirAccion(id, ctx) {
    var a = id ? accionById[id] : null;
    if (!a && !empresas.some(function (x) { return x.activa; })) { showToast('Primero crea una empresa activa', '#e74c3c'); return; }
    accId = id || null; accCtx = !id && ctx ? ctx : null;
    var activas = empresas.filter(function (x) { return x.activa || (a && x.id === a.empresa_id); });
    var emp0 = a ? a.empresa_id : (ctx && ctx.empresa_id) || Number($('fc-empresa').value) || (activas[0] && activas[0].id);
    $('acc-titulo').textContent = a ? 'Editar acción' : 'Nueva acción';
    var ev = a && a.evento_id ? eventoById[a.evento_id] : (ctx && ctx.evento_id ? eventoById[ctx.evento_id] : null);
    $('acc-meta').innerHTML = ev ? '<span>' + esc(tituloEvento(ev)) + '</span>' : '';
    $('acc-empresa').innerHTML = optsHtml(activas.map(function (x) { return { v: x.id, t: x.nombre }; }), null, emp0);
    $('acc-empresa').disabled = !!a || !!(ctx && ctx.evento_id);
    $('acc-origen').value = a ? a.origen : (ctx && ctx.evento_id ? 'evento' : 'otro');
    $('acc-origen').disabled = !!a || !!(ctx && ctx.evento_id);
    llenarEventosAccion(emp0, a ? a.evento_id : (ctx ? ctx.evento_id : null));
    $('acc-evento').disabled = !!a || !!(ctx && ctx.evento_id);
    aplicarOrigenAccion();
    $('acc-tipo').value = a ? a.tipo : 'correctiva';
    $('acc-nivel').value = a && a.nivel_control ? a.nivel_control : '';
    $('acc-hallazgo').value = a ? a.hallazgo : '';
    $('acc-descripcion').value = a ? a.descripcion : '';
    $('acc-responsable').value = a ? a.responsable : '';
    var d30 = new Date(); d30.setDate(d30.getDate() + 30);
    $('acc-limite').value = a ? a.fecha_limite : d30.getFullYear() + '-' + String(d30.getMonth() + 1).padStart(2, '0') + '-' + String(d30.getDate()).padStart(2, '0');
    $('acc-estado').value = a ? a.estado : 'abierta';
    $('acc-ejecucion').value = a && a.fecha_ejecucion ? a.fecha_ejecucion : '';
    $('acc-verificacion').value = a && a.fecha_verificacion ? a.fecha_verificacion : '';
    $('acc-eficaz').value = a && a.verificacion_eficaz !== null && a.verificacion_eficaz !== undefined ? (a.verificacion_eficaz ? '1' : '0') : '';
    $('acc-resultado').value = a ? a.resultado_verificacion : '';
    $('acc-verificado-por').value = a ? a.verificado_por : '';
    $('acc-motivo').value = a ? a.motivo_cancelacion : '';
    $('acc-obs').value = a ? a.observaciones : '';
    $('acc-aud').innerHTML = a ? auditoriaHtml(a) : '';
    var vistos = {}, dl = [];
    accionesC.forEach(function (x) { var r = String(x.responsable || '').trim(); if (r && !vistos[r]) { vistos[r] = 1; dl.push(r); } });
    $('acc-responsables').innerHTML = dl.sort().map(function (r) { return '<option value="' + esc(r) + '">'; }).join('');
    $('acc-cancel-box').style.display = $('acc-estado').value === 'cancelada' ? '' : 'none';
    var be = $('acc-btn-evid');
    be.style.display = a ? '' : 'none';
    if (a) be.textContent = '🔗 Soportes (' + evidenciasDe('accion', a.id).length + ')';
    MODAL.open('acc-overlay', 'acc-descripcion');
  }

  async function guardarAccion() {
    var desc = $('acc-descripcion').value.trim(), resp = $('acc-responsable').value.trim(), lim = $('acc-limite').value;
    if (desc.length < 3) { showToast('Describe la acción', '#e74c3c'); return; }
    if (resp.length < 2) { showToast('Indica el responsable', '#e74c3c'); return; }
    if (!lim) { showToast('Indica la fecha límite', '#e74c3c'); return; }
    var origen = $('acc-origen').value, eventoId = $('acc-evento').value ? Number($('acc-evento').value) : null;
    if (!accId && origen === 'evento' && !eventoId) { showToast('Selecciona el evento que origina la acción', '#e74c3c'); return; }
    var eficaz = $('acc-eficaz').value;
    var fila = {
      tipo: $('acc-tipo').value, nivel_control: $('acc-nivel').value || null, hallazgo: $('acc-hallazgo').value.trim(), descripcion: desc,
      responsable: resp, fecha_limite: lim, estado: $('acc-estado').value, fecha_ejecucion: valOrNull('acc-ejecucion'),
      fecha_verificacion: valOrNull('acc-verificacion'), verificacion_eficaz: eficaz === '' ? null : eficaz === '1',
      resultado_verificacion: $('acc-resultado').value.trim(), verificado_por: $('acc-verificado-por').value.trim(),
      motivo_cancelacion: $('acc-motivo').value.trim(), observaciones: $('acc-obs').value.trim(),
    };
    if (!accId) {
      fila.empresa_id = Number($('acc-empresa').value); fila.origen = origen;
      if (origen === 'evento') fila.evento_id = eventoId;
    }
    var btn = $('acc-ok'); btnBusy(btn, true);
    var res = accId ? await _sb.from('sst_acciones').update(fila).eq('id', accId) : await _sb.from('sst_acciones').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar la acción', res.error); return; }
    MODAL.close('acc-overlay');
    showToast(accId ? 'Acción actualizada' : 'Acción registrada');
    await cargar(false);
  }

  async function moverAccion(id, estado) {
    var cambios = { estado: estado };
    if (estado === 'en_verificacion') cambios.fecha_ejecucion = today();
    var res = await _sb.from('sst_acciones').update(cambios).eq('id', id);
    if (res.error) fail('mover la acción', res.error);
    else showToast('Acción: ' + (ESTADO_ACC[estado] || estado).toLowerCase());
    await cargar(false);
  }

  // ══════════════ Fase 3: Indicadores de accidentalidad ══════════════
  function rellenarIndicadores() {
    var cur = $('fi-empresa').value, op = empresas.map(function (e) { return { v: e.id, t: e.nombre }; });
    var primera = (empresas.filter(function (e) { return e.activa; })[0] || empresas[0] || {}).id;
    $('fi-empresa').innerHTML = optsHtml(op, null, cur || primera || '');
    var emp = Number($('fi-empresa').value);
    var anios = {}, y = parseInt(today().slice(0, 4), 10);
    anios[y] = 1;
    indAnio.forEach(function (x) { if (x.empresa_id === emp) anios[x.vigencia] = 1; });
    var lista = Object.keys(anios).map(Number).sort(function (a, b) { return b - a; });
    var actual = $('fi-anio').value;
    $('fi-anio').innerHTML = optsHtml(lista.map(function (v) { return { v: v, t: String(v) }; }), null, actual && anios[actual] ? actual : y);
  }
  function fmtInd(v, dec) {
    return v === null || v === undefined ? '—' : Number(v).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: dec === undefined ? 2 : dec });
  }
  function renderIndicadores() {
    var emp = Number($('fi-empresa').value), anio = parseInt($('fi-anio').value, 10);
    var cont = $('indicadores-contenido');
    if (!emp || isNaN(anio)) { cont.innerHTML = '<div class="empty">Elige la empresa y el año.</div>'; return; }
    var meses = indAt.filter(function (m) { return m.empresa_id === emp && m.vigencia === anio; }).sort(function (a, b) { return a.mes - b.mes; });
    var a = indAnio.filter(function (x) { return x.empresa_id === emp && x.vigencia === anio; })[0];
    if (!meses.length || !a) { cont.innerHTML = '<div class="empty">Sin datos para esta empresa y año.</div>'; return; }
    var ref = mesRef(anio), declarado = meses.some(function (m) { return m.base_trabajadores === 'declarado'; });
    var h = '';
    if (declarado) h += '<div class="mk-flag">Esta empresa no tiene trabajadores registrados en algún mes: el cálculo usa el número de trabajadores declarado en la empresa. Registra a los trabajadores en la pestaña Trabajadores (con su fecha de ingreso) para que los indicadores sean exactos.</div>';
    h += '<div class="mk-ctx-grid">' +
      '<div class="mk-box"><h4>Accidentalidad de ' + esc(anio) + '</h4>' +
        '<div class="mk-kv"><span>Accidentes de trabajo</span><span>' + esc(a.accidentes) + '</span></div>' +
        '<div class="mk-kv"><span>Accidentes mortales</span><span>' + esc(a.accidentes_mortales) + '</span></div>' +
        '<div class="mk-kv"><span>Proporción de accidentes mortales</span><span><strong>' + esc(a.proporcion_mortales === null ? '—' : fmtInd(a.proporcion_mortales) + ' %') + '</strong></span></div>' +
        '<div class="mk-kv"><span>Promedio de trabajadores</span><span>' + esc(fmtInd(a.promedio_trabajadores)) + '</span></div></div>' +
      '<div class="mk-box"><h4>Enfermedad laboral de ' + esc(anio) + '</h4>' +
        '<div class="mk-kv"><span>Casos nuevos</span><span>' + esc(a.el_nuevos) + '</span></div>' +
        '<div class="mk-kv"><span>Casos presentes (nuevos y antiguos)</span><span>' + esc(a.el_casos) + '</span></div>' +
        '<div class="mk-kv"><span>Prevalencia (por 100.000 trabajadores)</span><span><strong>' + esc(fmtInd(a.prevalencia)) + '</strong></span></div>' +
        '<div class="mk-kv"><span>Incidencia (por 100.000 trabajadores)</span><span><strong>' + esc(fmtInd(a.incidencia)) + '</strong></span></div></div></div>';
    h += '<div class="mk-box" style="margin-bottom:14px"><h4>Frecuencia y severidad por mes</h4><div class="table-wrap"><table class="mk-mini sst-ind"><thead><tr><th>Indicador</th>' +
      meses.map(function (m) { return '<th' + (m.mes === ref ? ' style="background:#fffbeb"' : '') + '>' + MES3[m.mes - 1] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      [['Trabajadores', function (m) { return m.trabajadores; }, 0],
       ['Accidentes de trabajo', function (m) { return m.accidentes; }, 0],
       ['Frecuencia (por 100 trabajadores)', function (m) { return m.mes > ref && ref !== 13 ? null : m.frecuencia; }, 2],
       ['Días de incapacidad', function (m) { return m.dias_incapacidad; }, 0],
       ['Días cargados', function (m) { return m.dias_cargados; }, 0],
       ['Severidad (días por 100 trabajadores)', function (m) { return m.mes > ref && ref !== 13 ? null : m.severidad; }, 2]].map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td>' + meses.map(function (m) {
          var v = r[1](m);
          return '<td' + (m.mes === ref ? ' style="background:#fffbeb"' : '') + '>' + esc(fmtInd(v, r[2])) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="ef-help">Frecuencia = accidentes del mes / trabajadores del mes × 100. Severidad = (días de incapacidad + días cargados) / trabajadores del mes × 100. Los días de incapacidad se atribuyen al mes del accidente.</div></div>';
    cont.innerHTML = h;
  }

  MODAL.onClose = function (id) {
    if (id === 'ae-overlay') aeId = null;
    if (id === 'evl-overlay') evlCtx = null;
    if (id === 'ev-overlay') evEntidad = null;
    if (id === 'pm-overlay') { pmEditId = null; pmAutoId = null; }
    if (id === 'pa-overlay') { paEditId = null; paPlanId = null; }
    if (id === 'cp-overlay') { cpEditId = null; cpCtx = null; }
    if (id === 'cs-lista-overlay') cslCapId = null;
    if (id === 'cs-overlay') { csEditId = null; csCapId = null; }
    if (id === 'evt-overlay') evtId = null;
    if (id === 'acc-overlay') { accId = null; accCtx = null; }
  };

  // ══════════════ Eventos ══════════════
  var CAMBIOS = {
    'ae-item-resultado': cambiarResultadoItem,
    'ae-item-obs': cambiarObsItem,
    'cs-conv': cambiarConvocado,
    'cs-asi': cambiarAsistio,
  };
  var ACCIONES = {
    'ae-nueva': abrirNuevaAuto,
    'ae-crear': crearAuto,
    'ae-abrir': function (el) { abrirAuto(Number(el.getAttribute('data-id'))); },
    'ae-guardar-datos': guardarDatosAuto,
    'ae-guardar-fechas': guardarFechasAuto,
    'ae-cerrar': cerrarAuto,
    'ae-reabrir': reabrirAuto,
    'ae-pdf': generarPdfAuto,
    'evl-abrir': function (el) { abrirEvl(el.getAttribute('data-tipo'), Number(el.getAttribute('data-id'))); },
    'evl-agregar': function () { if (evlCtx) abrirEvidencia(null, { tipo: evlCtx.tipo, id: evlCtx.id, empresa_id: evlCtx.empresa_id, titulo: evlCtx.titulo }); },
    'pm-nuevo': function () { abrirPlan(null, aeId, null); },
    'pm-nuevo-item': function (el) { abrirPlan(null, aeId, Number(el.getAttribute('data-id'))); },
    'pm-editar': function (el) { abrirPlan(Number(el.getAttribute('data-id')), null, null); },
    'pm-guardar': guardarPlan,
    'pl-nuevo': abrirNuevoPlan,
    'pl-crear': crearPlan,
    'pl-pdf': generarPdfPlan,
    'pd-guardar': guardarDatosPlan,
    'pf-limpiar': function () { $('pf-ciclo').value = ''; $('pf-grupo').value = ''; $('pf-estado').value = ''; $('pf-mes').value = ''; $('pf-txt').value = ''; renderActividades(); },
    'pa-nueva': function () { abrirActividad(null); },
    'pa-editar': function (el) { abrirActividad(Number(el.getAttribute('data-id'))); },
    'pa-guardar': guardarActividad,
    'pa-mes': function (el) { alternarMes(Number(el.getAttribute('data-id')), Number(el.getAttribute('data-mes'))); },
    'pa-evid': function () { if (paEditId) abrirEvl('plan_actividad', paEditId); },
    'cp-nuevo': function () { abrirTema(null); },
    'cp-editar': function (el) { abrirTema(Number(el.getAttribute('data-id'))); },
    'cp-guardar': guardarTema,
    'cs-lista': function (el) { abrirSesionesLista(Number(el.getAttribute('data-id'))); },
    'cs-nueva': function () { if (cslCapId) abrirSesion(null, cslCapId); },
    'cs-editar': function (el) { abrirSesion(Number(el.getAttribute('data-id')), null); },
    'cs-guardar': guardarSesion,
    'cs-todos': marcarTodosAsistentes,
    'cs-planilla': function () { if (csEditId) generarPlanilla(csEditId); },
    'cs-planilla-id': function (el) { generarPlanilla(Number(el.getAttribute('data-id'))); },
    'cs-evid': function () { if (csEditId) abrirEvl('cap_sesion', csEditId); },
    'evt-nuevo': function () { abrirEvento(null); },
    'evt-abrir': function (el) { abrirEvento(Number(el.getAttribute('data-id'))); },
    'evt-guardar': function () { guardarEvento(null, null); },
    'evt-estado': function (el) {
      var nuevo = el.getAttribute('data-estado');
      if (nuevo === 'abierto' && !window.confirm('¿Reabrir el evento? Volverá a estar abierto y se podrá editar.')) return;
      guardarEvento(nuevo, null);
    },
    'evt-anular': anularEvento,
    'evt-accion': function () {
      var e = evtId ? eventoById[evtId] : null;
      if (e) abrirAccion(null, { evento_id: e.id, empresa_id: e.empresa_id });
    },
    'evt-evid': function () { if (evtId) abrirEvl('evento', evtId); },
    'fe-limpiar': function () { $('fe-empresa').value = ''; $('fe-tipo').value = ''; $('fe-estado').value = 'activos'; $('fe-anio').value = ''; $('fe-txt').value = ''; renderEventos(); },
    'acc-nueva': function () { abrirAccion(null, null); },
    'acc-editar': function (el) { abrirAccion(Number(el.getAttribute('data-id')), null); },
    'acc-guardar': guardarAccion,
    'acc-mover': function (el) { moverAccion(Number(el.getAttribute('data-id')), el.getAttribute('data-estado')); },
    'acc-evid': function () { if (accId) abrirEvl('accion', accId); },
    'reintentar': function () { cargar(true); },
    'tab': function (el) { cambiarTab(el.getAttribute('data-tab')); },
    'cerrar-modal': function (el) { MODAL.close(el.getAttribute('data-modal')); },
    'emp-nueva': function () { abrirEmpresa(null); },
    'emp-editar': function (el) { abrirEmpresa(Number(el.getAttribute('data-id'))); },
    'emp-guardar': guardarEmpresa,
    'tr-nuevo': function () { abrirTrabajador(null); },
    'tr-editar': function (el) { abrirTrabajador(Number(el.getAttribute('data-id'))); },
    'tr-guardar': guardarTrabajador,
    'tr-limpiar': function () { $('ft-empresa').value = ''; $('ft-estado').value = 'activos'; $('ft-txt').value = ''; renderTrabajadores(); },
    'ev-nueva': function () { abrirEvidencia(null); },
    'ev-editar': function (el) { abrirEvidencia(Number(el.getAttribute('data-id'))); },
    'ev-guardar': guardarEvidencia,
    'ev-limpiar': function () { $('fv-empresa').value = ''; $('fv-tipo').value = ''; $('fv-estado').value = 'activas'; $('fv-vigencia').value = ''; $('fv-txt').value = ''; renderEvidencias(); },
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    // Un botón/enlace dentro de una fila clicable no debe disparar también la acción de la fila.
    if (el.tagName === 'TR' && e.target.closest && e.target.closest('button, a') && e.target.closest('button, a') !== el) return;
    var fn = ACCIONES[el.getAttribute('data-act')];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    fn(el);
  });

  ['ft-empresa', 'ft-estado', 'ft-txt'].forEach(function (id) { $(id).addEventListener('input', renderTrabajadores); $(id).addEventListener('change', renderTrabajadores); });
  ['fv-empresa', 'fv-tipo', 'fv-estado', 'fv-vigencia', 'fv-txt'].forEach(function (id) { $(id).addEventListener('input', renderEvidencias); $(id).addEventListener('change', renderEvidencias); });
  $('e-num').addEventListener('input', previsualizarGrupo);
  $('e-clases').addEventListener('change', previsualizarGrupo);
  ['fa-empresa', 'fa-estado'].forEach(function (id) { $(id).addEventListener('change', renderAutoevals); });
  $('pl-plan').addEventListener('change', function () { plSel = Number(this.value); plDatosKey = null; plDatosAbierto = null; renderPlan(); });
  $('pf-mes').innerHTML = '<option value="">Cualquier mes</option>' + MES_LARGO.map(function (m, i) { return '<option value="' + (i + 1) + '">' + m + '</option>'; }).join('');
  ['pf-ciclo', 'pf-grupo', 'pf-estado', 'pf-mes', 'pf-txt'].forEach(function (id) { $(id).addEventListener('input', renderActividades); $(id).addEventListener('change', renderActividades); });
  ['cf-empresa', 'cf-vigencia', 'cf-estado'].forEach(function (id) { $(id).addEventListener('input', renderCapacitaciones); $(id).addEventListener('change', renderCapacitaciones); });
  ['pn-empresa', 'pn-vigencia', 'pn-origen'].forEach(function (id) { $(id).addEventListener('input', actualizarNuevoPlan); $(id).addEventListener('change', actualizarNuevoPlan); });
  $('pa-aplica').addEventListener('change', function () { $('pa-motivo-box').style.display = this.value === '1' ? 'none' : ''; });
  ['cs-estado', 'cs-fecha'].forEach(function (id) { $(id).addEventListener('change', aplicarEstadoSesion); });
  ['fe-empresa', 'fe-tipo', 'fe-estado', 'fe-anio', 'fe-txt'].forEach(function (id) { $(id).addEventListener('input', renderEventos); $(id).addEventListener('change', renderEventos); });
  ['fc-empresa', 'fc-origen', 'fc-alerta', 'fc-txt', 'fc-cerradas'].forEach(function (id) { $(id).addEventListener('input', renderAcciones); $(id).addEventListener('change', renderAcciones); });
  $('fi-empresa').addEventListener('change', function () { $('fi-anio').value = ''; rellenarIndicadores(); renderIndicadores(); });
  $('fi-anio').addEventListener('change', renderIndicadores);
  ['evt-tipo', 'evt-gravedad'].forEach(function (id) { $(id).addEventListener('change', aplicarTipoEvento); });
  $('evt-empresa').addEventListener('change', function () { llenarTrabajadoresEvento(Number(this.value), null); });
  $('acc-origen').addEventListener('change', aplicarOrigenAccion);
  $('acc-empresa').addEventListener('change', function () { llenarEventosAccion(Number(this.value), null); });
  $('acc-estado').addEventListener('change', aplicarEstadoAccion);
  ['an-empresa', 'an-vigencia'].forEach(function (id) { $(id).addEventListener('input', actualizarNuevaAuto); $(id).addEventListener('change', actualizarNuevaAuto); });
  ['an-empleador', 'an-responsable'].forEach(function (id) { $(id).addEventListener('input', function () { this.dataset.tocado = '1'; }); });
  // Selectores y campos que guardan al cambiar (calificación y observación de cada estándar).
  document.addEventListener('change', function (e) {
    var h = e.target && e.target.getAttribute ? e.target.getAttribute('data-chg') : null;
    if (h && CAMBIOS[h]) CAMBIOS[h](e.target);
  });

  await cargar(true);
})();
