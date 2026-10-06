(async function () {
  await AUTH.authReady;
  var p = AUTH.getProfile();
  if (!p) return;
  document.getElementById('saludo').textContent = 'Hola, ' + (p.nombre || p.email);
})();
