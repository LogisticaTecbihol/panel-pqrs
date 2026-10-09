// PDF de la autoevaluación de estándares mínimos (SG-SST, Res. 312 de 2019).
// Usa jsPDF 2.5.2 + jspdf-autotable 3.8.4 (mismas versiones que el panel de pedidos), cargadas con
// <script defer> en sst.html. Carta vertical. Solo caracteres de la fuente estándar de jsPDF
// (Latin-1: admite tildes y ñ): sin emojis ni flechas.
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

  return { autoevaluacion: autoevaluacion, nombreArchivo: nombreArchivo };
})();
