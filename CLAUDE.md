# Panel PQRS + Mercadeo

Panel interno del holding con dos áreas:

- **PQRS**: gestión de Peticiones, Quejas, Reclamos y Sugerencias (y Encuesta de
  Satisfacción) recibidas por los 5 Google Forms. El Form externo NO se
  reemplaza: este repo solo trae las respuestas hacia Supabase y da un panel
  interno para gestionarlas.
- **Mercadeo** (módulo `mercadeo`): Tablero kanban de tareas del Departamento de
  Mercadeo y CRM de Mercadeo (leads, actividades = calendario maestro,
  presupuesto, indicadores) y Eventos (solicitudes de eventos, formato MC-ISO-FO01), para las 5
  empresas. El CRM se migró desde panel-pedidos (donde ya no existe). Detalle más abajo.

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
  encuestas, **mercadeo** (tablero), **crm**, **eventos** (solicitudes de eventos), **indicadores** (KPI del tablero), usuarios.
- `js/panel/` — lógica de cada página.
- `js/shared/supabase-client.js` — cliente Supabase + utilidades comunes (`fetchAll`, `parseMonto`,
  fechas sin desfase de zona horaria, `errMsg`, `auditoriaHtml`...).
- `js/shared/modal.js` — modales accesibles (foco, Escape, trampa de foco) de las páginas de Mercadeo.
- `js/shared/equipo-color.js` — color por responsable (`EQUIPO_COLOR`), compartido por el Tablero y los Indicadores.
- `css/panel.css` — estilos (sistema de diseño del holding).
- `supabase/migrations/` — migraciones SQL, aplicadas con el MCP de Supabase
  (`apply_migration`), igual que en panel-pedidos.
- `supabase/functions/` — Edge Functions (`ingest-formulario`, `create-user-pqrs`, `solicitud-mercadeo-pedidos`,
  `notificar-solicitante`, `solicitud-evento-pedidos`, `notificar-evento-solicitante`).
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
  (solo lectura), `mercadeo` (equipo de Mercadeo: Tablero y CRM, sin acceso a PQRS salvo que un admin le
  asigne el módulo `pqrs`, que es de solo lectura).
- Permisos por módulo: `usuarios_pqrs.modulos` (`'pqrs'`, `'mercadeo'`, `'sst'`, `'encuestas'`); el rol
  `mercadeo` siempre lleva el suyo (CHECK), igual que `sst`. Un gestor/lector puede recibir un módulo sin
  cambiar de rol. `AUTH.hasModule(key)`; cada página declara su módulo con
  `<body data-modulo="...">` y los enlaces/tarjetas con `data-modulo` se ocultan
  si no lo tiene. En BD: `user_has_module_pqrs('mercadeo')` (admin siempre pasa).
  La seguridad real es la RLS; el guard de página es solo UX. Única particularidad: `pqrs` además
  la traen por rol `gestor` y `lector` (no se guarda en `modulos`); ver «PQRS como módulo» más abajo.
- **Encuestas es un módulo aparte** (migración 0028), de SOLO LECTURA y sin rol propio: el admin lo ve
  siempre; lector, gestor, mercadeo y sst lo ven solo si tienen `'encuestas'` en `modulos` (ya NO por
  su rol). La policy `encuestas_satisfaccion_select` usa `user_has_module_pqrs('encuestas')`; editar,
  borrar y el historial de ediciones siguen siendo solo de admin. Al aplicarla no había gestores ni lectores.
- Valores almacenados en códigos ASCII (`en_produccion`, `diseno`...) con mapa de
  etiquetas en el JS: una tilde en un CHECK ya causó un bug (migración 0008).
- Empresas válidas (fijas, hardcodeadas en CHECK constraints y en el JS del
  panel, no una tabla catálogo): `PARCELAR`, `GREEN`, `RESO`, `IASO`, `IAS`.

## Usuarios: editar rol y módulos (migración 0026)

`panel/usuarios.html` + `js/panel/usuarios.js` (solo admin). El botón **Editar** de cada fila abre un modal con
rol y módulos (`pqrs`, `mercadeo`, `sst`, `encuestas`), un resumen de «Cambios / Tendrá acceso a» y **Guardar cambios** (ya no hay
autoguardado por clic). Activar/Desactivar sigue en la fila, con `confirm()`. El modal relee la fila antes de abrir.
Reglas de la interfaz: el rol que lleva su módulo (`mercadeo`, `sst`) lo fija; el admin ve todos marcados y se
guarda con `modulos = []`; al salir de un rol con módulo propio (o de admin) ese módulo se desmarca por defecto
(el admin puede volver a marcarlo); volver al rol original restaura lo guardado. `encuestas` no tiene rol propio
(se marca aparte, para cualquier rol); `pqrs` se marca para Mercadeo/SST y la traen sola Lector y Gestor (casilla fija,
no se guarda). `create-user-pqrs` v8 acepta los cuatro módulos. El cambio se ve al recargar (el perfil se lee en
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

## PQRS como módulo asignable (migración 0029)

Antes PQRS salía solo del rol (`admin`/`gestor`/`lector`) y un usuario `mercadeo` o `sst` no podía recibirla. Ahora
`'pqrs'` es un módulo válido de `usuarios_pqrs.modulos`, **de SOLO LECTURA**: da lista, detalle, adjuntos, bitácora y
descarga de adjuntos de gestión. Gestionar (estado, responsable, fecha límite, notas, adjuntos nuevos) sigue siendo de
los roles `admin`/`gestor` y borrar de `admin`; quien deba gestionar necesita el rol Gestor (puede llevar además el
módulo `mercadeo`). Los roles `gestor` y `lector` traen PQRS por sí solos y NO se guarda en `modulos` (la interfaz y
`create-user-pqrs` lo descartan: si se guardara, un cambio de rol posterior le dejaría el acceso).

- `user_has_module_pqrs('pqrs')` = admin, rol `gestor`/`lector`, o `'pqrs'` en `modulos` (igual que `AUTH.hasModule('pqrs')`).
- Las 4 policies de lectura (`pqrs_select`, `pqrs_adjuntos_select`, `pqrs_bitacora_select` y
  `pqrs_gestion_adjuntos_select` en `storage.objects`) usan esa función; las de escritura NO cambian.
- `AUTH.canEdit()` sigue siendo admin/gestor, así que el detalle de un usuario con solo el módulo queda de solo lectura.
- Al aplicarla nadie tenía `'pqrs'` en `modulos`: no cambió el acceso de nadie hasta que un admin lo marca.
- Probado en SQL en una transacción revertida (sin módulo: 0 filas; con módulo: lee todo y UPDATE/INSERT bloqueados; inactivo:
  0 filas; lector solo lee; gestor sin cambios) y la interfaz en navegador con un Supabase simulado.

### Directorio de responsables (migración 0030)

`usuarios_pqrs` solo deja leer la propia fila a quien no es admin, y el dashboard y el detalle la leían directo: un
gestor/lector/usuario con el módulo veía en blanco el nombre de todo responsable que no fuera él, un gestor solo podía
asignarse PQRS a sí mismo, la bitácora guardaba la asignación con el nombre vacío («Asignado a sin asignar») y, si el
responsable no estaba en la lista (p. ej. inactivo), el selector quedaba vacío y guardar solo un cambio de estado dejaba
`responsable_id = null` sin que nadie lo pidiera. Ahora ambas pantallas llaman al RPC `list_equipo_pqrs()` (mismo patrón que
`list_equipo_mercadeo()`): devuelve solo `id`, `nombre` (o el correo si no tiene) y `activo`, vacío si el llamador no tiene
acceso a PQRS, con las personas que tienen acceso a PQRS (admin, gestor, lector o módulo `pqrs`) más cualquiera que figure
como responsable de alguna PQRS aunque ya no tenga acceso. Los inactivos vienen para resolver nombres; el filtro y el selector
listan solo a los activos, y el selector del detalle conserva al responsable actual con la marca «(inactivo)». Cambio visible
para el admin: su lista de responsables ya no incluye a quien no tiene acceso a PQRS (hoy Mercadeo/SST sin el módulo), que de
todas formas no podría abrir la PQRS que se le asignara. `anon` no puede ejecutarlo. Sin cambios de policies.

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
- Productos relacionados (sin migración): el solicitante los elige en Pedidos (del maestro, por nombre sin presentación, o escritos a mano; opcional, hasta 20 de 2–100 car.). La tarea
  no tiene columna propia: `solicitud-mercadeo-pedidos` (`crear`) los valida (`productosLista`) y los pone en el encabezado del brief, `Productos relacionados: A, B`, junto a
  «Empresa» y «Departamento / Área». Ver también «Productos relacionados» de Eventos (migración 0038).
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
de calendario** cuenta como excepción (KPI de excepciones) y su aval (Comité de Mercadeo / Gerencia
General + referencia + motivo) es **OPCIONAL** desde la migración 0033, a discreción de Mercadeo; si se
diligencia algún dato se sella quién y cuándo, y si no, no hay sello ni evento `aval_registrado`; sin brief (descripción) y fecha límite no se sale
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

### Eventos (migración 0031)

`panel/eventos.html` + `js/panel/eventos.js`, mismo permiso `mercadeo` (sin clave de módulo nueva; el enlace «Eventos» va en
el menú de todas las páginas y hay tarjeta en Inicio). Digitaliza el formato **MC-ISO-FO01 «Solicitud de eventos» v1** (6 secciones)
y el *Manual de procesos y procedimiento de EVENTOS* (carpeta «PROCEDIMIENTOS MERCADEO» del Escritorio).

- **Tablas**: `mercadeo_eventos` (consecutivo visible `EV-<id>`; listas de opciones en códigos ASCII con CHECK `<@`:
  `objetivos`, `canales`, `materiales`, `logistica`, cada una con su texto «Otros»; `desglose_gastos` jsonb de `{concepto, valor}`),
  `mercadeo_evento_bitacora` y `mercadeo_evento_adjuntos` (mismo bucket privado `mercadeo-adjuntos`, rutas `evento_<id>/…` y,
  desde Pedidos, `eventos/<request_id>/…`). `mercadeo_tareas.evento_id` liga la tarea del Tablero (índice único: una por evento).
- **Flujo**: `radicada → en_revision → aprobada → en_preparacion → realizada → cerrada`; `rechazada` solo antes de aprobar;
  `cancelada` mientras no esté cerrada. `rechazada`/`cancelada`/`cerrada` son FINALES (el trigger rechaza cualquier edición).
  No se vuelve a revisión una vez aprobada; entre aprobada/en_preparación/realizada se puede retroceder. `cerrada` exige
  `realizada` y la fecha de llegada de la base de datos de asistentes (`bd_asistentes_fecha`) o `bd_no_aplica`.
- **Lo sella el servidor** (triggers `trg_auditoria`, `trg_origen`, `trg_reglas`, `trg_bitacora`): quién y cuándo
  aprobó/rechazó/canceló/realizó/cerró, `respondida_en` (primera respuesta), origen, bitácora de sistema; motivo obligatorio
  (3–500) al rechazar y cancelar. El navegador solo inserta comentarios (y respuestas al solicitante en eventos de Pedidos).
- **Política de 15 días**: NO bloquea (decisión del usuario; el manual dice «rechazo automático»). Columnas generadas
  `dias_anticipacion = fecha_evento - fecha_radicacion` y `extemporanea (< 15)`; la interfaz la muestra como advertencia ⚠ y
  alimenta el KPI «Oportunidad». `fecha_radicacion` = fecha en que LLEGÓ la solicitud: por defecto hoy, editable al digitar
  (queda en la bitácora) y fija el puente cuando viene de Pedidos (la del envío del solicitante, no la de la aprobación previa).
- **Tarea automática**: al pasar a `aprobada` el trigger `trg_tarea` crea en el Tablero una tarea tipo `evento`, clase
  `soporte_ventas`, `fecha_limite = fecha_evento - 1`, empresa del evento y un brief armado con `mercadeo_evento_brief()`
  (materiales, canales, logística y objetivos pedidos); la bitácora del evento registra `tarea_creada`. Al `cancelada` se cancela
  su tarea si sigue abierta. `evento_id` solo lo puede fijar ese trigger (GUC `mercadeo.creando_tarea_evento`). La tarjeta del
  La tarea nace ASIGNADA por defecto a Laura Sanchez (migración 0037): `mercadeo_responsable_eventos()` devuelve su id solo si sigue activa y con acceso a
  Mercadeo (si no, la tarea nace sin responsable como antes); para cambiar de persona basta un `CREATE OR REPLACE` de esa función con otro `usuarios_pqrs.id`.
  Solo aplica a eventos (no a las solicitudes generales a Mercadeo) y el equipo puede cambiar o ampliar el responsable desde la tarjeta. La tarjeta del
  Tablero muestra el chip 🎪 EV-n y su detalle enlaza al evento. Borrar un evento (solo admin) deja viva la tarea (`ON DELETE SET NULL`).
- **Formulario por pasos**: el modal se divide en 6 pasos (Solicitante · Evento · Objetivos y público · Requerimientos · Presupuesto · Aprobación y
  seguimiento) con barra clicable y Anterior/Siguiente. La navegación es LIBRE (el modal también sirve para revisar eventos ya registrados); un paso ya visto
  muestra ✓ o ! según esté completo, y al guardar o cambiar de estado se revisan todos los pasos y se lleva al primero con error (`validarPaso` / `revisar`
  en `eventos.js`). El pie del modal (acciones de estado y Guardar) se ve en todos los pasos.
- **Formulario ALINEADO con panel-pedidos** (migración 0035; cuando uno cambie, cambiar el otro): Empresa es el primer campo; `Departamento / Área`, `Plataforma` y
  `Segmentación` son listas con «Otros/Otra» + campo obligatorio (objeto `LISTAS` en `eventos.js`; se guarda el texto escrito, no «Otros»); el lugar son
  `lugar_municipio` + `lugar_departamento` (lista oficial `js/shared/colombia-geo.js` con el buscador `js/shared/autocomplete.js`), `lugar_distribuidor` +
  `lugar_distribuidor_nit` (texto libre: aquí NO hay lista de clientes, vive en Pedidos) y `lugar_finca`. `lugar` sigue siendo el texto armado con esas partes
  (`lugarTexto`; lo usan el brief, la lista y la búsqueda). Municipio+departamento son obligatorios en físico/híbrido, así que un evento anterior con
  `lugar` libre pide completarlos al guardar o cambiar de estado (se le muestra el texto anterior). La Segmentación reemplaza a segmento demográfico, segmentación
  profesional y nivel de conocimiento: se guarda en `segmento_profesional`; las otras dos columnas se conservan en BD y se muestran de solo lectura si traen datos.
  Las opciones de Logística (incl. `presencia_mercadeo`, migración 0034) deben coincidir con las de Pedidos.
- **Productos relacionados** (migración 0038; paso 3 «Objetivos y público»): columna `mercadeo_eventos.productos text[]` (hasta 20 nombres de 2 a 100 caracteres; el CHECK
  `mercadeo_eventos_productos_check` usa `mercadeo_productos_validos()` y también cubre las escrituras directas del navegador). Desde Pedidos los eligen del maestro de productos
  por NOMBRE, sin la presentación («CALIMAN X LITRO» → «CALIMAN»), o los escriben a mano; aquí no hay maestro, así que el formulario (`eventos.js`: `productos`,
  `pintarProductos`, `agregarProducto`) es de texto libre con chips, alineado con el de Pedidos (si cambias uno, cambia el otro). La migración reescribe `mercadeo_evento_brief()`
  (agrega «Productos relacionados:» con una línea por producto, solo si hay) y `mercadeo_eventos_bitacora()` (`productos` entra en la lista de campos que se anotan como cambio),
  ambas desde su definición vigente. El PDF del evento, la búsqueda de la lista y la etiqueta del historial de cambios (`CAMPO_T`) lo incluyen. El brief de la tarea se arma al aprobar:
  cambiar los productos después no lo reescribe (igual que el resto de campos). Los eventos anteriores quedan con la lista vacía. Aplicar la migración ANTES de redesplegar
  `solicitud-evento-pedidos` y de publicar el frontend (el formulario ya envía `productos` al guardar).
- **Checklist de actividades** (migración 0036; paso 6 «Actividades» del modal, «Aprobación y seguimiento» pasó al 7): tabla `mercadeo_evento_checklist`
  (NO es `mercadeo_actividades`, que es el calendario del CRM). Cada actividad lleva texto libre (3–300), casilla «hecha», responsable (`list_equipo_mercadeo()`),
  fecha límite opcional y notas (≤ 1000). Se guarda al instante, sin el botón Guardar del formulario. «Sugerir desde lo solicitado» crea una actividad por cada
  canal, material y logística pedidos (y sus «Otros»), con `origen_clave` para no repetirlas. El trigger `mercadeo_evento_checklist_reglas` solo deja escribir con el
  evento En revisión / Aprobada / En preparación / Realizada y sella quién creó y quién/cuándo marcó «hecha»; la bitácora del evento registra el tipo `actividad`
  (agregada a mano, completada, reabierta, eliminada). La función puente `listar` entrega solo el AVANCE (`actividades_total` / `actividades_hechas`) para
  mostrárselo al solicitante en Pedidos; las notas y los responsables no salen de aquí.
- **PDF de la solicitud** (`js/panel/eventos-pdf.js`: `EVENTO_PDF.solicitud` arma el documento y `EVENTO_PDF.ver` lo abre; ese archivo también guarda la ÚNICA copia de los
  catálogos `CAT` y `ESTADO_T`, que `eventos.js` usa): botón «📄 PDF» en cada fila de la lista de Eventos y «📄 Ver PDF» en el pie del modal, y en el **Tablero** el chip
  «📄 PDF» de cada tarjeta de tarea de evento y el botón «📄 Ver PDF del evento» en su detalle (`mercadeo.html` también carga jsPDF y `eventos-pdf.js`). Abre en una
  pestaña nueva (si el navegador la bloquea, se descarga) un PDF carta con TODAS las especificaciones guardadas del evento: estado y aprobaciones, las secciones 1–5 del
  formato MC-ISO-FO01, archivos adjuntos y el checklist de actividades con su avance (sin las notas internas). Refleja lo guardado, no lo que se esté editando en el
  formulario. jsPDF 2.5.2 + autotable 3.8.4 (CDN, como SST); solo caracteres Latin-1: `L()` limpia emojis y comillas tipográficas de lo que escriben las personas.
- **Columna «Por aprobar» del Tablero** (`mercadeo.js`, sin migración): las solicitudes con estado `radicada` / `en_revision` se ven en el Tablero desde que llegan, en una
  columna de SOLO LECTURA a la izquierda de «Recibido» (borde punteado, chip «⏳ Pendiente de aprobación»). NO son tareas: no se arrastran (las listas con `data-estado` son
  las únicas que reciben), no tienen responsable ni color, y no cuentan en Indicadores / CRM > Indicadores ni en «Tareas abiertas»; solo suman a la tarjeta-resumen «Eventos por
  aprobar» (con cuántas pasan de 48 h hábiles). El clic es un enlace a `eventos.html?evento=<id>`, donde se revisa/aprueba/rechaza (flujo sin cambios). Al aprobarse, el trigger crea
  la tarea real en «Recibido» y la provisional desaparece (Realtime sobre `mercadeo_eventos`). Los filtros que solo tiene una tarea (responsable, clase, asunto, urgentes) la ocultan;
  Empresa, Origen, Tipo=Evento y Buscar sí aplican. Si la consulta de eventos falla, el Tablero sigue con sus tareas y avisa. Probado con un arnés de navegador y una BD simulada.
- **KPI del encabezado** (cliente, sin festivos): Por atender (y cuántas pasan de 48 h hábiles sin respuesta), eventos de los
  próximos 30 días, Oportunidad del mes (≥ 15 días) y Retorno de la base de datos (entregada en ≤ 3 días hábiles tras el evento,
  últimos 90 días; «no aplica» no cuenta). Cada evento realizado sin base de datos y con plazo vencido se marca en la lista.
- **Desde panel-pedidos** (mismo patrón que «Solicitudes desde panel-pedidos»): Edge Function `solicitud-evento-pedidos`
  (`verify_jwt=false`, secreto `PEDIDOS_BRIDGE_SECRET`; acciones `preparar`, `crear`, `firmar`, `listar`, `observar`, `retirar`),
  llamada SOLO por la función `solicitud-evento` de panel-pedidos tras la aprobación previa allá; `crear` es idempotente por
  `origen_ref` (índice único parcial que no cuenta rechazadas ni canceladas: el solicitante corrige y reenvía → evento NUEVO).
  Un evento de Pedidos solo se puede `retirar` mientras sea `radicada`/`en_revision` (pasa a `cancelada` con el motivo y el nombre del
  solicitante; `trg_notificar_retiro` avisa a la campanita); ya aprobado, los cambios se piden con `observar`. Campanita del equipo:
  `mercadeo_notificaciones.evento_id` + tipos `evento_recibido`, `evento_retirado`, `evento_observacion` (abren `eventos.html?evento=<id>`).
  Aviso al solicitante: tras cada cambio de estado / rechazo / respuesta la interfaz llama a `notificar-evento-solicitante`
  (`verify_jwt=true`, exige módulo `mercadeo`), que arma el aviso desde la BD y lo reenvía a `solicitud-evento-aviso` de pedidos
  (`PEDIDOS_EVENTO_AVISO_URL` opcional). Si falla, el cambio ya quedó guardado y solo se informa.
- **Empresas adicionales** (migración 0032): además de las 5 del holding, un evento puede ser de `CHIA_ABAGO` («Chía Abagó»),
  `TECBIHOL` («Tecbihol») u `OTROS`. Con `OTROS` el nombre escrito va en `mercadeo_eventos.empresa_otra` (3–100 car.; el CHECK
  `mercadeo_eventos_empresa_otra_check` lo exige solo con `OTROS` y el trigger `mercadeo_eventos_reglas` lo normaliza). La función
  `mercadeo_empresa_nombre(empresa, otra)` da el nombre legible (`Otros: <nombre>`) y lo usan el brief y el título de la tarea.
  El Tablero las acepta: `mercadeo_tareas_empresas_check` admite los 8 códigos y la tarea de un evento lleva `empresas = {empresa}`
  (con `OTROS` el nombre escrito solo sale en el título y el brief, no en el chip). En el JS: `EMPRESAS_EXTRA` y `etiquetaEmpresa()`
  en `supabase-client.js`; Tablero, Indicadores y CRM las muestran como chips/filtros propios, pero «Todo el holding» sigue marcando solo
  las 5. Desde Pedidos la función `solicitud-evento` las ofrece (`empresas_extra`) a TODO el que puede enviar, sin depender de sus
  empresas asignadas, y `solicitud-evento-pedidos` exige `empresa_otra` con `OTROS`.
- Probado en SQL con transacciones revertidas (`DO` + `SET LOCAL ROLE authenticated` + `request.jwt.claims`): insert y rechazos,
  sellos no falsificables, creación/cancelación de la tarea, ciclo hasta `cerrada`, RLS (usuario `sst` sin acceso, borrar solo admin),
  puente (origen, avisos, retiro, reenvío con el mismo `origen_ref`). La interfaz se probó con un arnés de navegador y una BD simulada.

## Encuestas > pestaña Indicadores

`panel/encuestas.html` + `js/panel/encuestas.js` tienen dos pestañas (Respuestas / Indicadores; `#indicadores` abre la segunda).
Sin migración ni escritura: solo lee `encuestas_satisfaccion` (con `fetchAll`) y calcula en el cliente. Los filtros Empresa / Desde /
Hasta son compartidos por las dos pestañas y filtran por fecha LOCAL (`_f`). Definiciones: satisfecho = 4 o 5 (CSAT), insatisfecho = 1 o 2;
semáforo del promedio contra la meta 4,5 (ámbar desde 4,0), constantes `META` / `META_MEDIA` / `MIN_N` al inicio del JS. El comparativo
con el periodo anterior de igual duración solo existe si hay Desde y Hasta. Secciones: KPIs, tendencia mensual (12 meses, solo respeta
Empresa), distribución, calificación por pregunta, segmentos (empresa, canal, asesor, municipio; con menos de 5 respuestas se ve en
gris) y alertas (respuestas con algún 1 o 2). Asesor y municipio se agrupan sin mayúsculas ni tildes. Reutiliza las clases `.ind-*`
de los Indicadores de Mercadeo (más `.enc-*`) y el CSS de `.mk-tabs`.

### Edición de respuestas (solo admin, migración 0027)

Antes la tabla era inmutable. Ahora un ADMIN puede corregir desde la pestaña Respuestas (botón "✏️ Editar" + modal) empresa, municipio,
asesor, canal (y su texto "Otro") y comentarios. Las 6 calificaciones y `creado_en` NO se editan: lo impide el trigger
`trg_encuestas_satisfaccion_edicion` con un RAISE, aunque la policy lo dejara pasar. La policy `encuestas_satisfaccion_update` es solo
`get_user_role_pqrs() = 'admin'`; el botón solo se dibuja con `AUTH.isAdmin()` (UX), la seguridad es la BD. El trigger sella
`modificado_por` / `modificado_por_nombre` / `modificado_en` (el navegador no los puede falsificar), normaliza espacios solo en lo que
cambió (el histórico trae espacios sobrantes y no deben contarse como cambios) y guarda el antes/después en
`encuestas_satisfaccion_historial` (SELECT solo admin; nadie escribe ahí salvo el trigger). Sin sesión (service_role: `ingest-formulario`,
importación, SQL de mantenimiento) el trigger no interviene. Si nada cambió no se sella ni se registra. El cliente solo envía los campos
modificados. Las respuestas editadas llevan el chip "✏️ Editada" (tooltip con quién y cuándo) en Respuestas y en las alertas de Indicadores;
los indicadores usan los valores corregidos. Dos admins editando a la vez: gana el último guardado (el historial conserva ambos cambios).

Pruebas: no hay suite en el repo. Para verificar la UI se usó jsdom con un cliente Supabase
simulado en memoria; la RLS y los triggers se probaron en SQL dentro de transacciones que se revierten
(`DO` + `SET LOCAL ROLE authenticated` + `RAISE EXCEPTION` final).

Servidor local: usar `python -m http.server` (no `npx serve`: reescribe `/login.html` a `/login` y el
check `pathname.endsWith('login.html')` de `auth.js` entra en bucle de redirección).

Ver el plan completo en `~/.claude/plans/a-partir-de-un-adaptive-cosmos.md` (PQRS) y
`~/.claude/plans/c-users-melim-onedrive-desktop-procedim-unified-hinton.md` (Mercadeo).
