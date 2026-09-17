#!/usr/bin/env node
/**
 * Importación de un solo uso del histórico de un Google Form (PQRS + Encuesta de
 * Satisfacción) hacia Supabase. NO es parte de la app desplegada -- se corre una vez
 * localmente, con la service_role key del proyecto.
 *
 * Uso:
 *   SUPABASE_URL=https://kvfqcymeihglohkcckdp.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role key del proyecto panel-pqrs> \
 *   node scripts/importar_historico_pqrs.mjs GREEN ./exports/green.csv
 *
 * El CSV es el exportado desde Google Sheets (Archivo > Descargar > Valores separados
 * por comas) de la hoja de respuestas de ESE Form. Trae mezcladas las dos ramas
 * (PQRS y Encuesta de Satisfacción) -- el script las separa por la columna
 * "Su solicitud es: (seleccione al que corresponda)".
 *
 * Dependencias: npm install (ver package.json en esta misma carpeta).
 */

import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const [, , empresaSigla, csvPath] = process.argv;
const EMPRESAS_VALIDAS = ['PARCELAR', 'GREEN', 'RESO', 'IASO', 'IAS'];

if (!empresaSigla || !csvPath || !EMPRESAS_VALIDAS.includes(empresaSigla)) {
  console.error('Uso: node importar_historico_pqrs.mjs <PARCELAR|GREEN|RESO|IASO|IAS> <ruta-al-csv>');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan las variables de entorno SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Mismos títulos de pregunta que google-apps-script/ingest-template.gs -- si el Form
// tiene una redacción distinta, ajustar aquí también.
const COL = {
  timestamp: 'Marca temporal',
  branch: 'Su solicitud es: (seleccione al que corresponda)',
  branchEncuesta: 'Encuesta de Satisfacción del servicio',

  nombreCompletoPrefijo: 'Nombre Completo', // por prefijo: varía "Nombre Completo" / "Nombre Completo o Razón Social"
  contacto: 'Correo electrónico o Celular (Para dar respuesta y seguimiento a su solicitud)',
  tipoSolicitud: 'Tipo de solicitud',
  fechaEvento: 'Fecha del evento de situación',
  areaRelacionada: 'Área o servicio relacionado',
  descripcion: 'Descripción detallada de la situación',
  urgencia: 'Nivel de urgencia o impacto',
  adjuntos: '¿Desea adjuntar documentos o evidencia?',
  deseaRespuesta: '¿Desea recibir respuesta a su solicitud?',
  comentariosPqrs: 'Comentarios adicionales',
  identificacion: 'Identificación (NIT/Cédula)',
  referenciaPedido: 'N° de pedido, factura o remisión relacionado',
  productoLote: 'Producto y/o lote relacionado',
  ciudadDepartamento: 'Ciudad/Departamento',

  municipio: 'Municipio donde reside',
  asesorNombre: 'Nombre del asesor o persona que le vendió el producto',
  canalAdquisicion: '¿Dónde adquirió nuestros productos?',
  canalAdquisicionOtro: 'Si su respuesta fue "Otro" indique cual',
  califCalidadProducto: '¿Cómo califica la calidad de los productos recibidos?',
  califAsesorTecnico: '¿Cómo califica la atención, conocimiento técnico y acompañamiento brindado por nuestro asesor técnico comercial?',
  califServicioLogistica: '¿Cómo califica la atención y el servicio prestado por nuestro equipo, logística y/o distribuidor?',
  califTiemposRespuesta: '¿Qué tan satisfecho está con los tiempos de respuesta a sus solicitudes o pedidos?',
  califCalidadPrecio: '¿Cómo considera buena la relación calidad-precio de nuestros productos?',
  comentariosEncuesta: 'Comentarios o sugerencias adicionales',
};

// Normaliza espacios (colapsa espacios/saltos de línea múltiples y recorta los
// extremos) -- los CSV reales traen encabezados con espacios extra al inicio/fin
// que no se ven a simple vista en el Form.
function normalizarEspacios(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Construye un lookup por título normalizado, ya que las claves del objeto
// `row` (tal como las entrega csv-parse) son el encabezado tal cual del CSV.
function normalizarFila(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    out[normalizarEspacios(key)] = row[key];
  }
  return out;
}

function getVal(rowNorm, titulo) {
  return rowNorm[normalizarEspacios(titulo)];
}

function getValPrefijo(rowNorm, prefijo) {
  const prefijoNorm = normalizarEspacios(prefijo);
  const key = Object.keys(rowNorm).find((k) => k.indexOf(prefijoNorm) === 0);
  return key ? rowNorm[key] : undefined;
}

function parseTimestamp(raw) {
  if (!raw) return new Date();
  // Formato real de "Marca temporal" en la exportación de Google Forms:
  // "2025/11/24 8:52:58 a.m. GMT-5" (AM/PM en español + offset explícito).
  const m = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(a\.\s*m\.|p\.\s*m\.|am|pm)\.?\s*GMT([+-]\d+)/i);
  if (m) {
    let [, yyyy, mm, dd, hh, mi, ss, ampm, offset] = m;
    hh = parseInt(hh, 10);
    const isPM = /p/i.test(ampm);
    if (isPM && hh !== 12) hh += 12;
    if (!isPM && hh === 12) hh = 0;
    const utcMs = Date.UTC(+yyyy, +mm - 1, +dd, hh - parseInt(offset, 10), +mi, +ss);
    return new Date(utcMs);
  }
  const d = new Date(raw);
  return isNaN(d) ? new Date() : d;
}

function extraerLinksDrive(texto) {
  if (!texto) return [];
  // Google separa varios adjuntos con ";" SIN espacio -- un regex \S+ los uniría
  // en un solo "link" gigante, así que se separa primero por ; o , y luego se
  // valida cada trozo.
  return texto
    .split(/[;,]\s*/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/drive\.google\.com\//.test(s))
    .map((url) => {
      const idMatch = url.match(/[-\w]{25,}/);
      return { drive_file_id: idMatch ? idMatch[0] : null, nombre: null, tipo_mime: null, tamano_bytes: null, url };
    });
}

function mapAreaRelacionada(valor) {
  const MAP = {
    Producción: 'Produccion',
    'Servicio al cliente': 'Servicio al cliente',
    Ventas: 'Ventas',
    'Estado del producto': 'Estado del producto',
    'Logistica (Entregas, despachos y el personal de entrega)': 'Logistica',
    'Logística (Entregas, despachos y el personal de entrega)': 'Logistica',
    'Pos venta': 'Pos venta',
  };
  return MAP[valor] || 'Otro';
}

function mapUrgencia(valor) {
  if (!valor) return 'MEDIO';
  const v = valor.toUpperCase();
  if (v.startsWith('ALTO')) return 'ALTO';
  if (v.startsWith('MEDIO')) return 'MEDIO';
  return 'BAJA';
}

function mapCanal(valor) {
  if (!valor) return 'Otro';
  if (valor.startsWith('Directamente con')) return 'Directo';
  if (valor.startsWith('A través de un distribuidor')) return 'Distribuidor autorizado';
  if (valor.startsWith('En una tienda agropecuaria')) return 'Tienda agropecuaria local';
  return 'Otro';
}

async function importarPqrs(rowNorm, fecha) {
  const { data: folio, error: folioError } = await sb.rpc('generar_consecutivo_pqrs', { p_empresa_sigla: empresaSigla });
  if (folioError) throw folioError;

  const { data: pqrsRow, error: insertError } = await sb
    .from('pqrs')
    .insert({
      folio,
      empresa_sigla: empresaSigla,
      nombre_completo: getValPrefijo(rowNorm, COL.nombreCompletoPrefijo) || null,
      contacto: getVal(rowNorm, COL.contacto) || '(sin contacto registrado)',
      tipo_solicitud: getVal(rowNorm, COL.tipoSolicitud) || 'Petición',
      fecha_evento: getVal(rowNorm, COL.fechaEvento) || null,
      area_relacionada: mapAreaRelacionada(getVal(rowNorm, COL.areaRelacionada)),
      descripcion: getVal(rowNorm, COL.descripcion) || '(sin descripción)',
      urgencia: mapUrgencia(getVal(rowNorm, COL.urgencia)),
      desea_respuesta: getVal(rowNorm, COL.deseaRespuesta) === 'Sí',
      comentarios_adicionales: getVal(rowNorm, COL.comentariosPqrs) || null,
      identificacion_cliente: getVal(rowNorm, COL.identificacion) || null,
      referencia_pedido: getVal(rowNorm, COL.referenciaPedido) || null,
      producto_lote: getVal(rowNorm, COL.productoLote) || null,
      ciudad_departamento: getVal(rowNorm, COL.ciudadDepartamento) || null,
      estado: 'Cerrado', // histórico: se asume ya atendido por fuera del sistema
      es_historico: true,
      creado_en: fecha.toISOString(),
    })
    .select('id, folio')
    .single();
  if (insertError) throw insertError;

  const adjuntos = extraerLinksDrive(getVal(rowNorm, COL.adjuntos));
  if (adjuntos.length) {
    const { error } = await sb.from('pqrs_adjuntos').insert(
      adjuntos.map((a) => ({
        pqrs_id: pqrsRow.id,
        origen: 'cliente_drive',
        drive_file_id: a.drive_file_id,
        drive_url: a.url,
      }))
    );
    if (error) throw error;
  }

  const { error: bitError } = await sb.from('pqrs_bitacora').insert({
    pqrs_id: pqrsRow.id,
    tipo_evento: 'creacion',
    detalle: { origen: 'importacion_historica' },
    creado_en: fecha.toISOString(),
  });
  if (bitError) throw bitError;

  return pqrsRow.folio;
}

async function importarEncuesta(rowNorm, fecha) {
  const canal = mapCanal(getVal(rowNorm, COL.canalAdquisicion));
  const { error } = await sb.from('encuestas_satisfaccion').insert({
    empresa_sigla: empresaSigla,
    municipio: getVal(rowNorm, COL.municipio) || '(sin municipio)',
    asesor_nombre: getVal(rowNorm, COL.asesorNombre) || null,
    canal_adquisicion: canal,
    canal_adquisicion_otro: canal === 'Otro' ? getVal(rowNorm, COL.canalAdquisicionOtro) || null : null,
    calificacion_calidad_producto: parseInt(getVal(rowNorm, COL.califCalidadProducto), 10) || 3,
    calificacion_atencion_asesor_tecnico: parseInt(getVal(rowNorm, COL.califAsesorTecnico), 10) || 3,
    calificacion_atencion_servicio_logistica: parseInt(getVal(rowNorm, COL.califServicioLogistica), 10) || 3,
    calificacion_tiempos_respuesta: parseInt(getVal(rowNorm, COL.califTiemposRespuesta), 10) || 3,
    calificacion_relacion_calidad_precio: parseInt(getVal(rowNorm, COL.califCalidadPrecio), 10) || 3,
    calificacion_satisfaccion_general: parseInt(getValPrefijo(rowNorm, 'En general, qué tan satisfecho está con la experiencia'), 10) || 3,
    comentarios_adicionales: getVal(rowNorm, COL.comentariosEncuesta) || null,
    creado_en: fecha.toISOString(),
  });
  if (error) throw error;
}

async function main() {
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });

  const conFecha = records.map((row) => {
    const rowNorm = normalizarFila(row);
    return { rowNorm, fecha: parseTimestamp(getVal(rowNorm, COL.timestamp)) };
  });
  conFecha.sort((a, b) => a.fecha - b.fecha);

  let pqrsOk = 0, pqrsError = 0, encuestaOk = 0, encuestaError = 0;

  for (const { rowNorm, fecha } of conFecha) {
    const esEncuesta = getVal(rowNorm, COL.branch) === COL.branchEncuesta;
    try {
      if (esEncuesta) {
        await importarEncuesta(rowNorm, fecha);
        encuestaOk++;
      } else {
        const folio = await importarPqrs(rowNorm, fecha);
        pqrsOk++;
        console.log(`  PQRS importado: ${folio} (${fecha.toISOString().slice(0, 10)})`);
      }
    } catch (err) {
      if (esEncuesta) encuestaError++; else pqrsError++;
      console.error(`  Error en fila (${fecha.toISOString()}):`, err.message || err);
    }
  }

  console.log('\n── Resumen ──');
  console.log(`Total filas leídas: ${records.length}`);
  console.log(`PQRS importados: ${pqrsOk}  (errores: ${pqrsError})`);
  console.log(`Encuestas importadas: ${encuestaOk}  (errores: ${encuestaError})`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
