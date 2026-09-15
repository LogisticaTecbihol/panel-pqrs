(async function () {
  await AUTH.authReady;

  if (!AUTH.canManageUsers()) {
    document.getElementById('no-access').style.display = '';
    return;
  }
  document.getElementById('content').style.display = '';

  async function cargar() {
    var res = await _sb.from('usuarios_pqrs').select('*').order('created_at');
    if (res.error) { showToast('Error al cargar usuarios: ' + res.error.message, '#e74c3c'); return; }
    document.getElementById('tbody').innerHTML = res.data.map(function (u) {
      return '<tr>' +
        '<td>' + escHtml(u.nombre || '') + '</td>' +
        '<td>' + escHtml(u.email) + '</td>' +
        '<td>' + escHtml(u.rol) + '</td>' +
        '<td>' + (u.activo ? 'Sí' : 'No') + '</td>' +
        '<td><button class="btn-edit btn-toggle-activo" data-id="' + u.id + '" data-activo="' + u.activo + '">' + (u.activo ? 'Desactivar' : 'Activar') + '</button></td>' +
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
      body: JSON.stringify({ email: email, password: password, nombre: nombre, rol: rol }),
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
