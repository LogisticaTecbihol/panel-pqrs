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
  encuestas, **mercadeo** (tablero), **crm**, **indicadores** (KPI del tablero), usuarios.
- `js/panel/` — lógica de cada página.
- `js/shared/supabase-client.js` — cliente Supabase + utilidades comunes (`fetchAll`, `parseMonto`,
  fechas sin desfase de zona horaria, `errMsg`, `auditoriaHtml`...).
- `js/shared/modal.js` — modales accesibles (foco, Escape, trampa de foco) de las páginas de Mercadeo.
- `js/shared/equipo-color.js` — color por responsable (`EQUIPO_COLOR`), compartido por el Tablero y los Indicadores.
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

## Usuarios: editar rol y módulos (migración 0026)

`panel/usuarios.html` + `js/panel/usuarios.js` (solo admin). El botón **Editar** de cada fila abre un modal con
rol y módulos (`mercadeo`, `sst`), un resumen de «Cambios / Tendrá acceso a» y **Guardar cambios** (ya no hay
autoguardado por clic). Activar/Desactivar sigue en la fila, con `confirm()`. El modal relee la fila antes de abrir.
Reglas de la interfaz: el rol que lleva su módulo (`mercadeo`, `sst`) lo fija; el admin ve todos marcados y se
guarda con `modulos = []`; al salir de un rol con módulo propio (o de admin) ese módulo se desmarca por defecto
(el admin puede volver a marcarlo); volver al rol original restaura lo guardado. PQRS y Encuestas NO son módulos
guardados: salen del rol (`AUTH.hasModule('pqrs'|'encuestas')`). El cambio se ve al recargar (el perfil se lee en
cada carga de página, no hace falta volver a iniciar sesión).

La seguridad está en la BD (la policy `usuarios_pqrs_update` sigue siendo «solo admin»); 0026 agrega:
- `trg_usuarios_proteger` (BEFORE UPDATE): `id` nunca cambia; `email` y `created_at` no cambian con sesión; **sin
  auto-edición** (con sesión no se cambia el propio rol/módulos/activo; el nombre sí); **siempre ≥1 admin activo**
  (con `pg_advisory_xact_lock`, para que dos admins no se degraden a la vez); normaliza `modulos`.
- `trg_usuarios_proteger_baja` (BEFORE DELETE): no se borra al último admin activo (llega por la cascada de `auth.users`).
- `usuarios_pqrs_auditoria` + `trg_usuarios_auditar`: una fila por cambio de rol/módulos/activo con `antes`/`despues`,
  quién (`hecho_por`, nombre copiado; «Sistema» sin sesión) y cuándo. Solo la leen los admins; no hay pantalla que la
  muestre (consultar con SQL). No registra altas (las hace `create-user-pqrs` con service_role) ni cambios de nombre.
- Sin sesión (`auth.uid() IS NULL`: service_role, SQL del dashboard) se salta auto-edición y columnas fijas, pero NO
  la regla del último admin.
Probado en SQL dentro de una transacción revertida (`DO` + `SET LOCAL ROLE authenticated` + `request.jwt.claims`).

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
    `mercadeo.html?tarea=<id>`. Al llegar un aviso suena el mismo tono que la campanita de
    panel-pedidos; el navegador solo permite sonar tras un clic/tecla en ESA carga de página (una
    recarga lo reinicia), así que si el aviso llega antes el toast lo dice en vez de fallar en silencio.
  - Aviso al solicitante: tras cada cambio de estado / rechazo / respuesta el Tablero llama a la Edge
    Function `notificar-solicitante` (`verify_jwt=true`, exige módulo `mercadeo`), que arma el aviso
    con lo que hay en la BD (nunca con lo que dice el navegador) y lo reenvía con
    `PEDIDOS_BRIDGE_SECRET` a la función `solicitud-mercadeo-aviso` de pedidos (`PEDIDOS_AVISO_URL`
    opcional). Si falla, el cambio ya quedó guardado y el Tablero solo avisa. No hay `pg_net`: el
    envío lo dispara la interfaz, no un trigger.
  - El solicitante EDITA su solicitud (migración 0023) hasta que se entregue o cancele. Los datos de
    origen de una tarea son inmutables (`trg_origen`), así que si ya estaba en el Tablero la tarjeta se
    RETIRA (acción `retirar` de `solicitud-mercadeo-pedidos`, solo con el secreto del puente): pasa a
    `rechazada` con motivo "Retirada por el solicitante…" y el nombre del solicitante
    (`trg_rechazo` respeta el nombre solo si no hay `auth.uid()`; con sesión sale del perfil). Al
    aprobarse de nuevo llega como tarea NUEVA. `trg_notificar_retiro` avisa a la campanita
    (`solicitud_modificada`, "↩ Solicitud retirada del Tablero…") solo cuando lo hace el puente.
    `retirar` es idempotente y se niega (409) si la tarea ya está entregada o cancelada.

Reglas de priorización (MKT-DOC-00 §B.5, MKT-P-04), aplicadas en el trigger `mercadeo_tareas_reglas`:
clase 1 calendario > 2 soporte a ventas > 3 mejora > 4 exploratorio; una tarea vinculada a una
actividad APROBADA en calendario (`mercadeo_actividades.en_calendario`) es clase 1; **urgente fuera
de calendario exige aval** (Comité de Mercadeo / Gerencia General + referencia + motivo, se sella
quién y cuándo y alimenta el KPI de excepciones); sin brief (descripción) y fecha límite no se sale
de "solicitada". La cola de cada columna se ordena por regla (no a mano): arrastrar solo cambia de
columna (HTML5 DnD; en táctil/teclado, botones ◀ ▶). Los KPI (pestaña Indicadores del CRM) se
calculan en el cliente.

### Color por responsable e Indicadores

- **Color por responsable** (`js/shared/equipo-color.js`): paleta fija de 12 tonos asignada por POSICIÓN al ordenar los
  ids de `list_equipo_mercadeo()`; los inactivos conservan su casilla pero se ven en gris. Agregar a alguien al módulo
  puede recolorear a quien tenga un id mayor (si se quieren colores fijos: columna de color en `usuarios_pqrs`). El Tablero
  tiñe la tarjeta (un responsable) o pone una franja dividida (varios) y tiene una leyenda que filtra por responsable.
- **Indicadores** (`panel/indicadores.html` + `js/panel/indicadores.js`, mismo permiso `mercadeo`, sin migración, solo
  lectura): rango Desde/Hasta (por defecto el mes en curso) con filtros de empresa y responsable y comparativo contra el
  periodo anterior de igual duración. Cuatro grupos: Volumen y flujo, Tiempos (confirmación, ciclo, tiempo por etapa con el
  historial `cambio_estado` de la bitácora, antigüedad), Cumplimiento (a tiempo, calendario/urgentes, vencidas) y Carga por
  responsable. Gráficos con barras CSS (sin librerías). Las definiciones de "a tiempo" y "confirmada en ≤ 24 h" son las de
  CRM > Indicadores salvo que aquí también se excluyen las rechazadas del % de confirmación (el CRM las cuenta como tarde).
  "Abiertas / vencidas / antigüedad" son foto de hoy, no del periodo. Todo se calcula en el cliente con `fetchAll`.
- **Tareas de prueba** (migración 0025): columna `mercadeo_tareas.excluir_indicadores`. Un ADMIN la marca desde el detalle de
  la tarjeta (casilla "No contar en los indicadores"; el trigger `trg_excluir_indicadores` rechaza a cualquiera que no sea
  admin y una tarea nueva de un no-admin nace en false). La tarea sigue en el Tablero (chip 🧪 Prueba) y conserva su historial,
  pero Indicadores y CRM > Indicadores la ignoran (filtro en el cliente: `indicadores.js` y `crm.js`). Cada cambio queda en la
  bitácora como `cambio_datos`. Las tarjetas-resumen del propio Tablero NO aplican el filtro. Marcadas el 2026-10-19: #47, #51
  y #55 (pruebas de Diana Marquez / PARCELAR, todas rechazadas), con un UPDATE aparte, no dentro de la migración.

## Encuestas > pestaña Indicadores

`panel/encuestas.html` + `js/panel/encuestas.js` tienen dos pestañas (Respuestas / Indicadores; `#indicadores` abre la segunda).
Sin migración ni escritura: solo lee `encuestas_satisfaccion` (con `fetchAll`) y calcula en el cliente. Los filtros Empresa / Desde /
Hasta son compartidos por las dos pestañas y filtran por fecha LOCAL (`_f`). Definiciones: satisfecho = 4 o 5 (CSAT), insatisfecho = 1 o 2;
semáforo del promedio contra la meta 4,5 (ámbar desde 4,0), constantes `META` / `META_MEDIA` / `MIN_N` al inicio del JS. El comparativo
con el periodo anterior de igual duración solo existe si hay Desde y Hasta. Secciones: KPIs, tendencia mensual (12 meses, solo respeta
Empresa), distribución, calificación por pregunta, segmentos (empresa, canal, asesor, municipio; con menos de 5 respuestas se ve en
gris) y alertas (respuestas con algún 1 o 2). Asesor y municipio se agrupan sin mayúsculas ni tildes. Reutiliza las clases `.ind-*`
de los Indicadores de Mercadeo (más `.enc-*`) y el CSS de `.mk-tabs`.

Pruebas: no hay suite en el repo. Para verificar la UI se usó jsdom con un cliente Supabase
simulado en memoria; la RLS y los triggers se probaron en SQL dentro de transacciones que se revierten
(`DO` + `SET LOCAL ROLE authenticated` + `RAISE EXCEPTION` final).

Servidor local: usar `python -m http.server` (no `npx serve`: reescribe `/login.html` a `/login` y el
check `pathname.endsWith('login.html')` de `auth.js` entra en bucle de redirección).

Ver el plan completo en `~/.claude/plans/a-partir-de-un-adaptive-cosmos.md` (PQRS) y
`~/.claude/plans/c-users-melim-onedrive-desktop-procedim-unified-hinton.md` (Mercadeo).
