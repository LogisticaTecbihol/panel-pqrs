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
  var tab = 'empresas', editEmpId = null, editTrId = null, editEvId = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function badge(txt, color) { return '<span class="mk-badge" style="background:' + color + '">' + esc(txt) + '</span>'; }
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
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      empresas = rs[0].data; trabajadores = rs[1].data; evidencias = rs[2].data;
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
    $('estado-carga').style.display = 'none';
    $('contenido').style.display = '';
    rellenarFiltros();
    renderTodo();
    return true;
  }

  function rellenarFiltros() {
    var op = empresas.map(function (e) { return { v: e.id, t: e.nombre }; });
    ['ft-empresa', 'fv-empresa'].forEach(function (id) {
      var el = $(id), actual = el.value;
      el.innerHTML = optsHtml(op, 'Todas', actual);
    });
    var ftipo = $('fv-tipo'), actualTipo = ftipo.value;
    ftipo.innerHTML = optsHtml(mapOpts(TIPO_EVID), 'Todos', actualTipo);
  }

  function renderTodo() {
    renderStats(); renderEmpresas(); renderTrabajadores(); renderEvidencias();
    cambiarTab(tab);
  }

  function cambiarTab(t) {
    tab = t;
    ['empresas', 'trabajadores', 'evidencias'].forEach(function (k) {
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
        '<td><strong>' + esc(e.titulo) + '</strong></td>' +
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

  function abrirEvidencia(id) {
    if (!empresas.length) { showToast('Primero crea una empresa', '#e74c3c'); return; }
    editEvId = id || null;
    var e = id ? evidencias.filter(function (x) { return x.id === id; })[0] : null;
    $('ev-titulo').textContent = e ? 'Editar evidencia' : 'Nueva evidencia';
    var activas = empresas.filter(function (x) { return x.activa || (e && x.id === e.empresa_id); });
    var emp0 = e ? e.empresa_id : ($('fv-empresa').value || (activas[0] && activas[0].id));
    $('v-empresa').innerHTML = optsHtml(activas.map(function (x) { return { v: x.id, t: x.nombre }; }), null, emp0);
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
    var btn = $('v-ok'); btnBusy(btn, true);
    var res = editEvId ? await _sb.from('sst_evidencias').update(fila).eq('id', editEvId) : await _sb.from('sst_evidencias').insert(fila);
    btnBusy(btn, false);
    if (res.error) { fail('guardar la evidencia', res.error); return; }
    MODAL.close('ev-overlay');
    showToast(editEvId ? 'Evidencia actualizada' : 'Evidencia registrada');
    await cargar(false);
  }

  // ══════════════ Eventos ══════════════
  var ACCIONES = {
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

  await cargar(true);
})();
