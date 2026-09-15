/**
 * Plantilla del script puente: Google Form (PQRS + Encuesta de Satisfacción) -> Supabase.
 *
 * CÓMO USAR (una copia por cada uno de los 5 Forms):
 *   1. Abre el Form en Google Forms -> menú "⋮" (o Extensiones) -> Apps Script.
 *   2. Borra el contenido de Code.gs y pega este archivo completo.
 *   3. Cambia la constante EMPRESA_SIGLA más abajo por la sigla de ESTE Form
 *      ('PARCELAR' | 'GREEN' | 'RESO' | 'IASO' | 'IAS').
 *   4. Guarda el secreto del puente como Script Property (NO lo dejes en el código):
 *      Editor de Apps Script -> ⚙️ Configuración del proyecto -> Propiedades de secuencia
 *      de comandos -> agregar "INGEST_SHARED_SECRET" = <el mismo valor configurado como
 *      secreto del Edge Function ingest-formulario en Supabase>.
 *   5. Ejecuta la función `crearTrigger` una vez (seleccionarla arriba y pulsar ▶ Ejecutar)
 *      para instalar el trigger onFormSubmit. La primera vez pedirá autorizar permisos.
 *   6. Para probar sin esperar una respuesta real del Form, ejecuta `probarConexion`.
 *
 * IMPORTANTE: los títulos de pregunta en QUESTION_TITLES deben coincidir EXACTO (incluida
 * puntuación) con el texto de la pregunta en el Form. Si tu Form tiene una redacción
 * ligeramente distinta, ajusta el valor aquí (la clave del objeto no cambia).
 */

// ── Configuración por copia de Form ──────────────────────────────────────
var EMPRESA_SIGLA = 'GREEN'; // <-- cambiar por Form: PARCELAR | GREEN | RESO | IASO | IAS
var INGEST_URL = 'https://kvfqcymeihglohkcckdp.supabase.co/functions/v1/ingest-formulario';

// ── Títulos exactos de las preguntas del Form ────────────────────────────
var QUESTION_TITLES = {
  branch: 'Su solicitud es: (seleccione al que corresponda)',
  branchPqrs: 'Petición, Queja o Reclamo',
  branchEncuesta: 'Encuesta de Satisfacción del servicio',

  // Rama PQRS
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
  // Campos nuevos (agregarlos al Form antes de activar el puente)
  identificacion: 'Identificación (NIT/Cédula)',
  referenciaPedido: 'N° de pedido, factura o remisión relacionado',
  productoLote: 'Producto y/o lote relacionado',
  ciudadDepartamento: 'Ciudad/Departamento',

  // Rama Encuesta de Satisfacción
  municipio: 'Municipio donde reside',
  asesorNombre: 'Nombre del asesor o persona que le vendió el producto',
  canalAdquisicion: '¿Dónde adquirió nuestros productos?',
  canalAdquisicionOtro: 'Si su respuesta fue "Otro" indique cual',
  califCalidadProducto: '¿Cómo califica la calidad de los productos recibidos?',
  califAsesorTecnico: '¿Cómo califica la atención, conocimiento técnico y acompañamiento brindado por nuestro asesor técnico comercial?',
  califServicioLogistica: '¿Cómo califica la atención y el servicio prestado por nuestro equipo, logística y/o distribuidor?',
  califTiemposRespuesta: '¿Qué tan satisfecho está con los tiempos de respuesta a sus solicitudes o pedidos?',
  califCalidadPrecio: '¿Cómo considera buena la relación calidad-precio de nuestros productos?',
  // La de satisfacción general incluye el nombre de la empresa en el texto (varía por Form),
  // así que se busca por coincidencia parcial, no título exacto (ver getRespuestaParcial).
  califSatisfaccionGeneralPrefijo: 'En general, qué tan satisfecho está con la experiencia',
  comentariosEncuesta: 'Comentarios o sugerencias adicionales',
};

var CANAL_MAP = {
  'Directamente con': 'Directo', // coincidencia parcial: el texto real incluye el nombre de la empresa
  'A través de un distribuidor autorizado': 'Distribuidor autorizado',
  'En una tienda agropecuaria local': 'Tienda agropecuaria local',
  'Otro (especificar)': 'Otro',
};

// ── Trigger principal ─────────────────────────────────────────────────────
function onFormSubmit(e) {
  try {
    var itemResponses = e.response.getItemResponses();
    var rama = getRespuestaExacta(itemResponses, QUESTION_TITLES.branch);

    var payload;
    if (rama === QUESTION_TITLES.branchEncuesta) {
      payload = construirPayloadEncuesta(itemResponses);
    } else {
      payload = construirPayloadPqrs(itemResponses);
    }

    var folio = enviarAIngest(payload);
    if (payload.tipo_registro === 'pqrs') {
      Logger.log('PQRS creado: ' + folio);
    } else {
      Logger.log('Encuesta registrada correctamente');
    }
  } catch (err) {
    Logger.log('Error en onFormSubmit: ' + err);
    // Si esto falla repetidamente, revisa el log de ejecuciones en Apps Script
    // (Ver > Ejecuciones) y el log de la función ingest-formulario en Supabase.
    throw err;
  }
}

function construirPayloadPqrs(itemResponses) {
  var adjuntos = getAdjuntos(itemResponses, QUESTION_TITLES.adjuntos);
  return {
    tipo_registro: 'pqrs',
    empresa_sigla: EMPRESA_SIGLA,
    nombre_completo: getRespuestaExacta(itemResponses, QUESTION_TITLES.nombreCompleto),
    contacto: getRespuestaExacta(itemResponses, QUESTION_TITLES.contacto),
    identificacion_cliente: getRespuestaExacta(itemResponses, QUESTION_TITLES.identificacion),
    tipo_solicitud: getRespuestaExacta(itemResponses, QUESTION_TITLES.tipoSolicitud),
    fecha_evento: formatearFecha(getRespuestaExacta(itemResponses, QUESTION_TITLES.fechaEvento)),
    area_relacionada: mapAreaRelacionada(getRespuestaExacta(itemResponses, QUESTION_TITLES.areaRelacionada)),
    referencia_pedido: getRespuestaExacta(itemResponses, QUESTION_TITLES.referenciaPedido),
    producto_lote: getRespuestaExacta(itemResponses, QUESTION_TITLES.productoLote),
    ciudad_departamento: getRespuestaExacta(itemResponses, QUESTION_TITLES.ciudadDepartamento),
    descripcion: getRespuestaExacta(itemResponses, QUESTION_TITLES.descripcion),
    urgencia: mapUrgencia(getRespuestaExacta(itemResponses, QUESTION_TITLES.urgencia)),
    desea_respuesta: getRespuestaExacta(itemResponses, QUESTION_TITLES.deseaRespuesta) === 'Sí',
    comentarios_adicionales: getRespuestaExacta(itemResponses, QUESTION_TITLES.comentariosPqrs),
    adjuntos: adjuntos,
  };
}

function construirPayloadEncuesta(itemResponses) {
  var canalRaw = getRespuestaExacta(itemResponses, QUESTION_TITLES.canalAdquisicion) || '';
  var canal = mapCanalAdquisicion(canalRaw);
  return {
    tipo_registro: 'encuesta',
    empresa_sigla: EMPRESA_SIGLA,
    municipio: getRespuestaExacta(itemResponses, QUESTION_TITLES.municipio),
    asesor_nombre: getRespuestaExacta(itemResponses, QUESTION_TITLES.asesorNombre),
    canal_adquisicion: canal,
    canal_adquisicion_otro: canal === 'Otro' ? getRespuestaExacta(itemResponses, QUESTION_TITLES.canalAdquisicionOtro) : null,
    calificacion_calidad_producto: toNum(getRespuestaExacta(itemResponses, QUESTION_TITLES.califCalidadProducto)),
    calificacion_atencion_asesor_tecnico: toNum(getRespuestaExacta(itemResponses, QUESTION_TITLES.califAsesorTecnico)),
    calificacion_atencion_servicio_logistica: toNum(getRespuestaExacta(itemResponses, QUESTION_TITLES.califServicioLogistica)),
    calificacion_tiempos_respuesta: toNum(getRespuestaExacta(itemResponses, QUESTION_TITLES.califTiemposRespuesta)),
    calificacion_relacion_calidad_precio: toNum(getRespuestaExacta(itemResponses, QUESTION_TITLES.califCalidadPrecio)),
    calificacion_satisfaccion_general: toNum(getRespuestaParcial(itemResponses, QUESTION_TITLES.califSatisfaccionGeneralPrefijo)),
    comentarios_adicionales: getRespuestaExacta(itemResponses, QUESTION_TITLES.comentariosEncuesta),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getRespuestaExacta(itemResponses, titulo) {
  for (var i = 0; i < itemResponses.length; i++) {
    if (itemResponses[i].getItem().getTitle() === titulo) {
      var v = itemResponses[i].getResponse();
      return Array.isArray(v) ? v.join(', ') : v;
    }
  }
  return null;
}

// Para preguntas cuyo título varía por Form (ej. incluye el nombre de la empresa).
function getRespuestaParcial(itemResponses, prefijo) {
  for (var i = 0; i < itemResponses.length; i++) {
    if (itemResponses[i].getItem().getTitle().indexOf(prefijo) === 0) {
      return itemResponses[i].getResponse();
    }
  }
  return null;
}

function getAdjuntos(itemResponses, titulo) {
  for (var i = 0; i < itemResponses.length; i++) {
    if (itemResponses[i].getItem().getTitle() === titulo) {
      var v = itemResponses[i].getResponse();
      var ids = Array.isArray(v) ? v : (v ? [v] : []);
      return ids.map(function (id) {
        try {
          var file = DriveApp.getFileById(id);
          return {
            drive_file_id: id,
            nombre: file.getName(),
            tipo_mime: file.getMimeType(),
            tamano_bytes: file.getSize(),
            url: file.getUrl(),
          };
        } catch (e) {
          // Si no se puede leer metadata (permisos), igual se guarda el link básico.
          return { drive_file_id: id, nombre: null, tipo_mime: null, tamano_bytes: null, url: 'https://drive.google.com/file/d/' + id + '/view' };
        }
      });
    }
  }
  return [];
}

function formatearFecha(valor) {
  if (!valor) return null;
  // Google Forms entrega la fecha como texto 'yyyy-MM-dd' -- se deja tal cual si ya viene así.
  return valor;
}

function mapAreaRelacionada(valor) {
  var MAP = {
    'Producción': 'Produccion',
    'Servicio al cliente': 'Servicio al cliente',
    'Ventas': 'Ventas',
    'Estado del producto': 'Estado del producto',
    'Logistica (Entregas, despachos y el personal de entrega)': 'Logistica',
    'Logística (Entregas, despachos y el personal de entrega)': 'Logistica',
    'Pos venta': 'Pos venta',
    'otro': 'Otro',
    'Otro': 'Otro',
  };
  return MAP[valor] || 'Otro';
}

function mapUrgencia(valor) {
  if (!valor) return 'MEDIO';
  var v = valor.toUpperCase();
  if (v.indexOf('ALTO') === 0) return 'ALTO';
  if (v.indexOf('MEDIO') === 0) return 'MEDIO';
  return 'BAJA';
}

function mapCanalAdquisicion(valor) {
  for (var prefijo in CANAL_MAP) {
    if (valor.indexOf(prefijo) === 0) return CANAL_MAP[prefijo];
  }
  return 'Otro';
}

function toNum(valor) {
  var n = parseInt(valor, 10);
  return isNaN(n) ? null : n;
}

function enviarAIngest(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SHARED_SECRET');
  if (!secret) throw new Error('Falta configurar la Script Property INGEST_SHARED_SECRET');

  var res = UrlFetchApp.fetch(INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300 || !body.ok) {
    throw new Error('ingest-formulario respondió ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return body.folio;
}

// ── Utilidades de instalación / prueba (ejecutar manualmente una vez) ────

function crearTrigger() {
  // Evita duplicar el trigger si ya existe.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onFormSubmit') {
      Logger.log('El trigger onFormSubmit ya existe, no se crea uno nuevo.');
      return;
    }
  }
  ScriptApp.newTrigger('onFormSubmit')
    .forForm(FormApp.getActiveForm())
    .onFormSubmit()
    .create();
  Logger.log('Trigger onFormSubmit instalado correctamente.');
}

function probarConexion() {
  var folio = enviarAIngest({
    tipo_registro: 'pqrs',
    empresa_sigla: EMPRESA_SIGLA,
    nombre_completo: 'Prueba Apps Script',
    contacto: 'prueba@example.com',
    tipo_solicitud: 'Sugerencia',
    area_relacionada: 'Otro',
    descripcion: 'Envío de prueba desde probarConexion()',
    urgencia: 'BAJA',
    desea_respuesta: false,
    adjuntos: [],
  });
  Logger.log('Prueba exitosa, folio: ' + folio);
}
