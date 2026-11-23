// Registro de asistentes de un evento de Mercadeo (Eventos > «👥 Asistentes», migración 0042).
//
// Digitaliza la «Planilla de asistencia» que los asistentes firman en papel (IASO «Registro de asistencia»): nombre completo,
// número de cédula, cultivo principal, vereda o ubicación, número de hectáreas, teléfono, correo y si ya usó productos
// orgánicos / biorracionales (Sí/No). La firma queda en el papel. Un formulario arriba (mismas columnas que la planilla) y,
// debajo, la lista de lo ya digitado, con editar, eliminar, buscador y descarga a Excel (CSV).
//
// Cada asistente se guarda al instante (insert / update / delete directos contra mercadeo_evento_asistentes); las reglas
// (estado del evento, cédula repetida, tope, quién registró) las impone el trigger de la BD, aquí solo se validan los formatos
// para avisar antes. DATOS PERSONALES: solo el módulo `mercadeo` los lee; no van a Pedidos ni al PDF.
// Depende de supabase-client.js (escHtml, fmtDateOnly, fmtDateTime, fetchAll, norm, errMsg, showToast), modal.js (MODAL),
// eventos-pdf.js (EVENTO_PDF.ESTADO_T) y del modal #asistentes-overlay de eventos.html.
var EVENTO_ASISTENTES = (function () {
  var TABLA = 'mercadeo_evento_asistentes';
  // Estados en los que la BD deja escribir (igual que el trigger) y estados en los que se muestra el botón (+ cerrada, solo lectura).
  var ESTADOS = ['aprobada', 'en_preparacion', 'realizada'];
  var CON_BOTON = ESTADOS.concat(['cerrada']);
  var st = null;   // { sb, evento, filas, editId, ocupado, cargando, error, buscar, onCambio }

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function limpio(s) { return String(s === null || s === undefined ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); }
  // Un lector con el módulo Mercadeo (migración 0043) consulta y descarga, pero no digita: la BD tampoco lo deja escribir.
  function soloLectura() { return typeof AUTH !== 'undefined' && !!AUTH.soloLecturaMercadeo && AUTH.soloLecturaMercadeo(); }
  function enEstadoEditable() { return !!st && ESTADOS.indexOf(st.evento.estado) >= 0; }
  function editable() { return enEstadoEditable() && !soloLectura(); }
  function fmtHa(v) { return Number(v).toLocaleString('es-CO', { maximumFractionDigits: 2 }); }
  function siNo(v) { return v === true ? 'Sí' : v === false ? 'No' : '—'; }
  function celda(v) { return v ? esc(v) : '<span class="mk-sin">—</span>'; }

  // ── Lectura y validación del formulario ──
  // Devuelve { d } con lo que se envía a la BD, o { err, campo } con el primer problema. Solo el nombre es obligatorio: la planilla en papel
  // llega incompleta con frecuencia y es mejor tener a la persona registrada que perderla.
  function leerForm() {
    var d = {
      nombre: limpio($('asis-nombre').value),
      cedula: limpio($('asis-cedula').value),
      cultivo: limpio($('asis-cultivo').value),
      vereda: limpio($('asis-vereda').value),
      telefono: limpio($('asis-tel').value),
      correo: limpio($('asis-correo').value).toLowerCase(),
      hectareas: null,
      usa_organicos: $('asis-org').value === 'si' ? true : $('asis-org').value === 'no' ? false : null,
    };
    var err = '', campo = '';
    function falla(c, m) { if (!err) { err = m; campo = c; } }
    if (d.nombre.length < 3) falla('asis-nombre', 'Escribe el nombre completo (mínimo 3 caracteres)');
    if (d.cedula && (d.cedula.length < 4 || d.cedula.length > 20 || !/^[0-9A-Za-z.\- ]+$/.test(d.cedula))) {
      falla('asis-cedula', 'La cédula debe tener de 4 a 20 caracteres (solo letras, números, puntos o guiones)');
    }
    var ha = $('asis-ha').value.replace(/\s/g, '').replace(',', '.');
    if (ha) {
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(ha) || Number(ha) > 100000) falla('asis-ha', 'Las hectáreas deben ser un número con hasta 2 decimales (p. ej. 2,5)');
      else d.hectareas = Number(ha);
    }
    if (d.telefono && (d.telefono.match(/\d/g) || []).length < 7) falla('asis-tel', 'El teléfono debe tener al menos 7 dígitos');
    if (d.correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.correo)) falla('asis-correo', 'El correo no tiene un formato válido (p. ej. nombre@correo.com)');
    return err ? { err: err, campo: campo } : { d: d };
  }

  function llenarForm(f) {
    $('asis-nombre').value = f ? f.nombre : '';
    $('asis-cedula').value = f && f.cedula ? f.cedula : '';
    $('asis-cultivo').value = f && f.cultivo ? f.cultivo : '';
    $('asis-vereda').value = f && f.vereda ? f.vereda : '';
    $('asis-ha').value = f && f.hectareas !== null && f.hectareas !== undefined ? String(f.hectareas).replace('.', ',') : '';
    $('asis-tel').value = f && f.telefono ? f.telefono : '';
    $('asis-correo').value = f && f.correo ? f.correo : '';
    $('asis-org').value = f && f.usa_organicos === true ? 'si' : f && f.usa_organicos === false ? 'no' : '';
  }

  // Deja el formulario en modo «registrar» (vacío) o en modo «editar a <fila>».
  function modoForm(fila) {
    st.editId = fila ? fila.id : null;
    llenarForm(fila);
    $('asis-form-titulo').textContent = fila ? '✏️ Editando a ' + fila.nombre : 'Registrar asistente';
    $('asis-guardar').textContent = fila ? '💾 Guardar cambios' : '➕ Agregar';
    $('asis-cancelar').style.display = fila ? '' : 'none';
    $('asis-form-box').classList.toggle('asis-edit', !!fila);
  }

  // ── Dibujo ──
  function renderCabecera() {
    var e = st.evento;
    $('asis-titulo').textContent = '👥 Asistentes · EV-' + e.id;
    var meta = ['<span>' + esc(e.nombre) + '</span>', '<span>' + esc(fmtDateOnly(e.fecha_evento)) + '</span>'];
    if (e.lugar) meta.push('<span>' + esc(e.lugar) + '</span>');
    var esperados = (Number(e.asistentes_presencial) || 0) + (Number(e.asistentes_virtual) || 0);
    if (esperados) meta.push('<span>Asistentes esperados: ' + esperados + '</span>');
    $('asis-meta').innerHTML = meta.join('');
  }

  function renderAviso() {
    var e = st.evento, html = '';
    if (st.error) {
      html = '<div class="mk-flag">No se pudieron cargar los asistentes: ' + esc(st.error) +
        ' <button type="button" class="btn-secondary" data-aa="reintentar">Reintentar</button></div>';
    } else if (enEstadoEditable() && !editable()) {
      html = '<div class="mk-flag">Tu acceso a Mercadeo es de solo lectura: puedes consultar y descargar la lista, no modificarla.</div>';
    } else if (!editable()) {
      var t = (typeof EVENTO_PDF !== 'undefined' && EVENTO_PDF.ESTADO_T[e.estado]) || e.estado;
      html = '<div class="mk-flag">' + (e.estado === 'cerrada'
        ? 'El evento está en estado <strong>' + esc(t) + '</strong>: la lista ya no se modifica (solo consulta y descarga).'
        : 'Los asistentes se registran cuando el evento está Aprobada, En preparación o Realizada. Estado actual: <strong>' + esc(t) + '</strong>.') + '</div>';
    }
    $('asis-aviso').innerHTML = html;
    $('asis-form-box').style.display = editable() && !st.error ? '' : 'none';
  }

  function renderResumen() {
    var f = st.filas;
    if (!f.length) { $('asis-resumen').innerHTML = ''; return; }
    var ha = f.reduce(function (a, x) { return a + (Number(x.hectareas) || 0); }, 0);
    var resp = f.filter(function (x) { return x.usa_organicos !== null && x.usa_organicos !== undefined; });
    var si = resp.filter(function (x) { return x.usa_organicos === true; }).length;
    var sinCed = f.filter(function (x) { return !x.cedula; }).length;
    var chips = ['<span class="kb-chip">👥 ' + f.length + ' registrado' + (f.length === 1 ? '' : 's') + '</span>'];
    if (ha) chips.push('<span class="kb-chip">🌾 ' + esc(fmtHa(ha)) + ' ha en total</span>');
    if (resp.length) chips.push('<span class="kb-chip" title="Sobre quienes respondieron la pregunta">🌱 ' + si + ' de ' + resp.length + ' ya usaron productos orgánicos / biorracionales</span>');
    if (sinCed) chips.push('<span class="kb-chip warn" title="Sin cédula no se puede detectar a una persona repetida">⚠ ' + sinCed + ' sin cédula</span>');
    $('asis-resumen').innerHTML = chips.join(' ');
  }

  // Sugerencias de los campos de texto: lo ya digitado en este evento (misma vereda y mismo cultivo se repiten mucho).
  function renderSugerencias() {
    function unicos(campo) {
      var vistos = {}, out = [];
      st.filas.forEach(function (f) {
        var v = f[campo]; if (!v) return;
        var k = norm(v); if (vistos[k]) return;
        vistos[k] = true; out.push(v);
      });
      return out.sort(function (a, b) { return a.localeCompare(b, 'es'); });
    }
    $('asis-dl-cultivo').innerHTML = unicos('cultivo').map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join('');
    $('asis-dl-vereda').innerHTML = unicos('vereda').map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join('');
  }

  function renderTabla() {
    var body = $('asis-body');
    if (st.cargando) { body.innerHTML = '<tr><td colspan="10" class="empty">Cargando…</td></tr>'; return; }
    if (st.error) { body.innerHTML = '<tr><td colspan="10" class="empty">No se pudo cargar la lista de asistentes.</td></tr>'; return; }
    var q = norm(st.buscar), edit = editable();
    var lista = st.filas.map(function (f, i) { return { f: f, n: i + 1 }; }).filter(function (x) {
      return !q || norm([x.f.nombre, x.f.cedula, x.f.cultivo, x.f.vereda, x.f.telefono, x.f.correo].join(' ')).indexOf(q) >= 0;
    });
    $('asis-ct').textContent = st.filas.length ? '(' + lista.length + (lista.length !== st.filas.length ? ' de ' + st.filas.length : '') + ')' : '';
    if (!lista.length) {
      body.innerHTML = '<tr><td colspan="10" class="empty">' + (st.filas.length ? 'Nadie coincide con la búsqueda.'
        : edit ? 'Aún no hay asistentes registrados. Digita la planilla de asistencia con el formulario de arriba.'
          : enEstadoEditable() ? 'Aún no hay asistentes registrados.' : 'No se registraron asistentes en este evento.') + '</td></tr>';
      return;
    }
    body.innerHTML = lista.map(function (x) {
      var f = x.f;
      var quien = 'Registrado por ' + (f.creado_por_nombre || '—') + (f.creado_en ? ' el ' + fmtDateTime(f.creado_en) : '') +
        (f.modificado_en && f.modificado_en !== f.creado_en ? ' · Modificado por ' + (f.modificado_por_nombre || '—') + ' el ' + fmtDateTime(f.modificado_en) : '');
      return '<tr' + (st.editId === f.id ? ' class="asis-editando"' : '') + ' title="' + esc(quien) + '">' +
        '<td class="asis-n">' + x.n + '</td>' +
        '<td><strong>' + esc(f.nombre) + '</strong></td>' +
        '<td>' + celda(f.cedula) + '</td>' +
        '<td>' + celda(f.cultivo) + '</td>' +
        '<td>' + celda(f.vereda) + '</td>' +
        '<td class="asis-num">' + (f.hectareas === null || f.hectareas === undefined ? '<span class="mk-sin">—</span>' : esc(fmtHa(f.hectareas))) + '</td>' +
        '<td>' + celda(f.telefono) + '</td>' +
        '<td class="asis-correo">' + celda(f.correo) + '</td>' +
        '<td>' + (f.usa_organicos === null || f.usa_organicos === undefined ? '<span class="mk-sin">—</span>' : siNo(f.usa_organicos)) + '</td>' +
        '<td class="asis-acc">' + (edit ? '<button type="button" class="btn-ver" data-aa="editar" data-id="' + esc(f.id) + '" aria-label="Editar a ' + esc(f.nombre) + '">✏️</button> ' +
          '<button type="button" class="btn-danger" data-aa="eliminar" data-id="' + esc(f.id) + '" aria-label="Eliminar a ' + esc(f.nombre) + '">🗑</button>' : '') + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderLista() { renderResumen(); renderSugerencias(); renderTabla(); }

  function setOcupado(b) {
    st.ocupado = b;
    $('asis-guardar').disabled = b;
    $('asis-guardar').textContent = b ? 'Guardando…' : st.editId ? '💾 Guardar cambios' : '➕ Agregar';
  }

  function avisarCambio() { if (st && typeof st.onCambio === 'function') st.onCambio(st.evento.id, st.filas.length); }

  // ── Datos ──
  async function cargar() {
    var mi = st;
    mi.cargando = true; mi.error = '';
    renderAviso(); renderTabla();
    var r = await fetchAll(TABLA, '*', 'id', function (q) { return q.eq('evento_id', mi.evento.id); });
    if (st !== mi) return;
    mi.cargando = false;
    if (r.error) { mi.error = errMsg(r.error); mi.filas = []; } else mi.filas = r.data;
    renderAviso(); renderLista();
    if (!r.error) avisarCambio();   // reajusta el número del botón de la lista con lo que hay de verdad
  }

  async function guardar() {
    var mi = st;
    if (!mi || mi.ocupado || !editable() || mi.error) return;
    var r = leerForm();
    if (r.err) { showToast(r.err, '#e74c3c'); if ($(r.campo)) $(r.campo).focus(); return; }
    var edit = mi.editId;
    setOcupado(true);
    var res;
    try {
      res = edit
        ? await mi.sb.from(TABLA).update(r.d).eq('id', edit).select('*')
        : await mi.sb.from(TABLA).insert(Object.assign({ evento_id: mi.evento.id }, r.d)).select('*');
    } catch (err) { res = { error: err }; }
    if (st !== mi) { mi.ocupado = false; return; }
    setOcupado(false);
    if (res.error) {
      showToast('No se guardó: ' + errMsg(res.error), '#e74c3c');
      if (/cédula/i.test(res.error.message || '') && $('asis-cedula')) $('asis-cedula').focus();
      return;
    }
    if (!res.data || !res.data.length) { showToast('No se guardó: no tienes permiso o el asistente ya no existe', '#e74c3c'); return; }
    var fila = res.data[0];
    if (edit) mi.filas = mi.filas.map(function (x) { return x.id === fila.id ? fila : x; });
    else mi.filas.push(fila);
    modoForm(null);
    renderLista();
    avisarCambio();
    showToast(edit ? 'Cambios guardados' : 'Asistente agregado (' + mi.filas.length + ')', '#27ae60');
    $('asis-nombre').focus();
  }

  function editar(id) {
    var f = st.filas.filter(function (x) { return x.id === id; })[0];
    if (!f || !editable()) return;
    modoForm(f);
    renderTabla();
    $('asis-form-box').scrollIntoView({ block: 'nearest' });
    $('asis-nombre').focus();
  }

  async function eliminar(id) {
    var mi = st;
    var f = mi.filas.filter(function (x) { return x.id === id; })[0];
    if (!f || mi.ocupado || !editable()) return;
    if (!confirm('¿Eliminar a «' + f.nombre + '» de los asistentes del evento? Queda constancia en la bitácora.')) return;
    mi.ocupado = true;
    var res;
    try { res = await mi.sb.from(TABLA).delete().eq('id', id).select('id'); } catch (err) { res = { error: err }; }
    mi.ocupado = false;
    if (res.error || !res.data || !res.data.length) {
      if (res.error) showToast('No se eliminó: ' + errMsg(res.error), '#e74c3c');
      else showToast('No se eliminó: no tienes permiso o ya no existe', '#e74c3c');
      return;
    }
    mi.filas = mi.filas.filter(function (x) { return x.id !== id; });
    if (st !== mi) { if (mi.onCambio) mi.onCambio(mi.evento.id, mi.filas.length); return; }
    if (mi.editId === id) modoForm(null);
    renderLista();
    avisarCambio();
  }

  // ── Descarga a Excel (CSV con ; y BOM: es el formato que abre bien Excel configurado en español) ──
  var COLS_CSV = ['No.', 'Nombre completo', 'Número de cédula', 'Cultivo principal', 'Vereda o ubicación', 'Número de hectáreas', 'Teléfono', 'Correo electrónico', '¿Ha usado productos orgánicos/biorracionales?'];
  function csvCelda(v) {
    var s = v === null || v === undefined ? '' : String(v);
    // Excel evalúa como fórmula lo que empieza por = + - @: se antepone un apóstrofo (salvo números y teléfonos).
    if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s))) s = "'" + s;
    if (/[";\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function descargarCsv() {
    if (!st || !st.filas.length) { showToast('No hay asistentes para descargar', '#e74c3c'); return; }
    var lineas = [COLS_CSV.map(csvCelda).join(';')];
    st.filas.forEach(function (f, i) {
      lineas.push([i + 1, f.nombre, f.cedula, f.cultivo, f.vereda,
        f.hectareas === null || f.hectareas === undefined ? '' : String(f.hectareas).replace('.', ','),
        f.telefono, f.correo, f.usa_organicos === true ? 'Sí' : f.usa_organicos === false ? 'No' : ''].map(csvCelda).join(';'));
    });
    var slug = norm(st.evento.nombre).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'evento';
    var blob = new Blob(['﻿' + lineas.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'asistentes_EV-' + st.evento.id + '_' + slug + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ── Eventos del modal ──
  $('asistentes-overlay').addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-aa]') : null;
    if (!el || !st) return;
    var a = el.getAttribute('data-aa'), id = Number(el.getAttribute('data-id'));
    if (a === 'cerrar') MODAL.close('asistentes-overlay');
    else if (a === 'editar') editar(id);
    else if (a === 'eliminar') eliminar(id);
    else if (a === 'cancelar') { modoForm(null); renderTabla(); $('asis-nombre').focus(); }
    else if (a === 'csv') descargarCsv();
    else if (a === 'reintentar') cargar();
  });
  $('asis-form').addEventListener('submit', function (ev) { ev.preventDefault(); if (st) guardar(); });
  $('asis-buscar').addEventListener('input', function () { if (st) { st.buscar = this.value; renderTabla(); } });

  return {
    // ¿Se muestra el botón de asistentes para este evento? (desde Aprobada; el evento Cerrado queda en solo lectura)
    disponible: function (e) { return !!e && CON_BOTON.indexOf(e.estado) >= 0; },
    // opts: { sb, evento, onCambio(eventoId, total) }
    abrir: function (opts) {
      st = { sb: opts.sb, evento: opts.evento, filas: [], editId: null, ocupado: false, cargando: true, error: '', buscar: '', onCambio: opts.onCambio };
      $('asis-buscar').value = '';
      renderCabecera();
      renderAviso();
      modoForm(null);
      renderLista();
      MODAL.open('asistentes-overlay', editable() ? 'asis-nombre' : 'asis-cerrar');
      cargar();
    },
    cerrar: function () { MODAL.close('asistentes-overlay'); },
  };
})();
