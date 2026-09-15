// Cliente Supabase compartido + utilidades comunes del panel PQRS.
// Mismo patrón que js/shared.js del panel de pedidos: cliente único global,
// anon key pública (protegida por RLS, no por secreto).

var SUPABASE_URL = 'https://kvfqcymeihglohkcckdp.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2ZnFjeW1laWhnbG9oa2Nja2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0OTQyNjksImV4cCI6MjEwNTA3MDI2OX0.kdutwtsqpUDC6v9r7FPWTSKLFW62SMGy_1F41Fcv8Mk';

var _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Escapa HTML antes de interpolar en innerHTML (mismo helper que shared.js del panel de pedidos).
function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '';
  var dt = new Date(d);
  if (isNaN(dt)) return '';
  return dt.toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtDateTime(d) {
  if (!d) return '';
  var dt = new Date(d);
  if (isNaN(dt)) return '';
  return dt.toLocaleString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, color) {
  var el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = color || '#1a5276';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.classList.remove('show'); }, 3200);
}

var EMPRESAS = [
  { sigla: 'PARCELAR', nombre: 'PARCELAR DE COLOMBIA SAS' },
  { sigla: 'GREEN', nombre: 'GREEN AGROSOLUCIONES DE COLOMBIA SAS' },
  { sigla: 'RESO', nombre: 'SOLUCIONES INTEGRALES RESO SAS' },
  { sigla: 'IASO', nombre: 'INSUMOS AGROPECUARIOS SOSTENIBLES SAS' },
  { sigla: 'IAS', nombre: 'INSUMOS AGROPECUARIOS DE LA SABANA SAS' },
];

function nombreEmpresa(sigla) {
  var e = EMPRESAS.filter(function (x) { return x.sigla === sigla; })[0];
  return e ? e.nombre : sigla;
}
