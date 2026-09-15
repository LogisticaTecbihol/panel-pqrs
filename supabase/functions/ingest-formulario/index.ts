// ingest-formulario
//
// Llamada SOLO por el puente de Google Apps Script (google-apps-script/ingest-template.gs),
// nunca por un navegador. Maneja las dos ramas del mismo Google Form:
//   - tipo_registro = 'pqrs'     -> tabla pqrs (+ pqrs_adjuntos + pqrs_bitacora + aviso por correo)
//   - tipo_registro = 'encuesta' -> tabla encuestas_satisfaccion (sin folio, sin aviso)
//
// Autenticación: header x-ingest-secret comparado contra el secreto guardado con
// `supabase secrets set INGEST_SHARED_SECRET=...` -- nunca la service_role key completa
// llega al script de Apps Script (principio de mínimo privilegio).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-secret',
}

const EMPRESAS_VALIDAS = ['PARCELAR', 'GREEN', 'RESO', 'IASO', 'IAS']
const TIPOS_SOLICITUD = ['Peticion', 'Queja', 'Reclamo', 'Sugerencia']
const AREAS = ['Produccion', 'Servicio al cliente', 'Ventas', 'Estado del producto', 'Logistica', 'Pos venta', 'Otro']
const URGENCIAS = ['ALTO', 'MEDIO', 'BAJA']
const CANALES = ['Directo', 'Distribuidor autorizado', 'Tienda agropecuaria local', 'Otro']

function badRequest(message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const secretHeader = req.headers.get('x-ingest-secret')
    const expectedSecret = Deno.env.get('INGEST_SHARED_SECRET')
    if (!expectedSecret || secretHeader !== expectedSecret) {
      return new Response(JSON.stringify({ ok: false, error: 'No autorizado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()
    const { tipo_registro, empresa_sigla } = body

    if (!EMPRESAS_VALIDAS.includes(empresa_sigla)) {
      return badRequest(`empresa_sigla inválida: ${empresa_sigla}`)
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    if (tipo_registro === 'pqrs') {
      return await handlePqrs(supabaseAdmin, body)
    } else if (tipo_registro === 'encuesta') {
      return await handleEncuesta(supabaseAdmin, body)
    } else {
      return badRequest(`tipo_registro inválido: ${tipo_registro}`)
    }
  } catch (error) {
    console.error('ingest-formulario error:', error?.message, error)
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

async function handlePqrs(supabaseAdmin: ReturnType<typeof createClient>, body: any) {
  const {
    empresa_sigla,
    nombre_completo,
    contacto,
    identificacion_cliente,
    tipo_solicitud,
    fecha_evento,
    area_relacionada,
    referencia_pedido,
    producto_lote,
    ciudad_departamento,
    descripcion,
    urgencia,
    desea_respuesta,
    comentarios_adicionales,
    creado_en, // opcional: solo lo usa el script de importación histórica
    adjuntos, // [{drive_file_id, nombre, tipo_mime, tamano_bytes, url}]
  } = body

  if (!contacto) return badRequest('contacto es requerido')
  if (!TIPOS_SOLICITUD.includes(tipo_solicitud)) return badRequest(`tipo_solicitud inválido: ${tipo_solicitud}`)
  if (!AREAS.includes(area_relacionada)) return badRequest(`area_relacionada inválida: ${area_relacionada}`)
  if (!descripcion) return badRequest('descripcion es requerida')
  if (!URGENCIAS.includes(urgencia)) return badRequest(`urgencia inválida: ${urgencia}`)
  if (typeof desea_respuesta !== 'boolean') return badRequest('desea_respuesta debe ser boolean')

  const { data: folio, error: folioError } = await supabaseAdmin.rpc('generar_consecutivo_pqrs', {
    p_empresa_sigla: empresa_sigla,
  })
  if (folioError) throw folioError

  const insertRow: Record<string, unknown> = {
    folio,
    empresa_sigla,
    nombre_completo: nombre_completo || null,
    contacto,
    identificacion_cliente: identificacion_cliente || null,
    tipo_solicitud,
    fecha_evento: fecha_evento || null,
    area_relacionada,
    referencia_pedido: referencia_pedido || null,
    producto_lote: producto_lote || null,
    ciudad_departamento: ciudad_departamento || null,
    descripcion,
    urgencia,
    desea_respuesta,
    comentarios_adicionales: comentarios_adicionales || null,
  }
  if (creado_en) insertRow.creado_en = creado_en // solo importación histórica

  const { data: pqrsRow, error: insertError } = await supabaseAdmin
    .from('pqrs')
    .insert(insertRow)
    .select('id, folio')
    .single()
  if (insertError) throw insertError

  if (Array.isArray(adjuntos) && adjuntos.length > 0) {
    const adjuntosRows = adjuntos
      .filter((a: any) => a && a.url)
      .slice(0, 5)
      .map((a: any) => ({
        pqrs_id: pqrsRow.id,
        origen: 'cliente_drive',
        drive_file_id: a.drive_file_id || null,
        drive_url: a.url,
        nombre_original: a.nombre || null,
        tipo_mime: a.tipo_mime || null,
        tamano_bytes: a.tamano_bytes || null,
      }))
    if (adjuntosRows.length > 0) {
      const { error: adjError } = await supabaseAdmin.from('pqrs_adjuntos').insert(adjuntosRows)
      if (adjError) throw adjError
    }
  }

  const { error: bitacoraError } = await supabaseAdmin.from('pqrs_bitacora').insert({
    pqrs_id: pqrsRow.id,
    tipo_evento: 'creacion',
    detalle: { origen: creado_en ? 'importacion_historica' : 'formulario_google' },
  })
  if (bitacoraError) throw bitacoraError

  // Aviso al equipo interno. Nunca debe hacer fallar la respuesta: el registro
  // ya quedó guardado pase lo que pase con el correo.
  if (!creado_en) {
    try {
      await enviarAvisoEquipo(pqrsRow.folio, body)
      await supabaseAdmin.from('pqrs_bitacora').insert({
        pqrs_id: pqrsRow.id,
        tipo_evento: 'notificacion_enviada',
        detalle: { canal: 'resend' },
      })
    } catch (mailError) {
      console.error('No se pudo enviar el aviso por correo:', mailError)
    }
  }

  return new Response(JSON.stringify({ ok: true, folio: pqrsRow.folio }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handleEncuesta(supabaseAdmin: ReturnType<typeof createClient>, body: any) {
  const {
    empresa_sigla,
    municipio,
    asesor_nombre,
    canal_adquisicion,
    canal_adquisicion_otro,
    calificacion_calidad_producto,
    calificacion_atencion_asesor_tecnico,
    calificacion_atencion_servicio_logistica,
    calificacion_tiempos_respuesta,
    calificacion_relacion_calidad_precio,
    calificacion_satisfaccion_general,
    comentarios_adicionales,
    creado_en, // opcional: solo importación histórica
  } = body

  if (!municipio) return badRequest('municipio es requerido')
  if (!CANALES.includes(canal_adquisicion)) return badRequest(`canal_adquisicion inválido: ${canal_adquisicion}`)

  const calificaciones = {
    calificacion_calidad_producto,
    calificacion_atencion_asesor_tecnico,
    calificacion_atencion_servicio_logistica,
    calificacion_tiempos_respuesta,
    calificacion_relacion_calidad_precio,
    calificacion_satisfaccion_general,
  }
  for (const [campo, valor] of Object.entries(calificaciones)) {
    if (typeof valor !== 'number' || valor < 1 || valor > 5) {
      return badRequest(`${campo} debe ser un número entre 1 y 5`)
    }
  }

  const insertRow: Record<string, unknown> = {
    empresa_sigla,
    municipio,
    asesor_nombre: asesor_nombre || null,
    canal_adquisicion,
    canal_adquisicion_otro: canal_adquisicion_otro || null,
    ...calificaciones,
    comentarios_adicionales: comentarios_adicionales || null,
  }
  if (creado_en) insertRow.creado_en = creado_en

  const { error } = await supabaseAdmin.from('encuestas_satisfaccion').insert(insertRow)
  if (error) throw error

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function enviarAvisoEquipo(folio: string, body: any) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  const to = Deno.env.get('NOTIFY_TEAM_EMAILS')
  if (!apiKey || !to) {
    console.log('RESEND_API_KEY o NOTIFY_TEAM_EMAILS no configurados; se omite el aviso por correo.')
    return
  }

  const panelBaseUrl = Deno.env.get('PANEL_BASE_URL') || 'https://logisticatecbihol.github.io/panel-pqrs'
  const descripcionCorta = String(body.descripcion || '').slice(0, 500)
  const urgenciaTag = body.urgencia === 'ALTO' ? ' 🔴 URGENCIA ALTA' : ''

  const html = `
    <h2>Nuevo PQRS: ${folio}${urgenciaTag}</h2>
    <p><b>Empresa:</b> ${body.empresa_sigla}</p>
    <p><b>Tipo:</b> ${body.tipo_solicitud} &mdash; <b>Área:</b> ${body.area_relacionada} &mdash; <b>Urgencia:</b> ${body.urgencia}</p>
    <p><b>Fecha del evento:</b> ${body.fecha_evento || '—'}</p>
    ${body.desea_respuesta ? `<p><b>Contacto:</b> ${body.contacto}</p>` : ''}
    <p><b>Descripción:</b> ${descripcionCorta}</p>
    <p><b>Adjuntos:</b> ${(body.adjuntos || []).length}</p>
    <p><a href="${panelBaseUrl}/panel/dashboard.html?folio=${encodeURIComponent(folio)}">Ver en el panel</a></p>
  `

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: Deno.env.get('RESEND_FROM') || 'PQRS <onboarding@resend.dev>',
      to: to.split(',').map((s) => s.trim()),
      subject: `Nuevo PQRS ${folio} (${body.empresa_sigla})`,
      html,
    }),
  })
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${await res.text()}`)
  }
}
