// Color por responsable del equipo de Mercadeo, compartido por el Tablero y los Indicadores.
// Paleta fija de 12 tonos, ordenada para que los primeros queden lo más separados posible.
// Cada persona del equipo toma el tono que le toca por su posición al ordenar los ids (los inactivos conservan su
// casilla, así desactivar a alguien no cambia los colores de los demás); con más de 12 personas los tonos se repiten.
// Los inactivos y quien no está en el equipo no tienen color (se ven en gris).
var EQUIPO_COLOR = (function () {
  var HUES = [220, 15, 140, 320, 270, 185, 50, 355, 85, 300, 165, 240];
  var tonos = {};

  // equipo: filas de list_equipo_mercadeo() ({ id, nombre, activo }).
  function asignar(equipo) {
    tonos = {};
    equipo.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; }).forEach(function (u, i) {
      if (u.activo) tonos[u.id] = HUES[i % HUES.length];
    });
  }

  function tiene(id) { return tonos[id] !== undefined; }

  // Variables CSS del color de una persona: --uc sólido (avatar, punto), --ut tinte de fondo, --ub borde del tinte.
  function estilo(id) {
    var h = tonos[id];
    return h === undefined ? '' : '--uc:hsl(' + h + ',62%,31%);--ut:hsl(' + h + ',80%,91%);--ub:hsl(' + h + ',55%,74%)';
  }

  return { asignar: asignar, tiene: tiene, estilo: estilo };
})();
