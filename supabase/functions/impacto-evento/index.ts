// impacto-evento
//
// Mide el impacto en VENTAS de un evento de Mercadeo: compara lo vendido por el distribuidor, en la zona y de los
// productos del evento (todo según Pedidos) contra lo vendido por el resto de la empresa en las mismas fechas.
// La llama el navegador del equipo de Mercadeo (con su sesión) desde Eventos > «Impacto en ventas». Esta función
// NO confía en lo que diga el navegador: solo recibe el id del evento, lee de la BD la fecha, la empresa, el
// municipio, el NIT del distribuidor y los productos, y le pide a la función `ventas-evento-resumen` del proyecto
// de pedidos (server -> server, con el secreto compartido) las ventas agregadas. SOLO LECTURA, nada se guarda.
//
// Qué devuelve:
//   { ok, evento: {...}, cruce: <respuesta de pedidos> }          -> hay datos para mostrar
//   { ok, evento: {...}, sin_cruce: true, motivo: '...' }         -> no aplica (rechazado, empresa sin ventas en
//                                                                    Pedidos, evento sin distribuidor ni municipio)
//
// Permiso: sesión válida y módulo 'mercadeo' (user_has_module_pqrs; admin siempre).
// Secretos: PEDIDOS_BRIDGE_SECRET (ya existe). Opcional: PEDIDOS_VENTAS_URL (por defecto, la función de pedidos de
// producción). Desplegar con verify_jwt = true. Requiere que `ventas-evento-resumen` esté desplegada en pedidos.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://logisticatecbihol.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const VENTAS_URL_DEFECTO = 'https://opghwfuxrvjpbuxeykxn.supabase.co/functions/v1/ventas-evento-resumen'
// Solo estas empresas venden por Pedidos (Chía Abagó, Tecbihol y «Otros» son etiquetas de Eventos sin ventas allá).
const EMPRESAS_PEDIDOS = ['PARCELAR', 'GREEN', 'RESO', 'IASO', 'IAS']

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

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const t = await admin.from('mercadeo_eventos')
      .select('id, estado, nombre, empresa, fecha_evento, lugar_municipio, lugar_departamento, lugar_distribuidor, lugar_distribuidor_nit, productos')
      .eq('id', eventoId).maybeSingle()
    if (t.error) throw t.error
    if (!t.data) throw new Rechazo('Evento no encontrado', 404)
    const ev = t.data
    const evento = {
      id: ev.id,
      estado: ev.estado,
      nombre: ev.nombre,
      empresa: ev.empresa,
      fecha_evento: ev.fecha_evento,
      municipio: ev.lugar_municipio || '',
      departamento: ev.lugar_departamento || '',
      distribuidor: ev.lugar_distribuidor || '',
      nit: ev.lugar_distribuidor_nit || '',
      productos: Array.isArray(ev.productos) ? ev.productos : [],
    }

    const sinCruce = (motivo: string) => json(200, { ok: true, evento, sin_cruce: true, motivo })
    if (ev.estado === 'rechazada' || ev.estado === 'cancelada') {
      return sinCruce('La solicitud está ' + (ev.estado === 'rechazada' ? 'rechazada' : 'cancelada') + ': el evento no se hizo, no hay impacto que medir.')
    }
    if (!EMPRESAS_PEDIDOS.includes(ev.empresa)) {
      return sinCruce('Esta empresa no vende por Pedidos (solo PARCELAR, GREEN, RESO, IASO e IAS), así que no hay ventas con las que cruzar.')
    }
    if (!evento.nit.trim() && !evento.municipio.trim()) {
      return sinCruce('El evento no tiene ni distribuidor con NIT ni municipio (¿es virtual?). Completa el lugar del evento para poder cruzarlo con las ventas.')
    }

    const secret = Deno.env.get('PEDIDOS_BRIDGE_SECRET')
    if (!secret) throw new Rechazo('La consulta de ventas no está configurada', 503)
    const url = Deno.env.get('PEDIDOS_VENTAS_URL') || VENTAS_URL_DEFECTO

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 25000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
        body: JSON.stringify({
          empresa: ev.empresa,
          fecha_evento: ev.fecha_evento,
          nit: evento.nit,
          municipio: evento.municipio,
          productos: evento.productos,
        }),
        signal: ctrl.signal,
      })
      let j: any = null
      try { j = await res.json() } catch (_e) { /* cuerpo no JSON */ }
      if (!res.ok || !j || !j.ok) {
        console.error('impacto-evento: Pedidos respondió', res.status, JSON.stringify(j))
        // 404 = la función de ventas aún no está desplegada en Pedidos; 401 = el secreto no coincide.
        if (res.status === 404) throw new Rechazo('Pedidos todavía no tiene habilitada la consulta de ventas (falta desplegar ventas-evento-resumen)', 502)
        if (res.status === 401) throw new Rechazo('Pedidos rechazó la consulta: el secreto del puente no coincide', 502)
        throw new Rechazo('No se pudieron consultar las ventas en Pedidos', 502)
      }
      return json(200, { ok: true, evento, cruce: j })
    } catch (e) {
      if (e instanceof Rechazo) throw e
      console.error('impacto-evento: fallo de red hacia Pedidos:', (e as Error)?.message)
      throw new Rechazo('No se pudieron consultar las ventas en Pedidos', 502)
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    if (e instanceof Rechazo) return json(e.status, { ok: false, error: e.message })
    console.error('impacto-evento error:', (e as Error)?.message, e)
    return json(500, { ok: false, error: 'Error interno' })
  }
})
