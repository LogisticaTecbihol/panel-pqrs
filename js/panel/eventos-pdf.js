// PDF de una solicitud de evento (formato MC-ISO-FO01) para el módulo Eventos de Mercadeo: todas las especificaciones de la
// solicitud (solicitante, evento, objetivos y público, requerimientos, presupuesto, archivos adjuntos), el estado y las
// aprobaciones, y el checklist de actividades con su avance (sin las notas internas).
// Usa jsPDF 2.5.2 + jspdf-autotable 3.8.4 (las mismas que SST), cargadas con <script defer> en eventos.html. Solo caracteres de la
// fuente estándar de jsPDF (Latin-1: admite tildes y ñ): lo escrito por las personas se limpia (sin emojis ni símbolos raros).
var EVENTO_PDF = (function () {
  var AZUL = [26, 82, 118];
  var MODALIDAD = { fisico: 'Físico', virtual: 'Virtual', hibrido: 'Híbrido' };
  // Catálogos del formato (códigos de la BD -> texto). ÚNICA copia en panel-pqrs: eventos.js los toma de aquí. Deben coincidir con los CHECK de
  // mercadeo_eventos y con los de Pedidos (ver CLAUDE.md).
  var CAT = {
    OBJETIVOS: [['leads', 'Generar nuevos leads (oportunidades de venta)'], ['relacion_clientes', 'Fortalecer la relación con clientes existentes'], ['lanzamiento', 'Lanzamiento o promoción de un nuevo producto/servicio'], ['posicionamiento', 'Posicionamiento de la marca/empresa'], ['capacitacion', 'Capacitación o educación'], ['trafico_digital', 'Aumentar el tráfico a nuestro sitio web o redes sociales'], ['retencion', 'Retención de clientes']],
    CANALES: [['email', 'Email marketing (creación de campañas de invitación)'], ['redes', 'Redes sociales (posts, historias, anuncios)'], ['web', 'Blog o sitio web (creación de contenido, landing page)'], ['relaciones_publicas', 'Relaciones públicas (comunicados de prensa)'], ['publicidad_digital', 'Publicidad digital (Google Ads, LinkedIn Ads, etc.)'], ['video', 'Creación de videos promocionales']],
    MATERIALES: [['banners_redes', 'Banners para redes sociales'], ['diseno_email', 'Diseño de email'], ['invitaciones', 'Invitaciones digitales o impresas'], ['presentacion', 'Presentación de diapositivas'], ['flyers', 'Flyers o folletos'], ['rollups', 'Roll-ups o pendones'], ['merchandising', 'Diseño para materiales de merchandising']],
    LOGISTICA: [['registros', 'Apoyo en la gestión de registros (plataforma, base de datos)'], ['coordinacion_logistica', 'Coordinación con el área de logística para el evento'], ['plataforma_virtual', 'Apoyo en la configuración de la plataforma de evento virtual'], ['presencia_mercadeo', 'Se solicita presencia de Mercadeo']],
  };
  var ESTADO_T = { radicada: 'Radicada', en_revision: 'En revisión', aprobada: 'Aprobada', en_preparacion: 'En preparación', realizada: 'Realizada', cerrada: 'Cerrada', rechazada: 'Rechazada', cancelada: 'Cancelada' };

  // Texto seguro para la fuente estándar: comillas y guiones tipográficos a su equivalente simple; lo que no cabe en Latin-1 se quita.
  function L(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
      .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[•●]/g, '-')
      .replace(/[    ]/g, ' ')
      .replace(/[^\n -~¡-ÿ]/g, '');
  }
  function vacio(v) { var t = L(v).trim(); return t === '' ? '-' : t; }
  function fecha(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(L(d));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function p2(n) { return String(n).padStart(2, '0'); }
  function fechaHora(v) {
    if (!v) return '';
    var dt = new Date(v);
    if (isNaN(dt.getTime())) return '';
    return p2(dt.getDate()) + '/' + p2(dt.getMonth() + 1) + '/' + dt.getFullYear() + ' ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes());
  }
  function hhmm(t) { return t ? String(t).slice(0, 5) : ''; }
  function monto(v) { return '$ ' + Math.round(Number(v) || 0).toLocaleString('es-CO'); }
  function tam(b) { return b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round((b || 0) / 1024)) + ' KB'; }
  function etiqueta(cat, k) { var c = (cat || []).filter(function (x) { return x[0] === k; })[0]; return c ? c[1] : k; }
  function marcados(arr, cat, otro) {
    var l = (arr || []).map(function (k) { return etiqueta(cat, k); });
    if (L(otro).trim()) l.push('Otros: ' + L(otro).trim());
    return l.length ? l.map(function (x) { return '- ' + x; }).join('\n') : '-';
  }

  // ctx = { e (fila de mercadeo_eventos), cat: { OBJETIVOS, CANALES, MATERIALES, LOGISTICA }, estado (texto), empresa (texto),
  //         checklist: [fila de mercadeo_evento_checklist], equipo: [{id,nombre}], adjuntos: [{nombre_original, tamano_bytes}],
  //         generadoPor (texto), ahora (Date) }
  function solicitud(ctx) {
    var JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) throw new Error('La librería de PDF aún no cargó. Intenta de nuevo en unos segundos.');
    var doc = new JsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait' });
    if (typeof doc.autoTable !== 'function') throw new Error('El complemento de tablas del PDF aún no cargó. Intenta de nuevo.');
    var e = ctx.e, cat = ctx.cat || {}, ahora = ctx.ahora || new Date();
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 15, y = 16;
    var estilos = { fontSize: 8.5, cellPadding: 1.7, textColor: 30, lineColor: [200, 205, 210], overflow: 'linebreak' };
    var colEtiqueta = { 0: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 48 } };

    function titulo(txt) {
      if (y > H - 38) { doc.addPage(); y = 16; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
      doc.text(L(txt), M, y); y += 3.5;
      doc.setTextColor(30);
    }
    function tabla(filas) {
      doc.autoTable({ startY: y, theme: 'grid', margin: { left: M, right: M }, styles: estilos, columnStyles: colEtiqueta, body: filas });
      y = doc.lastAutoTable.finalY + 6;
    }
    function seccion(txt, filas) { titulo(txt); tabla(filas.map(function (f) { return [f[0], vacio(f[1])]; })); }

    // ── Encabezado ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('SOLICITUD DE EVENTOS', M, y);
    doc.setFontSize(11); doc.text('EV-' + e.id, W - M, y, { align: 'right' });
    doc.setFontSize(9.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
    y += 5.5; doc.text('Formato MC-ISO-FO01 - Mercadeo', M, y);
    doc.setFont('helvetica', 'bold'); doc.text(L(ctx.estado), W - M, y, { align: 'right' });
    y += 3; doc.setDrawColor(AZUL[0], AZUL[1], AZUL[2]); doc.setLineWidth(0.5); doc.line(M, y, W - M, y);
    y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30);
    var nom = doc.splitTextToSize(L(e.nombre), W - 2 * M);
    doc.text(nom, M, y); y += nom.length * 5 + 2;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    doc.text(L(ctx.empresa) + '  |  ' + (fecha(e.fecha_evento) || '-'), M, y); y += 6;
    doc.setTextColor(30);

    // ── Estado y aprobaciones ──
    var ant = e.dias_anticipacion === null || e.dias_anticipacion === undefined ? '' :
      e.dias_anticipacion + ' días' + (e.extemporanea ? ' (menos de 15 días: política incumplida, es una advertencia)' : '');
    var origen = e.origen === 'panel_pedidos' ? 'Desde Pedidos' + (e.origen_numero ? ' (SE-' + e.origen_numero + ')' : '') + (e.enviado_por_nombre ? ', enviada por ' + e.enviado_por_nombre : '') : 'Digitada en Mercadeo';
    var filasEstado = [
      ['Estado en Mercadeo', ctx.estado],
      ['Origen', origen],
      ['Fecha en que llegó la solicitud', fecha(e.fecha_radicacion)],
      ['Anticipación', ant],
    ];
    if (e.origen === 'panel_pedidos') filasEstado.push(['Aprobada en Pedidos', e.aprobada_origen_por_nombre ? e.aprobada_origen_por_nombre + (e.aprobada_origen_en ? ' el ' + fechaHora(e.aprobada_origen_en) : '') : '']);
    if (e.aprobado_por_nombre) filasEstado.push(['Aprobada por Mercadeo', e.aprobado_por_nombre + (e.aprobado_en ? ' el ' + fechaHora(e.aprobado_en) : '')]);
    if (e.rechazado_por_nombre || e.motivo_rechazo) filasEstado.push(['Rechazada', (e.rechazado_por_nombre || '') + (e.rechazado_en ? ' el ' + fechaHora(e.rechazado_en) : '') + (e.motivo_rechazo ? '. Motivo: ' + e.motivo_rechazo : '')]);
    if (e.cancelado_por_nombre || e.motivo_cancelacion) filasEstado.push(['Cancelada', (e.cancelado_por_nombre || '') + (e.cancelado_en ? ' el ' + fechaHora(e.cancelado_en) : '') + (e.motivo_cancelacion ? '. Motivo: ' + e.motivo_cancelacion : '')]);
    if (e.realizado_en) filasEstado.push(['Realizada', fechaHora(e.realizado_en)]);
    if (e.estado === 'realizada' || e.estado === 'cerrada') {
      filasEstado.push(['Base de datos de asistentes', e.bd_no_aplica ? 'No aplica' : (e.bd_asistentes_fecha ? 'Recibida el ' + fecha(e.bd_asistentes_fecha) : 'Pendiente')]);
    }
    if (e.cerrado_en) filasEstado.push(['Cerrada', fechaHora(e.cerrado_en)]);
    seccion('Estado y aprobaciones', filasEstado);

    // ── 1. Solicitante ──
    seccion('1. Información general del solicitante', [
      ['Empresa', ctx.empresa],
      ['Nombre del solicitante', e.solicitante_nombre],
      ['Departamento / Área', e.solicitante_area],
      ['Correo electrónico', e.solicitante_correo],
      ['Teléfono de contacto', e.solicitante_telefono],
      ['Fecha límite de aprobación', fecha(e.fecha_limite_aprobacion)],
    ]);

    // ── 2. Detalles del evento ──
    var horario = hhmm(e.hora_inicio) ? hhmm(e.hora_inicio) + (hhmm(e.hora_fin) ? ' a ' + hhmm(e.hora_fin) : '') : '';
    var filasEvento = [
      ['Nombre del evento', e.nombre],
      ['Descripción', e.descripcion],
      ['Fecha del evento', fecha(e.fecha_evento)],
      ['Horario', horario],
      ['Modalidad', MODALIDAD[e.modalidad] || e.modalidad],
    ];
    if (e.modalidad === 'fisico' || e.modalidad === 'hibrido') {
      if (e.lugar_municipio) {
        filasEvento.push(['Municipio', e.lugar_municipio], ['Departamento', e.lugar_departamento]);
        if (e.lugar_distribuidor) filasEvento.push(['Distribuidor o cliente', e.lugar_distribuidor + (e.lugar_distribuidor_nit ? ' (NIT ' + e.lugar_distribuidor_nit + ')' : '')]);
        if (e.lugar_finca) filasEvento.push(['Finca', e.lugar_finca]);
      } else {
        filasEvento.push(['Lugar / Ubicación', e.lugar]);   // solicitudes anteriores: texto libre
      }
    }
    if (e.modalidad === 'virtual' || e.modalidad === 'hibrido') filasEvento.push(['Plataforma', e.plataforma]);
    seccion('2. Detalles del evento', filasEvento);

    // ── 3. Objetivos y público ──
    var asist = [];
    if (e.total_invitados !== null && e.total_invitados !== undefined) asist.push(e.total_invitados + ' invitados');
    if (e.asistentes_presencial !== null && e.asistentes_presencial !== undefined) asist.push(e.asistentes_presencial + ' presenciales');
    if (e.asistentes_virtual !== null && e.asistentes_virtual !== undefined) asist.push(e.asistentes_virtual + ' virtuales');
    var filasPublico = [
      ['Objetivos del evento', marcados(e.objetivos, cat.OBJETIVOS, e.objetivos_otro)],
      ['Público objetivo', e.publico_objetivo],
      ['Segmentación', e.segmento_profesional],
    ];
    if (L(e.segmento_demografico).trim()) filasPublico.push(['Segmento demográfico', e.segmento_demografico]);
    if (L(e.nivel_conocimiento).trim()) filasPublico.push(['Nivel de conocimiento', e.nivel_conocimiento]);
    filasPublico.push(['Asistentes esperados', asist.join(' / ')]);
    seccion('3. Objetivos y público', filasPublico);

    // ── 4. Requerimientos ──
    seccion('4. Requerimientos específicos de Mercadeo', [
      ['Canales de promoción', marcados(e.canales, cat.CANALES, e.canales_otro)],
      ['Materiales gráficos y visuales', marcados(e.materiales, cat.MATERIALES, e.materiales_otro)],
      ['Logística y presencialidad', marcados(e.logistica, cat.LOGISTICA, e.logistica_otro)],
    ]);

    // ── 5. Presupuesto ──
    titulo('5. Presupuesto');
    tabla([
      ['Presupuesto estimado del evento', monto(e.presupuesto_estimado)],
      ['Total solicitado a Mercadeo', monto(e.total_solicitado)],
    ]);
    y -= 3;
    var desglose = (e.desglose_gastos || []).filter(function (l) { return l && L(l.concepto).trim(); });
    if (desglose.length) {
      var suma = desglose.reduce(function (a, l) { return a + (Number(l.valor) || 0); }, 0);
      doc.autoTable({
        startY: y, theme: 'grid', margin: { left: M, right: M }, styles: estilos,
        head: [['Desglose de gastos', 'Valor']],
        headStyles: { fillColor: AZUL, textColor: 255, fontSize: 8.5 },
        columnStyles: { 1: { halign: 'right', cellWidth: 40 } },
        body: desglose.map(function (l) { return [L(l.concepto), monto(l.valor)]; }).concat([[{ content: 'Suma del desglose', styles: { fontStyle: 'bold' } }, { content: monto(suma), styles: { fontStyle: 'bold', halign: 'right' } }]]),
      });
      y = doc.lastAutoTable.finalY + 6;
    } else {
      y += 3;
    }

    // ── Archivos adjuntos ──
    var ad = ctx.adjuntos || [];
    seccion('Archivos adjuntos', [['Archivos', ad.length ? ad.map(function (a) { return '- ' + L(a.nombre_original || 'archivo') + ' (' + tam(a.tamano_bytes) + ')'; }).join('\n') : 'Sin archivos']]);

    // ── Checklist de actividades ──
    var chk = ctx.checklist || [], hechas = chk.filter(function (a) { return a.hecha; }).length;
    titulo('Checklist de actividades' + (chk.length ? '  (' + hechas + ' de ' + chk.length + ' hechas, ' + Math.round(hechas / chk.length * 100) + ' %)' : ''));
    if (!chk.length) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(120);
      doc.text('Aún no hay actividades registradas.', M, y + 2); y += 8; doc.setTextColor(30);
    } else {
      var nombreDe = function (id) { var u = (ctx.equipo || []).filter(function (x) { return x.id === id; })[0]; return u ? u.nombre : ''; };
      doc.autoTable({
        startY: y, theme: 'grid', margin: { left: M, right: M }, styles: estilos,
        head: [['Hecha', 'Actividad', 'Responsable', 'Fecha límite', 'Hecha por']],
        headStyles: { fillColor: AZUL, textColor: 255, fontSize: 8.5 },
        columnStyles: { 0: { cellWidth: 14, halign: 'center' }, 2: { cellWidth: 34 }, 3: { cellWidth: 24 }, 4: { cellWidth: 40 } },
        body: chk.map(function (a) {
          return [a.hecha ? 'Sí' : 'No', L(a.descripcion), vacio(nombreDe(a.responsable_id)), vacio(fecha(a.fecha_limite)),
            a.hecha ? L(a.hecha_por_nombre) + (a.hecha_en ? '\n' + fechaHora(a.hecha_en) : '') : '-'];
        }),
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    // ── Pie de página en todas las hojas ──
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setDrawColor(200); doc.setLineWidth(0.2); doc.line(M, H - 12, W - M, H - 12);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120);
      doc.text('EV-' + e.id + ' - Formato MC-ISO-FO01 - Generado el ' + fechaHora(ahora) + (ctx.generadoPor ? ' por ' + L(ctx.generadoPor) : ''), M, H - 8);
      doc.text('Página ' + i + ' de ' + n, W - M, H - 8, { align: 'right' });
    }
    return doc;
  }

  // Abre el PDF de un evento en una pestaña nueva. Lo usan Eventos y el Tablero.
  // o = { sb (cliente Supabase), id (evento), evento (fila ya cargada, opcional), equipo (opcional, para los nombres de responsables),
  //       perfil (quien lo genera) }. Devuelve { equipo } para que quien llama lo reutilice; si algo falla, lanza el error.
  // Hay que llamarla DENTRO del clic: la pestaña se abre ya (así el navegador no la bloquea) y se llena cuando el PDF está listo;
  // si aun así la bloquea, el PDF se descarga.
  async function ver(o) {
    var w = window.open('', '_blank');
    if (w) {
      try { w.document.title = 'PDF EV-' + o.id; w.document.body.innerHTML = '<p style="font-family:sans-serif;padding:24px;color:#4a5568">Generando el PDF…</p>'; } catch (_e) { /* sin acceso a la pestaña */ }
    }
    try {
      var sb = o.sb, id = o.id;
      var rs = await Promise.all([
        o.evento ? Promise.resolve({ data: o.evento }) : sb.from('mercadeo_eventos').select('*').eq('id', id).maybeSingle(),
        sb.from('mercadeo_evento_checklist').select('*').eq('evento_id', id).order('id', { ascending: true }),
        sb.from('mercadeo_evento_adjuntos').select('nombre_original,tamano_bytes').eq('evento_id', id).order('id', { ascending: true }),
        o.equipo && o.equipo.length ? Promise.resolve({ data: o.equipo }) : sb.rpc('list_equipo_mercadeo'),
      ]);
      for (var i = 0; i < 3; i++) if (rs[i].error) throw rs[i].error;
      var e = rs[0].data;
      if (!e) throw new Error('El evento ya no existe o no tienes permiso para verlo');
      var equipo = rs[3].error || !rs[3].data ? (o.equipo || []) : rs[3].data;
      var perfil = o.perfil || {};
      var doc = solicitud({
        e: e, cat: CAT,
        estado: ESTADO_T[e.estado] || e.estado,
        empresa: etiquetaEmpresa(e.empresa) + (e.empresa === 'OTROS' && e.empresa_otra ? ': ' + e.empresa_otra : ''),
        checklist: rs[1].data, adjuntos: rs[2].data, equipo: equipo,
        generadoPor: perfil.nombre || perfil.email || '', ahora: new Date(),
      });
      if (w) w.location.href = doc.output('bloburl');
      else doc.save(nombreArchivo(e));
      return { equipo: equipo };
    } catch (err) {
      if (w) w.close();
      throw err;
    }
  }

  function nombreArchivo(e) {
    var base = L(e.nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return 'Evento_EV-' + e.id + (base ? '_' + base : '') + '.pdf';
  }

  return { solicitud: solicitud, ver: ver, nombreArchivo: nombreArchivo, CAT: CAT, ESTADO_T: ESTADO_T };
})();
