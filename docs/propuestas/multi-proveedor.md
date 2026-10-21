# Propuesta: varias cuentas por proyecto, Codex y LLMs locales

> Estado: **para discutir**. Nada de esto está implementado. El objetivo es elegir el rumbo antes de escribir código.
> Fecha: octubre de 2026. Versiones con las que se probó: Claude Code 2.1.288 y Codex CLI 0.160.0.

## Resumen

| Feature | Recomendación |
|---|---|
| **A. Proyectos entre varias cuentas** | Que el proyecto deje de estar atado a **una** cuenta: cada sesión elige su cuenta, y se suma un **relevo** manual (pasar una sesión a otra cuenta llevándose su conversación). **Sin rotación automática al llegar al límite.** Sincronizar entre máquinas queda para una fase posterior, por una carpeta que vos elijas. Varias personas: no por ahora. |
| **B. Codex** | Una **capa de proveedor**: Claude Code y Codex detrás de la misma interfaz. Codex se maneja con su **`app-server`** (JSON-RPC por stdio), que tiene casi todo lo que usamos de Claude: retomar, interrumpir, compactar, uso del plan, ventana de contexto y MCP. Primero como workers, después como orquestadoras. |
| **C. LLMs locales** | Primero una herramienta MCP **`delegar_a_local`** para las sesiones frontier: el modelo local recibe una tarea empaquetada para su ventana y devuelve el resultado, que revisa la sesión frontier. Más adelante, **sesiones locales con Codex `--oss`**, que salen casi gratis una vez que existe la capa de proveedor. Claude Code apuntado a un endpoint local: no. |

Las preguntas para vos están al final ([Preguntas](#preguntas-para-decidir)).

---

## A. Proyectos entre varias cuentas

"Compartidos" no describe la idea, y hay tres lecturas muy distintas. Las desarrollo y después recomiendo una.

### Cómo funciona hoy

- Una **cuenta** de Claude Code es un directorio de configuración (`CLAUDE_CONFIG_DIR`). Ahí están su login, sus settings y sus conversaciones (`<dir>/projects/<cwd-con-guiones>/<id>.jsonl`).
- Cada **proyecto** tiene una sola cuenta (`projects.account_id`), y todas sus sesiones corren con esa.
- El uso del plan (ventanas de 5 h y 7 días) se ve por cuenta.

### ¿Se puede retomar en la cuenta B una conversación de la cuenta A?

**Sí, copiando el transcript.** Lo probé con dos `CLAUDE_CONFIG_DIR` temporales y sin login:

```text
$ CLAUDE_CONFIG_DIR=/tmp/b claude -p --resume <id> "hola"
No conversation found with session ID: <id>          # en B no está

# copiando el .jsonl a /tmp/b/projects/<cwd-con-guiones>/<id>.jsonl
$ CLAUDE_CONFIG_DIR=/tmp/b claude -p --resume <id> "hola"
Not logged in · Please run /login                    # la encontró: ahora solo le falta el login
```

Eso muestra que la conversación se busca **por archivo, en el directorio de la cuenta**, y que nada la ata a la cuenta que la creó. Lo que falta probar con dos cuentas logueadas:

- que el turno siga bien. El modelo recibe el historial entero, así que no debería depender de la cuenta. El caché de prompts sí se pierde: el primer turno en B cuesta como uno sin caché;
- qué pasa con los subagentes y los archivos que la conversación guarda al lado (`<id>/`, tool results grandes). Hay que copiarlos también.

**Importa el cwd**: la carpeta del transcript sale de la ruta del proyecto. Entre dos cuentas de la **misma máquina** no cambia. Entre **dos máquinas** cambia (`/home/…` contra `/Users/…`), y hay que reescribir el `cwd` de cada línea o usar la misma ruta en las dos.

### Lectura 1: un proyecto con varias cuentas en la misma máquina

Las sesiones del proyecto no tienen por qué usar todas la misma cuenta. Hay dos sub-ideas:

- **1a. Repartir**: la orquestadora en una cuenta y los workers en otra, o un worker en la cuenta personal y otro en la del trabajo. La cuenta se elige **por sesión** y el proyecto tiene una cuenta por defecto.
- **1b. Pasar a otra cuenta al llegar al límite** (failover o rotación).

| | 1a. Repartir | 1b. Rotar al límite |
|---|---|---|
| Qué se sincroniza | Nada: todo vive en la misma base. Lo único que cambia es qué cuenta lanza cada sesión. | Igual, más mover la conversación (copiar el transcript) a la cuenta nueva. |
| Qué no se puede | Retomar una sesión en otra cuenta sin copiar su conversación. | — |
| Políticas | Bien, si cada cuenta la usa su titular (ver abajo). | **Choca.** Ver [Políticas](#políticas-de-uso). |

### Lectura 2: el mismo proyecto en dos máquinas

PC y Mac ven el mismo proyecto: sesiones, propuestas, cola, tareas y entornos.

- **Qué se puede sincronizar**: la definición del proyecto, las sesiones (nombre, rol, tarea, estado lógico), las propuestas, la cola de resultados, las tareas y los entornos. Las credenciales de los entornos, solo cifradas o directamente afuera.
- **Qué no se puede**:
  - los procesos vivos: una sesión corre en **una** máquina por vez, así que hace falta un "dueño" con traspaso explícito;
  - las terminales y las apps levantadas;
  - los logins de los CLIs;
  - los worktrees: son del disco de cada máquina, pero se pueden recrear desde la rama.
- **Conversaciones**: se pueden llevar copiando el transcript (ver arriba), reescribiendo el cwd si las rutas difieren. Cada máquina tiene sus propias cuentas logueadas. **No se copia el login** (`.credentials.json` / llavero): compartir credenciales lo prohíben los términos, y además es un riesgo.
- **Transporte**: ver [más abajo](#transporte-entre-máquinas-y-la-regla-100-local).

### Lectura 3: varias personas sobre el mismo proyecto

- Cada persona tiene su cuenta (compartir una no está permitido).
- Haría falta identidad, permisos y resolución de conflictos (dos personas aprobando la misma propuesta). También un transporte que no sea una carpeta de uno.
- Las conversaciones de una persona no deberían retomarse con la cuenta de otra: es una zona gris de "uso individual", y además expone lo que una persona habló con su agente.
- Es lo que más choca con "100% local". **Recomiendo no encararlo ahora.** Lo que sí sirve igual: exportar e importar la definición de un proyecto (roles, instrucciones, entornos sin secretos) como archivo.

### Políticas de uso

Lo que se pudo leer en fuentes primarias:

- **Anthropic, términos para consumidores**: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." ([consumer-terms](https://www.anthropic.com/legal/consumer-terms))
- **Anthropic, Claude Code**: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance))
- **Anthropic, política de uso aceptable**: prohíbe coordinar actividad entre varias cuentas "to avoid detection or circumvent product guardrails" y "circumvent a ban through the use of a different account". ([aup](https://www.anthropic.com/legal/aup))
- **OpenAI**: no pude leer el texto primario (las páginas de términos devolvieron 403). Según fuentes secundarias, los términos vigentes prohíben eludir límites de uso y compartir credenciales, y una cuenta de usuario final la usa una sola persona. **Hay que confirmarlo en el texto oficial antes de implementar.**

Cómo lo leo:

- **Tener varias cuentas propias con propósitos distintos** (personal y trabajo, o la de una organización) y elegir cuál usa cada sesión: **bien**. Es lo mismo que hoy, pero por sesión.
- **Rotar automáticamente** entre cuentas para seguir cuando una llega al límite: **choca** con "ordinary, individual usage" y con eludir guardrails. No encontré una cláusula que diga literalmente "no rotes cuentas", pero el espíritu es claro y el riesgo es que suspendan las cuentas. **Recomiendo no construirlo**, ni automático ni como botón de "seguir con otra cuenta" cuando se agota el plan.
- **El relevo manual** (pasar una sesión a otra cuenta tuya) es la zona gris: el mecanismo es el mismo que rotar, y lo que cambia es la intención. Si se hace, que lo inicies vos, que no aparezca como respuesta al límite y que la UI lo diga.

### Transporte entre máquinas y la regla "100% local"

CONTRIBUTING dice: *"El dashboard es 100% local: nada de telemetría, servicios externos ni cuentas propias. Solo habla con Claude Code y con tu navegador."*

| Opción | Cómo | Respeta la regla | Contras |
|---|---|---|---|
| **Carpeta sincronizada que ya usás** (Syncthing, iCloud Drive, Dropbox, una carpeta de red) | Cada máquina escribe un registro de cambios en la carpeta y lee los de la otra. No es la base SQLite: copiar la base entera la corrompe. | Sí: control-plane solo escribe archivos. El servicio, si hay, lo elegiste vos. | Latencia variable y conflictos si las dos editan a la vez (se resuelven con un dueño por proyecto y un registro de cambios). |
| **git** (un repo privado o una rama huérfana `control-plane-state`) | Exportar el estado como archivos y hacer commit y push. | Sí, con tu remoto. | Sirve para la definición del proyecto, no para lo que cambia a cada rato (la cola, las tareas). Ensucia el historial si va en el repo del proyecto. |
| **Conexión directa** (LAN o una VPN propia tipo Tailscale) | Los dos servers se hablan por HTTP con un token emparejado. | Sí, si es entre tus máquinas. | Las dos tienen que estar prendidas. Hay que exponer un puerto (hoy todo escucha solo en 127.0.0.1) y cuidar la autenticación. |

**Recomendación**: si se hace, por **carpeta sincronizada**, con un registro de cambios por máquina y un dueño por proyecto. Así no hay que abrir puertos.

La regla habría que reescribirla, porque con Codex ya no es cierto que "solo habla con Claude Code". Por ejemplo: *"No habla con servicios propios ni de terceros, salvo los CLIs de los agentes que vos instalaste y lo que vos configures (una carpeta sincronizada u otra máquina tuya)."*

### Recomendación para A

1. **Cuenta por sesión (1a)**: la cuenta del proyecto pasa a ser la de por defecto, y cada sesión puede elegir otra, de cualquier proveedor cuando exista Codex. Es la base de B.
2. **Relevo manual de una sesión** a otra cuenta del **mismo proveedor**: copia su conversación (transcript y archivos asociados) y la retoma ahí. Lo iniciás vos, con un aviso sobre las políticas. Entre proveedores no se puede: una conversación de Claude no se retoma en Codex. Lo que sí se puede es arrancar una sesión nueva con un resumen de la anterior.
3. **Sin rotación automática.**
4. **Espejo entre máquinas (lectura 2)**: fase aparte, solo si de verdad lo usás. Tiene un costo alto.
5. **Varias personas**: no por ahora.

### Nombres posibles

Para "un proyecto que no está atado a una cuenta, donde trabajan varias cuentas o proveedores":

- **Plantel**: el plantel del proyecto son las cuentas y agentes que trabajan en él. Corto, se entiende y no promete sincronización.
- **Proyecto multicuenta**: descriptivo, sin vueltas.
- **Equipo** (de cuentas): claro, pero se confunde con "varias personas".
- **Relevo**: no es el nombre del proyecto sino de la acción de pasar una sesión a otra cuenta o máquina. Encaja con "el que sigue toma la posta".

Para la lectura 2, si se hace: **proyecto espejado** o **Espejo**.

---

## B. Codex

### Qué tiene el Codex CLI

Lo verifiqué con el binario 0.160.0 corrido con `npx` en una carpeta temporal, con `HOME` y `CODEX_HOME` propios y sin login. El protocolo lo saqué con `codex app-server generate-ts`, y lo demás de la documentación oficial y del repo.

**Modos sin interacción**

- **`codex exec --json`**: un turno por proceso, con eventos JSONL. Sin login, mi prueba dio:
  ```json
  {"type":"thread.started","thread_id":"01a10c19-…"}
  {"type":"turn.started"}
  {"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized …)"}
  {"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized …"}}
  ```
  Además emite `item.started/updated/completed` (mensaje, reasoning, comando, cambio de archivo, llamada MCP, búsqueda web, plan) y `turn.completed` con el uso. Se retoma con `codex exec resume <id> "…"`.
- **`codex app-server`**: JSON-RPC bidireccional por stdio (o socket Unix o WebSocket). Está marcado como **[experimental]**. Es lo que más se parece a nuestro `claude -p --input-format stream-json`.
  - Métodos del cliente: `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/name/set`, `turn/start`, `turn/steer` (agregar texto a un turno en curso), `turn/interrupt`, `thread/compact/start`, `model/list`, `account/read`, `account/rateLimits/read`, `account/usage/read`, `mcpServerStatus/list`, `config/mcpServer/reload` y `getAuthStatus`.
  - Notificaciones: `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated` (con `modelContextWindow`), `thread/compacted`, `account/rateLimits/updated`, `hook/started` y `hook/completed`, y `mcpServer/startupStatus/updated`.
  - Pedidos del server, para aprobar: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` y `item/tool/requestUserInput`.
  - `ThreadStartParams` acepta `model`, `modelProvider`, `cwd`, `approvalPolicy`, `sandbox`, `config`, `baseInstructions` y **`developerInstructions`**: ahí va nuestro protocolo.
  - `RateLimitSnapshot` tiene `primary` y `secondary` (`usedPercent`, `windowDurationMins`, `resetsAt`) y `planType`. Es el equivalente directo de nuestras ventanas de 5 h y 7 días.
- **`codex mcp-server`**: en 0.160 no es un subcomando (lo toma como un prompt). No hace falta: nosotros somos los que exponemos MCP.

**Sesiones y cuentas**

- **Dónde guarda las conversaciones**: en 0.160, en **SQLite dentro de `CODEX_HOME`** (`thread_history_1.sqlite`, `state_5.sqlite`, …). En versiones anteriores eran archivos `sessions/AAAA/MM/DD/rollout-*.jsonl`, y existe un `codex migrate-rollouts`. Consecuencia para A: no se puede hacer un relevo de Codex copiando un archivo. Sería con `thread/fork` o reconstruyendo el historial con `thread/inject_items`, sin probar.
- **Una cuenta es un `CODEX_HOME`**: ahí viven el login (`auth.json` o el llavero, según `cli_auth_credentials_store`), la config y el historial. Es igual que `CLAUDE_CONFIG_DIR` para nosotros.
- **Login**: con ChatGPT (OAuth en el navegador o device code) o con API key. Se dispara con `codex login` o con `account/login/start` por el protocolo. Encaja en el catálogo de CLIs y en el botón de reautenticar de las tareas.

**Instrucciones y herramientas**

- **Instrucciones**: `AGENTS.md` (global en `CODEX_HOME` y por carpeta, hasta 32 KiB), `developer_instructions` y `model_instructions_file`.
  - Nuestro protocolo va como `developerInstructions` en `thread/start`, no en `AGENTS.md`, para no escribir en el repo del usuario.
  - **Ojo**: Codex va a leer el `AGENTS.md` del repo y nosotros no lo controlamos. Pasa lo mismo con `CLAUDE.md` en Claude.
- **MCP**: soporta servidores por stdio y por **streamable HTTP**, que es lo que exponemos (`/mcp/<token>`). Se configura por sesión con `-c mcp_servers.control-plane.url="http://127.0.0.1:4700/mcp/<token>"`, sin tocar el `config.toml` del usuario.
- **Permisos y sandbox**:
  - `--sandbox read-only | workspace-write | danger-full-access`;
  - `approval_policy` `on-request` o `never`, o granular;
  - `--dangerously-bypass-approvals-and-sandbox`, el equivalente a nuestro `--dangerously-skip-permissions`.
- **Compactación**: automática según `model_auto_compact_token_limit` y `model_context_window`, y manual con `thread/compact/start`. Avisa con `thread/compacted`. Hay hooks (`hook/started` y `hook/completed`), pero no confirmé que exista un equivalente a nuestro `PreCompact`, que frena la compactación hasta que elegís qué conservar.
- **Subagentes**: existen (`spawn_agent`, `wait_agent`, `agents.*` en la config), pero solo se lanzan si se los pide explícitamente, y hay issues abiertos de inestabilidad (#14579, #27331, #31097). Al principio, **sin subagentes en Codex**.
- **Locales**: `--oss --local-provider ollama|lmstudio` y `model_providers.<id>` con `base_url`. Ver C.

### Mapeo contra lo que tenemos

| Pieza actual | Claude Code | Codex (app-server) | En la capa de proveedor |
|---|---|---|---|
| `claude/args.ts` (`buildLaunch`) | `-p --input-format stream-json …`, `--resume`, `--append-system-prompt`, `--mcp-config`, `--settings` (hooks) | `codex app-server` y después `thread/start` (o `thread/resume`) con `developerInstructions`, `sandbox`, `approvalPolicy` y `-c mcp_servers…` | `launch(session)` propio de cada proveedor |
| `claude/process.ts` | Líneas JSON con `control_request` y `control_response` | JSON-RPC 2.0 (`id`, `method`, `params`) | Un transporte por proveedor; el proceso de base (spawn, stderr, exit) se comparte |
| `claude/normalize.ts` | `stream_event`, `assistant`, `user`, `result`, `rate_limit_event`, `system/*` → `Action` | `item/*`, `turn/*`, `thread/tokenUsage/updated`, `account/rateLimits/updated` → `Action` | **`Action` ya es el contrato neutral**: cada proveedor tiene su normalizador |
| Mandar un mensaje | Una línea `user` por stdin | `turn/start`, o `turn/steer` si hay un turno en curso | `send(text, adjuntos)` |
| Interrumpir | `control_request interrupt` | `turn/interrupt` | `interrupt()` |
| Modelo y esfuerzo | `set_model`, `apply_flag_settings` | En `turn/start` o `thread/settings`; la lista sale de `model/list` | `setModel()`, `models()` |
| Contexto | `get_context_usage` | `thread/tokenUsage/updated` (con `modelContextWindow`) | `contextUsage()` |
| Uso del plan | `rate_limit_event` (5 h y 7 d) | `account/rateLimits/updated` (`primary` y `secondary`) | `UsageInfo` con ventanas genéricas `{ label, usedPercent, resetsAt }` |
| Compactación (`compaction.ts`, hook `PreCompact`) | Hook que frena y deja elegir qué conservar | `thread/compact/start` y `thread/compacted`; frenar antes, sin confirmar | Capacidad opcional: `canHoldCompaction` |
| Protocolo (`prompts.ts`) | `--append-system-prompt` | `developerInstructions` | Mismo texto, con detalles por proveedor (los nombres de las herramientas MCP son iguales) |
| MCP de control-plane | `--mcp-config` (HTTP) | `-c mcp_servers.control-plane.url=…` (HTTP) | Sin cambios en `mcp.ts` |
| Cuentas (`accounts.ts`) | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `Account { provider, home }` |
| Retomar tras reiniciar (`restart.ts`, `resume.json`) | `--resume <claudeSessionId>` | `thread/resume <threadId>` | `providerSessionId` genérico |
| Recuperar tras `/clear` (`recover.ts`) | Propio de Claude | No aplica | Queda en Claude |
| Subagentes (`--forward-subagent-text`) | Sí | Inestable | Capacidad opcional |
| Mensajes entre sesiones (`crossSessionInbound`) | Propio de Claude Code | No existe | Las sesiones Codex se coordinan solo por el MCP de control-plane |
| Slash commands | `parseCommands` | No | Opcional |

**Qué se abstrae**:

```ts
interface AgentProvider {
  id: "claude" | "codex" | "local"
  detect(): Promise<{ bin: string; version: string } | null>
  accountEnv(account: Account): NodeJS.ProcessEnv          // CLAUDE_CONFIG_DIR, CODEX_HOME…
  models(account: Account): Promise<ModelInfo[]>            // con contextWindow y si sirve de orquestadora
  launch(session: SessionRecord, opts: LaunchOptions): AgentRuntime
  capabilities: { subagents: boolean; holdCompaction: boolean; slashCommands: boolean; steer: boolean }
}

interface AgentRuntime extends EventEmitter<{ action: [Action]; exit: [ExitInfo] }> {
  start(): Promise<void>                // initialize + thread/start o resume
  send(text: string, attachments: Attachment[]): Promise<void>
  interrupt(): Promise<void>
  setModel(model: string, effort?: string): Promise<void>
  compact(instructions?: string): Promise<void>
  contextUsage(): Promise<ContextUsage | null>
  close(): Promise<void>
}
```

- **Queda igual**: `sessions.ts`, que habla con un `AgentRuntime` en lugar de un `ClaudeProcess`; el timeline (`Action`); `mcp.ts`; el protocolo; la cola, las propuestas y las tareas.
- **Queda propio de cada proveedor**: los argumentos, el transporte, el normalizador, los hooks de compactación, la recuperación del `/clear`, los slash commands y las aprobaciones.

**Base de datos**: `sessions` suma `provider`, `account_id` (la cuenta por sesión de la feature A) y `provider_session_id`, que hoy es `claude_session_id`. `accounts` suma `provider`.

**Sandbox de Codex**: hoy Claude corre con `--dangerously-skip-permissions`. Para que valga lo mismo, Codex correría con `--dangerously-bypass-approvals-and-sandbox`. La alternativa más segura es `workspace-write` con `approvalPolicy: never`: escribe solo en el repo y en las carpetas que se agreguen. Las aprobaciones (`requestApproval`) podrían llegar a la UI como "la sesión te necesita". Es una pregunta para vos.

### Qué cambia en la UI

- **Nueva sesión y nueva orquestadora**: elegir proveedor, cuenta y modelo, con la lista de modelos de cada proveedor y su ventana. Las orquestadoras solo ofrecen modelos frontier (ver C).
- **Cuentas** (barra lateral y Herramientas): agrupadas por proveedor ("Claude", "Codex", "Local"), cada una con su login y su uso del plan. El medidor de uso pasa a ventanas genéricas: Claude muestra 5 h y 7 d; Codex, las de su plan.
- **En la sesión**: un ícono del proveedor al lado del nombre. El selector de modelo muestra los del proveedor de la sesión. Lo que el proveedor no tiene (subagentes, frenar la compactación, slash commands) no aparece, en lugar de fallar.
- **Proyecto**: la cuenta por defecto y, si se confirma A, el plantel de cuentas que pueden usar sus sesiones.
- **Herramientas → CLIs**: Codex ya puede estar en el catálogo (login con `codex login`, estado con `codex login status`, a confirmar). El botón de reautenticar de las tareas funciona igual.

### Políticas (B)

- control-plane sigue usando **el binario oficial** de cada proveedor con **tu login**, nunca el SDK con credenciales de suscripción. Con Codex es lo mismo: el `codex` instalado, con tu `CODEX_HOME`.
- `app-server` es el protocolo que OpenAI publica para integrar Codex en otras aplicaciones, y genera sus propios tipos. Usarlo no es usar el CLI de una forma no prevista. Igual hay que releer los términos de OpenAI sobre uso automatizado con login de ChatGPT, porque no pude abrirlos.

---

## C. LLMs locales como modelos de soporte

Lo que pediste como premisa: **las orquestadoras son siempre frontier**. Los modelos locales hacen tareas acotadas, porque tienen una ventana mucho más chica y rinden menos en razonamiento largo.

### Las cuatro opciones

#### 1. Una sesión de Codex con proveedor local

- **Cómo**: `codex app-server` con `--oss --local-provider ollama` (o `model_providers.<id>.base_url` para llama.cpp o vLLM). Con la capa de B, es otro proveedor más (`local`) que reusa el adaptador de Codex.
- **Ventana**: Codex manda sus instrucciones de base, las herramientas y `AGENTS.md`. Las guías recomiendan **32K de contexto como mínimo** (los ejemplos usan gpt-oss-20b). Con 8-16K no entra.
- **Calidad**: depende de que el modelo use bien las herramientas (tool calling) dentro del bucle de Codex. gpt-oss es el caso de uso que OpenAI pensó para esto.
- **Costo para nosotros**: bajo, una vez hecha la capa de proveedor.
- **Riesgo**: bajo en políticas (está soportado). Técnico: medio, porque es un agente completo con un modelo chico y puede dar vueltas.

#### 2. Claude Code apuntado a un endpoint local

- **Cómo**: `ANTHROPIC_BASE_URL=http://localhost:11434` (Ollama) o `:1234` (LM Studio), los dos con API compatible con Anthropic, más `ANTHROPIC_AUTH_TOKEN` y `--model <local>`. Ollama y LM Studio lo documentan ([Ollama](https://docs.ollama.com/integrations/claude-code), [LM Studio](https://lmstudio.ai/docs/developer/anthropic-compat)).
- **Soporte**: Anthropic dice que "doesn't support routing Claude Code to non-Claude models through any gateway" ([llm-gateway](https://code.claude.com/docs/en/llm-gateway)). No lo prohíbe, pero no tiene soporte: cualquier versión nueva puede romperlo.
- **Técnico**:
  - el gateway tiene que reenviar los headers `anthropic-beta` y hacer streaming completo;
  - la ventana de un modelo desconocido se asume en 200K y hay que corregirla a mano;
  - el system prompt y las herramientas de Claude Code ocupan una parte grande de una ventana chica.
- **Recomendación**: **no**. Es frágil y sin soporte, y desperdicia la ventana.

#### 3. Un agente propio mínimo

- **Cómo**: un bucle en el server con 4 herramientas (leer, buscar, listar y aplicar un parche) contra `/v1/chat/completions` de Ollama, LM Studio o llama.cpp, que los tres tienen. El prompt es nuestro y chico (menos de 1K tokens).
- **Ventaja**: control total del tamaño. Anda con 8-16K.
- **Costo de mantenimiento**: **alto**. Hay que parsear el tool calling de cada modelo (llama.cpp necesita `--jinja`, y cada familia lo hace distinto), cortar los bucles, controlar las ediciones y mantenerlo al día. Es hacer otro Claude Code chiquito.
- **Recomendación**: solo como pieza interna de la opción 4 (un bucle corto y de solo lectura), no como sesión.

#### 4. Una herramienta MCP para las sesiones frontier: `delegar_a_local`

- **Cómo**: el MCP de control-plane suma `delegar_a_local({ tarea, archivos, formato })`. La sesión frontier, que puede ser una orquestadora o un worker, decide qué delegar. El server empaqueta la tarea, llama al modelo local y devuelve el resultado. **La sesión frontier lo revisa y lo aplica.**
- **Cómo se ve el patrón**: el grande planifica y revisa, el chico hace el trabajo mecánico. Hay varios MCP comunitarios que lo hacen (ej. `claude-code-delegate-local`, `mcp-local-llm`), aunque no los evalué.
- **Ventana**: la controla el empaquetado (abajo). El modelo local nunca ve más que lo que se le manda.
- **Políticas**: ninguna fricción. Es un servicio en tu máquina, llamado desde una herramienta nuestra.
- **Costo**: bajo, porque reusa el MCP que ya tenemos.

### Cómo se empaqueta la tarea

Para las opciones 4 y 3:

1. **El presupuesto**: entrada ≤ 60% de la ventana del modelo, y el resto para la respuesta. Los tokens se estiman en unos 3,5 caracteres cada uno. El tokenizador exacto varía con el modelo y no vale la pena.
2. **Lo que entra, en orden**: una instrucción fija y corta (qué devolver y en qué formato), la tarea, los archivos pedidos (enteros o por rangos de líneas, con la ruta) y, si sobra lugar, las firmas o tipos de los archivos relacionados.
3. **Si no entra**, no se recorta en silencio: la herramienta devuelve "no entra en la ventana de qwen3-coder (32K): partila o pasame menos archivos". El que decide es el frontier.
4. **El formato de salida** se pide estructurado (un diff unificado, JSON con un esquema o texto). Los diffs se validan con `git apply --check` antes de devolverlos.
5. **Sin herramientas** (un solo paso) por defecto. Con `explorar: true`, un bucle corto de solo lectura (leer y buscar, como mucho N pasos).

### Cómo se detectan los modelos y su ventana

| Servidor | Listar | Ventana | Tool calling |
|---|---|---|---|
| **LM Studio** | `GET /api/v1/models` | Viene la configurada y la máxima | Dice si el modelo lo soporta |
| **llama.cpp** | `GET /v1/models` | `GET /props` → `n_ctx` | Con `--jinja` |
| **Ollama** | `GET /v1/models` (o `/api/tags`) | `POST /api/show` (la ventana del modelo, sin confirmar el campo) y `num_ctx`, que es lo que de verdad usa y se fija en el Modelfile. **El default de Ollama es chico**: hay que avisarlo. | Según el modelo |

control-plane buscaría los tres en sus puertos por defecto (11434, 1234 y 8080), solo en `127.0.0.1`, y mostraría lo que encuentra en Herramientas → Modelos locales, con un endpoint configurable.

### Hardware y calidad

Son cifras de terceros, que hay que verificar con tareas propias:

- **12-16 GB de VRAM** (o una Mac de 16-24 GB): gpt-oss-20b (~16 GB) o un Qwen coder de 14B. Sirven para tareas mecánicas.
- **24-32 GB** (o una Mac de 32 GB): Qwen3-Coder 30B (MoE, ~19 GB en Q4) o Devstral Small, que rinden bien en tareas acotadas.
- **Más grandes** (Devstral 2 de 123B, GLM-4.6): hardware de servidor. Quedan fuera de este caso.

**En qué andan bien**: renombrar en pocos archivos, escribir docstrings o tests a partir de un patrón dado, resumir logs largos, extraer datos, convertir formatos o revisar un diff chico contra una regla concreta.

**En qué no**: decisiones de diseño, cambios en muchos archivos, depurar algo sin pistas o lo que necesita todo el repo. Por eso las orquestadoras son frontier, y lo que hace el modelo local lo revisa el frontier.

### Cómo se ve en la UI

- **En el chat de la sesión frontier**: la llamada a `delegar_a_local` aparece como una herramienta más, con el modelo ("qwen3-coder-30b · local"), tokens de entrada y de salida, tokens por segundo, el tiempo y **$0**.
- **En el resumen del proyecto**: lo delegado del día (cantidad, tokens y lo que hubiera costado con el modelo de la sesión, como dato orientativo).
- **Herramientas → Modelos locales**: los servidores detectados, los modelos con su ventana, un "probar" con un prompt corto y cuál usar por defecto.
- **Sesiones locales** (opción 1, después): en "Nueva sesión", el proveedor "Local". Solo para workers, nunca para orquestadoras, y con un aviso si la ventana es menor de 32K.

### Recomendación para C

1. **`delegar_a_local` (opción 4)** primero: es la que más rinde con menos riesgo y no depende de B.
2. **Sesiones locales con Codex `--oss` (opción 1)** cuando exista la capa de proveedor: para workers acotados que tengan que editar solos.
3. **No** a Claude Code con endpoint local (opción 2). El agente propio (opción 3), solo como el bucle de solo lectura dentro de la opción 4.

---

## Arquitectura propuesta

```text
                         ┌─────────────────────────────┐
web (sesión, cuentas) ── │ sessions.ts (SessionManager) │ ── timeline / cola / tareas / propuestas
                         └──────────────┬──────────────┘
                                        │ AgentRuntime (send, interrupt, compact, …) + Action
                 ┌──────────────────────┼───────────────────────┐
         ┌───────┴───────┐      ┌───────┴────────┐      ┌───────┴────────┐
         │ ClaudeProvider │      │ CodexProvider  │      │ LocalProvider  │
         │ claude -p      │      │ codex app-     │      │ = Codex --oss   │
         │ stream-json    │      │ server (JSON-  │      │ (fase 5)        │
         │ hooks, /clear  │      │ RPC), threads  │      │                 │
         └───────┬───────┘      └───────┬────────┘      └────────────────┘
                 │ CLAUDE_CONFIG_DIR    │ CODEX_HOME
                 └──────────┬───────────┘
                            │ MCP HTTP /mcp/<token> (el mismo para todos)
                     ┌──────┴──────┐
                     │   mcp.ts     │ ── delegar_a_local ──► Ollama / LM Studio / llama.cpp (127.0.0.1)
                     └─────────────┘
```

- `Account` pasa a tener `provider`. Cada sesión tiene su cuenta (con el default del proyecto).
- `UsageInfo` pasa a tener ventanas genéricas. El medidor de uso no sabe de proveedores.
- El protocolo es uno solo, con párrafos condicionales por proveedor (lo que no existe en Codex, como los mensajes entre sesiones, no se menciona).

## Fases y esfuerzo

El esfuerzo es en días de trabajo de una sesión worker con revisión, y es orientativo.

| Fase | Qué | Esfuerzo | Depende de |
|---|---|---|---|
| **0** | Capa de proveedor con Claude adentro, sin cambios visibles: `AgentRuntime`, `Action` como contrato, `provider` en cuentas y sesiones, `UsageInfo` genérico. Con tests que comparen la salida antes y después. | 5-7 días | — |
| **1** | Cuenta por sesión (A.1a) y relevo manual de una sesión de Claude a otra cuenta (A.2), con su aviso. | 3-4 días | 0 |
| **2** | `delegar_a_local` (C.4): detección de servidores, empaquetado, Herramientas → Modelos locales, la tarjeta en el chat. | 4-6 días | — (puede ir en paralelo) |
| **3** | Codex como worker: adaptador de `app-server`, normalizador, MCP, retomar, interrumpir, login en el catálogo de CLIs, uso del plan. Con tests contra respuestas grabadas, para seguir los cambios de un protocolo experimental. | 8-12 días | 0 |
| **4** | Codex como orquestadora: compactación (sin frenar si no hay hook equivalente), protocolo de orquestadora, propuestas. | 4-5 días | 3 |
| **5** | Sesiones locales (C.1) con Codex `--oss`: proveedor `local`, aviso de ventana, solo workers. | 2-3 días | 3 |
| **6** (si se confirma) | Espejo entre máquinas (A, lectura 2): registro de cambios en una carpeta sincronizada, dueño por proyecto, traspaso de sesiones y de su conversación con reescritura del cwd. | 15-20 días | 0, 1 |

Orden sugerido: **0 → (1 y 2 en paralelo) → 3 → 4 → 5**, y la 6 solo si la querés después de usar las anteriores.

## Riesgos

**Técnicos**

- **`codex app-server` es experimental**: el protocolo puede cambiar entre versiones. Para contenerlo: fijar una versión mínima probada, tests contra respuestas grabadas y avisar en la UI si el `codex` instalado es más nuevo que el probado. Si se rompe, hay un plan B con `codex exec --json` y un proceso por turno, que es estable pero sin `steer` y con el interrumpir hecho matando el proceso.
- **El relevo copia archivos internos de Claude Code**: el formato del transcript no es público. Hay que copiarlo tal cual (sin reinterpretarlo) y verificar con `--resume` antes de borrar el original.
- **Codex y la compactación**: si no hay un equivalente a `PreCompact`, la función "elegir qué conservar" no existe en Codex. Se avisa en la UI.
- **Modelos locales**: hay que validar el tool calling por modelo, y un `num_ctx` chico en Ollama corta en silencio. Se detecta y se avisa.
- **La capa de proveedor** toca la parte más delicada (`sessions.ts`). La fase 0 tiene que ser un refactor sin cambios visibles y con tests de regresión.

**De políticas**

- **La rotación de cuentas** choca con los términos (ver [Políticas](#políticas-de-uso)): no se construye. El relevo manual es zona gris y lo decidís vos.
- **Los términos de OpenAI** no pude leerlos en la fuente primaria: hay que leerlos antes de la fase 3.
- **Claude Code contra modelos que no son Claude**: sin soporte de Anthropic. Por eso no está en la propuesta.

**De seguridad**

- **Las credenciales de los entornos** no se sincronizan en claro entre máquinas: o cifradas con una clave que no viaja con los datos, o afuera.
- **Los transcripts** pueden tener secretos que pasaron por la conversación. Copiarlos a otra cuenta o máquina los replica.
- **Codex sin sandbox** (`--dangerously-bypass…`) tiene el mismo nivel de riesgo que Claude con `--dangerously-skip-permissions`. Es más seguro `workspace-write`.
- **Los archivos de sesión de Codex** pueden quedar legibles por otros usuarios de la máquina (issue [#21660](https://github.com/openai/codex/issues/21660)). Se mitiga con permisos 0700 en `CODEX_HOME`, como ya hacemos con la base.
- **`delegar_a_local`** solo habla con `127.0.0.1` por defecto. Un endpoint remoto se configura a mano y queda a la vista. Lo que devuelve el modelo local es texto: nunca se ejecuta ni se aplica solo.
- **El espejo por conexión directa** necesitaría abrir un puerto: por eso se recomienda la carpeta.

## Lo que probé

- **Codex CLI 0.160.0**: con `npx` en `/tmp`, con `HOME`, `CODEX_HOME` y caché de npm temporales, sin login y sin instalar nada global. Miré `--help` de `codex`, `exec` y `app-server`, y corrí `exec --json` sin login (salida de arriba). Generé los tipos del protocolo con `app-server generate-ts`, de donde salen los métodos, las notificaciones, `ThreadStartParams`, `RateLimitSnapshot` y `ThreadTokenUsage`. Vi qué crea en `CODEX_HOME`: SQLite, sin rollouts.
- **Claude Code 2.1.288**: `--resume` con dos `CLAUDE_CONFIG_DIR` temporales y sin login. Sin el transcript da "No conversation found"; con el transcript copiado, "Not logged in". No toqué ninguna cuenta real.
- **No probé**: un turno real con Codex ni con Claude en otra cuenta (haría falta loguear), ni ningún modelo local.

## Preguntas para decidir

1. **¿Cuál de las tres lecturas de A es la tuya?** (1) varias cuentas en el mismo proyecto en esta máquina; (2) el mismo proyecto en tu PC y tu Mac; (3) varias personas. ¿O una combinación?
2. **Si es la 1**: ¿para qué querés varias cuentas? ¿Propósitos distintos (personal y organización) o seguir cuando una llega al límite? La segunda choca con las políticas y no la recomiendo.
3. **¿Querés el relevo manual** (pasar una sesión a otra cuenta tuya llevándose su conversación), sabiendo que es zona gris si el motivo es el límite?
4. **Si es la 2**: ¿qué carpeta sincronizada usás hoy entre la PC y la Mac (Syncthing, iCloud, Dropbox u otra)? ¿Las credenciales de los entornos tienen que viajar, o cada máquina carga las suyas?
5. **¿Qué nombre te gusta?** Plantel, Proyecto multicuenta, Equipo o Relevo (para la acción). ¿O ninguno?
6. **¿Te sirve reescribir la regla "100% local"** como está en la propuesta (los CLIs de los agentes, más lo que vos configures)?
7. **Codex**: ¿lo querés para workers, orquestadoras o los dos? ¿Tenés plan de ChatGPT (Plus, Pro o Team) o usarías API key?
8. **El sandbox de Codex**: ¿lo mismo que Claude hoy (sin sandbox ni aprobaciones), o `workspace-write`, más seguro pero que a veces frena?
9. **Locales**: ¿qué hardware tenés en cada máquina (GPU y VRAM en la PC, memoria de la Mac)? ¿Usás ya Ollama, LM Studio o llama.cpp?
10. **`delegar_a_local`**: ¿lo pueden usar todas las sesiones o solo las que habilites? ¿Y las orquestadoras?
11. **Prioridad**: ¿arrancamos por la fase 0 + la 2 (capa de proveedor y delegar a local) o preferís ir directo a Codex?

## Fuentes

- Anthropic: [consumer-terms](https://www.anthropic.com/legal/consumer-terms), [aup](https://www.anthropic.com/legal/aup), [Claude Code legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [LLM gateway](https://code.claude.com/docs/en/llm-gateway), [protocolo del gateway](https://code.claude.com/docs/en/llm-gateway-protocol), [configuración de modelos](https://code.claude.com/docs/en/model-config).
- Codex: [modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode), [comandos](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [config](https://learn.chatgpt.com/docs/config-file/config-reference), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [auth](https://learn.chatgpt.com/docs/auth) (`developers.openai.com/codex/*` redirige ahí), [README del app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), issues [#14579](https://github.com/openai/codex/issues/14579), [#21660](https://github.com/openai/codex/issues/21660), [#27331](https://github.com/openai/codex/issues/27331), [#29426](https://github.com/openai/codex/issues/29426), [#31097](https://github.com/openai/codex/issues/31097).
- Locales: [Ollama, compatibilidad OpenAI](https://docs.ollama.com/api/openai-compatibility), [Ollama con Claude Code](https://docs.ollama.com/integrations/claude-code), [LM Studio OpenAI](https://lmstudio.ai/docs/developer/openai-compat), [LM Studio Anthropic](https://lmstudio.ai/docs/developer/anthropic-compat), [LM Studio, listar modelos](https://lmstudio.ai/docs/developer/rest/list), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
- Ejemplos de delegación (comunitarios, sin evaluar): [claude-code-delegate-local](https://github.com/fegone/claude-code-delegate-local), [mcp-local-llm](https://github.com/aplaceforallmystuff/mcp-local-llm).
