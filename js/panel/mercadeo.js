// ══════════════════════════════════════════════════════════════
// Tablero de Mercadeo (kanban de tareas) — para las 5 empresas del holding
// ══════════════════════════════════════════════════════════════
// Flujo del manual: Recibido (código 'solicitada') -> Confirmada -> En producción -> En validación/aprobación ->
// Entregada/Publicada (+ Cancelada, fuera de columnas). Cualquiera del equipo mueve tareas.
// Las solicitudes enviadas desde panel-pedidos (origen 'panel_pedidos', migración 0019) nacen en
// "Recibido"; Mercadeo puede responder al solicitante (evento 'respuesta_solicitante') y el solicitante o un
// aprobador puede dejarle una observación a Mercadeo (evento 'observacion_solicitante', migración 0024; la
// escribe el puente de Pedidos y avisa por campanita, aquí solo se lee en la bitácora de la tarjeta).
//
// Reglas de priorización (MKT-DOC-00 §B.5, MKT-P-04) — las aplica la BD (trigger de la
// migración 0014); aquí solo se anticipan en la interfaz para dar mensajes claros:
//  - Clase de prioridad: 1 calendario aprobado > 2 soporte a ventas > 3 mejora > 4 exploratorio.
//    Una tarea vinculada a una actividad APROBADA en el calendario (CRM > Actividades) es clase 1.
//  - Urgente fuera de calendario exige aval (Comité de Mercadeo / Gerencia General) + referencia + motivo.
//  - Sin brief no hay fecha comprometida: salir de "Recibido" exige descripción y fecha límite.
// La cola de cada columna se ordena por regla (urgente, clase, fecha límite, antigüedad), no a mano:
// arrastrar solo cambia de columna. Para teclado/táctil cada tarjeta tiene botones ◀ ▶.
(async function () {
  await AUTH.authReady;
  if (!AUTH.getProfile() || !AUTH.hasModule('mercadeo')) return;

  var miId = AUTH.getUser().id;
  var esAdmin = AUTH.isAdmin();

  // ── Catálogos (valores en BD = códigos ASCII) ──
  var COLUMNAS = [
    { k: 'solicitada', t: 'Recibido' },
    { k: 'confirmada', t: 'Confirmada' },
    { k: 'en_produccion', t: 'En producción' },
    { k: 'en_validacion', t: 'En validación / aprobación' },
    { k: 'entregada', t: 'Entregada / Publicada' },
  ];
  var ESTADO_T = { solicitada: 'Recibido', confirmada: 'Confirmada', en_produccion: 'En producción', en_validacion: 'En validación / aprobación', entregada: 'Entregada / Publicada', cancelada: 'Cancelada', rechazada: 'Rechazada' };
  var ABIERTOS = ['solicitada', 'confirmada', 'en_produccion', 'en_validacion'];
  var TIPOS = { diseno: 'Diseño gráfico', redes: 'Redes sociales y contenido', evento: 'Evento', pop: 'Material POP', campana: 'Campaña', pauta: 'Pauta digital', otro: 'Otro' };
  // Asunto del formulario de Pedidos (códigos de mercadeo_tareas.asunto).
  var ASUNTOS = {
    material_pop: 'Material POP', material_impreso: 'Material impreso', piezas_graficas: 'Piezas gráficas',
    piezas_audiovisuales: 'Piezas audiovisuales', diseno_nuevo_producto: 'Diseño de nuevo producto',
    diseno_ajuste_portafolios: 'Diseño y ajuste de portafolios', diseno_ajuste_institucional: 'Diseño y ajuste de material institucional',
    desarrollo_marca: 'Desarrollo de marca', otros: 'Otros'
  };
  var CLASES = { calendario: '1 · Calendario aprobado', soporte_ventas: '2 · Soporte a ventas (fecha dura)', mejora: '3 · Mejora / pieza nueva fuera de calendario', exploratorio: '4 · Exploratorio' };
  var CLASE_CORTA = { calendario: 'Calendario', soporte_ventas: 'Soporte ventas', mejora: 'Mejora', exploratorio: 'Exploratorio' };
  var CLASE_RANK = { calendario: 1, soporte_ventas: 2, mejora: 3, exploratorio: 4 };
  var AVAL = { comite: 'Comité de Mercadeo', gerencia_general: 'Gerencia General' };
  var SIGLAS = EMPRESAS.map(function (e) { return e.sigla; });
  var MAX_ARCHIVO = 25 * 1024 * 1024;

  // ── Estado ──
  var tareas = [], actividades = [], equipo = [];
  var tareaById = {}, actById = {};
  var editId = null, orig = null, dragId = null, recargaTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) { return escHtml(v === null || v === undefined ? '' : String(v)); }
  function fail(accion, error) { showToast('Error al ' + accion + ': ' + errMsg(error), '#e74c3c'); }
  function optsHtml(pares, sel) {
    return pares.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(sel) ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('');
  }
  function nombreEquipo(id) {
    var u = equipo.filter(function (x) { return x.id === id; })[0];
    return u ? u.nombre : 'Usuario inactivo';
  }
  function iniciales(nombre) {
    var p = String(nombre || '?').trim().split(/\s+/);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[1].charAt(0) : '')).toUpperCase();
  }
  // Color por responsable: paleta fija de 12 tonos, ordenada para que los primeros queden lo más separados posible.
  // Cada persona del equipo toma el tono que le toca por su posición al ordenar los ids (los inactivos conservan su
  // casilla, así desactivar a alguien no cambia los colores de los demás); con más de 12 personas los tonos se repiten.
  // Los inactivos se ven en gris, igual que las tareas sin responsable.
  var HUES = [220, 15, 140, 320, 270, 185, 50, 355, 85, 300, 165, 240];
  var colorUsuario = {};
  function asignarColores() {
    colorUsuario = {};
    var orden = equipo.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    orden.forEach(function (u, i) { if (u.activo) colorUsuario[u.id] = HUES[i % HUES.length]; });
  }
  // Variables CSS del color de una persona: --uc sólido (avatar, punto), --ut tinte de fondo, --ub borde del tinte.
  function estiloColor(id) {
    var h = colorUsuario[id];
    return h === undefined ? '' : '--uc:hsl(' + h + ',62%,31%);--ut:hsl(' + h + ',80%,91%);--ub:hsl(' + h + ',55%,74%)';
  }
  function empresaChips(arr) {
    arr = arr || [];
    if (SIGLAS.every(function (s) { return arr.indexOf(s) >= 0; })) return '<span class="sigla-badge" style="background:#1a5276;color:#fff">TODO EL HOLDING</span>';
    return arr.filter(function (s) { return SIGLAS.indexOf(s) >= 0; }).map(function (s) { return '<span class="sigla-badge sigla-' + s + '">' + s + '</span>'; }).join(' ');
  }
  function actAprobada(id) { var a = id ? actById[id] : null; return !!(a && a.en_calendario); }
  function esAbierta(t) { return ABIERTOS.indexOf(t.estado) >= 0; }
  function horasDesde(ts) { return (Date.now() - new Date(ts).getTime()) / 3600000; }

  // ══════════════ Carga ══════════════
  async function cargar(primera) {
    try {
      var rs = await Promise.all([
        fetchAll('mercadeo_tareas', '*', 'id'),
        fetchAll('mercadeo_actividades', 'id,nombre,en_calendario,estado', 'id'),
        _sb.rpc('list_equipo_mercadeo'),
      ]);
      for (var i = 0; i < rs.length; i++) if (rs[i].error) throw rs[i].error;
      tareas = rs[0].data; actividades = rs[1].data; equipo = rs[2].data || [];
    } catch (err) {
      if (primera) {
        $('estado-carga').innerHTML = 'No se pudieron cargar los datos: ' + esc(errMsg(err)) +
          '<br><button class="btn-primary" style="margin-top:12px" data-act="reintentar">Reintentar</button>';
      } else {
        showToast('Error al actualizar: ' + errMsg(err), '#e74c3c');
      }
      return false;
    }
    tareaById = {}; tareas.forEach(function (t) { tareaById[t.id] = t; });
    actById = {}; actividades.forEach(function (a) { actById[a.id] = a; });
    asignarColores();
    $('estado-carga').style.display = 'none';
    $('contenido').style.display = '';
    rellenarFiltros();
    render();
    if (editId && tareaById[editId] && MODAL.isOpen('tarea-overlay')) cargarDetalle(editId);
    return true;
  }

  function programarRecarga() {
    clearTimeout(recargaTimer);
    recargaTimer = setTimeout(function () { cargar(false); }, 400);
  }

  function rellenarFiltros() {
    var fe = $('f-empresa'), vE = fe.value;
    fe.innerHTML = '<option value="">Todas</option>' + optsHtml(SIGLAS.map(function (s) { return [s, s]; }), vE);
    var fr = $('f-resp'), vR = fr.value;
    fr.innerHTML = '<option value="">Todos</option><option value="mias">Mis tareas</option><option value="sin">Sin asignar</option>' +
      optsHtml(equipo.filter(function (u) { return u.activo; }).map(function (u) { return [u.id, u.nombre]; }), vR);
    fr.value = vR;
    var ft = $('f-tipo'), vT = ft.value;
    ft.innerHTML = '<option value="">Todos</option>' + optsHtml(Object.keys(TIPOS).map(function (k) { return [k, TIPOS[k]]; }), vT);
    var fc = $('f-clase'), vC = fc.value;
    fc.innerHTML = '<option value="">Todas</option>' + optsHtml(Object.keys(CLASES).map(function (k) { return [k, CLASES[k]]; }), vC);
    var fa = $('f-asunto'), vA = fa.value;
    fa.innerHTML = '<option value="">Todos</option>' + optsHtml(Object.keys(ASUNTOS).map(function (k) { return [k, ASUNTOS[k]]; }), vA);
  }

  // ══════════════ Filtros, orden y render ══════════════
  function filtrar() {
    var emp = $('f-empresa').value, resp = $('f-resp').value, tipo = $('f-tipo').value, clase = $('f-clase').value;
    var q = norm($('f-buscar').value), soloUrg = $('f-urg').checked, entreg = $('f-entregadas').value;
    var origen = $('f-origen').value, asunto = $('f-asunto').value;
    return tareas.filter(function (t) {
      if (origen && (t.origen || 'panel_mercadeo') !== origen) return false;
      if (asunto && t.asunto !== asunto) return false;
      if (emp && t.empresas.indexOf(emp) < 0) return false;
      if (resp === 'mias' && t.responsables.indexOf(miId) < 0) return false;
      if (resp === 'sin' && t.responsables.length) return false;
      if (resp && resp !== 'mias' && resp !== 'sin' && t.responsables.indexOf(resp) < 0) return false;
      if (tipo && t.tipo !== tipo) return false;
      if (clase && t.prioridad !== clase) return false;
      if (soloUrg && !t.urgente) return false;
      if (q && norm(t.titulo + ' ' + t.descripcion + ' ' + (t.solicitante_nombre || '') + ' ' + (t.a_nombre_de_nombre || '')).indexOf(q) < 0) return false;
      if (t.estado === 'entregada' && entreg === '30' && t.entregada_en && horasDesde(t.entregada_en) > 30 * 24) return false;
      return true;
    });
  }

  // Cola por regla: urgente -> clase 1..4 -> fecha límite (sin fecha al final) -> antigüedad.
  function comparar(a, b) {
    if (a.urgente !== b.urgente) return a.urgente ? -1 : 1;
    var ra = CLASE_RANK[a.prioridad] || 9, rb = CLASE_RANK[b.prioridad] || 9;
    if (ra !== rb) return ra - rb;
    if (a.fecha_limite !== b.fecha_limite) {
      if (!a.fecha_limite) return 1;
      if (!b.fecha_limite) return -1;
      return a.fecha_limite < b.fecha_limite ? -1 : 1;
    }
    return String(a.creado_en).localeCompare(String(b.creado_en)) || a.id - b.id;
  }

  function tarjetaHtml(t, idxCol) {
    var hoy = today();
    var fechaHtml = '';
    if (t.fecha_limite) {
      var dias = diasEntre(hoy, t.fecha_limite);
      var cls = esAbierta(t) ? (dias < 0 ? ' venc' : dias <= 2 ? ' pronto' : '') : '';
      fechaHtml = '<span class="kb-fecha' + cls + '" title="Fecha límite">📅 ' + esc(fmtDateOnly(t.fecha_limite)) + (cls === ' venc' ? ' · vencida' : '') + '</span>';
    }
    var edad = '';
    if (t.estado === 'solicitada') {
      var h = horasDesde(t.creado_en);
      edad = '<span class="kb-chip' + (h > 24 ? ' warn' : '') + '" title="Tiempo sin confirmar (SLA de confirmación: 12–24 h)">⏱ ' + (h < 48 ? Math.floor(h) + ' h' : Math.floor(h / 24) + ' d') + ' sin confirmar</span>';
    }
    var sinAval = t.urgente && t.fuera_calendario && !t.aval_por;
    var urg = t.urgente ? '<span class="kb-chip urg" title="' + (t.aval_por ? 'Aval: ' + esc(AVAL[t.aval_por]) : 'Urgente') + '">🔥 Urgente' + (t.fuera_calendario ? (t.aval_por ? ' · aval ' + esc(t.aval_por === 'comite' ? 'Comité' : 'GG') : ' ⚠ sin aval') : '') + '</span>' : '';
    var avatars = t.responsables.length ? t.responsables.map(function (id) {
      var u = equipo.filter(function (x) { return x.id === id; })[0];
      return '<span class="kb-av' + (u && u.activo ? '' : ' inactivo') + '" style="' + estiloColor(id) + '" title="' + esc(u ? u.nombre : 'Usuario inactivo') + '">' + esc(iniciales(u ? u.nombre : '?')) + '</span>';
    }).join('') : '<span class="mk-sin">sin responsable</span>';
    // Un responsable con color: la tarjeta se tiñe de su color; dos o más: franja superior dividida (fondo blanco).
    var colores = t.responsables.filter(function (id) { return colorUsuario[id] !== undefined; });
    var uClase = colores.length === 1 ? ' u1' : colores.length > 1 ? ' um' : '';
    var uEstilo = colores.length === 1 ? ' style="' + estiloColor(colores[0]) + '"' : '';
    var franja = colores.length > 1 ? '<div class="kb-franja" aria-hidden="true">' + colores.map(function (id) { return '<i style="' + estiloColor(id) + '"></i>'; }).join('') + '</div>' : '';
    var act = t.actividad_id && actById[t.actividad_id] ? '<div class="kb-act">📅 ' + esc(actById[t.actividad_id].nombre) + '</div>' : '';
    var esPed = t.origen === 'panel_pedidos';
    var ped = esPed ? '<span class="kb-chip" title="Solicitud enviada desde panel-pedidos">📥 Pedidos</span>' : '';
    var quien = esPed ? '<div class="kb-act">👤 ' + esc(t.a_nombre_de_nombre || t.solicitante_nombre || '—') +
      (t.fecha_tentativa ? ' · lo necesita para ' + esc(fmtDateOnly(t.fecha_tentativa)) : '') + '</div>' : '';
    return '<div class="kb-card p-' + esc(t.prioridad) + (t.urgente ? ' urg' : '') + (sinAval ? ' sin-aval' : '') + uClase + '"' + uEstilo + ' draggable="true" tabindex="0" role="button" data-act="tarea-abrir" data-id="' + esc(t.id) + '" aria-label="Abrir tarea: ' + esc(t.titulo) + '">' + franja +
      '<div class="kb-card-top">' + urg + ped + '<span class="kb-chip">' + esc(TIPOS[t.tipo] || t.tipo) + '</span><span class="kb-chip" title="Clase de prioridad">' + esc(CLASE_CORTA[t.prioridad] || t.prioridad) + '</span>' + edad + '</div>' +
      '<div class="kb-title">' + esc(t.titulo) + '</div>' +
      '<div class="kb-emp">' + empresaChips(t.empresas) + '</div>' + act + quien +
      '<div class="kb-meta">' + (fechaHtml || '<span></span>') + '<span class="kb-avatars">' + avatars + '</span></div>' +
      '<div class="kb-move"><button data-act="mover" data-id="' + esc(t.id) + '" data-dir="-1" aria-label="Mover a la columna anterior"' + (idxCol === 0 ? ' disabled' : '') + '>◀</button>' +
      '<button data-act="mover" data-id="' + esc(t.id) + '" data-dir="1" aria-label="Mover a la columna siguiente"' + (idxCol === COLUMNAS.length - 1 ? ' disabled' : '') + '>▶</button></div>' +
      '</div>';
  }

  // Leyenda de colores: un chip por persona activa; al hacer clic filtra por ese responsable (el mismo filtro "Responsable").
  function renderLeyenda() {
    var activos = equipo.filter(function (u) { return u.activo; });
    if (!activos.length) { $('kb-leyenda').innerHTML = ''; return; }
    var sel = $('f-resp').value;
    var chips = activos.map(function (u) {
      return '<button type="button" class="kb-ley-chip' + (sel === u.id ? ' on' : '') + '" style="' + estiloColor(u.id) + '" data-act="ley-resp" data-id="' + esc(u.id) +
        '" aria-pressed="' + (sel === u.id) + '" title="Ver solo las tareas de ' + esc(u.nombre) + '"><i class="kb-ley-dot"></i>' + esc(u.nombre) + '</button>';
    });
    chips.push('<button type="button" class="kb-ley-chip sin' + (sel === 'sin' ? ' on' : '') + '" data-act="ley-resp" data-id="sin" aria-pressed="' + (sel === 'sin') +
      '" title="Ver solo las tareas sin responsable"><i class="kb-ley-dot"></i>Sin asignar</button>');
    $('kb-leyenda').innerHTML = '<span class="kb-ley-t">Color por responsable:</span>' + chips.join('');
  }

  function render() {
    renderStats();
    renderLeyenda();
    var lista = filtrar();
    $('kb-board').innerHTML = COLUMNAS.map(function (c, idx) {
      var ts = lista.filter(function (t) { return t.estado === c.k; }).sort(comparar);
      return '<section class="kb-col" data-estado="' + c.k + '" aria-label="' + esc(c.t) + ': ' + ts.length + ' tareas">' +
        '<div class="kb-col-head"><span>' + esc(c.t) + '</span><span class="kb-count">' + ts.length + '</span></div>' +
        '<div class="kb-list" data-estado="' + c.k + '" role="list">' +
        (ts.length ? ts.map(function (t) { return tarjetaHtml(t, idx); }).join('') : '<div class="kb-vacio">Sin tareas</div>') +
        '</div></section>';
    }).join('');
    renderCanceladas(lista);
  }

  function renderStats() {
    var hoy = today(), mes = hoy.slice(0, 7);
    var abiertas = tareas.filter(esAbierta);
    var mias = abiertas.filter(function (t) { return t.responsables.indexOf(miId) >= 0; });
    var vencidas = abiertas.filter(function (t) { return t.fecha_limite && t.fecha_limite < hoy; });
    var sinConf = tareas.filter(function (t) { return t.estado === 'solicitada' && horasDesde(t.creado_en) > 24; });
    var delMes = tareas.filter(function (t) { return String(t.creado_en || '').slice(0, 7) === mes; });
    var excep = delMes.filter(function (t) { return t.urgente && t.fuera_calendario; });
    $('kb-stats').innerHTML =
      '<div class="sc info"><div class="num">' + abiertas.length + '</div><div class="lbl">Tareas abiertas</div></div>' +
      '<div class="sc parcial"><div class="num">' + mias.length + '</div><div class="lbl">Mis tareas</div></div>' +
      '<div class="sc alerta"><div class="num">' + vencidas.length + '</div><div class="lbl">Vencidas</div></div>' +
      '<div class="sc pend"><div class="num">' + sinConf.length + '</div><div class="lbl">Sin confirmar &gt; 24 h</div></div>' +
      '<div class="sc total"><div class="num">' + excep.length + '</div><div class="lbl">Excepciones del mes</div><div class="mk-sub">' +
      (delMes.length ? Math.round(excep.length / delMes.length * 100) + '% de ' + delMes.length + ' solicitudes' : 'sin solicitudes este mes') + '</div></div>';
  }

  function renderCanceladas(lista) {
    var box = $('kb-canceladas');
    if (!$('f-canceladas').checked) { box.innerHTML = ''; return; }
    var ts = lista.filter(function (t) { return t.estado === 'cancelada' || t.estado === 'rechazada'; }).sort(function (a, b) { return b.id - a.id; });
    box.innerHTML = '<div class="card" style="margin-top:14px"><div class="card-head"><h3>Canceladas y rechazadas (' + ts.length + ')</h3></div>' +
      (ts.length ? '<div class="table-wrap"><table><thead><tr><th>Tarea</th><th>Tipo</th><th>Empresas</th><th>Estado</th><th>Por / motivo</th><th></th></tr></thead><tbody>' +
        ts.map(function (t) {
          var rech = t.estado === 'rechazada';
          return '<tr><td>' + esc(t.titulo) + '</td><td>' + esc(TIPOS[t.tipo] || t.tipo) + '</td><td>' + empresaChips(t.empresas) + '</td>' +
            '<td><span class="kb-chip' + (rech ? ' urg' : '') + '">' + esc(ESTADO_T[t.estado]) + '</span></td>' +
            '<td>' + (rech
              ? esc(t.rechazada_por_nombre || '—') + ' · ' + esc(fmtDateTime(t.rechazada_en)) + '<br><strong>Motivo:</strong> ' + esc(t.motivo_rechazo || '—')
              : esc(t.modificado_por_nombre || '—') + ' · ' + esc(fmtDateTime(t.modificado_en))) + '</td>' +
            '<td><div class="mk-actions"><button class="btn-ver" data-act="tarea-abrir" data-id="' + esc(t.id) + '">Ver</button>' +
            (rech ? '' : '<button class="btn-edit" data-act="reabrir" data-id="' + esc(t.id) + '">Reabrir</button>') + '</div></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty">No hay tareas canceladas ni rechazadas.</div>') + '</div>';
  }

  // ══════════════ Mover entre columnas ══════════════
  async function moverA(id, estado) {
    var t = tareaById[id];
    if (!t || t.estado === estado) return;
    if (t.estado === 'solicitada' && estado !== 'cancelada' && (!String(t.descripcion || '').trim() || !t.fecha_limite)) {
      showToast('Sin brief no hay fecha comprometida: abre la tarea y escribe la descripción (brief) y la fecha límite antes de confirmarla', '#e74c3c');
      return;
    }
    var previo = t.estado;
    t.estado = estado; render();            // optimista
    var res = await _sb.from('mercadeo_tareas').update({ estado: estado }).eq('id', Number(id)).select('id');
    if (res.error || !res.data || !res.data.length) {
      t.estado = previo; render();
      if (res.error) fail('mover la tarea', res.error); else showToast('No se pudo mover: no tienes permiso o la tarea ya no existe', '#e74c3c');
      return;
    }
    avisarSolicitante(Number(id), 'estado', t.origen);
    cargar(false);
  }

  function mover(id, dir) {
    var t = tareaById[id];
    if (!t) return;
    var idx = COLUMNAS.map(function (c) { return c.k; }).indexOf(t.estado);
    if (idx < 0) return;
    var nuevo = COLUMNAS[idx + dir];
    if (nuevo) moverA(id, nuevo.k);
  }

  // ══════════════ Modal de tarea ══════════════
  function checksEmpresas(sel) {
    $('t-empresas').innerHTML = SIGLAS.map(function (s) {
      return '<label><input type="checkbox" class="t-emp-chk" value="' + s + '"' + (sel.indexOf(s) >= 0 ? ' checked' : '') + '> ' + s + '</label>';
    }).join('') + '<button class="btn-secondary" type="button" data-act="emp-todas">Todo el holding</button>';
  }

  function checksResponsables(sel) {
    var base = equipo.filter(function (u) { return u.activo || sel.indexOf(u.id) >= 0; });
    $('t-resp').innerHTML = base.length ? base.map(function (u) {
      return '<label><input type="checkbox" class="t-resp-chk" value="' + esc(u.id) + '"' + (sel.indexOf(u.id) >= 0 ? ' checked' : '') + '> ' + esc(u.nombre) + (u.activo ? '' : ' (inactivo)') + '</label>';
    }).join('') : '<span class="mk-sin">No hay usuarios con acceso al módulo.</span>';
  }

  function opcionesActividad(actualId) {
    var lista = actividades.filter(function (a) { return (a.estado !== 'cancelada' && a.estado !== 'cerrada') || a.id === actualId; })
      .sort(function (a, b) { return String(a.nombre).localeCompare(String(b.nombre)); });
    return '<option value="">Sin actividad (fuera de calendario)</option>' + lista.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (a.id === actualId ? ' selected' : '') + '>' + esc(a.nombre) + (a.en_calendario ? ' ✅ aprobada' : ' (no aprobada)') + '</option>';
    }).join('');
  }

  // Clase de prioridad según la actividad elegida (espejo de la regla de la BD).
  function actualizarPrioridad() {
    var aprobada = actAprobada(Number($('t-actividad').value) || null);
    var sel = $('t-prioridad');
    var optCal = sel.querySelector('option[value="calendario"]');
    if (aprobada) {
      sel.value = 'calendario'; sel.disabled = true;
      $('t-prioridad-help').textContent = 'Vinculada a una actividad aprobada: clase 1 automática.';
    } else {
      sel.disabled = false;
      if (optCal) optCal.disabled = true;
      if (sel.value === 'calendario') sel.value = 'mejora';
      $('t-prioridad-help').textContent = 'La clase 1 solo aplica a actividades aprobadas en el calendario.';
    }
    if (aprobada && optCal) optCal.disabled = false;
  }

  function actualizarAval() {
    var urg = $('t-urgente').checked;
    var fuera = !actAprobada(Number($('t-actividad').value) || null);
    $('t-aval-box').style.display = urg && fuera ? '' : 'none';
    $('t-urg-ok').style.display = urg && !fuera ? '' : 'none';
  }

  // Datos que dijo el solicitante en el formulario de Pedidos (solo lectura).
  function solicitudHtml(t) {
    var quien = esc(t.solicitante_nombre || '—') + (t.solicitante_rol ? ' <span class="tag">' + esc(t.solicitante_rol) + '</span>' : '') +
      (t.solicitante_email ? ' · ' + esc(t.solicitante_email) : '');
    var puedeUsarFecha = t.fecha_tentativa && !t.fecha_limite && t.estado === 'solicitada';
    return '<h4>📥 Solicitud desde Pedidos</h4>' +
      '<div class="form-grid cols2">' +
      '<div><span class="ef-label">Solicitante (quien diligenció)</span>' + quien + '</div>' +
      '<div><span class="ef-label">A nombre de</span>' + (t.a_nombre_de_nombre ? esc(t.a_nombre_de_nombre) : 'Él mismo') + '</div>' +
      '<div><span class="ef-label">Asunto</span>' + esc(ASUNTOS[t.asunto] || t.asunto || '—') +
        (t.asunto_otro ? ' — <strong>' + esc(t.asunto_otro) + '</strong>' : '') + '</div>' +
      '<div><span class="ef-label">Fecha tentativa (no es compromiso)</span>' + esc(t.fecha_tentativa ? fmtDateOnly(t.fecha_tentativa) : '—') +
      (puedeUsarFecha ? ' <button type="button" class="btn-secondary" data-act="usar-fecha">Usar como fecha límite</button>' : '') + '</div>' +
      '<div><span class="ef-label">N° en Pedidos</span>' + esc(t.origen_numero ? 'SM-' + t.origen_numero : '—') + '</div>' +
      '<div><span class="ef-label">Aprobada en Pedidos por</span>' + esc(t.aprobada_por_nombre || '—') +
        (t.aprobada_en ? ' · ' + esc(fmtDateTime(t.aprobada_en)) : '') + '</div>' +
      '</div>' +
      (t.estado === 'rechazada'
        ? '<div class="mk-flag" style="margin-top:10px">❌ Rechazada por <strong>' + esc(t.rechazada_por_nombre || '—') + '</strong>' +
          (t.rechazada_en ? ' el ' + esc(fmtDateTime(t.rechazada_en)) : '') +
          '<br><strong>Motivo:</strong> ' + esc(t.motivo_rechazo || '—') + '</div>'
        : '');
  }

  // Avisa en la campanita de Pedidos a quien hizo la solicitud (estado | rechazo | respuesta).
  // No bloquea ni deshace nada: si falla, el cambio ya quedó guardado y solo se informa.
  async function avisarSolicitante(tareaId, evento, origen) {
    if (origen !== 'panel_pedidos') return;
    try {
      var r = await _sb.functions.invoke('notificar-solicitante', { body: { tarea_id: tareaId, evento: evento } });
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

  // ── Rechazar una solicitud de Pedidos (con motivo) ──
  function abrirRechazo() {
    var t = tareaById[editId];
    if (!t || t.origen !== 'panel_pedidos' || !esAbierta(t)) return;
    $('r-detalle').textContent = (t.origen_numero ? 'SM-' + t.origen_numero + ' · ' : '') + t.titulo;
    $('r-motivo').value = '';
    $('r-confirmar').disabled = false;
    MODAL.open('rechazo-overlay', 'r-motivo');
  }

  async function confirmarRechazo() {
    var motivo = $('r-motivo').value.trim();
    if (motivo.length < 3) { showToast('Escribe el motivo del rechazo (mínimo 3 caracteres)', '#e74c3c'); return; }
    var id = editId, origen = tareaById[id] ? tareaById[id].origen : null;
    var btn = $('r-confirmar');
    btn.disabled = true;
    var res = await _sb.from('mercadeo_tareas').update({ estado: 'rechazada', motivo_rechazo: motivo }).eq('id', id).select('id');
    if (res.error || !res.data || !res.data.length) {
      btn.disabled = false;
      if (res.error) fail('rechazar la solicitud', res.error); else showToast('No se pudo rechazar: no tienes permiso o la tarea ya no existe', '#e74c3c');
      return;
    }
    showToast('✅ Solicitud rechazada; se avisará al solicitante');
    MODAL.close('rechazo-overlay');
    MODAL.close('tarea-overlay');
    avisarSolicitante(id, 'rechazo', origen);
    await cargar(false);
  }

  function abrirTarea(id) {
    var t = id ? tareaById[id] : null;
    editId = t ? t.id : null;
    orig = t ? JSON.parse(JSON.stringify(t)) : null;
    $('tarea-titulo').textContent = t ? '✏️ Tarea #' + t.id : '➕ Nueva tarea';
    $('tarea-meta').innerHTML = t ? '<span>' + esc(ESTADO_T[t.estado]) + '</span>' : '';
    $('t-titulo').value = t ? t.titulo : '';
    $('t-tipo').innerHTML = optsHtml(Object.keys(TIPOS).map(function (k) { return [k, TIPOS[k]]; }), t ? t.tipo : 'diseno');
    // 'Rechazada' no se elige aquí (exige motivo: usa el botón "Rechazar solicitud") y es un estado final.
    var estados = t ? Object.keys(ESTADO_T).filter(function (k) { return k !== 'rechazada' || t.estado === 'rechazada'; }) : ['solicitada'];
    $('t-estado').innerHTML = optsHtml(estados.map(function (k) { return [k, ESTADO_T[k]]; }), t ? t.estado : 'solicitada');
    $('t-estado').disabled = !t || t.estado === 'rechazada';
    $('t-actividad').innerHTML = opcionesActividad(t ? t.actividad_id : null);
    $('t-prioridad').innerHTML = optsHtml(Object.keys(CLASES).map(function (k) { return [k, CLASES[k]]; }), t ? t.prioridad : 'mejora');
    $('t-fecha').value = t && t.fecha_limite ? t.fecha_limite : '';
    $('t-urgente').checked = t ? !!t.urgente : false;
    $('t-aval-por').value = t && t.aval_por ? t.aval_por : '';
    $('t-aval-ref').value = t ? t.aval_referencia : '';
    $('t-aval-motivo').value = t ? t.aval_motivo : '';
    $('t-aval-reg').textContent = t && t.aval_registrado_en ? 'Aval registrado por ' + (t.aval_registrado_por_nombre || '—') + ' el ' + fmtDateTime(t.aval_registrado_en) : '';
    $('t-desc').value = t ? t.descripcion : '';
    checksEmpresas(t ? t.empresas : []);
    checksResponsables(t ? t.responsables : []);
    actualizarPrioridad(); actualizarAval();
    $('t-files-nuevo').value = '';
    $('t-nuevo-files').style.display = t ? 'none' : '';
    $('t-extra').style.display = t ? '' : 'none';
    $('t-eliminar').style.display = t && esAdmin ? '' : 'none';
    // Mercadeo puede rechazar una solicitud de Pedidos mientras no esté entregada ni cancelada.
    $('t-rechazar').style.display = t && t.origen === 'panel_pedidos' && esAbierta(t) ? '' : 'none';
    $('t-guardar').disabled = false; $('t-guardar').textContent = 'Guardar';
    $('t-flags').innerHTML = t && t.urgente && t.fuera_calendario && !t.aval_por
      ? '<div class="mk-flag">⚠️ Esta tarea figura como urgente fuera de calendario sin aval registrado (la actividad pudo dejar de estar aprobada). Registra el aval o quita la urgencia.</div>' : '';
    var esPed = !!(t && t.origen === 'panel_pedidos');
    $('t-solicitud').style.display = esPed ? '' : 'none';
    $('t-solicitud').innerHTML = esPed ? solicitudHtml(t) : '';
    $('t-resp-box').style.display = esPed ? '' : 'none';
    $('t-resp-txt').value = '';
    if (t) { $('t-bitacora').innerHTML = '<div class="mk-sin">Cargando…</div>'; $('t-adjuntos').innerHTML = ''; $('t-audit').innerHTML = auditoriaHtml(t); $('t-coment-txt').value = ''; cargarDetalle(t.id); }
    MODAL.open('tarea-overlay', 't-titulo');
  }

  function leerForm() {
    var empresas = [].slice.call(document.querySelectorAll('.t-emp-chk:checked')).map(function (c) { return c.value; });
    var resp = [].slice.call(document.querySelectorAll('.t-resp-chk:checked')).map(function (c) { return c.value; });
    var actId = Number($('t-actividad').value) || null;
    var urg = $('t-urgente').checked, fuera = !actAprobada(actId);
    return {
      titulo: $('t-titulo').value.trim(), descripcion: $('t-desc').value.trim(), estado: $('t-estado').value,
      tipo: $('t-tipo').value, prioridad: $('t-prioridad').value, urgente: urg, actividad_id: actId,
      empresas: empresas, responsables: resp, fecha_limite: $('t-fecha').value || null,
      aval_por: urg && fuera ? ($('t-aval-por').value || null) : null,
      aval_referencia: urg && fuera ? $('t-aval-ref').value.trim() : '',
      aval_motivo: urg && fuera ? $('t-aval-motivo').value.trim() : '',
    };
  }

  function validar(d) {
    if (d.titulo.length < 3) return 'El título debe tener al menos 3 caracteres';
    if (!d.empresas.length) return 'Elige al menos una empresa';
    if (d.urgente && !actAprobada(d.actividad_id) && (!d.aval_por || !d.aval_referencia || !d.aval_motivo)) {
      return 'Una tarea urgente fuera de calendario requiere el aval del Comité de Mercadeo o de Gerencia General (quién avala, referencia y motivo)';
    }
    if (orig && orig.estado === 'solicitada' && d.estado !== 'solicitada' && d.estado !== 'cancelada' && (!d.descripcion || !d.fecha_limite)) {
      return 'Sin brief no hay fecha comprometida: para confirmar la tarea escribe la descripción (brief) y la fecha límite';
    }
    return null;
  }

  function igual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  async function guardarTarea() {
    var d = leerForm();
    var err = validar(d);
    if (err) { showToast(err, '#e74c3c'); return; }
    var btn = $('t-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    var res, nuevoId = editId;
    if (editId) {
      // Solo los campos modificados (evita pisar cambios simultáneos de otra persona en otros campos).
      var diff = {};
      Object.keys(d).forEach(function (k) {
        var a = k === 'empresas' || k === 'responsables' ? d[k].slice().sort() : d[k];
        var b = k === 'empresas' || k === 'responsables' ? (orig[k] || []).slice().sort() : orig[k];
        if (!igual(a, b)) diff[k] = d[k];
      });
      if (!Object.keys(diff).length) { btn.disabled = false; btn.textContent = 'Guardar'; showToast('No hay cambios que guardar'); return; }
      res = await _sb.from('mercadeo_tareas').update(diff).eq('id', editId).select('id');
      if (!res.error && (!res.data || !res.data.length)) res = { error: { message: 'No se guardó: no tienes permiso o la tarea ya no existe', code: '42501' } };
    } else {
      delete d.estado;
      res = await _sb.from('mercadeo_tareas').insert(d).select('id').single();
      if (!res.error) nuevoId = res.data.id;
    }
    btn.disabled = false; btn.textContent = 'Guardar';
    if (res.error) { fail('guardar la tarea', res.error); return; }
    if (!editId) await subirArchivos(nuevoId, $('t-files-nuevo').files);
    showToast(editId ? '✅ Tarea actualizada' : '✅ Tarea creada');
    // Si cambió el estado de una solicitud de Pedidos, se avisa al solicitante (se captura antes de cerrar el modal).
    var avisoEstado = editId && diff && diff.estado ? { id: editId, origen: orig ? orig.origen : null } : null;
    MODAL.close('tarea-overlay');
    if (avisoEstado) avisarSolicitante(avisoEstado.id, 'estado', avisoEstado.origen);
    await cargar(false);
  }

  async function eliminarTarea() {
    if (!editId || !esAdmin) return;
    var t = tareaById[editId];
    if (!confirm('¿Eliminar definitivamente la tarea "' + (t ? t.titulo : '') + '"? Se borran también sus comentarios, adjuntos e historial. Normalmente conviene cancelarla en lugar de eliminarla.')) return;
    var ad = await _sb.from('mercadeo_tarea_adjuntos').select('storage_path').eq('tarea_id', editId);
    if (!ad.error && ad.data && ad.data.length) {
      await _sb.storage.from('mercadeo-adjuntos').remove(ad.data.map(function (a) { return a.storage_path; }));
    }
    var res = await _sb.from('mercadeo_tareas').delete().eq('id', editId).select('id');
    if (res.error) { fail('eliminar la tarea', res.error); return; }
    if (!res.data || !res.data.length) { showToast('No se eliminó: solo un administrador puede borrar tareas', '#e74c3c'); return; }
    showToast('🗑 Tarea eliminada');
    MODAL.close('tarea-overlay');
    await cargar(false);
  }

  // ══════════════ Adjuntos y bitácora ══════════════
  function nombreSeguro(n) { return String(n).replace(/[^a-zA-Z0-9._-]/g, '_'); }

  async function subirArchivos(tareaId, files) {
    var ok = 0, errores = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > MAX_ARCHIVO) { errores.push(f.name + ' (supera 25 MB)'); continue; }
      var path = 'tarea_' + tareaId + '/' + Date.now() + '-' + i + '-' + nombreSeguro(f.name);
      var up = await _sb.storage.from('mercadeo-adjuntos').upload(path, f, { cacheControl: '3600', upsert: false });
      if (up.error) { errores.push(f.name + ' (' + errMsg(up.error) + ')'); continue; }
      var ins = await _sb.from('mercadeo_tarea_adjuntos').insert({ tarea_id: tareaId, storage_path: path, nombre_original: f.name, tipo_mime: f.type || null, tamano_bytes: f.size, subido_por: miId });
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
      _sb.from('mercadeo_tarea_adjuntos').select('*').eq('tarea_id', id).order('id', { ascending: true }),
      _sb.from('mercadeo_tarea_bitacora').select('*').eq('tarea_id', id).order('id', { ascending: false }),
    ]);
    if (editId !== id) return;   // se cerró o cambió de tarea mientras cargaba
    if (rs[0].error || rs[1].error) { $('t-bitacora').innerHTML = '<div class="mk-warn">No se pudo cargar el historial: ' + esc(errMsg(rs[0].error || rs[1].error)) + '</div>'; return; }
    var ads = rs[0].data;
    $('t-adjuntos').innerHTML = ads.length ? ads.map(function (a) {
      return '<div class="adjunto-item"><span>📎 ' + esc(a.nombre_original || 'archivo') + ' <span class="tag">' + esc(fmtTam(a.tamano_bytes)) + '</span></span>' +
        '<span class="mk-actions"><button class="btn-ver" data-act="adj-abrir" data-path="' + esc(a.storage_path) + '">Abrir</button>' +
        '<button class="btn-danger" data-act="adj-eliminar" data-id="' + esc(a.id) + '" data-path="' + esc(a.storage_path) + '" aria-label="Eliminar adjunto">🗑</button></span></div>';
    }).join('') : '<div class="mk-sin">Sin adjuntos.</div>';
    $('t-bitacora').innerHTML = rs[1].data.length ? rs[1].data.map(evHtml).join('') : '<div class="mk-sin">Sin actividad registrada.</div>';
  }

  function nomUsuarios(arr) { return (arr && arr.length) ? arr.map(esc).join(', ') : '—'; }
  function evTexto(ev) {
    var d = ev.detalle || {};
    switch (ev.tipo_evento) {
      case 'creacion':
        if (d.origen === 'panel_pedidos') {
          return 'Solicitud recibida desde Pedidos' + (d.asunto ? ': <strong>' + esc(ASUNTOS[d.asunto] || d.asunto) + '</strong>' : '') +
            (d.a_nombre_de ? ' · a nombre de <strong>' + esc(d.a_nombre_de) + '</strong>' : '');
        }
        return 'Creó la tarea';
      case 'respuesta_solicitante': return '📣 Respuesta al solicitante: ' + esc(d.texto);
      case 'observacion_solicitante':
        return '💬 <strong>Observación ' + (d.como === 'aprobador' ? 'del aprobador' : 'del solicitante') + ':</strong> <span style="white-space:pre-wrap">' + esc(d.texto) + '</span>';
      case 'cambio_estado': return 'Cambió el estado: <strong>' + esc(ESTADO_T[d.de] || d.de) + '</strong> → <strong>' + esc(ESTADO_T[d.a] || d.a) + '</strong>' +
        (d.motivo ? ' · <strong>Motivo:</strong> ' + esc(d.motivo) : '');
      case 'asignacion': return 'Responsables: ' + nomUsuarios(d.de) + ' → <strong>' + nomUsuarios(d.a) + '</strong>';
      case 'aval_registrado': return 'Registró el aval de excepción (urgente fuera de calendario): <strong>' + esc(AVAL[d.por] || d.por) + '</strong> · ' + esc(d.referencia) + ' · ' + esc(d.motivo);
      case 'comentario': return '💬 ' + esc(d.texto);
      case 'adjunto_agregado': return 'Adjuntó el archivo <strong>' + esc(d.nombre) + '</strong>';
      case 'adjunto_eliminado': return 'Eliminó el adjunto <strong>' + esc(d.nombre) + '</strong>';
      case 'cambio_datos':
        return 'Modificó: ' + Object.keys(d).map(function (k) {
          var v = d[k];
          if (k === 'descripcion') return 'descripción';
          var de = v && v.de, a = v && v.a;
          if (k === 'titulo') return 'título (“' + esc(de) + '” → “' + esc(a) + '”)';
          if (k === 'tipo') return 'tipo (' + esc(TIPOS[de] || de) + ' → ' + esc(TIPOS[a] || a) + ')';
          if (k === 'prioridad') return 'clase (' + esc(CLASE_CORTA[de] || de) + ' → ' + esc(CLASE_CORTA[a] || a) + ')';
          if (k === 'urgente') return 'urgente (' + (de ? 'sí' : 'no') + ' → ' + (a ? 'sí' : 'no') + ')';
          if (k === 'fecha_limite') return 'fecha límite (' + esc(de ? fmtDateOnly(de) : '—') + ' → ' + esc(a ? fmtDateOnly(a) : '—') + ')';
          if (k === 'empresas') return 'empresas (' + nomUsuarios(de) + ' → ' + nomUsuarios(a) + ')';
          if (k === 'actividad_id') return 'actividad (' + esc(de && actById[de] ? actById[de].nombre : '—') + ' → ' + esc(a && actById[a] ? actById[a].nombre : '—') + ')';
          return esc(k);
        }).join('; ');
      default: return esc(ev.tipo_evento);
    }
  }
  function evHtml(ev) {
    return '<div class="bitacora-item"><div>' + evTexto(ev) + '</div><div class="meta">' + esc(ev.usuario_nombre || 'Sistema') + ' · ' + esc(fmtDateTime(ev.creado_en)) + '</div></div>';
  }

  async function comentar() {
    var txt = $('t-coment-txt').value.trim();
    if (!txt) { showToast('Escribe el comentario', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_tarea_bitacora').insert({ tarea_id: editId, tipo_evento: 'comentario', detalle: { texto: txt } });
    if (res.error) { fail('comentar', res.error); return; }
    $('t-coment-txt').value = '';
    cargarDetalle(editId);
  }

  // Mensaje de Mercadeo que el solicitante ve en "Mis solicitudes" de panel-pedidos.
  async function responder() {
    var txt = $('t-resp-txt').value.trim();
    if (!txt) { showToast('Escribe la respuesta', '#e74c3c'); return; }
    var res = await _sb.from('mercadeo_tarea_bitacora').insert({ tarea_id: editId, tipo_evento: 'respuesta_solicitante', detalle: { texto: txt } });
    if (res.error) { fail('responder al solicitante', res.error); return; }
    $('t-resp-txt').value = '';
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
    var res = await _sb.from('mercadeo_tarea_adjuntos').delete().eq('id', Number(id)).select('id');
    if (res.error) { fail('eliminar el adjunto', res.error); return; }
    if (!res.data || !res.data.length) { showToast('No se eliminó el adjunto', '#e74c3c'); return; }
    await _sb.storage.from('mercadeo-adjuntos').remove([path]);
    cargarDetalle(editId);
  }

  // ══════════════ Eventos ══════════════
  var ACCIONES = {
    'reintentar': function () { $('estado-carga').textContent = 'Cargando…'; cargar(true); },
    'limpiar': function () {
      ['f-empresa', 'f-resp', 'f-tipo', 'f-clase', 'f-origen', 'f-asunto'].forEach(function (k) { $(k).value = ''; });
      $('f-buscar').value = ''; $('f-urg').checked = false; $('f-canceladas').checked = false; $('f-entregadas').value = '30'; render();
    },
    'ley-resp': function (id) {
      var f = $('f-resp');
      f.value = f.value === id ? '' : id;
      render();
      var b = document.querySelector('.kb-ley-chip[data-id="' + id + '"]');
      if (b) b.focus({ preventScroll: true });   // render() reconstruye la leyenda: se devuelve el foco al chip para quien usa teclado
    },
    'tarea-nueva': function () { abrirTarea(null); },
    'tarea-abrir': function (id) { abrirTarea(Number(id)); },
    'tarea-guardar': guardarTarea,
    'tarea-eliminar': eliminarTarea,
    'cerrar-modal': function () { MODAL.close('tarea-overlay'); },
    'mover': function (id, el) { mover(Number(id), Number(el.getAttribute('data-dir'))); },
    'reabrir': function (id) { moverA(Number(id), 'solicitada'); },
    'emp-todas': function () { [].slice.call(document.querySelectorAll('.t-emp-chk')).forEach(function (c) { c.checked = true; }); },
    'comentar': comentar,
    'responder': responder,
    'rechazo-abrir': abrirRechazo,
    'rechazo-confirmar': confirmarRechazo,
    'rechazo-cerrar': function () { MODAL.close('rechazo-overlay'); },
    'usar-fecha': function () { var t = tareaById[editId]; if (t && t.fecha_tentativa) $('t-fecha').value = t.fecha_tentativa; },
    'adj-abrir': function (id, el) { abrirAdjunto(el.getAttribute('data-path')); },
    'adj-eliminar': function (id, el) { eliminarAdjunto(id, el.getAttribute('data-path')); },
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACCIONES[el.getAttribute('data-act')];
    if (fn) fn(el.getAttribute('data-id'), el, e);
  });

  // Enter/Espacio abre la tarjeta enfocada
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('kb-card')) {
      e.preventDefault();
      abrirTarea(Number(e.target.getAttribute('data-id')));
    }
  });

  // Arrastrar y soltar entre columnas (HTML5 nativo; en táctil se usan los botones ◀ ▶)
  var board = $('kb-board');
  board.addEventListener('dragstart', function (e) {
    var c = e.target.closest ? e.target.closest('.kb-card') : null;
    if (!c) return;
    dragId = Number(c.getAttribute('data-id'));
    if (e.dataTransfer) { e.dataTransfer.setData('text/plain', String(dragId)); e.dataTransfer.effectAllowed = 'move'; }
    c.classList.add('dragging');
  });
  board.addEventListener('dragend', function () {
    dragId = null;
    [].slice.call(document.querySelectorAll('.kb-card.dragging, .kb-list.over')).forEach(function (n) { n.classList.remove('dragging', 'over'); });
  });
  board.addEventListener('dragover', function (e) {
    var l = e.target.closest ? e.target.closest('.kb-list') : null;
    if (!l || !dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    l.classList.add('over');
  });
  board.addEventListener('dragleave', function (e) {
    var l = e.target.closest ? e.target.closest('.kb-list') : null;
    if (l && !l.contains(e.relatedTarget)) l.classList.remove('over');
  });
  board.addEventListener('drop', function (e) {
    var l = e.target.closest ? e.target.closest('.kb-list') : null;
    if (!l || !dragId) return;
    e.preventDefault();
    l.classList.remove('over');
    var id = dragId; dragId = null;
    moverA(id, l.getAttribute('data-estado'));
  });

  // Filtros en vivo
  ['f-empresa', 'f-resp', 'f-tipo', 'f-clase', 'f-origen', 'f-asunto', 'f-urg', 'f-entregadas', 'f-canceladas'].forEach(function (id) { $(id).addEventListener('change', render); });
  $('f-buscar').addEventListener('input', render);

  // Modal: reglas de calendario/aval en vivo, y subida de archivos en tareas existentes
  $('t-actividad').addEventListener('change', function () { actualizarPrioridad(); actualizarAval(); });
  $('t-urgente').addEventListener('change', actualizarAval);
  $('t-files').addEventListener('change', async function () {
    if (!editId || !this.files.length) return;
    await subirArchivos(editId, this.files);
    this.value = '';
    cargarDetalle(editId);
  });
  MODAL.onClose = function (id) { if (id === 'tarea-overlay') { editId = null; orig = null; } };

  // Actualización en vivo entre las personas del equipo
  try {
    _sb.channel('mercadeo-tareas').on('postgres_changes', { event: '*', schema: 'public', table: 'mercadeo_tareas' }, programarRecarga).subscribe();
  } catch (e) { /* sin Realtime: queda la recarga al volver a la pestaña */ }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) programarRecarga(); });

  await cargar(true);

  // Enlace directo desde la campanita: ?tarea=<id> abre esa tarjeta.
  var tareaParam = Number(new URLSearchParams(location.search).get('tarea'));
  if (tareaParam && tareaById[tareaParam]) {
    $('f-canceladas').checked = tareaById[tareaParam].estado === 'cancelada' || tareaById[tareaParam].estado === 'rechazada';
    render();
    abrirTarea(tareaParam);
  }
})();
