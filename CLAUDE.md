# Panel PQRS + Mercadeo

Panel interno del holding con dos áreas:

- **PQRS**: gestión de Peticiones, Quejas, Reclamos y Sugerencias (y Encuesta de
  Satisfacción) recibidas por los 5 Google Forms. El Form externo NO se
  reemplaza: este repo solo trae las respuestas hacia Supabase y da un panel
  interno para gestionarlas.
- **Mercadeo** (módulo `mercadeo`): Tablero kanban de tareas del Departamento de
  Mercadeo y CRM de Mercadeo (leads, actividades = calendario maestro,
  presupuesto, indicadores), para las 5 empresas. El CRM se migró desde
  panel-pedidos (donde ya no existe). Detalle más abajo.

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
- `panel/` — páginas del panel interno: login, **inicio** (tarjetas de módulos), dashboard/detalle (PQRS),
  encuestas, **mercadeo** (tablero), **crm**, usuarios.
- `js/panel/` — lógica de cada página.
- `js/shared/supabase-client.js` — cliente Supabase + utilidades comunes (`fetchAll`, `parseMonto`,
  fechas sin desfase de zona horaria, `errMsg`, `auditoriaHtml`...).
- `js/shared/modal.js` — modales accesibles (foco, Escape, trampa de foco) de las páginas de Mercadeo.
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
  (solo lectura), `mercadeo` (equipo de Mercadeo: SOLO Tablero y CRM, sin acceso a
  PQRS/Encuestas; las policies de PQRS enumeran roles, por eso queda excluido).
- Permisos por módulo: `usuarios_pqrs.modulos` (hoy solo `'mercadeo'`); el rol
  `mercadeo` siempre lo lleva (CHECK). Un gestor/lector puede recibir el módulo sin
  cambiar de rol. `AUTH.hasModule(key)`; cada página declara su módulo con
  `<body data-modulo="...">` y los enlaces/tarjetas con `data-modulo` se ocultan
  si no lo tiene. En BD: `user_has_module_pqrs('mercadeo')` (admin siempre pasa).
  La seguridad real es la RLS; el guard de página es solo UX.
- Valores almacenados en códigos ASCII (`en_produccion`, `diseno`...) con mapa de
  etiquetas en el JS: una tilde en un CHECK ya causó un bug (migración 0008).
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

## Módulo Mercadeo

Migraciones 0012–0014 (aplicadas con `apply_migration`; el MCP no las aplica con el push):

- **0012** rol `mercadeo`, `modulos`, `user_has_module_pqrs()`, RPC `list_equipo_mercadeo()`
  (directorio del equipo: `usuarios_pqrs` solo deja leer la propia fila a un no-admin) y
  endurecimiento del bucket `pqrs-gestion-adjuntos`.
- **0013 CRM**: `mercadeo_leads`, `_leads_seguimiento`, `_actividades` (con `en_calendario`),
  `_presupuesto`, `_presupuesto_gastos`, `_comerciales` (catálogo, sin login: los comerciales NO usan
  este panel y mercadeo registra el seguimiento por ellos). Triggers: auditoría
  (`mercadeo_set_auditoria`), transiciones/fechas del lead selladas por el servidor (estados solo
  avanzan; reasignar/recalificar no los reinicia), `touch_lead_on_seguimiento`; cron
  `mercadeo-cerrar-leads-inactivos` (pg_cron, cierre automático a 90 días).
- **0014 Tablero**: `mercadeo_tareas`, `_tarea_bitacora` (eventos de sistema por trigger, no
  falsificables; el cliente solo inserta comentarios), `_tarea_adjuntos`, bucket privado
  `mercadeo-adjuntos`, Realtime sobre `mercadeo_tareas`.

### Solicitudes desde panel-pedidos (migración 0019)

Un usuario de panel-pedidos (otro proyecto Supabase, otra auth) diligencia un formulario allá y la
solicitud nace aquí como tarea en la primera columna (estado `solicitada`, cuya etiqueta es
**"Recibido"**; el código no cambia). Puente: Edge Function `solicitud-mercadeo-pedidos`
(`verify_jwt=false`, secreto `PEDIDOS_BRIDGE_SECRET`, distinto de `INGEST_SHARED_SECRET`), llamada
SOLO por la función `solicitud-mercadeo` de panel-pedidos (server→server, sin CORS). Acciones
`preparar` (URLs firmadas de subida a `mercadeo-adjuntos`, ruta `solicitudes/<request_id>/…`),
`crear` (idempotente por `origen_ref`) y `listar` ("Mis solicitudes", lista blanca de campos).

- Columnas nuevas en `mercadeo_tareas`: `origen` (`panel_mercadeo`|`panel_pedidos`), `origen_ref`,
  `solicitante_*`, `a_nombre_de_*`, `asunto` (9 códigos), `fecha_tentativa` (NO es compromiso:
  la fecha comprometida sigue siendo `fecha_limite`). El trigger `mercadeo_tareas_origen` solo deja
  fijar `origen='panel_pedidos'` sin sesión (service_role) y vuelve inmutables esas columnas.
- `tipo` del Tablero se llena por mapeo fijo desde el asunto (en la función); prioridad `mejora`,
  `urgente=false`: clase y aval los define Mercadeo.
- Bitácora: `respuesta_solicitante` es lo único (más los cambios de estado) que se le muestra al
  solicitante; los comentarios internos NUNCA salen.
- Adjuntos subidos desde Pedidos: `subido_por` NULL + `subido_por_nombre`.
- Aprobación previa (migración 0021): la solicitud se aprueba en panel-pedidos ANTES de existir aquí;
  la función `crear` se llama ya con `aprobacion: true`, `numero_origen` (SM-<n>) y `aprobada_por`
  (columnas `origen_numero`, `aprobada_por_nombre`, `aprobada_en`, inmutables). Por eso el trigger de
  origen ya no valida "fecha tentativa >= hoy" (la aprobación puede tardar; se valida al ENVIAR).
  Acción `firmar`: URLs de lectura para que el aprobador revise adjuntos antes de aprobar.
- Asunto "Otros" (migración 0020): el solicitante escribe el asunto → `asunto_otro` (3-100 car.,
  solo con `asunto = 'otros'`, inmutable); lo exigen las dos Edge Functions y el título de la tarea
  pasa a `Otros: <asunto escrito> · <empresa> · <solicitante>`.
- Rechazo por Mercadeo y avisos (migración 0022):
  - Estado nuevo `rechazada` (fuera de las columnas, como `cancelada`; estado FINAL). Solo para
    tareas de Pedidos y mientras no estén entregadas/canceladas; motivo obligatorio (3–500). Quién y
    cuándo (`rechazada_por_nombre`, `rechazada_en`) los pone el trigger `trg_rechazo`, no el
    navegador. Botón "❌ Rechazar solicitud" en el detalle de la tarjeta.
  - La unicidad de `origen_ref` es PARCIAL (no cuenta las rechazadas): el solicitante corrige y
    reenvía en Pedidos, y al aprobarse de nuevo llega una tarea NUEVA con el mismo `origen_ref`
    (la rechazada queda como historial; `crear` y `listar` de la función la ignoran).
  - Campanita del equipo (`mercadeo_notificaciones`, RLS: cada quien lee/marca las suyas; las crea el
    trigger `trg_notificar_solicitud` al entrar una tarea `panel_pedidos` a cada usuario activo admin
    o con módulo `mercadeo`; Realtime). La dibuja `js/panel/auth.js` en todas las páginas y abre
    `mercadeo.html?tarea=<id>`.
  - Aviso al solicitante: tras cada cambio de estado / rechazo / respuesta el Tablero llama a la Edge
    Function `notificar-solicitante` (`verify_jwt=true`, exige módulo `mercadeo`), que arma el aviso
    con lo que hay en la BD (nunca con lo que dice el navegador) y lo reenvía con
    `PEDIDOS_BRIDGE_SECRET` a la función `solicitud-mercadeo-aviso` de pedidos (`PEDIDOS_AVISO_URL`
    opcional). Si falla, el cambio ya quedó guardado y el Tablero solo avisa. No hay `pg_net`: el
    envío lo dispara la interfaz, no un trigger.

Reglas de priorización (MKT-DOC-00 §B.5, MKT-P-04), aplicadas en el trigger `mercadeo_tareas_reglas`:
clase 1 calendario > 2 soporte a ventas > 3 mejora > 4 exploratorio; una tarea vinculada a una
actividad APROBADA en calendario (`mercadeo_actividades.en_calendario`) es clase 1; **urgente fuera
de calendario exige aval** (Comité de Mercadeo / Gerencia General + referencia + motivo, se sella
quién y cuándo y alimenta el KPI de excepciones); sin brief (descripción) y fecha límite no se sale
de "solicitada". La cola de cada columna se ordena por regla (no a mano): arrastrar solo cambia de
columna (HTML5 DnD; en táctil/teclado, botones ◀ ▶). Los KPI (pestaña Indicadores del CRM) se
calculan en el cliente.

Pruebas: no hay suite en el repo. Para verificar la UI se usó jsdom con un cliente Supabase
simulado en memoria; la RLS y los triggers se probaron en SQL dentro de transacciones que se revierten
(`DO` + `SET LOCAL ROLE authenticated` + `RAISE EXCEPTION` final).

Servidor local: usar `python -m http.server` (no `npx serve`: reescribe `/login.html` a `/login` y el
check `pathname.endsWith('login.html')` de `auth.js` entra en bucle de redirección).

Ver el plan completo en `~/.claude/plans/a-partir-de-un-adaptive-cosmos.md` (PQRS) y
`~/.claude/plans/c-users-melim-onedrive-desktop-procedim-unified-hinton.md` (Mercadeo).
