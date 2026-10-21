// Módulo de autenticación del panel (PQRS + Mercadeo + SST).
// Mismo patrón que js/auth.js del panel de pedidos, simplificado: roles
// admin/gestor/lector (PQRS), 'mercadeo' (solo Tablero y CRM de Mercadeo) y 'sst'
// (solo el módulo SST), más usuarios_pqrs.modulos para habilitar un módulo extra sin
// cambiar de rol. El equipo interno ve todas las empresas (sin empresas por usuario).
//
// Módulos: 'pqrs' (rol admin/gestor/lector, o la clave en modulos: a un usuario Mercadeo/SST
// se le puede asignar y entonces solo LEE, migración 0029); 'mercadeo', 'sst' y 'encuestas'
// (admin o la clave en modulos; Encuestas es de solo lectura y no tiene rol propio,
// migración 0028). Cada página declara su módulo con
// <body data-modulo="..."> y los enlaces/tarjetas con data-modulo se ocultan
// si el usuario no lo tiene. La seguridad real es la RLS; esto es solo UX.
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

      if (isLoginPage) { location.replace('inicio.html'); return new Promise(function () {}); }

      // Guard de módulo: si la página exige uno que el usuario no tiene, va al inicio.
      var modPagina = document.body.getAttribute('data-modulo');
      if (modPagina && !hasModule(modPagina)) { location.replace('inicio.html'); return new Promise(function () {}); }

      _renderAuthUI();
      _setupAuthListener();
      _montarCampana();
    } finally {
      if (typeof _authResolve === 'function') _authResolve();
    }
  }

  function _renderAuthUI() {
    var el = document.getElementById('auth-info');
    if (!el) return;
    var name = _profile ? escHtml(_profile.nombre || _profile.email) : '';
    var rolLabel = _profile ? (_profile.rol === 'sst' ? 'SST' : _profile.rol.charAt(0).toUpperCase() + _profile.rol.slice(1)) : '';
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
    // Enlaces/tarjetas de un módulo que el usuario no tiene (el <body> también lleva data-modulo: se omite).
    document.querySelectorAll('[data-modulo]').forEach(function (e) {
      if (e === document.body) return;
      if (!hasModule(e.getAttribute('data-modulo'))) e.style.display = 'none';
    });
  }

  // ── Campanita de avisos del equipo de Mercadeo ──
  // Avisa cuando llega al Tablero una solicitud ya aprobada en Pedidos. Solo la ven quienes
  // tienen el módulo 'mercadeo'; cada quien lee únicamente las suyas (RLS). Se actualiza sola
  // por Realtime y, como respaldo, al volver a la pestaña.
  var _campana = { lista: [], abierta: false, canal: null };

  // Sonido del aviso (mismo tono que la campanita de panel-pedidos). El navegador solo deja
  // sonar a una página tras un clic o tecla del usuario en ESA carga (recargar lo reinicia):
  // un único <audio> se desbloquea en el primer gesto y, si el aviso llega antes, el mensaje
  // en pantalla lo dice en vez de fallar en silencio.
  var _sonido = { url: null, el: null, listo: false, bloqueados: 0 };
  var _GESTOS_SONIDO = ['click', 'keydown', 'touchend'];

  function _sonidoWav() {
    var sr = 44100, n = Math.floor(sr * 0.45), PI2 = 2 * Math.PI;
    var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var t = i / sr, s = 0;
      if (t < 0.18) {                                   // E6, decaimiento rápido tipo campana
        var e1 = Math.exp(-t * 18);
        s += Math.sin(PI2 * 1318 * t) * e1 * 0.40 + Math.sin(PI2 * 2636 * t) * e1 * 0.15 +
             Math.sin(PI2 * 3954 * t) * e1 * 0.06;
      }
      if (t >= 0.11) {                                  // A5, entra a los 0.11 s
        var t2 = t - 0.11, e2 = Math.exp(-t2 * 14);
        s += Math.sin(PI2 * 880 * t2) * e2 * 0.45 + Math.sin(PI2 * 1760 * t2) * e2 * 0.12 +
             Math.sin(PI2 * 2640 * t2) * e2 * 0.05;
      }
      v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767 | 0, true);
    }
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function _sonidoEl() {
    if (!_sonido.el) {
      if (!_sonido.url) _sonido.url = _sonidoWav();
      _sonido.el = new Audio(_sonido.url);
      _sonido.el.preload = 'auto';
    }
    return _sonido.el;
  }

  // Primer gesto real: deja el <audio> habilitado. Si el navegador lo rechaza, queda armado
  // para el siguiente gesto.
  function _sonidoDesbloquear() {
    if (_sonido.listo) return;
    try {
      var a = _sonidoEl();
      a.volume = 0;
      var listo = function () {
        _sonido.listo = true;
        if (a.volume === 0) { a.pause(); try { a.currentTime = 0; } catch (e) { /* sin efecto */ } }
        _GESTOS_SONIDO.forEach(function (g) { document.removeEventListener(g, _sonidoDesbloquear, true); });
      };
      var p = a.play();
      if (p && p.then) p.then(listo).catch(function () { /* sigue armado */ });
      else listo();
    } catch (e) { /* sin audio: solo queda el aviso visual */ }
  }

  // Devuelve una promesa: true si sonó, false si el navegador lo bloqueó.
  function _sonidoReproducir() {
    try {
      var a = _sonidoEl();
      a.volume = 0.5;
      try { a.currentTime = 0; } catch (e) { /* sin efecto */ }
      var p = a.play();
      if (p && p.then) return p.then(function () { return true; }, function () { return false; });
      return Promise.resolve(true);
    } catch (e) { return Promise.resolve(false); }
  }

  function _montarCampana() {
    if (!hasModule('mercadeo')) return;
    var cont = document.getElementById('auth-info');
    if (!cont || document.getElementById('mk-bell')) return;
    var wrap = document.createElement('div');
    wrap.id = 'mk-bell';
    wrap.className = 'mk-bell';
    wrap.innerHTML =
      '<button type="button" class="mk-bell-btn" id="mk-bell-btn" aria-label="Avisos" aria-haspopup="true" aria-expanded="false">🔔' +
      '<span class="mk-bell-badge" id="mk-bell-badge" style="display:none">0</span></button>' +
      '<div class="mk-bell-panel" id="mk-bell-panel" style="display:none" role="menu"></div>';
    cont.insertBefore(wrap, cont.firstChild);

    document.getElementById('mk-bell-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      _campanaAbrir(!_campana.abierta);
    });
    document.getElementById('mk-bell-panel').addEventListener('click', function (e) {
      e.stopPropagation();
      var b = e.target.closest ? e.target.closest('[data-notif]') : null;
      if (b) { _campanaAbrirAviso(b.getAttribute('data-notif')); return; }
      if (e.target.closest && e.target.closest('[data-notif-todas]')) _campanaMarcarTodas();
    });
    document.addEventListener('click', function () { if (_campana.abierta) _campanaAbrir(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _campana.abierta) _campanaAbrir(false); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) _campanaCargar(); });
    _GESTOS_SONIDO.forEach(function (g) { document.addEventListener(g, _sonidoDesbloquear, true); });

    _campanaCargar();
    try {
      _campana.canal = _sb.channel('mk-notif-' + _user.id).on('postgres_changes',
        { event: '*', schema: 'public', table: 'mercadeo_notificaciones', filter: 'para_usuario_id=eq.' + _user.id },
        function (payload) {
          _campanaCargar();
          if (payload && payload.eventType === 'INSERT' && payload.new) {
            var titulo = payload.new.titulo || 'Nuevo aviso';
            _sonidoReproducir().then(function (sono) {
              if (!sono) {
                _sonido.bloqueados++;
                if (_sonido.bloqueados === 1) titulo += ' — haz clic en la página para activar el sonido';
              }
              if (typeof showToast === 'function') showToast(titulo);
            });
          }
        }).subscribe();
    } catch (e) { /* sin Realtime: queda la recarga al volver a la pestaña */ }
  }

  async function _campanaCargar() {
    var r = await _sb.from('mercadeo_notificaciones')
      .select('id, tipo, tarea_id, evento_id, titulo, mensaje, leida, creado_en')
      .order('creado_en', { ascending: false }).limit(30);
    if (r.error) return;
    _campana.lista = r.data || [];
    _campanaPintar();
  }

  function _campanaPintar() {
    var sinLeer = _campana.lista.filter(function (n) { return !n.leida; }).length;
    var badge = document.getElementById('mk-bell-badge');
    if (!badge) return;
    badge.textContent = sinLeer > 99 ? '99+' : String(sinLeer);
    badge.style.display = sinLeer ? '' : 'none';
    var panel = document.getElementById('mk-bell-panel');
    var items = _campana.lista.map(function (n) {
      return '<button type="button" class="mk-bell-item' + (n.leida ? '' : ' nuevo') + '" role="menuitem" data-notif="' + escHtml(n.id) + '">' +
        '<span class="t">' + escHtml(n.titulo) + '</span>' +
        (n.mensaje ? '<span class="m">' + escHtml(n.mensaje) + '</span>' : '') +
        '<span class="f">' + escHtml(fmtDateTime(n.creado_en)) + '</span></button>';
    }).join('');
    panel.innerHTML =
      '<div class="mk-bell-head"><strong>Avisos</strong>' +
      (sinLeer ? '<button type="button" class="mk-bell-todas" data-notif-todas="1">Marcar todas como leídas</button>' : '') + '</div>' +
      (items || '<div class="mk-bell-vacio">No tienes avisos.</div>');
  }

  function _campanaAbrir(abrir) {
    _campana.abierta = abrir;
    document.getElementById('mk-bell-panel').style.display = abrir ? '' : 'none';
    document.getElementById('mk-bell-btn').setAttribute('aria-expanded', abrir ? 'true' : 'false');
  }

  async function _campanaAbrirAviso(id) {
    var n = _campana.lista.filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    if (!n.leida) {
      n.leida = true;
      _campanaPintar();
      await _sb.from('mercadeo_notificaciones').update({ leida: true, leida_en: new Date().toISOString() }).eq('id', id);
    }
    _campanaAbrir(false);
    if (n.evento_id) location.href = 'eventos.html?evento=' + encodeURIComponent(n.evento_id);
    else if (n.tarea_id) location.href = 'mercadeo.html?tarea=' + encodeURIComponent(n.tarea_id);
  }

  async function _campanaMarcarTodas() {
    var ids = _campana.lista.filter(function (n) { return !n.leida; }).map(function (n) { return n.id; });
    if (!ids.length) return;
    _campana.lista.forEach(function (n) { n.leida = true; });
    _campanaPintar();
    await _sb.from('mercadeo_notificaciones').update({ leida: true, leida_en: new Date().toISOString() }).in('id', ids);
  }

  function _setupAuthListener() {
    _sb.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') location.replace('login.html');
    });
  }

  function logout() {
    _sb.auth.signOut().then(function () { location.replace('login.html'); });
  }

  // canEdit() = escritura sobre PQRS: solo admin y gestor. El módulo 'pqrs' asignado a otro rol
  // (mercadeo, sst) es solo lectura.
  function canEdit() { return !!_profile && (_profile.rol === 'admin' || _profile.rol === 'gestor'); }
  function isAdmin() { return !!_profile && _profile.rol === 'admin'; }
  function canManageUsers() { return isAdmin(); }
  function getProfile() { return _profile; }
  function getUser() { return _user; }

  var ROLES_PQRS = ['admin', 'gestor', 'lector'];
  // ¿El usuario tiene el módulo? (admin: todos). 'pqrs' además lo traen los roles gestor y lector
  // sin guardarse en modulos; igual que user_has_module_pqrs('pqrs') en la BD.
  function hasModule(key) {
    if (!_profile) return false;
    if (_profile.rol === 'admin') return true;
    if (key === 'pqrs' && ROLES_PQRS.indexOf(_profile.rol) >= 0) return true;
    return (_profile.modulos || []).indexOf(key) >= 0;
  }

  return {
    init: init,
    authReady: authReady,
    logout: logout,
    canEdit: canEdit,
    isAdmin: isAdmin,
    canManageUsers: canManageUsers,
    hasModule: hasModule,
    getProfile: getProfile,
    getUser: getUser,
  };
})();

AUTH.init();
