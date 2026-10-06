// Modales accesibles para las páginas de Mercadeo (.overlay > .modal-box).
// Maneja: foco al abrir y devolución al cerrar, Escape, clic en el fondo (solo si el clic
// empezó y terminó en el fondo, para no cerrar al soltar un arrastre de texto) y trampa de
// foco con Tab. Los modales apilados (p. ej. cierre sobre detalle) cierran de arriba hacia abajo.
// Cada .overlay debe llevar role="dialog" aria-modal="true" aria-labelledby="<id del título>".
var MODAL = (function () {
  var stack = [];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var api = { onClose: null };

  function el(id) { return document.getElementById(id); }
  function indexOf(id) {
    for (var i = 0; i < stack.length; i++) if (stack[i].id === id) return i;
    return -1;
  }

  api.open = function (id, focusId) {
    var o = el(id);
    if (!o || indexOf(id) >= 0) return;
    stack.push({ id: id, opener: document.activeElement });
    o.classList.add('show');
    var target = (focusId && el(focusId)) || o.querySelector(FOCUSABLE);
    setTimeout(function () { if (target) target.focus(); }, 30);
  };

  api.close = function (id) {
    var o = el(id);
    if (!o) return;
    o.classList.remove('show');
    var i = indexOf(id);
    if (i >= 0) {
      var s = stack.splice(i, 1)[0];
      if (s.opener && typeof s.opener.focus === 'function' && document.contains(s.opener)) s.opener.focus();
    }
    if (typeof api.onClose === 'function') api.onClose(id);
  };

  api.top = function () { return stack.length ? stack[stack.length - 1].id : null; };
  api.isOpen = function (id) { return indexOf(id) >= 0; };

  document.addEventListener('keydown', function (e) {
    var t = api.top();
    if (!t) return;
    if (e.key === 'Escape') { e.preventDefault(); api.close(t); return; }
    if (e.key === 'Tab') {
      var items = [].slice.call(el(t).querySelectorAll(FOCUSABLE)).filter(function (n) { return n.offsetParent !== null; });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  var downEnFondo = false;
  document.addEventListener('mousedown', function (e) {
    var t = api.top();
    downEnFondo = !!t && e.target === el(t);
  });
  document.addEventListener('click', function (e) {
    var t = api.top();
    if (downEnFondo && t && e.target === el(t)) api.close(t);
    downEnFondo = false;
  });

  return api;
})();
