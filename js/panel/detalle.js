(async function () {
  await AUTH.authReady;

  var params = new URLSearchParams(location.search);
  var pqrsId = params.get('id');
  var _row = null;
  var _usuarios = [];
  var _ac;          // undefined = aún no cargada; null = PQRS pendiente de evaluar; objeto = acción correctiva (migración 0040)
  var _plan = [];

  var ESTADO_BADGE = { 'Nuevo': 'b-nuevo', 'En proceso': 'b-proceso', 'Resuelto': 'b-resuelto', 'Cerrado': 'b-cerrado' };
  var URGENCIA_BADGE = { 'ALTO': 'b-alerta', 'MEDIO': 'b-medio', 'BAJA': 'b-baja' };
  var BUCKET = 'pqrs-gestion-adjuntos';
  // Registro de gestión (migración 0039): códigos ASCII guardados en pqrs_gestiones.tipo.
  var TIPO_GESTION = {
    llamada: 'Llamada',
    correo: 'Correo electrónico',
    whatsapp: 'WhatsApp / mensaje',
    visita: 'Visita',
    reunion: 'Reunión',
    revision_interna: 'Revisión interna',
    escalamiento: 'Escalamiento',
    respuesta_cliente: 'Respuesta al cliente',
    correccion: 'Corrección inmediata / contención',
    solucion: 'Solución definitiva',
    otra: 'Otra',
  };

  var selTipoGestion = document.getElementById('gt-tipo');
  Object.keys(TIPO_GESTION).forEach(function (k) {
    var opt = document.createElement('option');
    opt.value = k; opt.textContent = TIPO_GESTION[k];
    selTipoGestion.appendChild(opt);
  });
  document.getElementById('gt-fecha').value = today();

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
    var [usuariosRes, rowRes, adjRes, bitRes, gesRes, acRes] = await Promise.all([
      _sb.rpc('list_equipo_pqrs'), // directorio (migración 0030); usuarios_pqrs solo deja leer la propia fila a un no-admin
      _sb.from('pqrs').select('*').eq('id', pqrsId).single(),
      _sb.from('pqrs_adjuntos').select('*').eq('pqrs_id', pqrsId).order('creado_en'),
      _sb.from('pqrs_bitacora').select('*').eq('pqrs_id', pqrsId).order('creado_en'),
      consultarGestiones(),
      consultarAccion(),
    ]);

    if (rowRes.error || !rowRes.data) {
      document.getElementById('not-found').style.display = '';
      return;
    }

    _usuarios = usuariosRes.data || [];
    _row = rowRes.data;

    // Lista a los activos, más al responsable actual aunque esté inactivo: sin su opción el selector quedaría
    // en blanco y al guardar se desasignaría la PQRS sin que nadie lo pida.
    var selResp = document.getElementById('g-responsable');
    _usuarios.forEach(function (u) {
      if (!u.activo && u.id !== _row.responsable_id) return;
      var opt = document.createElement('option');
      opt.value = u.id; opt.textContent = u.nombre + (u.activo ? '' : ' (inactivo)');
      selResp.appendChild(opt);
    });

    render();
    renderAdjuntos(adjRes.data || []);
    renderBitacora(bitRes.data || []);
    renderGestiones(gesRes);
    renderAccion(acRes);
    document.getElementById('content').style.display = '';
  }

  function consultarGestiones() {
    return _sb.from('pqrs_gestiones').select('*').eq('pqrs_id', pqrsId)
      .order('fecha_gestion', { ascending: false }).order('id', { ascending: false });
  }

  // Tras registrar o eliminar una gestión solo se releen ella y la bitácora (el trigger anota allí el evento);
  // no hace falta volver a cargar toda la página.
  async function recargarGestiones() {
    var res = await Promise.all([
      consultarGestiones(),
      _sb.from('pqrs_bitacora').select('*').eq('pqrs_id', pqrsId).order('creado_en'),
    ]);
    renderGestiones(res[0]);
    renderBitacora(res[1].data || []);
  }

  function campo(label, valor) {
    return '<div><label class="ef-label">' + label + '</label><div class="ef readonly" style="min-height:34px">' + (valor ? escHtml(valor) : '<span style="color:#a0aec0">&mdash;</span>') + '</div></div>';
  }

  // Campos editables de "Datos de la solicitud": solo admin los ve como
  // input/select/textarea (candado también reforzado en la base de datos por
  // el trigger guard_pqrs_datos_remitente); el resto de roles ve el valor
  // de solo lectura, igual que antes.
  function campoInput(id, label, valor, tipo) {
    if (!AUTH.isAdmin()) return campo(label, valor);
    return '<div><label class="ef-label">' + label + '</label><input class="ef" id="' + id + '" type="' + (tipo || 'text') + '" value="' + escHtml(valor || '') + '"></div>';
  }

  function campoTextarea(id, label, valor) {
    if (!AUTH.isAdmin()) return '<div style="grid-column:1/-1">' + campo(label, valor) + '</div>';
    return '<div style="grid-column:1/-1"><label class="ef-label">' + label + '</label><textarea class="ef" id="' + id + '" rows="3">' + escHtml(valor || '') + '</textarea></div>';
  }

  function campoSelect(id, label, valor, opciones, labelVisible) {
    if (!AUTH.isAdmin()) return campo(label, labelVisible || valor);
    var opts = opciones.map(function (o) {
      return '<option value="' + escHtml(o.value) + '"' + (o.value === valor ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
    }).join('');
    return '<div><label class="ef-label">' + label + '</label><select class="ef" id="' + id + '">' + opts + '</select></div>';
  }

  var TIPO_OPCIONES = ['Petición', 'Queja', 'Reclamo', 'Sugerencia'].map(function (v) { return { value: v, label: v }; });
  var AREA_OPCIONES = [
    { value: 'Produccion', label: 'Producción' },
    { value: 'Servicio al cliente', label: 'Servicio al cliente' },
    { value: 'Ventas', label: 'Ventas' },
    { value: 'Estado del producto', label: 'Estado del producto' },
    { value: 'Logistica', label: 'Logística (entregas, despachos)' },
    { value: 'Pos venta', label: 'Pos venta' },
    { value: 'Otro', label: 'Otro' },
  ];
  var URGENCIA_OPCIONES = [
    { value: 'ALTO', label: 'Alto' },
    { value: 'MEDIO', label: 'Medio' },
    { value: 'BAJA', label: 'Baja' },
  ];
  var SI_NO_OPCIONES = [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No' }];

  function valOrNull(id) {
    var v = document.getElementById(id).value.trim();
    return v || null;
  }

  function render() {
    document.getElementById('titulo-folio').textContent = _row.folio;
    document.title = 'PQRS ' + _row.folio;
    document.getElementById('badges').innerHTML =
      '<span class="sigla-badge sigla-' + _row.empresa_sigla + '">' + _row.empresa_sigla + '</span> ' +
      '<span class="badge ' + (URGENCIA_BADGE[_row.urgencia] || '') + '">' + _row.urgencia + '</span> ' +
      '<span class="badge ' + (ESTADO_BADGE[_row.estado] || '') + '">' + escHtml(_row.estado) + '</span>';

    document.getElementById('datos-grid').innerHTML =
      campo('Folio', _row.folio) +
      campo('Empresa', _row.empresa_sigla) +
      campo('Recibido', fmtDateTime(_row.creado_en)) +
      campoSelect('d-tipo_solicitud', 'Tipo de solicitud', _row.tipo_solicitud, TIPO_OPCIONES) +
      campoSelect('d-area_relacionada', 'Área relacionada', _row.area_relacionada, AREA_OPCIONES) +
      campoInput('d-fecha_evento', 'Fecha del evento', _row.fecha_evento, 'date') +
      campoInput('d-nombre_completo', 'Nombre completo', _row.nombre_completo) +
      campoInput('d-contacto', 'Contacto (correo/celular)', _row.contacto) +
      campoInput('d-identificacion_cliente', 'Identificación (NIT/Cédula)', _row.identificacion_cliente) +
      campoInput('d-referencia_pedido', 'N° pedido/factura/remisión', _row.referencia_pedido) +
      campoInput('d-producto_lote', 'Producto/lote relacionado', _row.producto_lote) +
      campoInput('d-ciudad_departamento', 'Ciudad/Departamento', _row.ciudad_departamento) +
      campoSelect('d-urgencia', 'Nivel de urgencia', _row.urgencia, URGENCIA_OPCIONES) +
      campoSelect('d-desea_respuesta', '¿Desea respuesta?', _row.desea_respuesta ? 'si' : 'no', SI_NO_OPCIONES, _row.desea_respuesta ? 'Sí' : 'No') +
      campoTextarea('d-descripcion', 'Descripción', _row.descripcion) +
      campoTextarea('d-comentarios_adicionales', 'Comentarios adicionales', _row.comentarios_adicionales);

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

  // res: { data, error } de consultarGestiones(). Si falla (p. ej. migración 0039 sin aplicar) se dice en
  // la sección en vez de mostrarla vacía como si no hubiera gestiones.
  function renderGestiones(res) {
    var list = document.getElementById('gestiones-list');
    var resumen = document.getElementById('gestiones-resumen');
    if (res.error) {
      resumen.textContent = '';
      list.innerHTML = '<div class="no-lines">No se pudo cargar el registro de gestión: ' + escHtml(errMsg(res.error)) + '</div>';
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      resumen.textContent = 'Sin gestiones registradas';
      list.innerHTML = '<div class="no-lines">Aún no se ha registrado ninguna gestión para esta solicitud.</div>';
      return;
    }
    resumen.textContent = rows.length + (rows.length === 1 ? ' gestión' : ' gestiones') + ' · última: ' + fmtDateOnly(rows[0].fecha_gestion);
    list.innerHTML = rows.map(function (g) {
      return '<div class="gest-item">' +
        '<div class="gest-head"><span class="gest-tipo">' + escHtml(TIPO_GESTION[g.tipo] || g.tipo) + '</span>' +
        '<span class="gest-fecha">' + escHtml(fmtDateOnly(g.fecha_gestion)) + '</span>' +
        (AUTH.isAdmin() ? '<button class="btn-secondary gest-del" data-id="' + escHtml(g.id) + '">Eliminar</button>' : '') + '</div>' +
        '<div class="gest-desc">' + escHtml(g.descripcion) + '</div>' +
        (g.resultado ? '<div class="gest-res"><strong>Resultado:</strong> ' + escHtml(g.resultado) + '</div>' : '') +
        '<div class="meta">Registrada por ' + escHtml(g.creado_por_nombre || '—') + ' el ' + escHtml(fmtDateTime(g.creado_en)) + '</div></div>';
    }).join('');

    list.querySelectorAll('.gest-del').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('¿Eliminar este registro de gestión? Quedará constancia en la bitácora.')) return;
        btn.disabled = true;
        var del = await _sb.from('pqrs_gestiones').delete().eq('id', btn.getAttribute('data-id')).select('id');
        // La RLS no da error al negar un DELETE: simplemente no borra filas.
        if (del.error || !del.data || !del.data.length) {
          btn.disabled = false;
          showToast('No se pudo eliminar la gestión' + (del.error ? ': ' + errMsg(del.error) : ' (sin permiso)'), '#e74c3c');
          return;
        }
        showToast('Gestión eliminada');
        recargarGestiones();
      });
    });
  }

  // ── Análisis y acción correctiva (ISO 9001:2015, 10.2; migración 0040) ──────────────────────────────
  // Una por PQRS (AC-<id>). Sin fila = pendiente de evaluar. Las reglas (qué se exige para pasar de un estado a otro,
  // qué campo se edita en cada estado, quién puede reabrir) viven en los triggers; aquí solo se dibuja y se avisa el
  // error de la base de datos tal cual (viene en español). Al cambiar de estado solo viaja el estado: lo demás se
  // guarda antes (acGuardar), como exige el trigger.
  var AC_ESTADO = {
    no_requiere: 'No requiere acción',
    en_analisis: 'En análisis',
    en_ejecucion: 'En ejecución',
    en_verificacion: 'En verificación',
    cerrada: 'Cerrada',
  };
  var AC_BADGE = { no_requiere: 'b-cerrado', en_analisis: 'b-nuevo', en_ejecucion: 'b-proceso', en_verificacion: 'b-proceso', cerrada: 'b-resuelto' };
  var AC_METODO = { cinco_porques: '5 porqués', ishikawa: 'Causa-efecto (Ishikawa)', arbol_causas: 'Árbol de causas', otro: 'Otro método' };
  var AC_SI_NO = [['', 'Seleccionar…'], ['si', 'Sí'], ['no', 'No']];
  // [columna, id del control, tipo]: solo se leen los controles que se dibujaron editables.
  var AC_CAMPOS = [
    ['criterio_evaluacion', 'ac-criterio', 'txt'],
    ['metodo_analisis', 'ac-metodo', 'sel'],
    ['analisis_causa', 'ac-analisis', 'txt'],
    ['causa_raiz', 'ac-causa', 'txt'],
    ['casos_similares', 'ac-similares', 'txt'],
    ['fecha_verificacion_prevista', 'ac-fprevista', 'date'],
    ['verificacion_fecha', 'ac-vfecha', 'date'],
    ['verificacion_resultado', 'ac-vresultado', 'sel'],
    ['verificacion_observaciones', 'ac-vobs', 'txt'],
    ['actualiza_riesgos', 'ac-riesgos', 'sel'],
    ['cambios_sgc', 'ac-sgc', 'sel'],
    ['detalle_sgc', 'ac-sgcdet', 'txt'],
  ];

  async function consultarAccion() {
    var res = await _sb.from('pqrs_acciones_correctivas').select('*').eq('pqrs_id', pqrsId).maybeSingle();
    if (res.error) return { error: res.error };
    if (!res.data) return { ac: null, plan: [] };
    var pl = await _sb.from('pqrs_accion_plan').select('*').eq('accion_id', res.data.id)
      .order('fecha_compromiso', { ascending: true }).order('id', { ascending: true });
    if (pl.error) return { error: pl.error };
    return { ac: res.data, plan: pl.data || [] };
  }

  // soloPlan: tras agregar, marcar o quitar una acción del plan solo se redibuja el plan (no se pierde lo que se esté
  // escribiendo en el análisis); en los demás casos se redibuja todo y se relee la bitácora (el trigger anota allí).
  async function recargarAccion(soloPlan) {
    if (soloPlan) {
      var r1 = await consultarAccion();
      if (r1.ac) { _ac = r1.ac; _plan = r1.plan; renderAcPlan(); } else renderAccion(r1);
      return;
    }
    var r = await Promise.all([consultarAccion(), _sb.from('pqrs_bitacora').select('*').eq('pqrs_id', pqrsId).order('creado_en')]);
    renderAccion(r[0]);
    renderBitacora(r[1].data || []);
  }

  function acCampo(id, label, valor, editable, tipo, o) {
    o = o || {};
    var ctl;
    if (!editable) {
      var txt = valor;
      if (tipo === 'select') {
        var m = (o.opts || []).filter(function (x) { return x[0] === (valor || ''); })[0];
        txt = m && m[0] !== '' ? m[1] : '';
      } else if (tipo === 'date') {
        txt = valor ? fmtDateOnly(valor) : '';
      }
      ctl = '<div class="ef readonly ac-ro">' + (txt ? escHtml(txt) : '<span style="color:#a0aec0">&mdash;</span>') + '</div>';
    } else if (tipo === 'textarea') {
      ctl = '<textarea class="ef" id="' + id + '" rows="' + (o.rows || 3) + '" maxlength="' + (o.max || 1000) + '" placeholder="' + escHtml(o.ph || '') + '">' + escHtml(valor || '') + '</textarea>';
    } else if (tipo === 'date') {
      ctl = '<input type="date" class="ef" id="' + id + '" value="' + escHtml(valor || '') + '"' + (o.max ? ' max="' + o.max + '"' : '') + '>';
    } else {
      ctl = '<select class="ef" id="' + id + '">' + (o.opts || []).map(function (x) {
        return '<option value="' + escHtml(x[0]) + '"' + (x[0] === (valor || '') ? ' selected' : '') + '>' + escHtml(x[1]) + '</option>';
      }).join('') + '</select>';
    }
    return '<div' + (tipo === 'textarea' ? ' style="grid-column:1/-1"' : '') + '><label class="ef-label"' + (editable ? ' for="' + id + '"' : '') + '>' + label + '</label>' + ctl + '</div>';
  }

  function acPasos(st) {
    if (st === 'no_requiere') return '<div class="ac-pasos"><span class="ac-paso hecho">✓ Evaluada: no requiere acción correctiva</span></div>';
    var idx = { en_analisis: 1, en_ejecucion: 2, en_verificacion: 3, cerrada: 4 }[st];
    return '<div class="ac-pasos">' + ['Evaluación', 'Análisis', 'Ejecución', 'Verificación', 'Cierre'].map(function (p, i) {
      var cls = (i < idx || st === 'cerrada') ? 'hecho' : (i === idx ? 'actual' : '');
      return '<span class="ac-paso ' + cls + '">' + (cls === 'hecho' ? '✓ ' : '') + p + '</span>';
    }).join('') + '</div>';
  }

  function acBotones(st) {
    var b = [];
    function btn(accion, texto, primario) { b.push('<button class="' + (primario ? 'btn-primary' : 'btn-secondary') + '" data-ac="' + accion + '">' + texto + '</button>'); }
    if (st === 'no_requiere') {
      btn('guardar', 'Guardar criterio');
      btn('iniciar', 'Sí requiere acción: iniciar análisis ▶', true);
    } else if (st === 'en_analisis') {
      btn('guardar', 'Guardar análisis');
      btn('ejecucion', 'Pasar a ejecución ▶', true);
      btn('no_requiere', 'Concluir: no requiere acción');
    } else if (st === 'en_ejecucion') {
      btn('guardar', 'Guardar');
      btn('analisis', '◀ Volver a análisis');
      btn('verificacion', 'Enviar a verificación ▶', true);
    } else if (st === 'en_verificacion') {
      btn('guardar', 'Guardar verificación');
      btn('cerrar', 'Cerrar: la acción fue eficaz ✔', true);
      btn('reabrir', 'Reabrir análisis: no fue eficaz');
    } else if (st === 'cerrada' && AUTH.isAdmin()) {
      btn('reabrir_admin', 'Reabrir (solo administrador)');
    }
    return b.length ? '<div class="ac-acciones">' + b.join('') + '</div>' : '';
  }

  function renderAccion(res) {
    var body = document.getElementById('ac-body');
    var badge = document.getElementById('ac-badge');
    if (res.error) {
      badge.innerHTML = '';
      body.innerHTML = '<div class="no-lines">No se pudo cargar la acción correctiva: ' + escHtml(errMsg(res.error)) + '</div>';
      return;
    }
    _ac = res.ac;
    _plan = res.plan || [];
    var puede = AUTH.canEdit();

    if (!_ac) {
      badge.innerHTML = '<span class="badge b-nuevo">Pendiente de evaluar</span>';
      body.innerHTML = '<div class="ac-intro">Esta solicitud <strong>aún no se ha evaluado</strong>. Decide si la causa de lo ocurrido debe eliminarse para que no se repita ' +
        '(una queja o reclamo con una no conformidad, o un riesgo de que vuelva a pasar) y deja el criterio: queda como evidencia tanto si abres la acción como si no.</div>' +
        (puede ? '<div class="form-grid cols2">' +
          '<div><label class="ef-label" for="ac-requiere">¿Requiere acción correctiva?</label><select class="ef" id="ac-requiere">' +
          '<option value="">Seleccionar…</option><option value="si">Sí: hay una causa que eliminar</option><option value="no">No: basta con la corrección y la respuesta</option></select></div>' +
          '<div style="grid-column:1/-1"><label class="ef-label" for="ac-criterio-nuevo">Criterio de la evaluación</label>' +
          '<textarea class="ef" id="ac-criterio-nuevo" rows="3" maxlength="1000" placeholder="Por qué sí o por qué no: gravedad, recurrencia, si afecta la conformidad del producto o servicio…"></textarea></div></div>' +
          '<button class="btn-primary" id="ac-btn-evaluar">Registrar evaluación</button>' : '');
      var bEv = document.getElementById('ac-btn-evaluar');
      if (bEv) bEv.addEventListener('click', acEvaluar);
      return;
    }

    var st = _ac.estado;
    var edEval = puede && (st === 'no_requiere' || st === 'en_analisis');
    var edAnal = puede && (st === 'en_analisis' || st === 'en_ejecucion');
    var edVerif = puede && st === 'en_verificacion';
    badge.innerHTML = '<span class="badge ' + AC_BADGE[st] + '">AC-' + escHtml(_ac.id) + ' · ' + escHtml(AC_ESTADO[st]) + '</span>';

    var h = acPasos(st);
    h += '<div class="ac-sec ac-sec-1"><h4>1. Evaluación de la necesidad <small>10.2.1 b</small></h4><div class="form-grid cols2">' +
      acCampo('ac-requiere-ro', '¿Requiere acción correctiva?', st === 'no_requiere' ? 'No' : 'Sí', false, 'text') +
      acCampo('ac-criterio', 'Criterio de la evaluación', _ac.criterio_evaluacion, edEval, 'textarea', { rows: 2, max: 1000 }) +
      '</div></div>';

    if (st !== 'no_requiere') {
      var metodos = [['', 'Seleccionar…']].concat(Object.keys(AC_METODO).map(function (k) { return [k, AC_METODO[k]]; }));
      h += '<div class="ac-sec"><h4>2. Análisis de causa <small>10.2.1 b</small></h4><div class="form-grid cols2">' +
        acCampo('ac-metodo', 'Método de análisis', _ac.metodo_analisis || '', edAnal, 'select', { opts: metodos }) +
        acCampo('ac-fprevista', 'Verificación de eficacia prevista para', _ac.fecha_verificacion_prevista, edAnal, 'date') +
        acCampo('ac-analisis', 'Análisis de causas', _ac.analisis_causa, edAnal, 'textarea', { rows: 4, max: 3000, ph: 'Ej. 5 porqués: 1) … 2) … 3) …' }) +
        acCampo('ac-causa', 'Causa raíz', _ac.causa_raiz, edAnal, 'textarea', { rows: 2, max: 1000 }) +
        acCampo('ac-similares', '¿Existen o podrían presentarse casos similares?', _ac.casos_similares, edAnal, 'textarea',
          { rows: 2, max: 1000, ph: 'Otras PQRS, productos, áreas o empresas donde pueda ocurrir. Si no, escribe «No se identificaron».' }) +
        '</div></div>';
      h += '<div class="ac-sec"><h4>3. Plan de acción <small>10.2.1 c</small></h4><div id="ac-plan"></div></div>';
    }

    if (st === 'en_verificacion' || st === 'cerrada') {
      h += '<div class="ac-sec"><h4>4. Verificación de eficacia y cierre <small>10.2.1 d, e y f</small></h4><div class="form-grid cols2">' +
        acCampo('ac-vfecha', 'Fecha de la verificación', _ac.verificacion_fecha, edVerif, 'date', { max: today() }) +
        acCampo('ac-vresultado', 'Resultado', _ac.verificacion_resultado || '', edVerif, 'select',
          { opts: [['', 'Seleccionar…'], ['eficaz', 'Eficaz: la causa se eliminó'], ['no_eficaz', 'No eficaz: el problema persiste']] }) +
        acCampo('ac-vobs', '¿Cómo se verificó y con qué evidencia?', _ac.verificacion_observaciones, edVerif, 'textarea', { rows: 3, max: 2000 }) +
        acCampo('ac-riesgos', '¿Se actualizan los riesgos y oportunidades?', _ac.actualiza_riesgos || '', edVerif, 'select', { opts: AC_SI_NO }) +
        acCampo('ac-sgc', '¿Se requieren cambios al sistema de gestión?', _ac.cambios_sgc || '', edVerif, 'select', { opts: AC_SI_NO }) +
        acCampo('ac-sgcdet', 'Detalle de la actualización (si respondiste «Sí»)', _ac.detalle_sgc, edVerif, 'textarea', { rows: 2, max: 1000 }) +
        '</div>' +
        (_ac.verificado_por_nombre ? '<div class="meta" style="color:#718096;font-size:0.76rem">Verificación registrada por ' + escHtml(_ac.verificado_por_nombre) + '</div>' : '') +
        (st === 'cerrada' ? '<div class="meta" style="color:#276749;font-size:0.8rem;margin-top:6px"><strong>Acción cerrada</strong> el ' + escHtml(fmtDateTime(_ac.cerrada_en)) + ' por ' + escHtml(_ac.cerrada_por_nombre || '—') + '. Queda como evidencia y no se puede modificar.</div>' : '') +
        '</div>';
    }

    if (puede) h += acBotones(st);
    h += auditoriaHtml(_ac);
    body.innerHTML = h;

    renderAcPlan();
    body.querySelectorAll('[data-ac]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        try { await acAccion(btn.getAttribute('data-ac')); } finally { btn.disabled = false; }
      });
    });
  }

  // Los campos que cambiaron respecto de lo guardado (solo de los controles que están editables en este estado).
  function acCambios() {
    var cambios = {};
    AC_CAMPOS.forEach(function (c) {
      var el = document.getElementById(c[1]);
      if (!el) return;
      var nuevo = el.value, viejo = _ac[c[0]];
      if (c[2] === 'txt') { nuevo = nuevo.trim(); viejo = (viejo || '').trim(); }
      else { nuevo = nuevo || null; viejo = viejo || null; }
      if (nuevo !== viejo) cambios[c[0]] = nuevo;
    });
    return cambios;
  }

  async function acGuardar(silencioso) {
    var cambios = acCambios();
    if (cambios.criterio_evaluacion !== undefined && cambios.criterio_evaluacion.length < 3) {
      showToast('El criterio de la evaluación es obligatorio (mínimo 3 caracteres)', '#e74c3c');
      return false;
    }
    if (!Object.keys(cambios).length) {
      if (!silencioso) showToast('No hay cambios por guardar');
      return true;
    }
    var res = await _sb.from('pqrs_acciones_correctivas').update(cambios).eq('id', _ac.id).select('id');
    if (res.error || !res.data || !res.data.length) {
      showToast('No se pudo guardar: ' + (res.error ? errMsg(res.error) : 'sin permiso'), '#e74c3c');
      return false;
    }
    Object.assign(_ac, cambios);
    if (!silencioso) showToast('Cambios guardados');
    return true;
  }

  async function acTransicion(nuevo, confirmacion) {
    if (confirmacion && !confirm(confirmacion)) return;
    if (!(await acGuardar(true))) return;
    var res = await _sb.from('pqrs_acciones_correctivas').update({ estado: nuevo }).eq('id', _ac.id).select('id');
    if (res.error || !res.data || !res.data.length) {
      showToast(res.error ? errMsg(res.error) : 'No se pudo cambiar el estado (sin permiso)', '#e74c3c');
      return;
    }
    showToast('Acción correctiva: ' + AC_ESTADO[nuevo]);
    recargarAccion();
  }

  async function acAccion(accion) {
    if (accion === 'guardar') { if (await acGuardar(false)) recargarAccion(); return; }
    if (accion === 'iniciar') return acTransicion('en_analisis');
    if (accion === 'no_requiere') return acTransicion('no_requiere', '¿Concluir que esta solicitud no requiere acción correctiva? Deja claro el criterio en la evaluación.');
    if (accion === 'ejecucion') return acTransicion('en_ejecucion');
    if (accion === 'analisis') return acTransicion('en_analisis');
    if (accion === 'verificacion') return acTransicion('en_verificacion');
    if (accion === 'cerrar') return acTransicion('cerrada', '¿Cerrar la acción correctiva? Queda como evidencia y ya no se podrá modificar.');
    if (accion === 'reabrir') return acTransicion('en_analisis', '¿Reabrir el análisis porque la acción no fue eficaz? La verificación queda anotada en la bitácora.');
    if (accion === 'reabrir_admin') return acTransicion('en_analisis', '¿Reabrir esta acción correctiva cerrada? La verificación y el cierre anteriores quedan anotados en la bitácora.');
  }

  async function acEvaluar() {
    var btn = this;
    var decision = document.getElementById('ac-requiere').value;
    var criterio = document.getElementById('ac-criterio-nuevo').value.trim();
    if (!decision) { showToast('Indica si la solicitud requiere acción correctiva', '#e74c3c'); return; }
    if (criterio.length < 3) { showToast('Escribe el criterio de la evaluación (mínimo 3 caracteres)', '#e74c3c'); return; }
    btn.disabled = true;
    var res = await _sb.from('pqrs_acciones_correctivas').insert({
      pqrs_id: pqrsId, estado: decision === 'si' ? 'en_analisis' : 'no_requiere', criterio_evaluacion: criterio,
    });
    btn.disabled = false;
    if (res.error) { showToast('No se pudo registrar la evaluación: ' + errMsg(res.error), '#e74c3c'); return; }
    showToast('Evaluación registrada');
    recargarAccion();
  }

  function renderAcPlan() {
    var box = document.getElementById('ac-plan');
    if (!box || !_ac) return;
    var st = _ac.estado, puede = AUTH.canEdit();
    var edPlan = puede && (st === 'en_analisis' || st === 'en_ejecucion');
    var marcar = puede && st === 'en_ejecucion';
    var hoy = today();
    var hechas = _plan.filter(function (i) { return i.hecha; }).length;

    var h = _plan.length
      ? '<div class="meta" style="color:#718096;font-size:0.78rem;margin-bottom:8px">' + hechas + ' de ' + _plan.length + (_plan.length === 1 ? ' acción hecha' : ' acciones hechas') + '</div>'
      : '<div class="no-lines">Aún no hay acciones en el plan.</div>';
    h += _plan.map(function (i) {
      var vencida = !i.hecha && i.fecha_compromiso < hoy && st !== 'cerrada';
      return '<div class="ac-item' + (i.hecha ? ' hecha' : '') + '">' +
        '<div class="ac-item-head"><strong>' + escHtml(i.descripcion) + '</strong>' +
        '<span class="badge ' + (i.hecha ? 'b-resuelto' : 'b-nuevo') + '">' + (i.hecha ? 'Hecha' : 'Pendiente') + '</span></div>' +
        '<div class="meta">Responsable: ' + escHtml(i.responsable_nombre || '—') + ' · Compromiso: ' + escHtml(fmtDateOnly(i.fecha_compromiso)) +
        (vencida ? ' · <span class="ac-venc">vencida</span>' : '') + '</div>' +
        (i.hecha ? '<div class="ac-evid"><strong>Evidencia:</strong> ' + escHtml(i.evidencia) + '</div>' +
          '<div class="meta">Hecha el ' + escHtml(fmtDateTime(i.hecha_en)) + ' · ' + escHtml(i.hecha_por_nombre || '—') + '</div>' : '') +
        (marcar && !i.hecha ? '<div class="ac-item-act"><input class="ef" data-evid="' + escHtml(i.id) + '" maxlength="1000" placeholder="Evidencia de que se hizo (acta, foto, registro…)">' +
          '<button class="btn-secondary" data-hecha="' + escHtml(i.id) + '">Marcar hecha</button></div>' : '') +
        (marcar && i.hecha ? '<div class="ac-item-act"><button class="btn-secondary" data-deshacer="' + escHtml(i.id) + '">Desmarcar</button></div>' : '') +
        (edPlan && !i.hecha ? '<div class="ac-item-act"><button class="btn-secondary gest-del" data-borrar="' + escHtml(i.id) + '">Eliminar</button></div>' : '') +
        '</div>';
    }).join('');

    if (edPlan) {
      var yo = (AUTH.getProfile() || {}).id;
      h += '<div class="ac-add">' +
        '<div><label class="ef-label" for="ac-p-desc">Acción</label><input class="ef" id="ac-p-desc" maxlength="500" placeholder="Qué se va a hacer"></div>' +
        '<div><label class="ef-label" for="ac-p-resp">Responsable</label><select class="ef" id="ac-p-resp">' +
        _usuarios.filter(function (u) { return u.activo; }).map(function (u) {
          return '<option value="' + escHtml(u.id) + '"' + (u.id === yo ? ' selected' : '') + '>' + escHtml(u.nombre) + '</option>';
        }).join('') + '</select></div>' +
        '<div><label class="ef-label" for="ac-p-fecha">Fecha compromiso</label><input type="date" class="ef" id="ac-p-fecha" min="' + hoy + '"></div>' +
        '<button class="btn-secondary" id="ac-p-agregar">Agregar acción</button></div>';
    }
    box.innerHTML = h;

    // Operaciones del plan: tras cada una solo se redibuja el plan.
    async function operar(btn, hacer, ok) {
      btn.disabled = true;
      var res = await hacer();
      if (res.error || (res.data && !res.data.length)) {
        btn.disabled = false;
        showToast(res.error ? errMsg(res.error) : 'No se pudo completar (sin permiso)', '#e74c3c');
        return;
      }
      if (ok) showToast(ok);
      recargarAccion(true);
    }
    var bAdd = document.getElementById('ac-p-agregar');
    if (bAdd) bAdd.addEventListener('click', function () {
      var desc = document.getElementById('ac-p-desc').value.trim();
      var resp = document.getElementById('ac-p-resp').value;
      var fecha = document.getElementById('ac-p-fecha').value;
      if (desc.length < 3) { showToast('Describe la acción (mínimo 3 caracteres)', '#e74c3c'); return; }
      if (!resp) { showToast('Selecciona el responsable', '#e74c3c'); return; }
      if (!fecha) { showToast('Indica la fecha compromiso', '#e74c3c'); return; }
      if (fecha < today()) { showToast('La fecha compromiso no puede ser anterior a hoy', '#e74c3c'); return; }
      operar(bAdd, function () {
        return _sb.from('pqrs_accion_plan').insert({ accion_id: _ac.id, descripcion: desc, responsable_id: resp, fecha_compromiso: fecha });
      }, 'Acción agregada al plan');
    });
    box.querySelectorAll('[data-hecha]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-hecha');
        var evid = box.querySelector('[data-evid="' + id + '"]').value.trim();
        if (evid.length < 3) { showToast('Describe la evidencia de que la acción se realizó', '#e74c3c'); return; }
        operar(btn, function () { return _sb.from('pqrs_accion_plan').update({ hecha: true, evidencia: evid }).eq('id', id).select('id'); }, 'Acción marcada como hecha');
      });
    });
    box.querySelectorAll('[data-deshacer]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-deshacer');
        operar(btn, function () { return _sb.from('pqrs_accion_plan').update({ hecha: false }).eq('id', id).select('id'); });
      });
    });
    box.querySelectorAll('[data-borrar]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('¿Eliminar esta acción del plan?')) return;
        var id = btn.getAttribute('data-borrar');
        operar(btn, function () { return _sb.from('pqrs_accion_plan').delete().eq('id', id).select('id'); }, 'Acción eliminada del plan');
      });
    });
  }

  function nombreUsuario(id) {
    var u = _usuarios.filter(function (x) { return x.id === id; })[0];
    return u ? u.nombre : '';
  }

  var EVENTO_LABEL = {
    creacion: 'Solicitud recibida',
    cambio_estado: 'Cambio de estado',
    asignacion: 'Asignación',
    nota: 'Nota',
    notificacion_enviada: 'Aviso enviado al equipo',
    adjunto_agregado: 'Adjunto agregado',
    edicion_datos: 'Datos de la solicitud corregidos',
    gestion_registrada: 'Gestión registrada',
    gestion_eliminada: 'Gestión eliminada',
    accion_correctiva: 'Acción correctiva',
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
      if ((b.tipo_evento === 'gestion_registrada' || b.tipo_evento === 'gestion_eliminada') && b.detalle) {
        detalleTxt = escHtml(TIPO_GESTION[b.detalle.tipo] || b.detalle.tipo || '') +
          (b.detalle.fecha ? ' del ' + escHtml(fmtDateOnly(b.detalle.fecha)) : '');
        if (b.tipo_evento === 'gestion_eliminada' && b.detalle.descripcion) detalleTxt += ' — «' + escHtml(b.detalle.descripcion) + '»';
      }
      if (b.tipo_evento === 'accion_correctiva' && b.detalle) {
        detalleTxt = b.detalle.evento === 'evaluada'
          ? 'AC-' + escHtml(b.detalle.accion_id) + ' evaluada: ' + (b.detalle.a === 'no_requiere' ? 'no requiere acción correctiva' : 'requiere acción correctiva')
          : 'AC-' + escHtml(b.detalle.accion_id) + ' ' + escHtml(AC_ESTADO[b.detalle.de] || b.detalle.de) + ' &rarr; ' + escHtml(AC_ESTADO[b.detalle.a] || b.detalle.a);
        if (b.detalle.observaciones) {
          detalleTxt += ' (verificación ' + (b.detalle.verificacion_resultado === 'no_eficaz' ? 'no eficaz' : 'eficaz') + ': «' + escHtml(b.detalle.observaciones) + '»)';
        }
      }
      return '<div class="bitacora-item"><strong>' + (EVENTO_LABEL[b.tipo_evento] || b.tipo_evento) + '</strong>' +
        (detalleTxt ? ': ' + detalleTxt : '') +
        '<div class="meta">' + fmtDateTime(b.creado_en) + (b.usuario_nombre ? ' · ' + escHtml(b.usuario_nombre) : '') + '</div></div>';
    }).join('');
  }

  document.getElementById('btn-guardar-gestion').addEventListener('click', async function () {
    var nuevoEstado = document.getElementById('g-estado').value;
    var nuevoResp = document.getElementById('g-responsable').value || null;
    var nuevaFecha = document.getElementById('g-fecha-limite').value || null;

    // ISO 9001 10.2.1 b: dejar evaluada la necesidad de acción correctiva antes de dar por resuelta o cerrada la solicitud.
    // Es un aviso, no un bloqueo: la acción correctiva puede seguir abierta después (la verificación de eficacia llega más tarde).
    if (nuevoEstado !== _row.estado && (nuevoEstado === 'Resuelto' || nuevoEstado === 'Cerrado') && _ac === null) {
      if (!confirm('Esta solicitud aún no tiene evaluada la necesidad de una acción correctiva (ISO 9001, 10.2).\n' +
          'Hazlo en la sección «Análisis y acción correctiva».\n\n¿Guardar el cambio de estado de todos modos?')) return;
    }

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

  var btnGuardarDatos = document.getElementById('btn-guardar-datos');
  if (btnGuardarDatos) {
    btnGuardarDatos.addEventListener('click', async function () {
      if (!AUTH.isAdmin()) return;

      var cambios = {
        nombre_completo: valOrNull('d-nombre_completo'),
        contacto: document.getElementById('d-contacto').value.trim(),
        identificacion_cliente: valOrNull('d-identificacion_cliente'),
        tipo_solicitud: document.getElementById('d-tipo_solicitud').value,
        fecha_evento: document.getElementById('d-fecha_evento').value || null,
        area_relacionada: document.getElementById('d-area_relacionada').value,
        referencia_pedido: valOrNull('d-referencia_pedido'),
        producto_lote: valOrNull('d-producto_lote'),
        ciudad_departamento: valOrNull('d-ciudad_departamento'),
        urgencia: document.getElementById('d-urgencia').value,
        descripcion: document.getElementById('d-descripcion').value.trim(),
        desea_respuesta: document.getElementById('d-desea_respuesta').value === 'si',
        comentarios_adicionales: valOrNull('d-comentarios_adicionales'),
      };
      if (!cambios.contacto) { showToast('El contacto es requerido', '#e74c3c'); return; }
      if (!cambios.descripcion) { showToast('La descripción es requerida', '#e74c3c'); return; }

      var res = await _sb.from('pqrs').update(cambios).eq('id', pqrsId);
      if (res.error) { showToast('Error al guardar: ' + res.error.message, '#e74c3c'); return; }

      var profile = AUTH.getProfile();
      await _sb.from('pqrs_bitacora').insert({
        pqrs_id: pqrsId, tipo_evento: 'edicion_datos', usuario_id: profile.id, usuario_nombre: profile.nombre || profile.email, detalle: {},
      });

      showToast('Datos guardados');
      cargar();
    });
  }

  document.getElementById('btn-registrar-gestion').addEventListener('click', async function () {
    var btn = this;
    var fecha = document.getElementById('gt-fecha').value;
    var tipo = selTipoGestion.value;
    var descripcion = document.getElementById('gt-descripcion').value.trim();
    var resultado = document.getElementById('gt-resultado').value.trim();

    if (!fecha) { showToast('Indica la fecha de la gestión', '#e74c3c'); return; }
    if (fecha > today()) { showToast('La fecha de la gestión no puede ser futura', '#e74c3c'); return; }
    if (!tipo) { showToast('Selecciona el tipo de gestión', '#e74c3c'); return; }
    if (descripcion.length < 3) { showToast('Describe qué se hizo (mínimo 3 caracteres)', '#e74c3c'); return; }

    btn.disabled = true;
    var res = await _sb.from('pqrs_gestiones').insert({
      pqrs_id: pqrsId, fecha_gestion: fecha, tipo: tipo, descripcion: descripcion, resultado: resultado,
    });
    btn.disabled = false;
    if (res.error) { showToast('No se pudo registrar la gestión: ' + errMsg(res.error), '#e74c3c'); return; }

    document.getElementById('gt-fecha').value = today();
    selTipoGestion.value = '';
    document.getElementById('gt-descripcion').value = '';
    document.getElementById('gt-resultado').value = '';
    showToast('Gestión registrada');
    recargarGestiones();
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
