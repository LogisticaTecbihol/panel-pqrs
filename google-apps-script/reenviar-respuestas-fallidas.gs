/**
 * Reenvío puntual de respuestas del Form que NO llegaron al panel (la ejecución de
 * onFormSubmit aparece como "Fallida" en Apps Script > Ejecuciones).
 *
 * CÓMO USAR: pegar este archivo COMPLETO como un archivo nuevo (+ > Secuencia de
 * comandos) en el MISMO proyecto de Apps Script que ya tiene ingest-template.gs: usa
 * sus funciones y constantes (QUESTION_TITLES, construirPayloadPqrs, enviarAIngest...).
 *
 * Ejecutar en este orden (elegir la función arriba y pulsar ▶ Ejecutar):
 *   1) revisarRespuestasFallidas  -> solo LISTA qué se enviaría. No envía nada.
 *   2) reenviarRespuestasFallidas -> envía de verdad.
 * Los resultados salen en el "Registro de ejecución" de abajo.
 *
 * Es seguro ejecutarla más de una vez: guarda en las Propiedades de secuencia de
 * comandos (REENVIADAS) el id de cada respuesta ya reenviada y la omite después.
 */

// Se consideran las respuestas recibidas DESPUÉS de esta fecha (hora de Colombia).
var REENVIO_DESDE = '2026-10-16T00:00:00-05:00';

function revisarRespuestasFallidas() {
  procesarRespuestasFallidas(false);
}

function reenviarRespuestasFallidas() {
  procesarRespuestasFallidas(true);
}

function procesarRespuestasFallidas(enviar) {
  var props = PropertiesService.getScriptProperties();
  var yaEnviadas = JSON.parse(props.getProperty('REENVIADAS') || '[]');
  var respuestas = FormApp.getActiveForm().getResponses(new Date(REENVIO_DESDE));
  Logger.log('Respuestas posteriores a ' + REENVIO_DESDE + ': ' + respuestas.length +
    (enviar ? '  [MODO ENVIAR]' : '  [SOLO REVISION: no se envia nada]'));
  // La plantilla trae GREEN por defecto: si este Form es de otra empresa y no se cambio,
  // el PQRS quedaria registrado en la empresa equivocada. Verificar ANTES de enviar.
  Logger.log('EMPRESA con la que se registrara en el panel: ' + EMPRESA_SIGLA +
    '   (debe ser la de ESTE formulario: PARCELAR | GREEN | RESO | IASO | IAS)');

  respuestas.forEach(function (r) {
    var id = r.getId();
    var items = r.getItemResponses();
    var cuando = Utilities.formatDate(r.getTimestamp(), 'America/Bogota', 'yyyy-MM-dd HH:mm:ss');

    if (yaEnviadas.indexOf(id) >= 0) {
      Logger.log('- ' + cuando + ': ya fue reenviada, se omite');
      return;
    }

    var esEncuesta = getRespuestaExacta(items, QUESTION_TITLES.branch) === QUESTION_TITLES.branchEncuesta;
    var payload = esEncuesta ? construirPayloadEncuesta(items) : construirPayloadPqrs(items);

    if (!esEncuesta) {
      // El panel la registra hoy como una solicitud nueva (así llega el aviso por correo
      // al equipo); la nota deja constancia de cuándo la envió realmente el cliente.
      var nota = '[Reenviada al panel el ' +
        Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd') +
        '. El cliente la envio por el formulario el ' + cuando + ' (hora Colombia).]';
      payload.comentarios_adicionales = payload.comentarios_adicionales
        ? payload.comentarios_adicionales + '\n\n' + nota
        : nota;
    }

    Logger.log('- ' + cuando + ' | ' + (esEncuesta ? 'ENCUESTA' : 'PQRS'));
    if (!esEncuesta) {
      var tipoRaw = getRespuestaExacta(items, QUESTION_TITLES.tipoSolicitud);
      var areaRaw = getRespuestaExacta(items, QUESTION_TITLES.areaRelacionada);
      var urgRaw = getRespuestaExacta(items, QUESTION_TITLES.urgencia);
      Logger.log('    tipo:     "' + tipoRaw + '"  -> el panel lo guarda como el tipo base');
      Logger.log('    area:     "' + areaRaw + '"  -> se envia como "' + payload.area_relacionada + '"' +
        (payload.area_relacionada === 'Otro' && areaRaw && String(areaRaw).toLowerCase() !== 'otro'
          ? '   <-- AVISO: area no reconocida, quedaria como "Otro"' : ''));
      Logger.log('    urgencia: "' + urgRaw + '"  -> se envia como "' + payload.urgencia + '"');
      Logger.log('    descripcion: ' + String(payload.descripcion || '').slice(0, 80));
    }

    if (!enviar) return;

    try {
      var folio = enviarAIngest(payload);
      yaEnviadas.push(id);
      props.setProperty('REENVIADAS', JSON.stringify(yaEnviadas));
      Logger.log('    OK reenviada' + (folio ? ', folio ' + folio : ''));
    } catch (err) {
      Logger.log('    ERROR al reenviar: ' + err);
    }
  });
}
