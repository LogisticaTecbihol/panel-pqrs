# Panel PQRS

Gestión interna de Peticiones, Quejas, Reclamos y Sugerencias (y Encuesta de
Satisfacción) recibidas por los 5 Google Forms del holding. El Form externo NO
se reemplaza: este repo solo trae las respuestas hacia Supabase y da un panel
interno para gestionarlas.

## Stack

- Frontend: HTML estático + CSS + JavaScript vanilla (sin frameworks), mismo
  sistema de diseño visual que `panel-pedidos`.
- Backend: Supabase (auth, Postgres, Storage, Edge Functions).
- Proyecto Supabase: `kvfqcymeihglohkcckdp` (organización `tecbihol`, la misma
  del panel de pedidos, proyecto separado).
- Repositorio: GitHub `LogisticaTecbihol/panel-pqrs`.
- Puente de datos: Google Apps Script (uno por cada uno de los 5 Forms) ->
  Edge Function `ingest-formulario`. Ver `google-apps-script/ingest-template.gs`.

## Estructura

- `index.html` — redirige a `panel/login.html`.
- `panel/` — páginas del panel interno (login, dashboard, detalle, usuarios, encuestas).
- `js/panel/` — lógica de cada página.
- `js/shared/supabase-client.js` — cliente Supabase + utilidades comunes.
- `css/panel.css` — estilos (sistema de diseño del holding).
- `supabase/migrations/` — migraciones SQL, aplicadas con el MCP de Supabase
  (`apply_migration`), igual que en panel-pedidos.
- `supabase/functions/` — Edge Functions (`ingest-formulario`, `create-user-pqrs`).
- `google-apps-script/` — plantilla del script puente (se despliega manualmente
  en el editor de Apps Script de cada Form, no vía CI).
- `scripts/importar_historico_pqrs.mjs` — script de un solo uso para importar
  el histórico de respuestas ya existentes (Node.js, no forma parte de la app).
- `.github/workflows/keep-alive.yml` — evita que Supabase pause el proyecto
  por inactividad (Free Plan).

## Convenciones

- El idioma del código y UI es español.
- No hay formulario público: toda escritura a `pqrs` y `encuestas_satisfaccion`
  pasa por `ingest-formulario` con `service_role`, nunca por una policy RLS
  directa a `anon`/`authenticated`.
- Roles del equipo interno: `admin` (todo, incluida gestión de usuarios),
  `gestor` (gestiona PQRS: estado, asignación, notas, adjuntos), `lector`
  (solo lectura).
- Empresas válidas (fijas, hardcodeadas en CHECK constraints y en el JS del
  panel, no una tabla catálogo): `PARCELAR`, `GREEN`, `RESO`, `IASO`, `IAS`.

## Configuración pendiente tras clonar (secretos del Edge Function)

Configurar con `supabase secrets set` (o desde el dashboard del proyecto,
Edge Functions > Secrets) antes de que el puente funcione en producción:

- `INGEST_SHARED_SECRET` — el mismo valor que se guarda como Script Property
  en cada copia del script de Apps Script.
- `RESEND_API_KEY` y `NOTIFY_TEAM_EMAILS` (lista separada por comas) — para el
  aviso por correo al equipo cuando llega un PQRS nuevo. Si no se configuran,
  el registro se guarda igual, solo no se envía el correo.
- `PANEL_BASE_URL` (opcional) — URL base del panel para el link del correo de
  aviso; por defecto `https://logisticatecbihol.github.io/panel-pqrs`.

Ver el plan completo en `~/.claude/plans/a-partir-de-un-adaptive-cosmos.md`.
