// create-user-pqrs
//
// Clon adaptado de supabase/functions/create-user/index.ts del panel de pedidos.
// Exige JWT de un 'admin' ya autenticado en usuarios_pqrs; usa service_role para
// auth.admin.createUser y para insertar el perfil en usuarios_pqrs.
//
// v5 (SST): acepta el rol 'sst' y el módulo 'sst' (migración 0015). Hasta la v4 este
// archivo no estaba versionado en el repo; el código de la v4 vivía solo en Supabase.
//
// v7 (Encuestas): acepta el módulo 'encuestas' (migración 0028). No tiene rol propio: se marca
// aparte para cualquier rol, igual que cualquier módulo extra.
//
// v8 (PQRS): acepta el módulo 'pqrs' (migración 0029), de solo lectura, para roles que no lo traen
// (mercadeo, sst). Los roles lector y gestor ya lo traen por sí solos: no se guarda en modulos, para
// que un cambio de rol posterior no les deje el acceso.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://logisticatecbihol.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('No authorization header')

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const {
      data: { user: caller },
    } = await supabaseUser.auth.getUser()
    if (!caller) throw new Error('Not authenticated')

    const { data: profile } = await supabaseAdmin
      .from('usuarios_pqrs')
      .select('rol')
      .eq('id', caller.id)
      .eq('activo', true)
      .single()

    if (!profile || profile.rol !== 'admin') {
      throw new Error('Solo los administradores pueden crear usuarios')
    }

    const { email, password, nombre, rol, modulos } = await req.json()
    if (!email || !password) throw new Error('Email y contraseña son requeridos')
    if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres')
    if (!['admin', 'gestor', 'lector', 'mercadeo', 'sst'].includes(rol)) throw new Error('Rol inválido')

    // Módulos extra habilitados ('pqrs', 'mercadeo', 'sst', 'encuestas'). Un rol que lleva su módulo (mercadeo, sst) siempre lo tiene.
    const MODULOS_VALIDOS = ['pqrs', 'mercadeo', 'sst', 'encuestas']
    let mods: string[] = Array.isArray(modulos) ? modulos : []
    if (mods.some((m) => !MODULOS_VALIDOS.includes(m))) throw new Error('Módulo inválido')
    if (rol === 'mercadeo' && !mods.includes('mercadeo')) mods.push('mercadeo')
    if (rol === 'sst' && !mods.includes('sst')) mods.push('sst')
    // PQRS la traen los roles lector y gestor (y el admin lo tiene todo): no se guarda en modulos.
    if (['admin', 'gestor', 'lector'].includes(rol)) mods = mods.filter((m) => m !== 'pqrs')

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) throw error
    if (!data.user) throw new Error('No se pudo crear el usuario')

    const { error: profileError } = await supabaseAdmin.from('usuarios_pqrs').insert({
      id: data.user.id,
      email,
      nombre: nombre || null,
      rol,
      modulos: [...new Set(mods)],
    })
    if (profileError) {
      // Sin perfil el usuario no podría entrar y el correo quedaría ocupado: se revierte el alta en auth.
      await supabaseAdmin.auth.admin.deleteUser(data.user.id)
      throw profileError
    }

    return new Response(JSON.stringify({ user_id: data.user.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('create-user-pqrs error:', error?.message, error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
