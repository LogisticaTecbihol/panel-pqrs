// solicitud-evento-pedidos
//
// Puente entre panel-pedidos y el módulo de Eventos de Mercadeo (migración 0031). La llama SOLO la
// Edge Function `solicitud-evento` del proyecto de pedidos (server -> server), nunca un navegador
// (por eso no hay CORS). Ya validó la sesión del usuario, su permiso y sus empresas; aquí se vuelve
// a validar todo porque este lado no confía en nadie más que en el secreto compartido.
//
// Acciones (campo `action`):
//   preparar -> valida los archivos y devuelve URLs firmadas de subida al bucket privado
//               `mercadeo-adjuntos` (ruta eventos/<request_id>/…; el navegador sube directo).
//   crear    -> inserta el evento en `mercadeo_eventos` (origen 'panel_pedidos', estado 'radicada')
//               + sus adjuntos. Idempotente por `request_id` (== origen_ref). Se llama cuando la
//               solicitud YA fue aprobada en Pedidos (con quién la aprobó y su N° SE-n). Las reglas
//               de negocio (modalidad, fechas, desglose…) las vuelve a exigir el trigger de la BD.
//   firmar   -> URLs firmadas de lectura (1 h) de archivos ya subidos, para que el aprobador los
//               revise antes de aprobar.
//   listar   -> "Mis solicitudes": solo las del solicitante (enviadas por él o a su nombre) o las
//               vigentes de una lista de solicitudes (`request_ids`, vista de aprobadores), con una
//               lista blanca de campos (nunca comentarios internos).
//   observar -> el solicitante, a nombre de quién se hizo o un aprobador le escribe una OBSERVACIÓN
//               a Mercadeo. Queda en la bitácora del evento y el trigger avisa al equipo (campanita).
//   retirar  -> el solicitante MODIFICÓ una solicitud ya aprobada en Pedidos: el evento vigente sale
//               del módulo (estado 'cancelada' con el motivo) y la solicitud vuelve a aprobación; al
//               aprobarse llega como evento NUEVO. Solo si Mercadeo aún no lo aprobó (radicada o
//               en_revision); idempotente.
//
// Autenticación: header x-bridge-secret contra PEDIDOS_BRIDGE_SECRET (el mismo de
// solicitud-mercadeo-pedidos). Desplegar con verify_jwt = false: lo que protege es el secreto.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUCKET = 'mercadeo-adjuntos'
// Las 5 del holding + 3 adicionales de los eventos (migración 0032): OTROS exige el nombre escrito (empresa_otra).
const EMPRESAS_VALIDAS = ['PARCELAR', 'GREEN', 'RESO', 'IASO', 'IAS', 'CHIA_ABAGO', 'TECBIHOL', 'OTROS']
const MODALIDADES = ['fisico', 'virtual', 'hibrido']
const OBJETIVOS = ['leads', 'relacion_clientes', 'lanzamiento', 'posicionamiento', 'capacitacion', 'trafico_digital', 'retencion']
const CANALES = ['email', 'redes', 'web', 'relaciones_publicas', 'publicidad_digital', 'video']
const MATERIALES = ['banners_redes', 'diseno_email', 'invitaciones', 'presentacion', 'flyers', 'rollups', 'merchandising']
const LOGISTICA = ['registros', 'coordinacion_logistica', 'plataforma_virtual', 'presencia_mercadeo']

const EXT_PERMITIDAS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ai', 'psd', 'eps',
  'mp4', 'mov', 'mp3', 'wav', 'zip',
]
const MAX_ARCHIVOS = 5
const MAX_ARCHIVO_BYTES = 25 * 1024 * 1024
const MAX_SIN_APROBAR_POR_SOLICITANTE = 30
const MAX_CREADOS_POR_HORA = 10
const MAX_OBSERVACIONES_POR_HORA = 10
// Estados en los que el solicitante todavía puede dejarle una observación a Mercadeo.
const ESTADOS_ABIERTOS = ['radicada', 'en_revision', 'aprobada', 'en_preparacion', 'realizada']
// Estados en los que el evento aún no fue aprobado por Mercadeo (se puede retirar).
const ESTADOS_SIN_APROBAR = ['radicada', 'en_revision']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

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

// Texto opcional: vacío si no viene.
function textoOpc(v: unknown, campo: string, max: number): string {
  if (v === null || v === undefined || v === '') return ''
  return texto(v, campo, 0, max)
}

function uuid(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new Rechazo(`${campo} inválido`)
  return v.toLowerCase()
}

function fecha(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !FECHA_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new Rechazo(`${campo} no es una fecha válida (AAAA-MM-DD)`)
  }
  return v
}

function fechaOpc(v: unknown, campo: string): string | null {
  return v === null || v === undefined || v === '' ? null : fecha(v, campo)
}

function hora(v: unknown, campo: string): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || !HORA_RE.test(v)) throw new Rechazo(`${campo} no es una hora válida (HH:MM)`)
  return v.slice(0, 5)
}

function enteroOpc(v: unknown, campo: string): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Rechazo(`${campo} debe ser un número entero entre 0 y 100000`)
  return n
}

function monto(v: unknown, campo: string): number {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100000000000) throw new Rechazo(`${campo} no es un valor válido`)
  return n
}

function lista(v: unknown, validos: string[], campo: string): string[] {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) throw new Rechazo(`${campo} inválido`)
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || !validos.includes(x)) throw new Rechazo(`${campo}: opción inválida`)
    if (!out.includes(x)) out.push(x)
  }
  return out
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

// Errores de la BD: los RAISE EXCEPTION de los triggers (P0001) están en español y son para el
// usuario; los de CHECK/NOT NULL se traducen a un mensaje general (el detalle técnico no sale).
function errorBD(e: any): never {
  if (e && e.code === 'P0001' && e.message) throw new Rechazo(String(e.message), 400)
  if (e && (e.code === '23514' || e.code === '23502' || e.code === '22P02' || e.code === '22007')) {
    console.error('solicitud-evento-pedidos: dato rechazado por la BD:', e.code, e.message)
    throw new Rechazo('Algún dato del formulario no es válido; revísalo e inténtalo de nuevo', 400)
  }
  throw e
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
      case 'firmar': return await firmar(admin, body)
      case 'listar': return await listar(admin, body)
      case 'retirar': return await retirar(admin, body)
      case 'observar': return await observar(admin, body)
      default: throw new Rechazo(`action inválida: ${body?.action}`)
    }
  } catch (e) {
    if (e instanceof Rechazo) return respuesta(e.status, { ok: false, error: e.message })
    console.error('solicitud-evento-pedidos error:', (e as Error)?.message, e)
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
    const path = `eventos/${requestId}/${i}-${ts}-${nombreSeguro(a.nombre)}`
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error || !data) throw new Error(`No se pudo preparar la subida: ${error?.message}`)
    salida.push({ indice: i, path: data.path ?? path, token: data.token, signed_url: data.signedUrl })
  }
  return respuesta(200, { ok: true, archivos: salida })
}

// ── crear ────────────────────────────────────────────────────
async function crear(admin: any, body: any) {
  const requestId = uuid(body.request_id, 'request_id')

  const numeroOrigen = Number(body.numero_origen)
  if (!Number.isInteger(numeroOrigen) || numeroOrigen < 1) throw new Rechazo('numero_origen inválido')
  const aprobadaPor = texto(body.aprobada_por, 'aprobada_por', 1, 120)

  const env = body.enviado_por || {}
  const enviadoPorId = uuid(env.id, 'enviado_por.id')
  const enviadoPorNombre = texto(env.nombre, 'enviado_por.nombre', 1, 120)

  const d = body.datos || {}
  const sol = d.solicitante || {}
  const solicitanteId = sol.id ? uuid(sol.id, 'solicitante.id') : null

  const empresa = d.empresa
  if (!EMPRESAS_VALIDAS.includes(empresa)) throw new Rechazo(`empresa inválida: ${empresa}`)
  const empresaOtra = empresa === 'OTROS' ? texto(d.empresa_otra, 'El nombre de la empresa', 3, 100).replace(/\s+/g, ' ') : ''
  const modalidad = d.modalidad
  if (!MODALIDADES.includes(modalidad)) throw new Rechazo(`modalidad inválida: ${modalidad}`)

  const hoy = hoyBogota()
  const fechaRadicacion = fecha(body.fecha_radicacion, 'La fecha de radicación')
  if (fechaRadicacion > hoy) throw new Rechazo('La fecha de radicación no puede ser futura')
  const fechaEvento = fecha(d.fecha_evento, 'La fecha del evento')

  const fila = {
    estado: 'radicada',
    empresa,
    empresa_otra: empresaOtra,
    origen: 'panel_pedidos',
    origen_ref: requestId,
    origen_numero: numeroOrigen,
    enviado_por_id: enviadoPorId,
    enviado_por_nombre: enviadoPorNombre,
    aprobada_origen_por_nombre: aprobadaPor,
    aprobada_origen_en: new Date().toISOString(),
    fecha_radicacion: fechaRadicacion,
    solicitante_id: solicitanteId,
    solicitante_nombre: texto(sol.nombre, 'El nombre del solicitante', 2, 120),
    solicitante_area: textoOpc(sol.area, 'El departamento/área', 120),
    solicitante_correo: textoOpc(sol.correo, 'El correo', 160),
    solicitante_telefono: textoOpc(sol.telefono, 'El teléfono', 40),
    fecha_limite_aprobacion: fechaOpc(d.fecha_limite_aprobacion, 'La fecha límite de aprobación'),
    nombre: texto(d.nombre, 'El nombre del evento', 3, 200),
    descripcion: texto(d.descripcion, 'La descripción del evento', 10, 2000),
    fecha_evento: fechaEvento,
    hora_inicio: hora(d.hora_inicio, 'La hora de inicio'),
    hora_fin: hora(d.hora_fin, 'La hora de fin'),
    modalidad,
    lugar: textoOpc(d.lugar, 'El lugar', 300),
    lugar_municipio: textoOpc(d.lugar_municipio, 'El municipio', 60),
    lugar_departamento: textoOpc(d.lugar_departamento, 'El departamento', 40),
    lugar_distribuidor: textoOpc(d.lugar_distribuidor, 'El distribuidor o cliente', 120),
    lugar_distribuidor_nit: textoOpc(d.lugar_distribuidor_nit, 'El NIT del distribuidor o cliente', 25),
    lugar_finca: textoOpc(d.lugar_finca, 'La finca', 100),
    plataforma: textoOpc(d.plataforma, 'La plataforma', 200),
    objetivos: lista(d.objetivos, OBJETIVOS, 'Objetivos'),
    objetivos_otro: textoOpc(d.objetivos_otro, 'Otros objetivos', 300),
    publico_objetivo: textoOpc(d.publico_objetivo, 'El público objetivo', 500),
    segmento_demografico: textoOpc(d.segmento_demografico, 'El segmento demográfico', 500),
    segmento_profesional: textoOpc(d.segmento_profesional, 'El segmento profesional', 500),
    nivel_conocimiento: textoOpc(d.nivel_conocimiento, 'El nivel de conocimiento', 300),
    total_invitados: enteroOpc(d.total_invitados, 'El total de invitados'),
    asistentes_presencial: enteroOpc(d.asistentes_presencial, 'Los asistentes presenciales'),
    asistentes_virtual: enteroOpc(d.asistentes_virtual, 'Los asistentes virtuales'),
    canales: lista(d.canales, CANALES, 'Canales de promoción'),
    canales_otro: textoOpc(d.canales_otro, 'Otros canales', 300),
    materiales: lista(d.materiales, MATERIALES, 'Materiales'),
    materiales_otro: textoOpc(d.materiales_otro, 'Otros materiales', 300),
    logistica: lista(d.logistica, LOGISTICA, 'Logística'),
    logistica_otro: textoOpc(d.logistica_otro, 'Otra logística', 300),
    presupuesto_estimado: monto(d.presupuesto_estimado, 'El presupuesto estimado'),
    total_solicitado: monto(d.total_solicitado, 'El total solicitado a Mercadeo'),
    desglose_gastos: Array.isArray(d.desglose_gastos) ? d.desglose_gastos : [],
  }

  // Idempotencia: el mismo envío (doble clic, reintento) devuelve el mismo evento.
  // Un evento RECHAZADO o RETIRADO no cuenta: si el solicitante lo corrige y lo reenvía, llega uno nuevo.
  const previa = await admin.from('mercadeo_eventos').select('id, estado').eq('origen_ref', requestId).not('estado', 'in', '(rechazada,cancelada)').maybeSingle()
  if (previa.error) throw previa.error
  if (previa.data) return respuesta(200, { ok: true, id: previa.data.id, estado: previa.data.estado, duplicada: true })

  // Topes por solicitante (freno a abusos/errores; son holgados para el uso normal).
  const desde = new Date(Date.now() - 3600 * 1000).toISOString()
  const [abiertos, recientes] = await Promise.all([
    admin.from('mercadeo_eventos').select('id', { count: 'exact', head: true })
      .eq('origen', 'panel_pedidos').eq('enviado_por_id', enviadoPorId).in('estado', ESTADOS_SIN_APROBAR),
    admin.from('mercadeo_eventos').select('id', { count: 'exact', head: true })
      .eq('origen', 'panel_pedidos').eq('enviado_por_id', enviadoPorId).gte('creado_en', desde),
  ])
  if (abiertos.error) throw abiertos.error
  if (recientes.error) throw recientes.error
  if ((abiertos.count ?? 0) >= MAX_SIN_APROBAR_POR_SOLICITANTE) {
    throw new Rechazo('Tienes demasiadas solicitudes de evento esperando a Mercadeo; espera a que atienda algunas', 429)
  }
  if ((recientes.count ?? 0) >= MAX_CREADOS_POR_HORA) {
    throw new Rechazo('Has enviado muchas solicitudes en poco tiempo; intenta de nuevo en un rato', 429)
  }

  // Archivos: cada uno debe haberse subido bajo eventos/<request_id>/ por URL firmada.
  const declarados = Array.isArray(body.archivos) ? body.archivos : []
  if (declarados.length > MAX_ARCHIVOS) throw new Rechazo(`Máximo ${MAX_ARCHIVOS} archivos por solicitud`)
  const adjuntos: { path: string; nombre: string; tipo: string | null; tamano: number }[] = []
  if (declarados.length) {
    const carpeta = `eventos/${requestId}`
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

  const ins = await admin.from('mercadeo_eventos').insert(fila).select('id, estado').single()
  if (ins.error) {
    // Carrera: otro envío con el mismo request_id ganó. Es el mismo envío: devolver ese evento.
    if ((ins.error as any).code === '23505') {
      const otra = await admin.from('mercadeo_eventos').select('id, estado').eq('origen_ref', requestId).not('estado', 'in', '(rechazada,cancelada)').maybeSingle()
      if (otra.data) return respuesta(200, { ok: true, id: otra.data.id, estado: otra.data.estado, duplicada: true })
    }
    errorBD(ins.error)
  }

  if (adjuntos.length) {
    const filas = adjuntos.map((a) => ({
      evento_id: ins.data.id,
      storage_path: a.path,
      nombre_original: a.nombre,
      tipo_mime: a.tipo,
      tamano_bytes: a.tamano,
      subido_por: null,
      subido_por_nombre: enviadoPorNombre,
    }))
    const adj = await admin.from('mercadeo_evento_adjuntos').insert(filas)
    if (adj.error) {
      // Sin adjuntos el evento quedaría incompleto: se deshace para que el reintento lo cree bien.
      await admin.from('mercadeo_eventos').delete().eq('id', ins.data.id)
      throw adj.error
    }
  }

  return respuesta(200, { ok: true, id: ins.data.id, estado: ins.data.estado })
}

// ── retirar ──────────────────────────────────────────────────
// El evento vigente de una solicitud (origen_ref = request_id) sale del módulo porque el solicitante
// la modificó. Usa el estado final 'cancelada': el trigger de la migración 0031 respeta el nombre que
// manda el puente y avisa al equipo (campanita).
async function retirar(admin: any, body: any) {
  const requestId = uuid(body.request_id, 'request_id')
  const por = texto(body.por?.nombre, 'por.nombre', 1, 120)
  const motivo = texto(body.motivo, 'El motivo', 3, 500)

  // A lo sumo un evento vigente (no rechazado ni cancelado) por origen_ref (índice único parcial).
  const t = await admin.from('mercadeo_eventos').select('id, estado')
    .eq('origen', 'panel_pedidos').eq('origen_ref', requestId).not('estado', 'in', '(rechazada,cancelada)').maybeSingle()
  if (t.error) throw t.error
  // Ya no hay evento vigente (p. ej. Mercadeo lo rechazó antes o este mismo retiro ya corrió).
  if (!t.data) return respuesta(200, { ok: true, retirada: false })

  if (!ESTADOS_SIN_APROBAR.includes(t.data.estado)) {
    throw new Rechazo(
      t.data.estado === 'cerrada'
        ? 'Mercadeo ya cerró el evento; ya no se puede modificar'
        : 'Mercadeo ya aprobó el evento; para pedir cambios escríbele una observación',
      409,
    )
  }

  const u = await admin.from('mercadeo_eventos')
    .update({ estado: 'cancelada', motivo_cancelacion: motivo, cancelado_por_nombre: por })
    .eq('id', t.data.id).in('estado', ESTADOS_SIN_APROBAR).select('id').maybeSingle()
  if (u.error) errorBD(u.error)
  // Otro cambio lo movió entre la lectura y la escritura: se vuelve a mirar.
  if (!u.data) {
    const otra = await admin.from('mercadeo_eventos').select('id, estado').eq('id', t.data.id).maybeSingle()
    if (otra.error) throw otra.error
    if (otra.data && otra.data.estado !== 'cancelada') {
      throw new Rechazo('El evento cambió de estado en Mercadeo; intenta de nuevo', 409)
    }
  }
  return respuesta(200, { ok: true, retirada: true, id: t.data.id })
}

// ── observar ─────────────────────────────────────────────────
async function observar(admin: any, body: any) {
  const requestId = uuid(body.request_id, 'request_id')
  const porId = uuid(body.por?.id, 'por.id')
  const porNombre = texto(body.por?.nombre, 'por.nombre', 1, 120)
  const como = body.como
  if (como !== 'solicitante' && como !== 'aprobador') throw new Rechazo('como inválido')
  // Se conservan los saltos de línea, pero no los espacios ni las líneas en blanco de sobra.
  const limpio = typeof body.texto === 'string'
    ? body.texto.replace(/[ \t]+/g, ' ').replace(/ ?\r?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    : body.texto
  const obs = texto(limpio, 'La observación', 5, 1000)

  const t = await admin.from('mercadeo_eventos').select('id, estado')
    .eq('origen', 'panel_pedidos').eq('origen_ref', requestId).not('estado', 'in', '(rechazada,cancelada)').maybeSingle()
  if (t.error) throw t.error
  if (!t.data) throw new Rechazo('La solicitud no está en el módulo de Eventos de Mercadeo', 409)
  if (body.evento_id != null && Number(body.evento_id) !== Number(t.data.id)) {
    throw new Rechazo('La solicitud cambió en Mercadeo; recarga la lista e inténtalo de nuevo', 409)
  }
  if (!ESTADOS_ABIERTOS.includes(t.data.estado)) {
    throw new Rechazo('Mercadeo ya cerró el evento; ya no se pueden enviar observaciones', 409)
  }

  // Tope por evento (freno al ruido en la campanita del equipo; holgado para el uso normal).
  const desde = new Date(Date.now() - 3600 * 1000).toISOString()
  const recientes = await admin.from('mercadeo_evento_bitacora').select('id', { count: 'exact', head: true })
    .eq('evento_id', t.data.id).eq('tipo_evento', 'observacion_solicitante').gte('creado_en', desde)
  if (recientes.error) throw recientes.error
  if ((recientes.count ?? 0) >= MAX_OBSERVACIONES_POR_HORA) {
    throw new Rechazo('Has enviado muchas observaciones en poco tiempo; intenta de nuevo en un rato', 429)
  }

  const ins = await admin.from('mercadeo_evento_bitacora').insert({
    evento_id: t.data.id,
    tipo_evento: 'observacion_solicitante',
    detalle: { texto: obs, como, solicitante_nombre: porNombre, solicitante_id: porId },
  })
  if (ins.error) throw ins.error
  return respuesta(200, { ok: true, id: t.data.id })
}

// ── firmar ───────────────────────────────────────────────────
// Solo archivos bajo eventos/<request_id>/ ; devuelve, por cada ruta, si existe y su URL de lectura.
async function firmar(admin: any, body: any) {
  const requestId = uuid(body.request_id, 'request_id')
  const paths = Array.isArray(body.paths) ? body.paths : []
  if (paths.length < 1 || paths.length > MAX_ARCHIVOS * 2) throw new Rechazo('Cantidad de rutas inválida')
  const carpeta = `eventos/${requestId}/`
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith(carpeta) || p.includes('..')) throw new Rechazo('Ruta de archivo inválida')
  }
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrls(paths, 3600)
  if (error) throw error
  const porRuta = new Map<string, any>()
  for (const d of data || []) porRuta.set(d.path, d)
  const archivos = paths.map((p: string) => {
    const d = porRuta.get(p)
    const url = d && !d.error ? d.signedUrl : null
    return { path: p, existe: !!url, url }
  })
  return respuesta(200, { ok: true, archivos })
}

// ── listar ───────────────────────────────────────────────────
// Dos modos: los del usuario (`solicitante.id`: enviados por él o a su nombre) o los eventos vigentes
// de una lista de solicitudes (`request_ids`, la vista de aprobadores de Pedidos).
async function listar(admin: any, body: any) {
  let q = admin.from('mercadeo_eventos')
    .select('id, origen_ref, estado, nombre, empresa, empresa_otra, fecha_evento, hora_inicio, modalidad, extemporanea, dias_anticipacion, fecha_radicacion, ' +
      'respondida_en, aprobado_por_nombre, aprobado_en, motivo_rechazo, rechazado_por_nombre, rechazado_en, motivo_cancelacion, cancelado_por_nombre, ' +
      'cancelado_en, realizado_en, bd_asistentes_fecha, bd_no_aplica, cerrado_en, creado_en')
    .eq('origen', 'panel_pedidos')
  if (Array.isArray(body.request_ids)) {
    if (body.request_ids.length < 1) return respuesta(200, { ok: true, eventos: [] })
    if (body.request_ids.length > 200) throw new Rechazo('Demasiadas solicitudes en una consulta')
    q = q.in('origen_ref', body.request_ids.map((x: unknown) => uuid(x, 'request_ids'))).not('estado', 'in', '(rechazada,cancelada)')
  } else {
    const usuarioId = uuid(body.solicitante?.id, 'solicitante.id')
    q = q.or(`enviado_por_id.eq.${usuarioId},solicitante_id.eq.${usuarioId}`)
  }
  const t = await q.order('id', { ascending: false }).limit(200)
  if (t.error) throw t.error
  const eventos = t.data || []
  if (!eventos.length) return respuesta(200, { ok: true, eventos: [] })

  const ids = eventos.map((x: any) => x.id)
  const [bit, adj, chk] = await Promise.all([
    admin.from('mercadeo_evento_bitacora')
      .select('evento_id, tipo_evento, detalle, usuario_nombre, creado_en')
      .in('evento_id', ids).in('tipo_evento', ['respuesta_solicitante', 'cambio_estado', 'observacion_solicitante'])
      .order('id', { ascending: true }),
    admin.from('mercadeo_evento_adjuntos').select('evento_id, nombre_original, tamano_bytes').in('evento_id', ids).order('id', { ascending: true }),
    // Solo el AVANCE del checklist de actividades (cuántas van); las notas y los responsables son internos de Mercadeo.
    admin.from('mercadeo_evento_checklist').select('evento_id, hecha').in('evento_id', ids),
  ])
  if (bit.error) throw bit.error
  if (adj.error) throw adj.error
  if (chk.error) throw chk.error
  const avance = new Map<number, { total: number; hechas: number }>()
  for (const c of chk.data || []) {
    const a = avance.get(c.evento_id) || { total: 0, hechas: 0 }
    a.total += 1
    if (c.hecha) a.hechas += 1
    avance.set(c.evento_id, a)
  }

  const salida = eventos.map((x: any) => ({
    id: x.id,
    origen_ref: x.origen_ref,
    estado: x.estado,
    nombre: x.nombre,
    empresa: x.empresa,
    empresa_otra: x.empresa_otra,
    fecha_evento: x.fecha_evento,
    hora_inicio: x.hora_inicio,
    modalidad: x.modalidad,
    extemporanea: x.extemporanea,
    dias_anticipacion: x.dias_anticipacion,
    fecha_radicacion: x.fecha_radicacion,
    recibida_en: x.creado_en,
    respondida_en: x.respondida_en,
    aprobada_por: x.aprobado_por_nombre,
    aprobada_en: x.aprobado_en,
    motivo_rechazo: x.motivo_rechazo,
    rechazada_por: x.rechazado_por_nombre,
    rechazada_en: x.rechazado_en,
    motivo_cancelacion: x.motivo_cancelacion,
    cancelada_por: x.cancelado_por_nombre,
    cancelada_en: x.cancelado_en,
    realizada_en: x.realizado_en,
    bd_asistentes_fecha: x.bd_asistentes_fecha,
    bd_no_aplica: x.bd_no_aplica,
    cerrada_en: x.cerrado_en,
    actividades_total: avance.get(x.id)?.total ?? 0,
    actividades_hechas: avance.get(x.id)?.hechas ?? 0,
    historial: (bit.data || []).filter((b: any) => b.evento_id === x.id).map((b: any) =>
      b.tipo_evento === 'cambio_estado'
        ? { tipo: 'estado', estado: b.detalle?.a, motivo: b.detalle?.motivo ?? null, en: b.creado_en }
        : b.tipo_evento === 'observacion_solicitante'
          ? { tipo: 'observacion', texto: b.detalle?.texto ?? '', por: b.usuario_nombre || 'Solicitante', como: b.detalle?.como ?? 'solicitante', en: b.creado_en }
          : { tipo: 'respuesta', texto: b.detalle?.texto ?? '', por: b.usuario_nombre || 'Mercadeo', en: b.creado_en }),
    adjuntos: (adj.data || []).filter((a: any) => a.evento_id === x.id)
      .map((a: any) => ({ nombre: a.nombre_original, tamano: a.tamano_bytes })),
  }))
  return respuesta(200, { ok: true, eventos: salida })
}
