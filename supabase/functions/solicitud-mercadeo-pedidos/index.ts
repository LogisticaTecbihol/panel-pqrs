// solicitud-mercadeo-pedidos
//
// Puente entre panel-pedidos y el Tablero de Mercadeo. La llama SOLO la Edge
// Function `solicitud-mercadeo` del proyecto de pedidos (server -> server),
// nunca un navegador (por eso no hay CORS). Ya validó la sesión del usuario,
// su permiso y sus empresas; aquí se vuelve a validar todo porque este lado no
// confía en nadie más que en el secreto compartido.
//
// Acciones (campo `action`):
//   preparar -> valida los archivos y devuelve URLs firmadas de subida al bucket
//               privado `mercadeo-adjuntos` (el navegador sube directo, sin pasar
//               por una función: evita el límite de tamaño del cuerpo).
//   crear    -> inserta la tarea en `mercadeo_tareas` (origen 'panel_pedidos',
//               estado 'solicitada' = "Recibido") + sus adjuntos. Idempotente
//               por `request_id` (== origen_ref).
//   listar   -> "Mis solicitudes": solo las del solicitante o hechas a su nombre,
//               con una lista blanca de campos (nunca comentarios internos,
//               avales ni la bitácora completa).
//
// Autenticación: header x-bridge-secret contra el secreto PEDIDOS_BRIDGE_SECRET
// (distinto de INGEST_SHARED_SECRET, que usa el script de Google Apps Script).
//   supabase secrets set PEDIDOS_BRIDGE_SECRET=<valor largo aleatorio>
//
// Desplegar con verify_jwt = false (igual que ingest-formulario): lo que protege
// es el secreto, no un JWT.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUCKET = 'mercadeo-adjuntos'
const EMPRESAS_VALIDAS = ['PARCELAR', 'GREEN', 'RESO', 'IASO', 'IAS']

// Asunto del formulario -> etiqueta (para el título) y `tipo` del Tablero.
const ASUNTOS: Record<string, { label: string; tipo: string }> = {
  material_pop: { label: 'Material POP', tipo: 'pop' },
  material_impreso: { label: 'Material impreso', tipo: 'diseno' },
  piezas_graficas: { label: 'Piezas gráficas', tipo: 'redes' },
  piezas_audiovisuales: { label: 'Piezas audiovisuales', tipo: 'redes' },
  diseno_nuevo_producto: { label: 'Diseño de nuevo producto', tipo: 'diseno' },
  diseno_ajuste_portafolios: { label: 'Diseño y ajuste de portafolios', tipo: 'diseno' },
  diseno_ajuste_institucional: { label: 'Diseño y ajuste de material institucional', tipo: 'diseno' },
  desarrollo_marca: { label: 'Desarrollo de marca', tipo: 'diseno' },
  otros: { label: 'Otros', tipo: 'otro' },
}

const EXT_PERMITIDAS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ai', 'psd', 'eps',
  'mp4', 'mov', 'mp3', 'wav', 'zip',
]
const MAX_ARCHIVOS = 5
const MAX_ARCHIVO_BYTES = 25 * 1024 * 1024
const MAX_ABIERTAS_POR_SOLICITANTE = 30
const MAX_CREADAS_POR_HORA = 10
const ESTADOS_ABIERTOS = ['solicitada', 'confirmada', 'en_produccion', 'en_validacion']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/

class Rechazo extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function respuesta(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Comparación en tiempo constante (no revela cuántos caracteres coinciden).
function secretoValido(recibido: string | null, esperado: string | undefined): boolean {
  if (!esperado || esperado.length < 32 || !recibido) return false
  const enc = new TextEncoder()
  const a = enc.encode(recibido)
  const b = enc.encode(esperado)
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

function texto(v: unknown, campo: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new Rechazo(`${campo} es requerido`)
  const t = v.trim()
  if (t.length < min) throw new Rechazo(`${campo} debe tener al menos ${min} caracteres`)
  if (t.length > max) throw new Rechazo(`${campo} no puede superar ${max} caracteres`)
  return t
}

function uuid(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Rechazo(`${campo} inválido`)
  return v.toLowerCase()
}

function hoyBogota(): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
}

function extension(nombre: string): string {
  const i = nombre.lastIndexOf('.')
  return i >= 0 ? nombre.slice(i + 1).toLowerCase() : ''
}

function nombreSeguro(nombre: string): string {
  const base = nombre.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-zA-Z0-9._-]/g, '_')
  if (base.length <= 100) return base
  const ext = extension(base)
  return base.slice(0, 100 - (ext ? ext.length + 1 : 0)) + (ext ? '.' + ext : '')
}

function validarArchivoDeclarado(a: any, idx: number) {
  if (!a || typeof a !== 'object') throw new Rechazo(`Archivo ${idx + 1} inválido`)
  const nombre = texto(a.nombre, `Nombre del archivo ${idx + 1}`, 1, 200)
  const ext = extension(nombre)
  if (!EXT_PERMITIDAS.includes(ext)) {
    throw new Rechazo(`El archivo "${nombre}" no es de un tipo permitido (${EXT_PERMITIDAS.join(', ')})`)
  }
  const tamano = Number(a.tamano)
  if (!Number.isFinite(tamano) || tamano <= 0) throw new Rechazo(`El archivo "${nombre}" está vacío`)
  if (tamano > MAX_ARCHIVO_BYTES) throw new Rechazo(`El archivo "${nombre}" supera 25 MB`)
  return { nombre, tamano, tipo: typeof a.tipo === 'string' ? a.tipo.slice(0, 120) : null }
}

serve(async (req) => {
  if (req.method !== 'POST') return respuesta(405, { ok: false, error: 'Método no permitido' })

  if (!secretoValido(req.headers.get('x-bridge-secret'), Deno.env.get('PEDIDOS_BRIDGE_SECRET'))) {
    return respuesta(401, { ok: false, error: 'No autorizado' })
  }

  try {
    const body = await req.json()
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    switch (body?.action) {
      case 'preparar': return await preparar(admin, body)
      case 'crear': return await crear(admin, body)
      case 'listar': return await listar(admin, body)
      default: throw new Rechazo(`action inválida: ${body?.action}`)
    }
  } catch (e) {
    if (e instanceof Rechazo) return respuesta(e.status, { ok: false, error: e.message })
    console.error('solicitud-mercadeo-pedidos error:', (e as Error)?.message, e)
    return respuesta(500, { ok: false, error: 'Error interno al procesar la solicitud' })
  }
})

// ── preparar ─────────────────────────────────────────────────
async function preparar(admin: any, body: any) {
  const requestId = uuid(body.request_id, 'request_id')
  const archivos = Array.isArray(body.archivos) ? body.archivos : []
  if (archivos.length < 1) throw new Rechazo('No hay archivos para preparar')
  if (archivos.length > MAX_ARCHIVOS) throw new Rechazo(`Máximo ${MAX_ARCHIVOS} archivos por solicitud`)

  const ts = Date.now().toString(36)
  const salida = []
  for (let i = 0; i < archivos.length; i++) {
    const a = validarArchivoDeclarado(archivos[i], i)
    const path = `solicitudes/${requestId}/${i}-${ts}-${nombreSeguro(a.nombre)}`
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error || !data) throw new Error(`No se pudo preparar la subida: ${error?.message}`)
    salida.push({ indice: i, path: data.path ?? path, token: data.token, signed_url: data.signedUrl })
  }
  return respuesta(200, { ok: true, archivos: salida })
}

// ── crear ────────────────────────────────────────────────────
async function crear(admin: any, body: any) {
  const requestId = uuid(body.request_id, 'request_id')

  const sol = body.solicitante || {}
  const solicitanteId = uuid(sol.id, 'solicitante.id')
  const solicitanteNombre = texto(sol.nombre, 'solicitante.nombre', 1, 120)
  const solicitanteEmail = typeof sol.email === 'string' ? sol.email.trim().slice(0, 160) : ''
  const solicitanteRol = typeof sol.rol === 'string' ? sol.rol.trim().slice(0, 40) : ''

  let aNombreId: string | null = null
  let aNombreNombre: string | null = null
  if (body.a_nombre_de) {
    aNombreId = uuid(body.a_nombre_de.id, 'a_nombre_de.id')
    aNombreNombre = texto(body.a_nombre_de.nombre, 'a_nombre_de.nombre', 1, 120)
    if (aNombreId === solicitanteId) { aNombreId = null; aNombreNombre = null }
  }

  const empresa = body.empresa
  if (!EMPRESAS_VALIDAS.includes(empresa)) throw new Rechazo(`empresa inválida: ${empresa}`)
  const asunto = ASUNTOS[body.asunto]
  if (!asunto) throw new Rechazo(`asunto inválido: ${body.asunto}`)

  const fecha = body.fecha_tentativa
  if (typeof fecha !== 'string' || !FECHA_RE.test(fecha) || Number.isNaN(Date.parse(fecha + 'T00:00:00Z'))) {
    throw new Rechazo('fecha_tentativa inválida (use AAAA-MM-DD)')
  }
  if (fecha < hoyBogota()) throw new Rechazo('La fecha tentativa no puede ser anterior a hoy')

  const descripcion = texto(body.descripcion, 'La descripción', 10, 2000)

  // Idempotencia: el mismo envío (doble clic, reintento) devuelve la misma solicitud.
  const previa = await admin.from('mercadeo_tareas').select('id, estado').eq('origen_ref', requestId).maybeSingle()
  if (previa.error) throw previa.error
  if (previa.data) return respuesta(200, { ok: true, id: previa.data.id, estado: previa.data.estado, duplicada: true })

  // Topes por solicitante (freno a abusos/errores; son holgados para el uso normal).
  const desde = new Date(Date.now() - 3600 * 1000).toISOString()
  const [abiertas, recientes] = await Promise.all([
    admin.from('mercadeo_tareas').select('id', { count: 'exact', head: true })
      .eq('origen', 'panel_pedidos').eq('solicitante_id', solicitanteId).in('estado', ESTADOS_ABIERTOS),
    admin.from('mercadeo_tareas').select('id', { count: 'exact', head: true })
      .eq('origen', 'panel_pedidos').eq('solicitante_id', solicitanteId).gte('creado_en', desde),
  ])
  if (abiertas.error) throw abiertas.error
  if (recientes.error) throw recientes.error
  if ((abiertas.count ?? 0) >= MAX_ABIERTAS_POR_SOLICITANTE) {
    throw new Rechazo('Tienes demasiadas solicitudes abiertas; espera a que Mercadeo atienda algunas', 429)
  }
  if ((recientes.count ?? 0) >= MAX_CREADAS_POR_HORA) {
    throw new Rechazo('Has enviado muchas solicitudes en poco tiempo; intenta de nuevo en un rato', 429)
  }

  // Archivos: cada uno debe haberse subido bajo solicitudes/<request_id>/ por URL firmada.
  const declarados = Array.isArray(body.archivos) ? body.archivos : []
  if (declarados.length > MAX_ARCHIVOS) throw new Rechazo(`Máximo ${MAX_ARCHIVOS} archivos por solicitud`)
  const adjuntos: { path: string; nombre: string; tipo: string | null; tamano: number }[] = []
  if (declarados.length) {
    const carpeta = `solicitudes/${requestId}`
    const listado = await admin.storage.from(BUCKET).list(carpeta, { limit: 100 })
    if (listado.error) throw listado.error
    const enStorage = new Map<string, number>()
    for (const o of listado.data || []) enStorage.set(`${carpeta}/${o.name}`, Number(o.metadata?.size ?? 0))
    for (let i = 0; i < declarados.length; i++) {
      const a = validarArchivoDeclarado(declarados[i], i)
      const path = String(declarados[i].path || '')
      if (!path.startsWith(carpeta + '/') || path.includes('..')) throw new Rechazo(`Ruta de archivo inválida: ${a.nombre}`)
      if (!enStorage.has(path)) throw new Rechazo(`El archivo "${a.nombre}" no llegó completo; vuelve a intentarlo`)
      const real = enStorage.get(path) as number
      if (real > MAX_ARCHIVO_BYTES) throw new Rechazo(`El archivo "${a.nombre}" supera 25 MB`)
      adjuntos.push({ path, nombre: a.nombre, tipo: a.tipo, tamano: real || a.tamano })
    }
  }

  const titulo = `${asunto.label} · ${empresa} · ${aNombreNombre || solicitanteNombre}`.slice(0, 200)
  const ins = await admin.from('mercadeo_tareas').insert({
    titulo,
    descripcion,
    estado: 'solicitada',
    tipo: asunto.tipo,
    prioridad: 'mejora',
    urgente: false,
    empresas: [empresa],
    origen: 'panel_pedidos',
    origen_ref: requestId,
    solicitante_id: solicitanteId,
    solicitante_nombre: solicitanteNombre,
    solicitante_email: solicitanteEmail || null,
    solicitante_rol: solicitanteRol || null,
    a_nombre_de_id: aNombreId,
    a_nombre_de_nombre: aNombreNombre,
    asunto: body.asunto,
    fecha_tentativa: fecha,
  }).select('id, estado').single()

  if (ins.error) {
    // Carrera: otro envío con el mismo request_id ganó. Es el mismo envío: devolver esa tarea.
    if ((ins.error as any).code === '23505') {
      const otra = await admin.from('mercadeo_tareas').select('id, estado').eq('origen_ref', requestId).maybeSingle()
      if (otra.data) return respuesta(200, { ok: true, id: otra.data.id, estado: otra.data.estado, duplicada: true })
    }
    throw ins.error
  }

  if (adjuntos.length) {
    const filas = adjuntos.map((a) => ({
      tarea_id: ins.data.id,
      storage_path: a.path,
      nombre_original: a.nombre,
      tipo_mime: a.tipo,
      tamano_bytes: a.tamano,
      subido_por: null,
      subido_por_nombre: solicitanteNombre,
    }))
    const adj = await admin.from('mercadeo_tarea_adjuntos').insert(filas)
    if (adj.error) {
      // Sin adjuntos la solicitud quedaría incompleta: se deshace para que el reintento la cree bien.
      await admin.from('mercadeo_tareas').delete().eq('id', ins.data.id)
      throw adj.error
    }
  }

  return respuesta(200, { ok: true, id: ins.data.id, estado: ins.data.estado })
}

// ── listar ───────────────────────────────────────────────────
async function listar(admin: any, body: any) {
  const usuarioId = uuid(body.solicitante?.id, 'solicitante.id')

  const t = await admin.from('mercadeo_tareas')
    .select('id, titulo, asunto, empresas, estado, descripcion, fecha_tentativa, fecha_limite, creado_en, confirmada_en, entregada_en, responsables, solicitante_nombre, a_nombre_de_nombre')
    .eq('origen', 'panel_pedidos')
    .or(`solicitante_id.eq.${usuarioId},a_nombre_de_id.eq.${usuarioId}`)
    .order('id', { ascending: false })
    .limit(200)
  if (t.error) throw t.error
  const tareas = t.data || []
  if (!tareas.length) return respuesta(200, { ok: true, solicitudes: [] })

  const ids = tareas.map((x: any) => x.id)
  const idsResp = [...new Set(tareas.flatMap((x: any) => x.responsables || []))]

  const [bit, adj, usr] = await Promise.all([
    admin.from('mercadeo_tarea_bitacora')
      .select('tarea_id, tipo_evento, detalle, usuario_nombre, creado_en')
      .in('tarea_id', ids).in('tipo_evento', ['respuesta_solicitante', 'cambio_estado'])
      .order('id', { ascending: true }),
    admin.from('mercadeo_tarea_adjuntos').select('tarea_id, nombre_original, tamano_bytes').in('tarea_id', ids).order('id', { ascending: true }),
    idsResp.length
      ? admin.from('usuarios_pqrs').select('id, nombre, email').in('id', idsResp)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (bit.error) throw bit.error
  if (adj.error) throw adj.error
  if (usr.error) throw usr.error

  const nombreUsuario = new Map<string, string>()
  for (const u of usr.data || []) nombreUsuario.set(u.id, (u.nombre || '').trim() || u.email)

  const solicitudes = tareas.map((x: any) => ({
    id: x.id,
    titulo: x.titulo,
    asunto: x.asunto,
    empresas: x.empresas,
    estado: x.estado,
    descripcion: x.descripcion,
    fecha_tentativa: x.fecha_tentativa,
    fecha_comprometida: x.fecha_limite,
    creada_en: x.creado_en,
    confirmada_en: x.confirmada_en,
    entregada_en: x.entregada_en,
    solicitante: x.solicitante_nombre,
    a_nombre_de: x.a_nombre_de_nombre,
    responsables: (x.responsables || []).map((id: string) => nombreUsuario.get(id) || 'Equipo de Mercadeo'),
    historial: (bit.data || []).filter((b: any) => b.tarea_id === x.id).map((b: any) =>
      b.tipo_evento === 'cambio_estado'
        ? { tipo: 'estado', estado: b.detalle?.a, en: b.creado_en }
        : { tipo: 'respuesta', texto: b.detalle?.texto ?? '', por: b.usuario_nombre || 'Mercadeo', en: b.creado_en }),
    adjuntos: (adj.data || []).filter((a: any) => a.tarea_id === x.id)
      .map((a: any) => ({ nombre: a.nombre_original, tamano: a.tamano_bytes })),
  }))
  return respuesta(200, { ok: true, solicitudes })
}
