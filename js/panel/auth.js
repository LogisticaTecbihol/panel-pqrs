// Módulo de autenticación del panel PQRS.
// Mismo patrón que js/auth.js del panel de pedidos, simplificado: solo 3 roles
// (admin/gestor/lector), sin concepto de módulos ni empresas por usuario (el
// equipo interno ve todas las empresas).
var AUTH = (function () {
  var _user = null;
  var _profile = null;
  var _ready = null;
  var _authResolve;
  var authReady = new Promise(function (resolve) { _authResolve = resolve; });

  function init() {
    if (_ready) return _ready;
    _ready = _init();
    return _ready;
  }

  function _withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; reject(new Error('auth-timeout')); }
      }, ms);
      promise.then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } }
      );
    });
  }

  function _showAuthError(msg) {
    var ov = document.getElementById('auth-error-overlay');
    if (ov) return;
    ov = document.createElement('div');
    ov.id = 'auth-error-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f0f4f8;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:"Segoe UI",sans-serif';
    ov.innerHTML =
      '<div style="font-size:2.4rem;margin-bottom:10px">☁️⚠️</div>' +
      '<h2 style="color:#2d3748;margin:0 0 8px;font-size:1.15rem">Sin conexión con la nube</h2>' +
      '<p style="color:#718096;max-width:420px;margin:0 0 18px;font-size:0.9rem">' + msg + '</p>' +
      '<button style="background:#1a5276;color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:700">🔄 Reintentar</button>';
    ov.querySelector('button').onclick = function () { location.reload(); };
    document.body.appendChild(ov);
    var main = document.getElementById('main');
    if (main) main.style.display = 'none';
  }

  async function _init() {
    var isLoginPage = location.pathname.endsWith('login.html');

    try {
      var sess;
      try {
        sess = await _withTimeout(_sb.auth.getSession(), 8000);
      } catch (e) {
        if (!isLoginPage) _showAuthError('No se pudo conectar con el servicio de autenticación. Revisa tu conexión e inténtalo de nuevo.');
        return;
      }

      if (!sess.data.session) {
        if (!isLoginPage) { location.replace('login.html'); return new Promise(function () {}); }
        return;
      }

      _user = sess.data.session.user;

      var res;
      try {
        res = await _withTimeout(
          _sb.from('usuarios_pqrs').select('*').eq('id', _user.id).eq('activo', true).single(),
          10000
        );
      } catch (e) {
        if (!isLoginPage) _showAuthError('No se pudieron cargar tus datos de usuario.');
        return;
      }

      if (res.error || !res.data) {
        try { await _withTimeout(_sb.auth.signOut(), 5000); } catch (e) {}
        if (!isLoginPage) { location.replace('login.html'); return new Promise(function () {}); }
        return;
      }

      _profile = res.data;

      if (isLoginPage) { location.replace('dashboard.html'); return new Promise(function () {}); }

      _renderAuthUI();
      _setupAuthListener();
    } finally {
      if (typeof _authResolve === 'function') _authResolve();
    }
  }

  function _renderAuthUI() {
    var el = document.getElementById('auth-info');
    if (!el) return;
    var name = _profile ? escHtml(_profile.nombre || _profile.email) : '';
    var rolLabel = _profile ? _profile.rol.charAt(0).toUpperCase() + _profile.rol.slice(1) : '';
    el.innerHTML =
      '<span class="auth-user">' + name + '</span>' +
      '<span class="auth-role-badge">' + escHtml(rolLabel) + '</span>' +
      '<button class="btn-secondary" onclick="AUTH.logout()">Cerrar sesión</button>';
    el.style.display = 'flex';

    document.querySelectorAll('.auth-edit-only').forEach(function (e) {
      e.style.display = canEdit() ? (e.dataset.display || 'inline-block') : 'none';
    });
    document.querySelectorAll('.auth-admin-only').forEach(function (e) {
      e.style.display = canManageUsers() ? (e.dataset.display || 'inline-block') : 'none';
    });
  }

  function _setupAuthListener() {
    _sb.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') location.replace('login.html');
    });
  }

  function logout() {
    _sb.auth.signOut().then(function () { location.replace('login.html'); });
  }

  function canEdit() { return !!_profile && (_profile.rol === 'admin' || _profile.rol === 'gestor'); }
  function isAdmin() { return !!_profile && _profile.rol === 'admin'; }
  function canManageUsers() { return isAdmin(); }
  function getProfile() { return _profile; }
  function getUser() { return _user; }

  return {
    init: init,
    authReady: authReady,
    logout: logout,
    canEdit: canEdit,
    isAdmin: isAdmin,
    canManageUsers: canManageUsers,
    getProfile: getProfile,
    getUser: getUser,
  };
})();

AUTH.init();
