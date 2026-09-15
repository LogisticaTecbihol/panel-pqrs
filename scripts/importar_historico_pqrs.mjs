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

  nombreCompleto: 'Nombre Completo',
  contacto: 'Correo electrónico o Celular (Para dar respuesta y seguimiento a su solicitud)',
  tipoSolicitud: 'Tipo de solicitud',
  fechaEvento: 'Fecha del evento o situación',
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

function parseTimestamp(raw) {
  if (!raw) return new Date();
  let d = new Date(raw);
  if (!isNaN(d)) return d;
  // Fallback: formato "DD/MM/YYYY HH:mm:ss" (Sheets en configuración regional Colombia)
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    return new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mi}:${ss}`);
  }
  return new Date();
}

function extraerLinksDrive(texto) {
  if (!texto) return [];
  const urls = texto.match(/https?:\/\/drive\.google\.com\/\S+/g) || [];
  return urls.map((url) => {
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

function buscarColumnaSatisfaccionGeneral(headers) {
  return headers.find((h) => h.startsWith('En general, qué tan satisfecho está con la experiencia'));
}

async function importarPqrs(row, fecha) {
  const { data: folio, error: folioError } = await sb.rpc('generar_consecutivo_pqrs', { p_empresa_sigla: empresaSigla });
  if (folioError) throw folioError;

  const { data: pqrsRow, error: insertError } = await sb
    .from('pqrs')
    .insert({
      folio,
      empresa_sigla: empresaSigla,
      nombre_completo: row[COL.nombreCompleto] || null,
      contacto: row[COL.contacto] || '(sin contacto registrado)',
      tipo_solicitud: row[COL.tipoSolicitud] || 'Peticion',
      fecha_evento: row[COL.fechaEvento] || null,
      area_relacionada: mapAreaRelacionada(row[COL.areaRelacionada]),
      descripcion: row[COL.descripcion] || '(sin descripción)',
      urgencia: mapUrgencia(row[COL.urgencia]),
      desea_respuesta: row[COL.deseaRespuesta] === 'Sí',
      comentarios_adicionales: row[COL.comentariosPqrs] || null,
      estado: 'Cerrado', // histórico: se asume ya atendido por fuera del sistema
      creado_en: fecha.toISOString(),
    })
    .select('id, folio')
    .single();
  if (insertError) throw insertError;

  const adjuntos = extraerLinksDrive(row[COL.adjuntos]);
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

async function importarEncuesta(row, fecha, colSatisfaccionGeneral) {
  const canal = mapCanal(row[COL.canalAdquisicion]);
  const { error } = await sb.from('encuestas_satisfaccion').insert({
    empresa_sigla: empresaSigla,
    municipio: row[COL.municipio] || '(sin municipio)',
    asesor_nombre: row[COL.asesorNombre] || null,
    canal_adquisicion: canal,
    canal_adquisicion_otro: canal === 'Otro' ? row[COL.canalAdquisicionOtro] || null : null,
    calificacion_calidad_producto: parseInt(row[COL.califCalidadProducto], 10) || 3,
    calificacion_atencion_asesor_tecnico: parseInt(row[COL.califAsesorTecnico], 10) || 3,
    calificacion_atencion_servicio_logistica: parseInt(row[COL.califServicioLogistica], 10) || 3,
    calificacion_tiempos_respuesta: parseInt(row[COL.califTiemposRespuesta], 10) || 3,
    calificacion_relacion_calidad_precio: parseInt(row[COL.califCalidadPrecio], 10) || 3,
    calificacion_satisfaccion_general: parseInt(row[colSatisfaccionGeneral], 10) || 3,
    comentarios_adicionales: row[COL.comentariosEncuesta] || null,
    creado_en: fecha.toISOString(),
  });
  if (error) throw error;
}

async function main() {
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  const headers = Object.keys(records[0] || {});
  const colSatisfaccionGeneral = buscarColumnaSatisfaccionGeneral(headers);

  const conFecha = records.map((row) => ({ row, fecha: parseTimestamp(row[COL.timestamp]) }));
  conFecha.sort((a, b) => a.fecha - b.fecha);

  let pqrsOk = 0, pqrsError = 0, encuestaOk = 0, encuestaError = 0;

  for (const { row, fecha } of conFecha) {
    const esEncuesta = row[COL.branch] === COL.branchEncuesta;
    try {
      if (esEncuesta) {
        await importarEncuesta(row, fecha, colSatisfaccionGeneral);
        encuestaOk++;
      } else {
        const folio = await importarPqrs(row, fecha);
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
