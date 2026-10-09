// PDF del módulo SST (Res. 312 de 2019): autoevaluación de estándares mínimos (Fase 1), plan anual de
// trabajo y planilla de asistencia a capacitación (Fase 2).
// Usa jsPDF 2.5.2 + jspdf-autotable 3.8.4 (mismas versiones que el panel de pedidos), cargadas con
// <script defer> en sst.html. Solo caracteres de la fuente estándar de jsPDF (Latin-1: admite tildes y
// ñ): sin emojis ni flechas.
var SST_PDF = (function () {
  var BANDA = {
    critico: 'CRÍTICO (menos de 60 %)',
    moderado: 'MODERADAMENTE ACEPTABLE (entre 60 % y 85 %)',
    aceptable: 'ACEPTABLE (más de 85 %)',
  };
  var BANDA_TXT = {
    critico: 'Plan de mejoramiento disponible de inmediato para el Ministerio del Trabajo; reporte de avances a la ARL en máximo 3 meses; seguimiento anual y plan de visita del Ministerio.',
    moderado: 'Plan de mejoramiento disponible para el Ministerio del Trabajo; reporte de avances a la ARL en máximo 6 meses; plan de visita del Ministerio.',
    aceptable: 'Mantener la calificación y las evidencias a disposición del Ministerio del Trabajo e incluir en el plan anual las mejoras que resulten de la evaluación.',
  };
  var RESULTADO = { cumple: 'Cumple', no_cumple: 'No cumple', pendiente: 'Pendiente' };
  var ESTADO_PLAN = { pendiente: 'Pendiente', en_curso: 'En curso', cumplida: 'Cumplida', cancelada: 'Cancelada' };

  function s(v) { return v === null || v === undefined ? '' : String(v); }
  function fecha(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s(d));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function fechaHora(dt) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(dt.getDate()) + '/' + p(dt.getMonth() + 1) + '/' + dt.getFullYear() + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
  }

  // ctx = { empresa, auto (fila de sst_autoevaluaciones_resumen), items: [{ item, estandar, evidencias[] }],
  //         plan: [{ plan, codigo, evidencias[] }], ahora: Date }
  function autoevaluacion(ctx) {
    var JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) throw new Error('La librería de PDF aún no cargó. Intenta de nuevo en unos segundos.');
    var doc = new JsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait' });
    if (typeof doc.autoTable !== 'function') throw new Error('El complemento de tablas del PDF aún no cargó. Intenta de nuevo.');
    var a = ctx.auto, emp = ctx.empresa, ahora = ctx.ahora || new Date();
    var W = doc.internal.pageSize.getWidth(), M = 15, y = 16;
    var AZUL = [26, 82, 118];

    // ── Encabezado ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('AUTOEVALUACIÓN DE ESTÁNDARES MÍNIMOS DEL SG-SST', M, y);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
    y += 6; doc.text('Resolución 0312 de 2019 - Ministerio del Trabajo', M, y);
    doc.setFont('helvetica', 'bold'); doc.text('Vigencia ' + s(a.vigencia), W - M, y, { align: 'right' });
    y += 3;
    doc.setDrawColor(AZUL[0], AZUL[1], AZUL[2]); doc.setLineWidth(0.5); doc.line(M, y, W - M, y);
    y += 4;

    // ── Datos de la empresa ──
    var estadoTxt = a.estado === 'cerrada'
      ? 'Cerrada' + (a.cerrada_en ? ' el ' + fecha(String(a.cerrada_en).slice(0, 10)) : '') + (a.cerrada_por_nombre ? ' por ' + a.cerrada_por_nombre : '')
      : 'BORRADOR (sin cerrar)';
    doc.autoTable({
      startY: y, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8.5, cellPadding: 1.6, textColor: 30, lineColor: [200, 205, 210] },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 38 }, 2: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 38 } },
      body: [
        ['Razón social', s(emp.nombre), 'NIT', s(emp.nit)],
        ['ARL', s(emp.arl), 'Clases de riesgo', (emp.clases_riesgo || []).join(', ')],
        ['Número de trabajadores', s(emp.num_trabajadores), 'Estándares aplicables', s(a.grupo_estandares) + ' estándares mínimos'],
        ['Fecha de la evaluación', fecha(a.fecha_evaluacion), 'Estado', estadoTxt],
      ],
    });
    y = doc.lastAutoTable.finalY + 5;

    // ── Resultado ──
    var puntaje = a.puntaje === null || a.puntaje === undefined ? null : Number(a.puntaje);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('Resultado', M, y); y += 4;
    doc.setTextColor(30);
    var cuerpoRes = [
      ['Puntaje', puntaje === null ? 'Sin calcular' : puntaje.toFixed(2).replace('.', ',') + ' %'],
      ['Estándares', s(a.items_cumple) + ' cumplen, ' + s(a.items_no_cumple) + ' no cumplen, ' + s(a.items_pendientes) + ' pendientes (de ' + s(a.items_total) + ')'],
      ['Resultado', a.banda ? BANDA[a.banda] : 'Sin calcular'],
    ];
    if (a.banda) cuerpoRes.push(['Qué implica', BANDA_TXT[a.banda]]);
    if (a.fecha_limite_reporte_arl) cuerpoRes.push(['Límite del reporte de avances a la ARL', fecha(a.fecha_limite_reporte_arl)]);
    doc.autoTable({
      startY: y, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8.5, cellPadding: 1.6, textColor: 30, lineColor: [200, 205, 210] },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 52 } },
      body: cuerpoRes,
    });
    y = doc.lastAutoTable.finalY + 2;
    if (!a.pesos_verificados) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(146, 64, 14);
      var nota = doc.splitTextToSize('PUNTAJE REFERENCIAL: la ponderación de cada estándar aún no está confirmada (la Resolución 312 solo publica la Tabla de Valores de 60 ítems). Hoy todos pesan igual. Verifique la calificación en la aplicación del Ministerio antes de registrarla.', W - 2 * M);
      doc.text(nota, M, y + 3); y += 3 + nota.length * 3.6;
      doc.setTextColor(30);
    }
    if (a.estado !== 'cerrada') {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(120);
      doc.text('Documento en borrador: la evaluación no está cerrada y puede cambiar.', M, y + 3); y += 6; doc.setTextColor(30);
    }
    y += 3;

    // ── Estandares ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('Calificación por estándar', M, y); y += 2;
    doc.autoTable({
      startY: y, margin: { left: M, right: M }, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.6, textColor: 30, lineColor: [200, 205, 210], valign: 'top' },
      headStyles: { fillColor: AZUL, textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 16 }, 2: { cellWidth: 22 }, 3: { cellWidth: 12, halign: 'center' }, 4: { cellWidth: 50 } },
      head: [['Código', 'Estándar y modo de verificación', 'Resultado', 'Peso', 'Observaciones y evidencias']],
      body: ctx.items.map(function (r) {
        var evs = (r.evidencias || []).map(function (e) { return '- ' + e.titulo + (e.codigo_documento ? ' (' + e.codigo_documento + ')' : ''); });
        var obs = [r.item.observaciones].concat(evs).filter(function (x) { return s(x).trim() !== ''; }).join('\n');
        return [
          r.estandar.codigo,
          r.estandar.nombre + '\nVerificación: ' + r.estandar.verificacion,
          RESULTADO[r.item.resultado] || r.item.resultado,
          s(Number(r.item.peso)),
          obs,
        ];
      }),
      didParseCell: function (d) {
        if (d.section === 'body' && d.column.index === 2) {
          var v = d.cell.raw;
          d.cell.styles.fontStyle = 'bold';
          d.cell.styles.textColor = v === 'Cumple' ? [21, 128, 61] : v === 'No cumple' ? [192, 57, 43] : [113, 128, 150];
        }
      },
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── Plan de mejoramiento ──
    if (y > 235) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('Plan de mejoramiento', M, y); y += 2;
    if (!ctx.plan.length) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(120);
      doc.text('Sin actividades registradas en el plan.', M, y + 5); y += 9; doc.setTextColor(30);
    } else {
      doc.autoTable({
        startY: y, margin: { left: M, right: M }, theme: 'grid',
        styles: { fontSize: 8, cellPadding: 1.6, textColor: 30, lineColor: [200, 205, 210], valign: 'top' },
        headStyles: { fillColor: AZUL, textColor: 255, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 62 }, 1: { cellWidth: 16 }, 3: { cellWidth: 20 }, 5: { cellWidth: 20 } },
        head: [['Actividad', 'Estándar', 'Responsable', 'Plazo', 'Recursos', 'Estado']],
        body: ctx.plan.map(function (p) {
          var evs = (p.evidencias || []).map(function (e) { return e.titulo; });
          return [
            p.plan.actividad + (evs.length ? '\nSoportes: ' + evs.join('; ') : ''),
            s(p.codigo), s(p.plan.responsable), fecha(p.plan.plazo), s(p.plan.recursos),
            (ESTADO_PLAN[p.plan.estado] || p.plan.estado) + (p.plan.fecha_cumplimiento ? '\n' + fecha(p.plan.fecha_cumplimiento) : ''),
          ];
        }),
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    // ── Seguimiento del reporte ──
    if (y > 245) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('Seguimiento del reporte', M, y); y += 2;
    doc.autoTable({
      startY: y, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8.5, cellPadding: 1.6, textColor: 30, lineColor: [200, 205, 210] },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 92 } },
      body: [
        ['Copia de la autoevaluación y del plan enviada a la ARL', fecha(a.copia_arl_en) || 'Sin registrar'],
        ['Reporte de avances del plan enviado a la ARL', fecha(a.reporte_avances_arl_en) || 'Sin registrar'],
        ['Registro en la aplicación del Ministerio del Trabajo', fecha(a.registro_ministerio_en) || 'Sin registrar'],
      ],
    });
    y = doc.lastAutoTable.finalY + 4;
    if (s(a.observaciones).trim()) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
      doc.text('Observaciones generales', M, y + 3);
      doc.setFont('helvetica', 'normal');
      var obs = doc.splitTextToSize(s(a.observaciones), W - 2 * M);
      doc.text(obs, M, y + 7); y += 8 + obs.length * 3.8;
    }

    // ── Firmas ──
    if (y > 226) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('Firmas', M, y);
    y += 20;
    var mitad = (W - 2 * M) / 2;
    doc.setDrawColor(60); doc.setLineWidth(0.3);
    doc.line(M, y, M + mitad - 8, y); doc.line(M + mitad + 8, y, W - M, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
    doc.text(s(a.empleador_nombre) || ' ', M, y + 4);
    doc.text(s(a.responsable_nombre) || ' ', M + mitad + 8, y + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Empleador o representante legal', M, y + 8);
    doc.text('Responsable del SG-SST', M + mitad + 8, y + 8);

    // ── Pie en todas las paginas ──
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(130);
      var H = doc.internal.pageSize.getHeight();
      doc.text('Generado desde el Panel interno (SST) el ' + fechaHora(ahora) + ' - ' + s(emp.nombre) + ' - Vigencia ' + s(a.vigencia), M, H - 8);
      doc.text('Página ' + i + ' de ' + n, W - M, H - 8, { align: 'right' });
    }
    return doc;
  }

  // Nombre de archivo seguro: Autoevaluacion_SST_<empresa>_<vigencia>.pdf
  function nombreArchivo(emp, a) {
    var base = s(emp.nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return 'Autoevaluacion_SST_' + (base || 'empresa') + '_' + s(a.vigencia) + '.pdf';
  }


  // ── Fase 2 ──────────────────────────────────────────────────
  var MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  var CICLO = { planear: 'PLANEAR', hacer: 'HACER', verificar: 'VERIFICAR', actuar: 'ACTUAR' };
  var MODALIDAD = { presencial: 'Presencial', virtual: 'Virtual', mixta: 'Mixta' };

  function nuevoDoc(orientation) {
    var JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) throw new Error('La librería de PDF aún no cargó. Intenta de nuevo en unos segundos.');
    var doc = new JsPDF({ unit: 'mm', format: 'letter', orientation: orientation });
    if (typeof doc.autoTable !== 'function') throw new Error('El complemento de tablas del PDF aún no cargó. Intenta de nuevo.');
    return doc;
  }
  function pct(v) { return v === null || v === undefined ? '-' : Number(v).toFixed(1).replace('.', ',') + ' %'; }
  function titulo(doc, txt, M, y) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(26, 82, 118);
    doc.text(txt, M, y);
    doc.setTextColor(30);
  }
  function pie(doc, M, texto, ahora) {
    var n = doc.getNumberOfPages(), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(130);
      doc.text('Generado desde el Panel interno (SST) el ' + fechaHora(ahora) + ' - ' + texto, M, H - 7);
      doc.text('Página ' + i + ' de ' + n, W - M, H - 7, { align: 'right' });
    }
  }
  function bloqueTexto(doc, rotulo, valor, M, y, W) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
    doc.text(rotulo, M, y);
    var vacio = !s(valor).trim();
    doc.setFont('helvetica', vacio ? 'italic' : 'normal'); doc.setTextColor(vacio ? 150 : 30);
    var lineas = doc.splitTextToSize(vacio ? 'Sin definir' : s(valor), W - 2 * M);
    doc.text(lineas, M, y + 4);
    doc.setTextColor(30);
    return y + 4 + lineas.length * 3.8 + 2;
  }
  function filaMeses(prog, ejec) {
    var P = (prog || []).map(Number), E = (ejec || []).map(Number), out = [];
    for (var m = 1; m <= 12; m++) out.push(E.indexOf(m) >= 0 ? 'E' : P.indexOf(m) >= 0 ? 'P' : '');
    return out;
  }
  function colorearMeses(d, desde) {
    if (d.section !== 'body' || d.column.index < desde || d.column.index > desde + 11 || d.cell.colSpan > 1) return;
    var v = d.cell.raw;
    if (v === 'E') { d.cell.styles.fillColor = [187, 232, 200]; d.cell.styles.textColor = [21, 100, 50]; d.cell.styles.fontStyle = 'bold'; }
    else if (v === 'P') { d.cell.styles.fillColor = [200, 221, 244]; d.cell.styles.textColor = [26, 82, 118]; d.cell.styles.fontStyle = 'bold'; }
  }
  function columnasMeses(anchoTexto, anchoResp, anchoExtra, anchoUlt) {
    var c = { 0: { cellWidth: 'auto', halign: 'left' }, 1: { cellWidth: anchoResp, halign: 'left' }, 2: { cellWidth: anchoExtra }, 15: { cellWidth: anchoUlt, halign: 'center' } };
    for (var i = 3; i <= 14; i++) c[i] = { cellWidth: 7, halign: 'center' };
    return c;
  }

  // ctx = { empresa, plan (fila de sst_planes_resumen), actividades (filas de sst_plan_actividades_calc, ordenadas),
  //         capacitaciones (filas de sst_capacitaciones_resumen), ahora: Date }
  function planAnual(ctx) {
    var doc = nuevoDoc('landscape');
    var p = ctx.plan, emp = ctx.empresa, ahora = ctx.ahora || new Date();
    var W = doc.internal.pageSize.getWidth(), M = 12, y = 14;
    var AZUL = [26, 82, 118];

    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('PLAN ANUAL DE TRABAJO DEL SG-SST', M, y);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
    y += 6; doc.text('Resolución 0312 de 2019 - Ministerio del Trabajo (estándar: Plan Anual de Trabajo)', M, y);
    doc.setFont('helvetica', 'bold'); doc.text('Vigencia ' + s(p.vigencia), W - M, y, { align: 'right' });
    y += 3; doc.setDrawColor(AZUL[0], AZUL[1], AZUL[2]); doc.setLineWidth(0.5); doc.line(M, y, W - M, y); y += 4;

    var firma = p.firmado_en ? 'Firmado por el empleador el ' + fecha(p.firmado_en) : 'SIN FIRMA DEL EMPLEADOR (el estándar exige el plan firmado)';
    var rot = { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 34 };
    doc.autoTable({
      startY: y, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8, cellPadding: 1.4, textColor: 30, lineColor: [200, 205, 210] },
      columnStyles: { 0: rot, 2: rot, 4: rot },
      body: [
        ['Razón social', s(emp.nombre), 'NIT', s(emp.nit), 'ARL', s(emp.arl)],
        ['Trabajadores', s(emp.num_trabajadores), 'Clases de riesgo', (emp.clases_riesgo || []).join(', '), 'Estándares aplicables', s(emp.grupo_estandares) + ' mínimos'],
        ['Documento', [s(p.codigo_documento), s(p.version) ? 'versión ' + s(p.version) : '', fecha(p.fecha_documento)].filter(Boolean).join(' - ') || 'Sin registrar', 'Firma', { content: firma, colSpan: 3 }],
      ],
    });
    y = doc.lastAutoTable.finalY + 4;

    var prog = p.cumplimiento === null || p.cumplimiento === undefined ? 'sin calcular' : pct(p.cumplimiento);
    doc.autoTable({
      startY: y, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8, cellPadding: 1.4, textColor: 30, lineColor: [200, 205, 210] },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 58 } },
      body: [['Cumplimiento ponderado del plan (a la fecha de emisión)',
        prog + ' ejecutado - ' + pct(p.esperado) + ' esperado según el cronograma - ' + s(p.n_aplica) + ' actividades que aplican (' + s(p.n_ejecutadas) + ' ejecutadas, ' + s(p.n_vencidas) + ' vencidas, ' + s(p.n_este_mes) + ' del mes)' +
        (p.n_no_aplica ? ' - ' + s(p.n_no_aplica) + ' no aplican' : '')]],
    });
    y = doc.lastAutoTable.finalY + 4;

    y = bloqueTexto(doc, 'Objetivos', p.objetivo, M, y, W);
    y = bloqueTexto(doc, 'Metas', p.metas, M, y, W);
    y = bloqueTexto(doc, 'Recursos', p.recursos, M, y, W);

    // ── Cronograma de actividades (solo las que aplican) ──
    var aplican = ctx.actividades.filter(function (a) { return a.aplica; });
    var noAplican = ctx.actividades.filter(function (a) { return !a.aplica; });
    y += 3;
    if (y > 150) { doc.addPage(); y = 14; }
    titulo(doc, 'Cronograma de actividades y responsables', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100);
    doc.text('P = programada, E = ejecutada. El peso es relativo: el cumplimiento se calcula sobre la suma de pesos de las actividades que aplican.', W - M, y, { align: 'right' });
    y += 2;
    var body = [], ultimoGrupo = null, ultimoItem = null;
    aplican.forEach(function (a) {
      var g = a.ciclo + '|' + a.grupo;
      if (g !== ultimoGrupo) {
        body.push([{ content: (CICLO[a.ciclo] || a.ciclo) + ' - ' + s(a.grupo), colSpan: 16, styles: { fillColor: AZUL, textColor: 255, fontStyle: 'bold', fontSize: 8 } }]);
        ultimoGrupo = g; ultimoItem = null;
      }
      var it = a.item_codigo + '|' + a.item_nombre;
      if (it !== ultimoItem && (a.item_codigo || a.item_nombre)) {
        body.push([{ content: (s(a.item_codigo) + ' ' + s(a.item_nombre)).trim(), colSpan: 16, styles: { fillColor: [232, 238, 244], fontStyle: 'bold' } }]);
        ultimoItem = it;
      }
      body.push([s(a.actividad), s(a.responsable), s(Number(a.peso))].concat(filaMeses(a.meses_programados, a.meses_ejecutados))
        .concat([a.avance === null || a.avance === undefined ? '' : Math.round(Number(a.avance) * 100) + ' %']));
    });
    var cols = columnasMeses(116, 30, 10, 13);
    cols[2].halign = 'center';
    doc.autoTable({
      startY: y, margin: { left: M, right: M }, theme: 'grid',
      styles: { fontSize: 6.8, cellPadding: 1, textColor: 30, lineColor: [200, 205, 210], valign: 'middle' },
      headStyles: { fillColor: [60, 85, 110], textColor: 255, fontStyle: 'bold', halign: 'center' },
      columnStyles: cols,
      head: [['Actividad', 'Responsable', 'Peso'].concat(MESES).concat(['Avance'])],
      body: body,
      didParseCell: function (d) { colorearMeses(d, 3); },
    });
    y = doc.lastAutoTable.finalY + 6;

    if (noAplican.length) {
      if (y > 170) { doc.addPage(); y = 14; }
      titulo(doc, 'Actividades de la plantilla que no aplican a la empresa', M, y);
      doc.autoTable({
        startY: y + 2, margin: { left: M, right: M }, theme: 'grid',
        styles: { fontSize: 7, cellPadding: 1, textColor: 30, lineColor: [200, 205, 210], valign: 'top' },
        headStyles: { fillColor: [120, 130, 145], textColor: 255 },
        columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 130 } },
        head: [['Ítem', 'Actividad', 'Motivo']],
        body: noAplican.map(function (a) { return [s(a.item_codigo), s(a.actividad), s(a.motivo_no_aplica)]; }),
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    // ── Programa de capacitación ──
    var caps = (ctx.capacitaciones || []).filter(function (c) { return c.activa; });
    if (caps.length) {
      doc.addPage(); y = 14;
      titulo(doc, 'Programa de capacitación', M, y);
      var cols2 = columnasMeses(89, 36, 30, 14);
      cols2[2].halign = 'left';
      doc.autoTable({
        startY: y + 2, margin: { left: M, right: M }, theme: 'grid',
        styles: { fontSize: 7, cellPadding: 1.1, textColor: 30, lineColor: [200, 205, 210], valign: 'middle' },
        headStyles: { fillColor: [60, 85, 110], textColor: 255, halign: 'center' },
        columnStyles: cols2,
        head: [['Tema', 'Responsable', 'Entregable'].concat(MESES).concat(['Cobert.'])],
        body: caps.map(function (c) {
          return [s(c.tema), s(c.responsable), s(c.entregable)].concat(filaMeses(c.meses_programados, c.meses_ejecutados))
            .concat([c.cobertura === null || c.cobertura === undefined ? '' : Math.round(Number(c.cobertura)) + ' %']);
        }),
        didParseCell: function (d) { colorearMeses(d, 3); },
      });
      y = doc.lastAutoTable.finalY + 6;
    }

    // ── Firmas ──
    if (y > 168) { doc.addPage(); y = 14; }
    titulo(doc, 'Firmas', M, y);
    y += 22;
    var mitad = (W - 2 * M) / 2;
    doc.setDrawColor(60); doc.setLineWidth(0.3);
    doc.line(M, y, M + mitad - 10, y); doc.line(M + mitad + 10, y, W - M, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
    doc.text(s(p.empleador_nombre) || ' ', M, y + 4);
    doc.text(s(p.responsable_nombre) || ' ', M + mitad + 10, y + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Empleador o representante legal' + (p.firmado_en ? ' - firmado el ' + fecha(p.firmado_en) : ''), M, y + 8);
    doc.text('Responsable del SG-SST', M + mitad + 10, y + 8);

    pie(doc, M, s(emp.nombre) + ' - Plan anual ' + s(p.vigencia), ahora);
    return doc;
  }

  // ctx = { empresa, capacitacion (fila de sst_capacitaciones_resumen), sesion, convocados: [{ trabajador, asistio }], ahora }
  function planilla(ctx) {
    var doc = nuevoDoc('portrait');
    var emp = ctx.empresa, cap = ctx.capacitacion, ses = ctx.sesion, ahora = ctx.ahora || new Date();
    var W = doc.internal.pageSize.getWidth(), M = 15, y = 16;
    var AZUL = [26, 82, 118];
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]);
    doc.text('PLANILLA DE ASISTENCIA A CAPACITACIÓN', M, y);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
    y += 6; doc.text('Sistema de Gestión de Seguridad y Salud en el Trabajo - Res. 312 de 2019', M, y);
    y += 3; doc.setDrawColor(AZUL[0], AZUL[1], AZUL[2]); doc.setLineWidth(0.5); doc.line(M, y, W - M, y); y += 4;
    var rot = { fontStyle: 'bold', fillColor: [240, 244, 248] };
    doc.autoTable({
      startY: y, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8.5, cellPadding: 1.7, textColor: 30, lineColor: [200, 205, 210] },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 34 }, 2: { fontStyle: 'bold', fillColor: [240, 244, 248], cellWidth: 30 } },
      body: [
        ['Empresa', s(emp.nombre), 'NIT', s(emp.nit)],
        [{ content: 'Tema', styles: rot }, { content: s(cap.tema), colSpan: 3 }],
        ['Fecha', fecha(ses.fecha), 'Duración', ses.horas ? s(Number(ses.horas)) + ' h' : ''],
        ['Instructor', s(ses.instructor), 'Modalidad', (MODALIDAD[ses.modalidad] || s(ses.modalidad)) + (s(ses.lugar) ? ' - ' + s(ses.lugar) : '')],
      ],
    });
    y = doc.lastAutoTable.finalY + 5;
    var filas = ctx.convocados.map(function (c, i) {
      return [String(i + 1), s(c.trabajador.nombre), s(c.trabajador.tipo_documento) + ' ' + s(c.trabajador.numero_documento), s(c.trabajador.cargo), ''];
    });
    for (var k = 0; k < 2; k++) filas.push([String(filas.length + 1), '', '', '', '']);
    doc.autoTable({
      startY: y, margin: { left: M, right: M }, theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2, textColor: 30, lineColor: [150, 155, 160], minCellHeight: 13, valign: 'middle' },
      headStyles: { fillColor: AZUL, textColor: 255, fontStyle: 'bold', minCellHeight: 8 },
      columnStyles: { 0: { cellWidth: 9, halign: 'center' }, 1: { cellWidth: 52 }, 2: { cellWidth: 32 }, 3: { cellWidth: 30 }, 4: { cellWidth: 'auto' } },
      head: [['N.', 'Nombre completo', 'Documento', 'Cargo', 'Firma']],
      body: filas,
    });
    y = doc.lastAutoTable.finalY + 14;
    if (y > 245) { doc.addPage(); y = 30; }
    doc.setDrawColor(60); doc.setLineWidth(0.3);
    doc.line(M, y, M + 80, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(30);
    doc.text('Firma del instructor' + (s(ses.instructor) ? ': ' + s(ses.instructor) : ''), M, y + 4);
    doc.setFontSize(7.5); doc.setTextColor(110);
    var nota = doc.splitTextToSize('Escanee la planilla firmada, guárdela en la carpeta de capacitaciones de Drive y registre el enlace como evidencia de esta sesión en el módulo SST.', W - 2 * M);
    doc.text(nota, M, y + 11);
    pie(doc, M, s(emp.nombre) + ' - Planilla ' + fecha(ses.fecha), ahora);
    return doc;
  }

  function slug(v) {
    return s(v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function nombrePlan(emp, p) { return 'Plan_Anual_SST_' + (slug(emp.nombre) || 'empresa') + '_' + s(p.vigencia) + '.pdf'; }
  function nombrePlanilla(emp, ses) { return 'Planilla_Asistencia_' + (slug(emp.nombre) || 'empresa') + '_' + s(ses.fecha) + '.pdf'; }

  return { autoevaluacion: autoevaluacion, nombreArchivo: nombreArchivo, planAnual: planAnual, planilla: planilla, nombrePlan: nombrePlan, nombrePlanilla: nombrePlanilla };
})();
