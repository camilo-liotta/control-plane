# control-plane

Dashboard local para trabajar con varias sesiones de Claude Code en paralelo sobre un mismo repo, con una sesión **orquestadora** que tiene el panorama general y arma los prompts, y sesiones **worker** que trabajan solas y reportan al terminar.

Reemplaza el copy-paste entre terminales y el chat que orquesta: los workers le entregan sus resultados directo a la orquestadora, ella te propone los próximos prompts y vos los aprobás (o los editás) antes de que salgan. Podés escribirle a cualquier sesión en cualquier momento sin pasar por la orquestadora.

No reinventa nada: cada sesión es el `claude` que ya tenés instalado, con tu login, corriendo en modo headless. El dashboard le da una UI y un poco de estructura.

## Requisitos

- **Node.js 24 o más nuevo** (corre TypeScript y SQLite nativos, sin compilar ni dependencias nativas).
- **Claude Code** instalado y logueado (`claude --version` tiene que andar en la terminal donde levantás el dashboard).
- Linux o macOS.

## Instalación y uso diario

```bash
git clone <este repo> control-plane
cd control-plane
npm install
npm start
```

`npm start` compila la web y levanta el server en **http://127.0.0.1:4700**. Las sesiones viven mientras el server esté corriendo; si lo cerrás, quedan detenidas y se reanudan (con `claude --resume`) cuando les volvés a escribir.

Para desarrollar el dashboard: `npm run dev` (server en 4700 + Vite con recarga en **http://localhost:4701**). Tests del server: `npm test`.

## Cómo se usa

1. **Nuevo proyecto**: elegís la carpeta del repo. Se crea su orquestadora (`ORQ-<PROYECTO>`).
2. **Contale el objetivo a la orquestadora** en su chat. Te va a proponer sesiones nuevas y prompts para cada una. Las propuestas aparecen como tarjetas: **Enviar**, **Editar** o **Descartar**.
3. **Sesiones worker**: las creás vos ("Nueva sesión": nombre, rol y primer prompt opcional) o aprobás las que propone la orquestadora. Arrancan con el protocolo de trabajo en paralelo ya cargado.
4. **Intervenir**: entrá a cualquier sesión y escribile. Si está trabajando, tu mensaje se suma al turno en curso. **Interrumpir** corta el turno.
5. **Resultados**: cuando un worker termina, llama a `report_result` y el resultado entra a la **cola** de la orquestadora (lo ves al instante en el tablero y en la Bandeja).
6. **Bandeja**: todo lo que espera una decisión tuya, en todos los proyectos. Las preguntas de Claude (AskUserQuestion) y los pedidos de aprobación se contestan desde el chat.

Atajos: <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> para saltar a cualquier sesión, <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>B</kbd> para ocultar la barra lateral.

### El mapa del proyecto

El tablero de cada proyecto tiene un **mapa en vivo**: la orquestadora en el centro, cada sesión conectada a ella y, colgando de cada sesión, los subagentes que tiene corriendo.

- **Color = estado**: trabajando, te necesita, terminó, esperando o error.
- **Animaciones**: el nodo late mientras trabaja (más rápido si te necesita) y su línea fluye hacia la orquestadora. El anillo de la orquestadora gira mientras revisa la cola; un punto ámbar sobre una línea es un resultado de esa sesión en la cola, y un número ámbar, propuestas listas para vos.
- **Sesiones en desuso**: las detenidas hace más de un día se ven apagadas.
- Pasá el mouse para ver el detalle (tarea, qué está haciendo, tokens y costo) y hacé clic para abrir la sesión; en un subagente, abre lo que está haciendo. Las sesiones se pueden arrastrar para acomodarlas.

### Sesiones viejas

**Archivar sesión** (en el menú de la sesión) la detiene y la saca del tablero y del mapa. Al pie del tablero, **Archivadas** las lista:

- **Restaurar** la vuelve al tablero; se reanuda cuando le escribís.
- **Eliminar** borra del dashboard su historial, sus adjuntos y sus resultados.

La conversación de Claude Code no se borra nunca: queda en disco y se retoma desde una terminal con `claude --resume <id>`.

### En el chat de cada sesión

- **Slash commands**: escribí `/` y aparecen los comandos y skills de esa sesión (`/compact`, `/context`, `/code-review`…). <kbd>↑</kbd>/<kbd>↓</kbd> para elegir, <kbd>Tab</kbd> para completar.
- **Adjuntos**: con el clip, pegando (<kbd>Ctrl</kbd>+<kbd>V</kbd> de una captura) o arrastrando archivos al chat. Las imágenes Claude las ve directo; cualquier archivo queda guardado en disco y Claude recibe su ruta para abrirlo con sus herramientas. Las imágenes grandes se achican antes de subirlas. Se ven en el mensaje y en la sección **Adjuntos** del panel; las imágenes que devuelve una herramienta (capturas, imágenes leídas) aparecen en su fila.
- **Modelo y esfuerzo**: se cambian desde el encabezado, en vivo: aplican desde el próximo turno sin reiniciar la sesión.
- **Costo y tokens**: el encabezado muestra lo acumulado de la sesión (costo equivalente API y tokens, incluidos sus subagentes), el panel el desglose (entrada, salida, caché) y cada separador de turno los tokens de ese turno. El tablero suma los totales del proyecto.

### Subagentes

Las sesiones usan subagentes como siempre (la herramienta Agent de Claude Code). En el chat cada uno aparece como una tarjeta con su tipo, modelo, si corre en segundo plano, lo que está haciendo en este momento, herramientas y tokens. **Un clic abre su trabajo en vivo**: la tarea que recibió, cada paso y su resultado. Si un subagente lanza otros, se navegan desde ahí. El panel de la sesión y el encabezado muestran cuántos están trabajando.

La orquestadora puede **pedirle a un worker subagentes específicos** en sus propuestas: nombre, rol, tarea, reglas (cláusulas), modelo, si corre en paralelo y si es de solo lectura. Aparecen en la tarjeta de la propuesta, los podés editar antes de enviar, y el worker los lanza tal cual.

### Importar sesiones que ya tenías abiertas

Desde el menú del tablero, **Importar una sesión existente** lista las conversaciones de Claude Code en la carpeta del repo. Se traen con su historial y se retoman por su id. Si la sesión sigue abierta en una terminal, cerrala antes (dos procesos sobre la misma conversación la rompen).

Para lo contrario, el panel de cada sesión tiene el comando `claude --resume <id>` listo para copiar: detenela en el dashboard y abrila en una terminal.

## La cola de resultados

Muchas veces varias sesiones terminan casi al mismo tiempo, y el resultado de una puede cambiar lo que hizo o va a hacer otra. Por eso:

- Los resultados que llegan juntos se **agrupan**: el server espera una ventana corta (15 s por defecto, configurable) después del último y los entrega **en un solo lote**.
- Lo que la orquestadora propone mientras analiza queda **en preparación**: no se puede aprobar ni enviar.
- El server **libera las propuestas recién cuando la orquestadora termina su turno con la cola vacía**. Si llegó algo mientras analizaba, se lo entrega enseguida, junto con la lista de sus propuestas pendientes, para que las ajuste o las descarte.
- Si ya había propuestas listas y entra un resultado nuevo, **vuelven a bloquearse** hasta que la orquestadora termine de leer todo.
- Si interrumpís a la orquestadora a mitad de una revisión, queda **en pausa**: no se entrega ni se libera nada solo. Podés escribirle para que siga, tocar **Revisar ahora** o **Liberar propuestas**.

La tarjeta de la orquestadora muestra la compuerta completa: **Cola → Revisando → Propuestas**.

Con **Enviar las propuestas solas** (configuración del proyecto) los prompts salen apenas se cierra la revisión. Las sesiones nuevas siempre las aprobás vos.

## Varias cuentas de Claude Code

Cada cuenta es un directorio de configuración de Claude Code, el que se elige con `CLAUDE_CONFIG_DIR`. Ahí viven su login, sus settings y sus conversaciones. La cuenta de siempre (`~/.claude`) se crea sola la primera vez.

- **Elegir la cuenta**: el selector de arriba a la izquierda funciona como el de una organización. Muestra los proyectos, el uso del plan y la configuración de esa cuenta. Cada proyecto pertenece a una cuenta, que se elige al crearlo, y todas sus sesiones corren con ella.
- **Agregar una cuenta**: selector → **Administrar cuentas…**. Los directorios `~/.claude-*` que ya tengas aparecen detectados.
  - Si tu comando es un alias del tipo `claude-personal` = `CLAUDE_CONFIG_DIR=~/.claude-personal claude`, poné `~/.claude-personal` como directorio y listo.
  - Si es un script que hace algo más, ponelo además en **Comando**. Tiene que ser un ejecutable (en el `PATH` o con ruta completa): los alias y las funciones de la shell no se ven desde el server.
- **Login**: el dashboard nunca toca credenciales. Si una cuenta figura **Sin login**, abrí una terminal con `CLAUDE_CONFIG_DIR=<directorio> claude`, usá `/login` y después **Volver a verificar los logins**.
- Una cuenta con proyectos activos no se puede quitar: archivá sus proyectos antes. La de siempre no se quita.

## Configuración de Claude Code desde el dashboard

Selector de cuenta → **Configuración de Claude Code** muestra las opciones del menú `/config` de esa cuenta: tema, modo del editor, modelo por defecto, compactación automática, checkpoints, notificaciones, mensajes entre sesiones, IDE, etc.

- Se guardan en los mismos archivos que usa `/config`: el `settings.json` del directorio de la cuenta y, las de IDE y copiado, en su `.claude.json` (`~/.claude.json` para la cuenta de siempre).
- Claude Code relee `settings.json` solo, así que las sesiones abiertas toman el cambio sin reiniciarse (el modelo por defecto aplica a las sesiones nuevas). Lo de `.claude.json` aplica la próxima vez que abras Claude Code.
- Las marcadas **en la terminal** solo se notan en la terminal (tema, vim, barra de progreso…).
- Se cambia solo esa clave: el resto del archivo queda igual. Si el archivo no es JSON válido, no se toca y te avisa; si es un symlink (dotfiles), se escribe el archivo real.

## Cómo funciona por dentro

```
                 navegador (React + shadcn)
                          │  REST + WebSocket
                          ▼
┌─────────────────────── server (Node) ───────────────────────┐
│  SessionManager ── un proceso `claude -p` por sesión         │
│    stdin: tus mensajes y los prompts aprobados               │
│    stdout: stream-json → timeline, estados, uso del plan     │
│  Orchestration ── cola de resultados, lotes, propuestas      │
│  MCP local (/mcp/<token>) ── herramientas de control-plane   │
│  SQLite (~/.control-plane) ── proyectos, sesiones, historial │
└──────────────────────────────────────────────────────────────┘
         │                                    ▲
         ▼                                    │ report_result / propose_prompt
   claude (worker) ◄── SendMessage ──► claude (worker)     claude (orquestadora)
```

- Cada sesión es `claude -p --input-format stream-json --output-format stream-json` con `--dangerously-skip-permissions`, `--name`, `--append-system-prompt` (el protocolo) y `--mcp-config` (el MCP local). Es un proceso largo que recibe mensajes por stdin, igual que una sesión interactiva.
- **Protocolo**: al arrancar, cada sesión recibe su rol, quiénes son las otras y las reglas (coordinar con `SendMessage` antes de tocar algo compartido, no pisar el checkout, reportar al terminar). Se arma en `server/src/prompts.ts` y se puede ampliar por proyecto en su configuración.
- **Herramientas MCP de control-plane**: `list_sessions` (todas); `report_result` (workers); `propose_prompt`, `propose_session`, `update_proposal`, `discard_proposal`, `list_proposals` y `read_results` (orquestadora). Las propuestas aceptan `subagents` para pedir subagentes específicos.
- **Adjuntos**: se guardan en `~/.control-plane/attachments/<sesión>/` y se sirven solo a esta máquina.
- **Cuentas**: cada proceso `claude` se lanza con el `CLAUDE_CONFIG_DIR` (y el comando, si tiene uno) de la cuenta del proyecto. La de siempre se lanza sin tocar el entorno. El uso del plan, los comandos y las sesiones vivas se leen por cuenta.
- **Coordinación entre workers**: la mensajería nativa de Claude Code (`SendMessage`/`ListAgents`). Los mensajes entre sesiones se ven en el chat de cada una.
- **La orquestadora no edita archivos** por defecto (se lanza sin `Edit`/`Write`); lo podés habilitar por proyecto.
- **Mismo checkout** por defecto, como cuando trabajás con terminales. Al crear una sesión podés marcar **Worktree aparte** para que trabaje en su propia rama.

Sobre la cuenta: el dashboard ejecuta el binario oficial de Claude Code sin modificar, con tu propio login, y nunca toca credenciales. No usa el Agent SDK, que según la política de Anthropic es para productos que usan API key.

## Configuración

Variables de entorno (opcionales):

| Variable | Default | Para qué |
| --- | --- | --- |
| `CONTROL_PLANE_PORT` | `4700` | Puerto del server |
| `CONTROL_PLANE_HOST` | `127.0.0.1` | Interfaz donde escucha (dejalo en localhost) |
| `CONTROL_PLANE_HOME` | `~/.control-plane` | Base de datos local |
| `CLAUDE_BIN` | `claude` | Binario de Claude Code (para las cuentas sin comando propio) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Directorio de la cuenta de siempre, si levantás el server con otro |

Por proyecto (menú del tablero → Configuración): auto-envío, ventana de agrupación, si la orquestadora puede editar, modelo y esfuerzo por defecto, e instrucciones extra para los workers y para la orquestadora. Las instrucciones aplican al iniciar o reanudar cada sesión.

El estado del dashboard es local de cada máquina: el repo solo tiene el código. En la PC y en la Mac cada uno tiene su propia base en `~/.control-plane`.

## Solución de problemas

- **`npm install <paquete>` falla con `EALLOWSCRIPTS`**: npm 11 rechaza instalaciones con paquetes explícitos si tu `~/.npmrc` tiene `allow-scripts`. `npm install` a secas funciona. Para agregar dependencias: `npm_config_userconfig=/dev/null npm install -w web <paquete>`.
- **"El MCP de control-plane no está conectado"** en una sesión: el server no estaba accesible cuando arrancó la sesión. Detenela y reanudala.
- **Un nombre de sesión "ya existe fuera del dashboard"**: hay una sesión viva con ese nombre en una terminal. Los mensajes entre sesiones se dirigen por nombre, así que no se permite repetirlo: elegí otro o cerrala e importala.
- **La sesión terminó inesperadamente**: el aviso en el chat muestra el final del error de `claude`. Reanudala desde el encabezado.
- **Puerto ocupado**: `CONTROL_PLANE_PORT=4800 npm start`.
- **Una cuenta figura "Sin login" pero en la terminal anda**: el directorio tiene que ser exactamente el que usa tu comando. `alias claude-personal` (o `type claude-personal`) te muestra cuál es.

## Estructura

```
server/   Node 24 + Fastify: procesos claude, cola, MCP, API y WebSocket
  src/shared/types.ts   tipos compartidos con la web
  src/claude/           proceso, normalización del stream, transcripts
  src/orchestration.ts  cola de resultados y propuestas
  src/accounts.ts       cuentas (directorios de configuración de Claude Code)
  src/claude/config-settings.ts  opciones de /config
  src/prompts.ts        protocolo de orquestadora y workers
web/      Vite + React + Tailwind + shadcn/ui
```
