(async function () {
  await AUTH.authReady;

  if (!AUTH.canManageUsers()) {
    document.getElementById('no-access').style.display = '';
    return;
  }
  document.getElementById('content').style.display = '';

  // 'acceso' = lo que da el rol por sí solo (PQRS y Encuestas salen del rol, no de `modulos`).
  var ROLES = [
    { v: 'lector', t: 'Lector', acceso: 'PQRS y Encuestas (solo lectura)' },
    { v: 'gestor', t: 'Gestor', acceso: 'PQRS (gestionar) y Encuestas' },
    { v: 'mercadeo', t: 'Mercadeo', acceso: null },
    { v: 'sst', t: 'SST', acceso: null },
    { v: 'admin', t: 'Admin', acceso: 'Todo: PQRS, Encuestas, Mercadeo, SST y gestión de usuarios' },
  ];
  // Módulos extra. 'rol' = el rol que siempre lleva ese módulo (el admin tiene todos).
  var MODULOS = [
    { key: 'mercadeo', rol: 'mercadeo', label: 'Mercadeo', acceso: 'Tablero, CRM e Indicadores de Mercadeo' },
    { key: 'sst', rol: 'sst', label: 'SST', acceso: 'SST (Seguridad y Salud en el Trabajo)' },
  ];
  var miId = AUTH.getUser().id;
  var usuarios = [];

  function rolTexto(v) {
    var r = ROLES.filter(function (x) { return x.v === v; })[0];
    return r ? r.t : v;
  }
  function moduloPropio(rol) {
    return MODULOS.filter(function (m) { return m.rol === rol; })[0] || null;
  }
  function tieneModulo(rol, mods, key) {
    return rol === 'admin' || (mods || []).indexOf(key) >= 0;
  }

  // ── Formulario «Nuevo usuario» ──
  // Un rol que lleva su módulo lo tiene siempre; el admin tiene todos (la casilla no aplica).
  function sincronizarFormulario() {
    var rol = document.getElementById('n-rol').value;
    MODULOS.forEach(function (m) {
      var chk = document.getElementById('n-mod-' + m.key);
      if (rol === m.rol) { chk.checked = true; chk.disabled = true; }
      else if (rol === 'admin') { chk.checked = false; chk.disabled = true; }
      else { chk.disabled = false; }
    });
  }
  document.getElementById('n-rol').addEventListener('change', sincronizarFormulario);
  sincronizarFormulario();

  function modulosDeFormulario() {
    return MODULOS.filter(function (m) { return document.getElementById('n-mod-' + m.key).checked; })
      .map(function (m) { return m.key; });
  }

  // ── Tabla del equipo ──
  function pintar() {
    var cuerpo = document.getElementById('tbody');
    if (!usuarios.length) {
      cuerpo.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:18px">Sin usuarios.</td></tr>';
      return;
    }
    cuerpo.innerHTML = usuarios.map(function (u) {
      var esYo = u.id === miId;
      var id = escHtml(u.id);
      var celdasMod = MODULOS.map(function (m) {
        return '<td>' + (u.rol === 'admin' ? '<span class="us-nota">todos</span>'
          : (tieneModulo(u.rol, u.modulos, m.key) ? 'Sí' : '—')) + '</td>';
      }).join('');
      var aviso = ' disabled title="No puedes cambiar tus propios permisos: pídeselo a otro administrador"';
      return '<tr>' +
        '<td>' + escHtml(u.nombre || '') + (esYo ? '<span class="us-yo">(tú)</span>' : '') + '</td>' +
        '<td>' + escHtml(u.email) + '</td>' +
        '<td><span class="badge us-rol us-rol-' + escHtml(u.rol) + '">' + escHtml(rolTexto(u.rol)) + '</span></td>' +
        celdasMod +
        '<td>' + (u.activo ? 'Sí' : 'No') + '</td>' +
        '<td class="us-acc">' +
          '<button class="btn-edit" data-act="editar" data-id="' + id + '"' + (esYo ? aviso : '') + '>Editar</button> ' +
          '<button class="btn-edit" data-act="activo" data-id="' + id + '"' + (esYo ? aviso : '') + '>' + (u.activo ? 'Desactivar' : 'Activar') + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  async function cargar() {
    var res = await _sb.from('usuarios_pqrs').select('*').order('created_at');
    if (res.error) { showToast('Error al cargar usuarios: ' + errMsg(res.error), '#e74c3c'); return; }
    usuarios = res.data || [];
    pintar();
  }

  function buscar(id) {
    return usuarios.filter(function (u) { return u.id === id; })[0] || null;
  }

  document.getElementById('tbody').addEventListener('click', async function (ev) {
    var btn = ev.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    var u = buscar(btn.getAttribute('data-id'));
    if (!u) return;
    if (btn.getAttribute('data-act') === 'editar') { abrirEditar(u.id); return; }

    // Activar / desactivar
    var msg = u.activo
      ? '¿Desactivar a ' + (u.nombre || u.email) + '? Dejará de poder entrar al panel.'
      : '¿Activar a ' + (u.nombre || u.email) + '? Podrá entrar de nuevo con su rol y módulos.';
    if (!confirm(msg)) return;
    btn.disabled = true;
    var r = await _sb.from('usuarios_pqrs').update({ activo: !u.activo }).eq('id', u.id).select('id');
    if (r.error) { showToast('Error: ' + errMsg(r.error), '#e74c3c'); btn.disabled = false; return; }
    if (!r.data || !r.data.length) { showToast('No se aplicó el cambio (sin permiso o el usuario ya no existe).', '#e74c3c'); cargar(); return; }
    showToast(u.activo ? 'Usuario desactivado' : 'Usuario activado');
    cargar();
  });

  // ── Modal «Editar permisos» ──
  // editando = { u: fila original, rolSel: rol que muestra el selector (para saber de cuál venía) }.
  var editando = null;
  var selRol = document.getElementById('e-rol');
  var btnGuardar = document.getElementById('e-guardar');

  function chkMod(key) { return document.getElementById('e-mod-' + key); }

  // Estado inicial de las casillas según el usuario guardado.
  function casillasDesdeUsuario(u) {
    MODULOS.forEach(function (m) {
      var chk = chkMod(m.key);
      chk.checked = tieneModulo(u.rol, u.modulos, m.key);
      chk.disabled = u.rol === 'admin' || u.rol === m.rol;
    });
  }

  // Al cambiar el rol: el rol que lleva su módulo lo fija; al irse de un rol con módulo propio (o de admin)
  // ese acceso se quita (el admin puede volver a marcarlo); si vuelve al rol original se restaura lo guardado.
  function alCambiarRol() {
    var u = editando.u;
    var nuevo = selRol.value;
    var previo = editando.rolSel;
    editando.rolSel = nuevo;
    if (nuevo === u.rol) { casillasDesdeUsuario(u); resumir(); return; }
    MODULOS.forEach(function (m) {
      var chk = chkMod(m.key);
      if (nuevo === 'admin') { chk.checked = true; chk.disabled = true; return; }
      if (nuevo === m.rol) { chk.checked = true; chk.disabled = true; return; }
      chk.disabled = false;
      if (previo === 'admin' || previo === m.rol) chk.checked = false;
    });
    resumir();
  }

  // Lo que se guardaría con el formulario tal como está.
  function propuesta() {
    var rol = selRol.value;
    var mods = rol === 'admin' ? [] : MODULOS.filter(function (m) {
      return m.rol === rol || chkMod(m.key).checked;
    }).map(function (m) { return m.key; });
    return { rol: rol, modulos: mods };
  }

  function accesosDe(rol, mods) {
    var lista = [];
    var r = ROLES.filter(function (x) { return x.v === rol; })[0];
    if (r && r.acceso) lista.push(r.acceso);
    if (rol !== 'admin') {
      MODULOS.forEach(function (m) { if (tieneModulo(rol, mods, m.key)) lista.push(m.acceso); });
    }
    return lista;
  }

  function hayCambios(p) {
    var u = editando.u;
    var ant = (u.modulos || []).slice().sort().join(',');
    return p.rol !== u.rol || p.modulos.slice().sort().join(',') !== ant;
  }

  function resumir() {
    var u = editando.u;
    var p = propuesta();
    var cambios = [];
    if (p.rol !== u.rol) cambios.push('Rol: <b>' + escHtml(rolTexto(u.rol)) + '</b> → <b>' + escHtml(rolTexto(p.rol)) + '</b>');
    MODULOS.forEach(function (m) {
      var antes = tieneModulo(u.rol, u.modulos, m.key);
      var despues = tieneModulo(p.rol, p.modulos, m.key);
      if (antes !== despues) cambios.push(escHtml(m.label) + ': <b>' + (antes ? 'sí' : 'no') + '</b> → <b>' + (despues ? 'sí' : 'no') + '</b>');
    });
    var html = '<div class="us-res-tit">Cambios</div>' +
      (cambios.length ? '<ul>' + cambios.map(function (c) { return '<li>' + c + '</li>'; }).join('') + '</ul>'
        : '<div class="us-nota">Sin cambios.</div>');
    html += '<div class="us-res-tit" style="margin-top:8px">Tendrá acceso a</div><ul>' +
      accesosDe(p.rol, p.modulos).map(function (a) { return '<li>' + escHtml(a) + '</li>'; }).join('') + '</ul>';
    if (p.rol === 'admin' && u.rol !== 'admin') {
      html += '<div class="us-alerta">Un administrador tiene acceso total, incluida la gestión de usuarios.</div>';
    } else if (u.rol === 'admin' && p.rol !== 'admin') {
      html += '<div class="us-alerta">Dejará de ser administrador y de poder gestionar usuarios.</div>';
    }
    document.getElementById('e-resumen').innerHTML = html;
    btnGuardar.disabled = !hayCambios(p);
  }

  async function abrirEditar(id) {
    // Se relee la fila para no editar sobre datos viejos (otro admin pudo cambiarla).
    var res = await _sb.from('usuarios_pqrs').select('*').eq('id', id).single();
    if (res.error || !res.data) { showToast('No se pudo leer el usuario: ' + errMsg(res.error), '#e74c3c'); cargar(); return; }
    var u = res.data;
    editando = { u: u, rolSel: u.rol };
    document.getElementById('e-usuario').textContent = (u.nombre ? u.nombre + ' · ' : '') + u.email;
    selRol.value = u.rol;
    casillasDesdeUsuario(u);
    resumir();
    MODAL.open('editar-overlay', 'e-rol');
  }

  selRol.addEventListener('change', alCambiarRol);
  MODULOS.forEach(function (m) { chkMod(m.key).addEventListener('change', resumir); });
  document.querySelectorAll('[data-act="editar-cerrar"]').forEach(function (b) {
    b.addEventListener('click', function () { MODAL.close('editar-overlay'); });
  });

  btnGuardar.addEventListener('click', async function () {
    if (!editando) return;
    var p = propuesta();
    if (!hayCambios(p)) return;
    btnGuardar.disabled = true;
    var r = await _sb.from('usuarios_pqrs').update({ rol: p.rol, modulos: p.modulos }).eq('id', editando.u.id).select('id');
    if (r.error) {
      showToast('No se pudo guardar: ' + errMsg(r.error), '#e74c3c');
      btnGuardar.disabled = false;
      return;
    }
    if (!r.data || !r.data.length) {
      showToast('No se aplicó el cambio (sin permiso o el usuario ya no existe).', '#e74c3c');
      btnGuardar.disabled = false;
      return;
    }
    var idEditado = editando.u.id;
    MODAL.close('editar-overlay');
    showToast('Permisos actualizados. La persona los verá al recargar el panel.');
    // La tabla se repinta: el foco vuelve al botón Editar de la misma persona.
    cargar().then(function () {
      var b = document.querySelector('button[data-act="editar"][data-id="' + idEditado + '"]');
      if (b) b.focus();
    });
  });

  // ── Crear usuario ──
  document.getElementById('btn-crear').addEventListener('click', async function () {
    var nombre = document.getElementById('n-nombre').value.trim();
    var email = document.getElementById('n-email').value.trim();
    var password = document.getElementById('n-password').value;
    var rol = document.getElementById('n-rol').value;

    if (!email || !password) { showToast('Correo y contraseña son requeridos', '#e74c3c'); return; }

    var session = await _sb.auth.getSession();
    var token = session.data.session.access_token;

    var res = await fetch(SUPABASE_URL + '/functions/v1/create-user-pqrs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ email: email, password: password, nombre: nombre, rol: rol, modulos: modulosDeFormulario() }),
    });
    var data = await res.json();
    if (!res.ok) { showToast('Error: ' + (data.error || 'no se pudo crear el usuario'), '#e74c3c'); return; }

    showToast('Usuario creado');
    document.getElementById('n-nombre').value = '';
    document.getElementById('n-email').value = '';
    document.getElementById('n-password').value = '';
    cargar();
  });

  cargar();
})();
