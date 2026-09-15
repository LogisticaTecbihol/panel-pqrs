(async function () {
  await AUTH.authReady;

  var params = new URLSearchParams(location.search);
  var pqrsId = params.get('id');
  var _row = null;
  var _usuarios = [];

  var ESTADO_BADGE = { 'Nuevo': 'b-nuevo', 'En proceso': 'b-proceso', 'Resuelto': 'b-resuelto', 'Cerrado': 'b-cerrado' };
  var URGENCIA_BADGE = { 'ALTO': 'b-alerta', 'MEDIO': 'b-medio', 'BAJA': 'b-baja' };
  var TIPO_LABEL = { 'Peticion': 'Petición', 'Queja': 'Queja', 'Reclamo': 'Reclamo', 'Sugerencia': 'Sugerencia' };
  var BUCKET = 'pqrs-gestion-adjuntos';

  document.querySelectorAll('.auth-edit-only').forEach(function (e) {
    e.style.display = AUTH.canEdit() ? (e.dataset.display || 'inline-block') : 'none';
  });
  if (!AUTH.canEdit()) {
    document.getElementById('g-estado').disabled = true;
    document.getElementById('g-responsable').disabled = true;
    document.getElementById('g-fecha-limite').disabled = true;
    document.getElementById('btn-guardar-gestion').style.display = 'none';
  }

  if (!pqrsId) {
    document.getElementById('not-found').style.display = '';
    return;
  }

  async function cargar() {
    var [usuariosRes, rowRes, adjRes, bitRes] = await Promise.all([
      _sb.from('usuarios_pqrs').select('id, nombre, email').eq('activo', true),
      _sb.from('pqrs').select('*').eq('id', pqrsId).single(),
      _sb.from('pqrs_adjuntos').select('*').eq('pqrs_id', pqrsId).order('creado_en'),
      _sb.from('pqrs_bitacora').select('*').eq('pqrs_id', pqrsId).order('creado_en'),
    ]);

    if (rowRes.error || !rowRes.data) {
      document.getElementById('not-found').style.display = '';
      return;
    }

    _usuarios = usuariosRes.data || [];
    _row = rowRes.data;

    var selResp = document.getElementById('g-responsable');
    _usuarios.forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.id; opt.textContent = u.nombre || u.email;
      selResp.appendChild(opt);
    });

    render();
    renderAdjuntos(adjRes.data || []);
    renderBitacora(bitRes.data || []);
    document.getElementById('content').style.display = '';
  }

  function campo(label, valor) {
    return '<div><label class="ef-label">' + label + '</label><div class="ef readonly" style="min-height:34px">' + (valor ? escHtml(valor) : '<span style="color:#a0aec0">&mdash;</span>') + '</div></div>';
  }

  function render() {
    document.getElementById('titulo-folio').textContent = _row.folio;
    document.title = 'PQRS ' + _row.folio;
    document.getElementById('badges').innerHTML =
      '<span class="sigla-badge sigla-' + _row.empresa_sigla + '">' + _row.empresa_sigla + '</span> ' +
      '<span class="badge ' + (URGENCIA_BADGE[_row.urgencia] || '') + '">' + _row.urgencia + '</span> ' +
      '<span class="badge ' + (ESTADO_BADGE[_row.estado] || '') + '">' + escHtml(_row.estado) + '</span>';

    document.getElementById('datos-grid').innerHTML =
      campo('Tipo de solicitud', TIPO_LABEL[_row.tipo_solicitud] || _row.tipo_solicitud) +
      campo('Área relacionada', _row.area_relacionada) +
      campo('Fecha del evento', fmtDate(_row.fecha_evento)) +
      campo('Nombre completo', _row.nombre_completo) +
      campo('Contacto (correo/celular)', _row.contacto) +
      campo('Identificación (NIT/Cédula)', _row.identificacion_cliente) +
      campo('N° pedido/factura/remisión', _row.referencia_pedido) +
      campo('Producto/lote relacionado', _row.producto_lote) +
      campo('Ciudad/Departamento', _row.ciudad_departamento) +
      campo('¿Desea respuesta?', _row.desea_respuesta ? 'Sí' : 'No') +
      campo('Recibido', fmtDateTime(_row.creado_en)) +
      '<div style="grid-column:1/-1">' + campo('Descripción', _row.descripcion) + '</div>' +
      (_row.comentarios_adicionales ? '<div style="grid-column:1/-1">' + campo('Comentarios adicionales', _row.comentarios_adicionales) + '</div>' : '');

    document.getElementById('g-estado').value = _row.estado;
    document.getElementById('g-responsable').value = _row.responsable_id || '';
    document.getElementById('g-fecha-limite').value = _row.fecha_limite || '';
  }

  function renderAdjuntos(rows) {
    var list = document.getElementById('adjuntos-list');
    document.getElementById('adjuntos-empty').style.display = rows.length ? 'none' : '';
    list.innerHTML = rows.map(function (a) {
      if (a.origen === 'cliente_drive') {
        return '<div class="adjunto-item"><div><div>' + escHtml(a.nombre_original || 'Adjunto del cliente') + '</div>' +
          '<div class="tag">Del cliente (Google Drive)</div></div>' +
          '<a class="btn-ver" href="' + escHtml(a.drive_url) + '" target="_blank" rel="noopener">Ver en Drive</a></div>';
      }
      return '<div class="adjunto-item" data-path="' + escHtml(a.storage_path) + '"><div><div>' + escHtml(a.nombre_original || 'Archivo') + '</div>' +
        '<div class="tag">Gestión interna</div></div>' +
        '<button class="btn-ver btn-descargar-adjunto" data-path="' + escHtml(a.storage_path) + '">Descargar</button></div>';
    }).join('');

    list.querySelectorAll('.btn-descargar-adjunto').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var path = btn.getAttribute('data-path');
        var res = await _sb.storage.from(BUCKET).createSignedUrl(path, 3600);
        if (res.error) { showToast('No se pudo generar el link: ' + res.error.message, '#e74c3c'); return; }
        window.open(res.data.signedUrl, '_blank');
      });
    });
  }

  function nombreUsuario(id) {
    var u = _usuarios.filter(function (x) { return x.id === id; })[0];
    return u ? (u.nombre || u.email) : '';
  }

  var EVENTO_LABEL = {
    creacion: 'Solicitud recibida',
    cambio_estado: 'Cambio de estado',
    asignacion: 'Asignación',
    nota: 'Nota',
    notificacion_enviada: 'Aviso enviado al equipo',
    adjunto_agregado: 'Adjunto agregado',
  };

  function renderBitacora(rows) {
    var list = document.getElementById('bitacora-list');
    if (!rows.length) { list.innerHTML = '<div class="no-lines">Sin eventos.</div>'; return; }
    list.innerHTML = rows.slice().reverse().map(function (b) {
      var detalleTxt = '';
      if (b.tipo_evento === 'nota' && b.detalle && b.detalle.texto) detalleTxt = escHtml(b.detalle.texto);
      if (b.tipo_evento === 'cambio_estado' && b.detalle) detalleTxt = escHtml(b.detalle.de || '') + ' &rarr; ' + escHtml(b.detalle.a || '');
      if (b.tipo_evento === 'asignacion' && b.detalle) detalleTxt = 'Asignado a ' + escHtml(b.detalle.a_nombre || 'sin asignar');
      if (b.tipo_evento === 'adjunto_agregado' && b.detalle) detalleTxt = escHtml(b.detalle.nombre || '');
      return '<div class="bitacora-item"><strong>' + (EVENTO_LABEL[b.tipo_evento] || b.tipo_evento) + '</strong>' +
        (detalleTxt ? ': ' + detalleTxt : '') +
        '<div class="meta">' + fmtDateTime(b.creado_en) + (b.usuario_nombre ? ' · ' + escHtml(b.usuario_nombre) : '') + '</div></div>';
    }).join('');
  }

  document.getElementById('btn-guardar-gestion').addEventListener('click', async function () {
    var nuevoEstado = document.getElementById('g-estado').value;
    var nuevoResp = document.getElementById('g-responsable').value || null;
    var nuevaFecha = document.getElementById('g-fecha-limite').value || null;

    var cambios = { estado: nuevoEstado, responsable_id: nuevoResp, fecha_limite: nuevaFecha };
    var res = await _sb.from('pqrs').update(cambios).eq('id', pqrsId);
    if (res.error) { showToast('Error al guardar: ' + res.error.message, '#e74c3c'); return; }

    var profile = AUTH.getProfile();
    var eventos = [];
    if (nuevoEstado !== _row.estado) {
      eventos.push({ pqrs_id: pqrsId, tipo_evento: 'cambio_estado', usuario_id: profile.id, usuario_nombre: profile.nombre || profile.email, detalle: { de: _row.estado, a: nuevoEstado } });
    }
    if (nuevoResp !== (_row.responsable_id || null)) {
      eventos.push({ pqrs_id: pqrsId, tipo_evento: 'asignacion', usuario_id: profile.id, usuario_nombre: profile.nombre || profile.email, detalle: { a: nuevoResp, a_nombre: nombreUsuario(nuevoResp) } });
    }
    if (eventos.length) await _sb.from('pqrs_bitacora').insert(eventos);

    showToast('Cambios guardados');
    cargar();
  });

  document.getElementById('btn-agregar-nota').addEventListener('click', async function () {
    var texto = document.getElementById('nueva-nota').value.trim();
    if (!texto) return;
    var profile = AUTH.getProfile();
    var res = await _sb.from('pqrs_bitacora').insert({
      pqrs_id: pqrsId, tipo_evento: 'nota', usuario_id: profile.id, usuario_nombre: profile.nombre || profile.email, detalle: { texto: texto },
    });
    if (res.error) { showToast('Error al agregar la nota: ' + res.error.message, '#e74c3c'); return; }
    document.getElementById('nueva-nota').value = '';
    cargar();
  });

  document.getElementById('file-adjunto').addEventListener('change', async function () {
    var file = this.files[0];
    if (!file) return;
    var status = document.getElementById('upload-status');
    status.textContent = 'Subiendo…';

    var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    var path = _row.empresa_sigla + '/' + _row.folio + '/' + Date.now() + '-' + safeName;

    var up = await _sb.storage.from(BUCKET).upload(path, file, { cacheControl: '3600', upsert: false });
    if (up.error) { status.textContent = ''; showToast('Error al subir: ' + up.error.message, '#e74c3c'); return; }

    var profile = AUTH.getProfile();
    var ins = await _sb.from('pqrs_adjuntos').insert({
      pqrs_id: pqrsId, origen: 'gestion_interna', storage_path: path, subido_por: profile.id,
      nombre_original: file.name, tipo_mime: file.type || null, tamano_bytes: file.size,
    });
    if (ins.error) { status.textContent = ''; showToast('Error al registrar el adjunto: ' + ins.error.message, '#e74c3c'); return; }

    await _sb.from('pqrs_bitacora').insert({
      pqrs_id: pqrsId, tipo_evento: 'adjunto_agregado', usuario_id: profile.id, usuario_nombre: profile.nombre || profile.email, detalle: { nombre: file.name },
    });

    status.textContent = '';
    this.value = '';
    showToast('Adjunto agregado');
    cargar();
  });

  cargar();
})();
