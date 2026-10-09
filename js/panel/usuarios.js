(async function () {
  await AUTH.authReady;

  if (!AUTH.canManageUsers()) {
    document.getElementById('no-access').style.display = '';
    return;
  }
  document.getElementById('content').style.display = '';

  var ROLES = [
    { v: 'lector', t: 'Lector' },
    { v: 'gestor', t: 'Gestor' },
    { v: 'mercadeo', t: 'Mercadeo' },
    { v: 'sst', t: 'SST' },
    { v: 'admin', t: 'Admin' },
  ];
  // Módulos extra. 'rol' = el rol que siempre lleva ese módulo (el admin tiene todos).
  var MODULOS = [
    { key: 'mercadeo', rol: 'mercadeo', label: 'Mercadeo' },
    { key: 'sst', rol: 'sst', label: 'SST' },
  ];
  var miId = AUTH.getUser().id;

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

  async function cargar() {
    var res = await _sb.from('usuarios_pqrs').select('*').order('created_at');
    if (res.error) { showToast('Error al cargar usuarios: ' + res.error.message, '#e74c3c'); return; }
    document.getElementById('tbody').innerHTML = res.data.map(function (u) {
      var esYo = u.id === miId;
      var rolSel = '<select class="ef sel-rol" data-id="' + escHtml(u.id) + '"' + (esYo ? ' disabled title="No puedes cambiar tu propio rol"' : '') + '>' +
        ROLES.map(function (r) { return '<option value="' + r.v + '"' + (r.v === u.rol ? ' selected' : '') + '>' + r.t + '</option>'; }).join('') +
        '</select>';
      var celdasMod = MODULOS.map(function (m) {
        var tiene = (u.modulos || []).indexOf(m.key) >= 0;
        return '<td>' + (u.rol === 'admin'
          ? '<span style="color:#718096;font-size:0.78rem">todos</span>'
          : '<input type="checkbox" class="chk-mod" data-id="' + escHtml(u.id) + '" data-mod="' + m.key + '"' + (tiene ? ' checked' : '') + (u.rol === m.rol ? ' disabled' : '') + ' aria-label="Acceso a ' + m.label + '">') + '</td>';
      }).join('');
      return '<tr>' +
        '<td>' + escHtml(u.nombre || '') + '</td>' +
        '<td>' + escHtml(u.email) + '</td>' +
        '<td style="min-width:130px">' + rolSel + '</td>' +
        celdasMod +
        '<td>' + (u.activo ? 'Sí' : 'No') + '</td>' +
        '<td><button class="btn-edit btn-toggle-activo" data-id="' + escHtml(u.id) + '" data-activo="' + u.activo + '">' + (u.activo ? 'Desactivar' : 'Activar') + '</button></td>' +
        '</tr>';
    }).join('');

    document.querySelectorAll('.btn-toggle-activo').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-id');
        var activo = btn.getAttribute('data-activo') === 'true';
        var res2 = await _sb.from('usuarios_pqrs').update({ activo: !activo }).eq('id', id);
        if (res2.error) { showToast('Error: ' + res2.error.message, '#e74c3c'); return; }
        cargar();
      });
    });

    // Cambio de rol / módulos de un usuario existente (se guarda al instante).
    function guardarRolModulos(id, rol) {
      var mods = rol === 'admin' ? [] : MODULOS.filter(function (m) {
        if (m.rol === rol) return true;
        var chk = document.querySelector('.chk-mod[data-id="' + id + '"][data-mod="' + m.key + '"]');
        return !!chk && chk.checked;
      }).map(function (m) { return m.key; });
      return _sb.from('usuarios_pqrs').update({ rol: rol, modulos: mods }).eq('id', id).then(function (r) {
        if (r.error) { showToast('Error: ' + errMsg(r.error), '#e74c3c'); } else { showToast('Usuario actualizado'); }
        cargar();
      });
    }
    document.querySelectorAll('.sel-rol').forEach(function (sel) {
      sel.addEventListener('change', function () {
        guardarRolModulos(sel.getAttribute('data-id'), sel.value);
      });
    });
    document.querySelectorAll('.chk-mod').forEach(function (chk) {
      chk.addEventListener('change', function () {
        var id = chk.getAttribute('data-id');
        var sel = document.querySelector('.sel-rol[data-id="' + id + '"]');
        guardarRolModulos(id, sel.value);
      });
    });
  }

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
