// notificar-evento-solicitante
//
// Avisa en panel-pedidos (campanita) a quien hizo una solicitud de EVENTO cuando Mercadeo hace algo
// con ella. La llama el navegador del equipo de Mercadeo (con su sesión) justo después de cada
// cambio; esta función NO confía en lo que diga el navegador: solo recibe el id del evento y el tipo
// de aviso, y arma el mensaje con lo que realmente hay en la BD. Luego lo reenvía (server -> server,
// con el secreto compartido) a la función `solicitud-evento-aviso` del proyecto de pedidos.
//
// Eventos:
//   estado    -> el evento cambió de estado (En revisión, Aprobada, En preparación, Realizada,
//                Cerrada o Cancelada; la cancelación lleva su motivo)
//   rechazo   -> Mercadeo la rechazó (estado 'rechazada', con motivo): en Pedidos vuelve a
//                "Rechazada" para que el solicitante la corrija y la reenvíe
//   respuesta -> Mercadeo escribió una respuesta al solicitante
//
// Permiso: sesión válida y módulo 'mercadeo' (user_has_module_pqrs; admin siempre).
// Secretos: PEDIDOS_BRIDGE_SECRET (ya existe). Opcional: PEDIDOS_EVENTO_AVISO_URL (por defecto, la
// función de pedidos de producción). Desplegar con verify_jwt = true.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://logisticatecbihol.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const AVISO_URL_DEFECTO = 'https://opghwfuxrvjpbuxeykxn.supabase.co/functions/v1/solicitud-evento-aviso'
const EVENTOS = ['estado', 'rechazo', 'respuesta']

class Rechazo extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Método no permitido' })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Rechazo('No autenticado', 401)

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user } } = await supabaseUser.auth.getUser()
    if (!user) throw new Rechazo('No autenticado', 401)

    const mod = await supabaseUser.rpc('user_has_module_pqrs', { p_modulo: 'mercadeo' })
    if (mod.error) throw mod.error
    if (mod.data !== true) throw new Rechazo('Sin acceso al módulo Mercadeo', 403)

    const body = await req.json()
    const eventoId = Number(body?.evento_id)
    if (!Number.isInteger(eventoId) || eventoId < 1) throw new Rechazo('evento_id inválido')
    if (!EVENTOS.includes(body?.evento)) throw new Rechazo('evento inválido')

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const t = await admin.from('mercadeo_eventos')
      .select('id, origen, origen_ref, origen_numero, estado, motivo_rechazo, rechazado_por_nombre, motivo_cancelacion, cancelado_por_nombre, modificado_por_nombre')
      .eq('id', eventoId).maybeSingle()
    if (t.error) throw t.error
    if (!t.data) throw new Rechazo('Evento no encontrado', 404)
    const ev = t.data
    // Solo los que llegaron de Pedidos tienen a quién avisar.
    if (ev.origen !== 'panel_pedidos' || !ev.origen_ref) {
      return json(200, { ok: true, omitido: true })
    }

    // evento_id permite a Pedidos descartar avisos de un evento que ya no es el vigente
    // (p. ej. uno rechazado que el solicitante corrigió y reenvió).
    const aviso: Record<string, unknown> = {
      evento: body.evento,
      request_id: ev.origen_ref,
      numero: ev.origen_numero,
      evento_id: ev.id,
    }

    if (body.evento === 'estado') {
      aviso.estado = ev.estado
      if (ev.estado === 'cancelada') {
        aviso.motivo = ev.motivo_cancelacion
        aviso.por = ev.cancelado_por_nombre
      } else {
        aviso.por = ev.modificado_por_nombre
      }
    } else if (body.evento === 'rechazo') {
      if (ev.estado !== 'rechazada' || !ev.motivo_rechazo) {
        throw new Rechazo('El evento no está rechazado')
      }
      aviso.motivo = ev.motivo_rechazo
      aviso.por = ev.rechazado_por_nombre
    } else {
      const b = await admin.from('mercadeo_evento_bitacora')
        .select('detalle, usuario_nombre')
        .eq('evento_id', eventoId).eq('tipo_evento', 'respuesta_solicitante')
        .order('id', { ascending: false }).limit(1).maybeSingle()
      if (b.error) throw b.error
      if (!b.data) throw new Rechazo('El evento no tiene respuestas')
      aviso.texto = String(b.data.detalle?.texto ?? '').slice(0, 300)
      aviso.por = b.data.usuario_nombre
    }

    const secret = Deno.env.get('PEDIDOS_BRIDGE_SECRET')
    if (!secret) throw new Rechazo('El aviso al solicitante no está configurado', 503)
    const url = Deno.env.get('PEDIDOS_EVENTO_AVISO_URL') || AVISO_URL_DEFECTO

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
        body: JSON.stringify(aviso),
        signal: ctrl.signal,
      })
      let j: any = null
      try { j = await res.json() } catch (_e) { /* cuerpo no JSON */ }
      if (!res.ok || !j || !j.ok) {
        console.error('notificar-evento-solicitante: Pedidos respondió', res.status, JSON.stringify(j))
        throw new Rechazo('No se pudo avisar al solicitante en Pedidos', 502)
      }
      return json(200, { ok: true, avisados: j.avisados ?? null })
    } catch (e) {
      if (e instanceof Rechazo) throw e
      console.error('notificar-evento-solicitante: fallo de red hacia Pedidos:', (e as Error)?.message)
      throw new Rechazo('No se pudo avisar al solicitante en Pedidos', 502)
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    if (e instanceof Rechazo) return json(e.status, { ok: false, error: e.message })
    console.error('notificar-evento-solicitante error:', (e as Error)?.message, e)
    return json(500, { ok: false, error: 'Error interno' })
  }
})
