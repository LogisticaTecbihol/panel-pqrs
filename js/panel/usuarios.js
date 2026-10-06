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
    { v: 'admin', t: 'Admin' },
  ];
  var miId = AUTH.getUser().id;

  // El rol 'mercadeo' siempre lleva el módulo; el admin tiene todos (la casilla no aplica).
  function sincronizarFormulario() {
    var rol = document.getElementById('n-rol').value;
    var chk = document.getElementById('n-mod-mercadeo');
    if (rol === 'mercadeo') { chk.checked = true; chk.disabled = true; }
    else if (rol === 'admin') { chk.checked = false; chk.disabled = true; }
    else { chk.disabled = false; }
  }
  document.getElementById('n-rol').addEventListener('change', sincronizarFormulario);
  sincronizarFormulario();

  async function cargar() {
    var res = await _sb.from('usuarios_pqrs').select('*').order('created_at');
    if (res.error) { showToast('Error al cargar usuarios: ' + res.error.message, '#e74c3c'); return; }
    document.getElementById('tbody').innerHTML = res.data.map(function (u) {
      var esYo = u.id === miId;
      var tieneMod = (u.modulos || []).indexOf('mercadeo') >= 0;
      var rolSel = '<select class="ef sel-rol" data-id="' + escHtml(u.id) + '"' + (esYo ? ' disabled title="No puedes cambiar tu propio rol"' : '') + '>' +
        ROLES.map(function (r) { return '<option value="' + r.v + '"' + (r.v === u.rol ? ' selected' : '') + '>' + r.t + '</option>'; }).join('') +
        '</select>';
      var modChk = u.rol === 'admin'
        ? '<span style="color:#718096;font-size:0.78rem">todos</span>'
        : '<input type="checkbox" class="chk-mod" data-id="' + escHtml(u.id) + '"' + (tieneMod ? ' checked' : '') + (u.rol === 'mercadeo' ? ' disabled' : '') + ' aria-label="Acceso a Mercadeo">';
      return '<tr>' +
        '<td>' + escHtml(u.nombre || '') + '</td>' +
        '<td>' + escHtml(u.email) + '</td>' +
        '<td style="min-width:130px">' + rolSel + '</td>' +
        '<td>' + modChk + '</td>' +
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

    // Cambio de rol / módulo de un usuario existente (se guarda al instante).
    function guardarRolModulos(id, rol, conMercadeo) {
      var mods = (conMercadeo || rol === 'mercadeo') && rol !== 'admin' ? ['mercadeo'] : [];
      return _sb.from('usuarios_pqrs').update({ rol: rol, modulos: mods }).eq('id', id).then(function (r) {
        if (r.error) { showToast('Error: ' + errMsg(r.error), '#e74c3c'); } else { showToast('Usuario actualizado'); }
        cargar();
      });
    }
    document.querySelectorAll('.sel-rol').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-id');
        var chk = document.querySelector('.chk-mod[data-id="' + id + '"]');
        guardarRolModulos(id, sel.value, chk ? chk.checked : false);
      });
    });
    document.querySelectorAll('.chk-mod').forEach(function (chk) {
      chk.addEventListener('change', function () {
        var id = chk.getAttribute('data-id');
        var sel = document.querySelector('.sel-rol[data-id="' + id + '"]');
        guardarRolModulos(id, sel.value, chk.checked);
      });
    });
  }

  document.getElementById('btn-crear').addEventListener('click', async function () {
    var nombre = document.getElementById('n-nombre').value.trim();
    var email = document.getElementById('n-email').value.trim();
    var password = document.getElementById('n-password').value;
    var rol = document.getElementById('n-rol').value;
    var conMercadeo = document.getElementById('n-mod-mercadeo').checked;

    if (!email || !password) { showToast('Correo y contraseña son requeridos', '#e74c3c'); return; }

    var session = await _sb.auth.getSession();
    var token = session.data.session.access_token;

    var res = await fetch(SUPABASE_URL + '/functions/v1/create-user-pqrs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ email: email, password: password, nombre: nombre, rol: rol, modulos: conMercadeo ? ['mercadeo'] : [] }),
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
