// ══════════════════════════════════════════════════════════════
// SST — Sistema de Gestión de Seguridad y Salud en el Trabajo (Res. 312 de 2019)
// FASE 0: base del módulo = Empresas + Trabajadores + Evidencias (enlaces a Drive).
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
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      empresas = rs[0].data; trabajadores = rs[1].data; evidencias = rs[2].data;
      estandares = rs[3].data; autoevals = rs[4].data; aeItems = rs[5].data; planes = rs[6].data;
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
    var ftipo = $('fv-tipo'), actualTipo = ftipo.value;
    ftipo.innerHTML = optsHtml(mapOpts(TIPO_EVID), 'Todos', actualTipo);
  }

  function renderTodo() {
    renderStats(); renderEmpresas(); renderTrabajadores(); renderAutoevals(); renderEvidencias();
    cambiarTab(tab);
    if (aeId) { if (autoById[aeId]) renderAutoDetalle(); else MODAL.close('ae-overlay'); }
    if (evlCtx) renderEvl();
  }

  function cambiarTab(t) {
    tab = t;
    ['empresas', 'trabajadores', 'autoevaluacion', 'evidencias'].forEach(function (k) {
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

  MODAL.onClose = function (id) {
    if (id === 'ae-overlay') aeId = null;
    if (id === 'evl-overlay') evlCtx = null;
    if (id === 'ev-overlay') evEntidad = null;
    if (id === 'pm-overlay') { pmEditId = null; pmAutoId = null; }
  };

  // ══════════════ Eventos ══════════════
  var CAMBIOS = {
    'ae-item-resultado': cambiarResultadoItem,
    'ae-item-obs': cambiarObsItem,
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
  ['an-empresa', 'an-vigencia'].forEach(function (id) { $(id).addEventListener('input', actualizarNuevaAuto); $(id).addEventListener('change', actualizarNuevaAuto); });
  ['an-empleador', 'an-responsable'].forEach(function (id) { $(id).addEventListener('input', function () { this.dataset.tocado = '1'; }); });
  // Selectores y campos que guardan al cambiar (calificación y observación de cada estándar).
  document.addEventListener('change', function (e) {
    var h = e.target && e.target.getAttribute ? e.target.getAttribute('data-chg') : null;
    if (h && CAMBIOS[h]) CAMBIOS[h](e.target);
  });

  await cargar(true);
})();
