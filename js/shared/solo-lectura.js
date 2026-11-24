// Modo «solo lectura» de las páginas de Mercadeo (Tablero, CRM, Eventos, Indicadores).
//
// Quien tiene el módulo 'mercadeo' con el rol 'lector' (AUTH.soloLecturaMercadeo(), migración 0043) ve todo pero no
// gestiona nada. La seguridad real es la RLS (las policies de escritura exigen user_can_manage_mercadeo()); esto solo
// evita que vea botones que terminarían en un error:
//  1. Un aviso fijo arriba de la página y la clase `mk-solo-lectura` en <body>.
//  2. Se oculta todo elemento con data-act que NO esté en la lista de acciones de consulta de la página (lista blanca:
//     si mañana se agrega un botón de escritura nuevo, queda oculto sin tocar este archivo). Los estilos se generan una
//     sola vez, así que también cubren lo que la página dibuja después.
//  3. Los campos de los modales (.overlay) se deshabilitan y los de subida de archivos se ocultan. Un campo que deba
//     seguir activo (p. ej. el buscador de asistentes) lleva data-lectura.
//  4. No se pueden arrastrar las tarjetas del Tablero.
// Cargar DESPUÉS de auth.js. En quien sí gestiona no hace nada.
(function () {
  // Acciones (data-act) que solo consultan: abrir, cerrar, filtrar, navegar, ver PDF/adjuntos/impacto.
  var SEGURAS = {
    comun: ['reintentar', 'limpiar', 'cerrar-modal'],
    'mercadeo.html': ['ley-resp', 'vista-compacta', 'plegar-aprobar', 'grupo-plegar', 'tarea-abrir', 'evento-pdf', 'adj-abrir', 'rechazo-cerrar'],
    'eventos.html': ['paso-ir', 'paso-ant', 'paso-sig', 'evento-abrir', 'evento-pdf', 'evento-impacto', 'impacto-cerrar',
      'evento-asistentes', 'chk-adj-abrir', 'adj-abrir', 'motivo-cerrar'],
    'crm.html': ['tab', 'leads-limpiar', 'quitar-filtro-actividad', 'lead-ver', 'act-ver-leads', 'pr-ver'],
    'indicadores.html': ['preset', 'actualizar'],
  };
  var SELECTOR_CAMPOS = '.overlay input, .overlay select, .overlay textarea';

  async function iniciar() {
    await AUTH.authReady;
    if (!AUTH.getProfile() || !AUTH.soloLecturaMercadeo()) return;

    var pagina = (location.pathname.split('/').pop() || '').toLowerCase();
    var seguras = SEGURAS.comun.concat(SEGURAS[pagina] || []);
    document.body.classList.add('mk-solo-lectura');

    // 2. Ocultar lo que no es de consulta.
    var st = document.createElement('style');
    st.textContent = 'body.mk-solo-lectura [data-act]' + seguras.map(function (a) { return ':not([data-act="' + a + '"])'; }).join('') +
      '{display:none !important}';
    document.head.appendChild(st);
    // Respaldo: una acción de escritura que llegara a dispararse (p. ej. con .click() desde la consola) no se procesa.
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (el && seguras.indexOf(el.getAttribute('data-act')) < 0) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    // 4. Las tarjetas del Tablero no se arrastran (frena también el manejador de la página, que dejaría un arrastre a medias).
    document.addEventListener('dragstart', function (e) {
      if (e.target && e.target.closest && e.target.closest('.kb-card')) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // 1. Aviso.
    var main = document.getElementById('main');
    if (main) {
      var aviso = document.createElement('div');
      aviso.className = 'mk-lectura-banner';
      aviso.setAttribute('role', 'note');
      aviso.innerHTML = '<strong>👁 Acceso de solo lectura.</strong> Puedes consultar el Tablero, el CRM, los Eventos y los Indicadores, ' +
        'pero no crear, mover ni modificar nada.';
      main.insertBefore(aviso, main.firstChild);
    }

    // 3. Campos de los modales: se revisan al cargar y cada vez que la página dibuja o cambia algo.
    // Sin requestAnimationFrame: no corre con la pestaña oculta y dejaría los campos activos un instante. El observador
    // agrupa los cambios y solo se vuelve a disparar si algo se deshabilita, así que no entra en ciclo.
    function bloquear() {
      [].forEach.call(document.querySelectorAll(SELECTOR_CAMPOS), function (c) {
        if (c.hasAttribute('data-lectura')) return;
        if (!c.disabled) c.disabled = true;
        if (c.type === 'file') {
          // Sin campo de subida, tampoco su etiqueta ni su ayuda.
          var et = c.closest('label') || (c.id ? document.querySelector('label[for="' + c.id + '"]') : null);
          if (et) et.style.display = 'none';
          var ayuda = c.nextElementSibling;
          if (ayuda && ayuda.classList.contains('ef-help')) ayuda.style.display = 'none';
          c.style.display = 'none';
        }
      });
    }
    bloquear();
    new MutationObserver(bloquear).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  }

  iniciar();
})();
