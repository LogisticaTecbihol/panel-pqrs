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

// ── Utilidades del área de Mercadeo ───────────────────────────

// Hoy en hora LOCAL como 'YYYY-MM-DD' (toISOString() usa UTC y adelanta el día en Colombia por la noche).
function today() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Fecha 'YYYY-MM-DD' (columna date) -> Date local a medianoche. new Date('2026-09-15') se interpreta
// como UTC y en Colombia mostraría el día anterior; por eso fmtDate() no sirve para columnas date.
function parseDateOnly(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function fmtDateOnly(s) {
  if (!s) return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : fmtDate(s);
}

// Días calendario entre dos fechas 'YYYY-MM-DD' (b - a), o null si alguna no es válida.
function diasEntre(a, b) {
  var da = parseDateOnly(a), db = parseDateOnly(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function fmtMoney(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
}

// Convierte lo que se digita en un campo de monto a número, entendiendo el formato colombiano
// (puntos de miles, coma decimal): '3.500.000' -> 3500000, '1.234,56' -> 1234.56, '$ 500000' -> 500000.
// Devuelve NaN si no es un número. (El CRM original usaba .replace(/[^\d.]/g,'') y guardaba 0 con '3.500.000'.)
function parseMonto(txt) {
  var s = String(txt === null || txt === undefined ? '' : txt).replace(/[$\s]/g, '');
  if (!s || !/^[\d.,]+$/.test(s)) return NaN;
  var hasDot = s.indexOf('.') >= 0, hasComma = s.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    // El último separador es el decimal; el otro es de miles.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

// Minúsculas sin tildes, para búsquedas.
function norm(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Mensaje legible para un error de Supabase/PostgREST. Los RAISE EXCEPTION de los triggers
// (reglas de negocio, en español) se muestran tal cual.
function errMsg(error) {
  if (!error) return 'Error desconocido';
  var m = error.message || String(error);
  if (error.code === '42501' || /row-level security/i.test(m)) return 'No tienes permiso para esta acción.';
  if (error.code === '23505') return 'Ya existe un registro igual (duplicado).';
  if (error.code === '23503') return 'No se puede completar: hay registros relacionados que lo impiden.';
  return m;
}
