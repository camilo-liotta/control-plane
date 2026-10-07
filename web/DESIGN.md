# control-plane · sistema visual "Estudio"

Esta es la guía para quien trabaje en una pantalla. **Los tokens (`src/index.css`) y los componentes
de `src/components/ui/` tienen dueño**: la sesión SERVER. Si te falta un token, una variante o un
componente, pedíselo; no los agregues en tu área ni los pises con clases sueltas.

La idea en una línea: **la barra lateral es la mesa y el trabajo es una hoja que flota encima**. Las
superficies se separan por altura, no por borde, y el color queda para los estados.

## Tipografía

| Rol | Clase | Fuente | Para qué |
|---|---|---|---|
| UI | `font-sans` (por defecto) | Instrument Sans | Todo el texto de la interfaz. |
| Nombres | `.name` | Instrument Sans 550 | Nombres de sesión, de app y de cuenta. **Nunca en mono.** |
| Títulos | `.page-title` o `font-heading` | Bricolage Grotesque | Solo para el título de la página, el de los diálogos y los h1/h2 del markdown. |
| Código y datos | `font-mono` | Geist Mono | Código, rutas, comandos, ids, hashes, versiones. No va en nombres ni en etiquetas. |
| Etiqueta | `.eyebrow` | Instrument Sans 600, 12 px | Encabezados de sección y de grupo, **en minúscula** y en el color secundario. |

**La escala** tiene 7 tamaños. Usá estas clases y **nunca** `text-[0.xxrem]`:

| Clase | px | Uso |
|---|---|---|
| `text-2xs` | 11 | Horas, contadores, pastillas y metadatos de una fila. |
| `text-xs` | 12 | Texto secundario y descripciones cortas. |
| `text-ui` | 13 | Controles compactos, menús, filas densas y la barra lateral. |
| `text-sm` | 14 | Texto normal y el chat. |
| `text-base` | 16 | Títulos de diálogo y de tarjeta. |
| `text-lg` | 20 | Títulos de página grandes. |
| `text-xl` | 24 | Cifras destacadas. |

Las cifras son tabulares en toda la app (`html { font-variant-numeric: tabular-nums }`).

## Superficies, alturas y forma

- **Mesa** (`bg-sidebar`): el fondo detrás de todo y la barra lateral.
- **Hoja** (`bg-background`): el área de trabajo. Flota sobre la mesa con `shadow-sheet` y `rounded-2xl` (lo arma `<Sidebar variant="inset">`).
- **Tarjeta** (`.surface-card`, o `bg-card shadow-raised rounded-2xl`): algo apoyado en la hoja. **No le pongas borde.** Adentro de una tarjeta no va otra tarjeta: para separar filas usá `divide-y` o espacio.
- **Lo que flota** (`shadow-overlay`): diálogos, menús, popovers, toasts. Ya lo traen los componentes de `ui/`.
- **Radios**: `rounded-md` (8) en controles chicos, `rounded-lg` (10) en botones e inputs, `rounded-xl` (14) en menús y bloques de código, `rounded-2xl` (18) en tarjetas y la hoja, `rounded-3xl` (22) en diálogos. Para pastillas, `rounded-full`.
- **Bordes**: `border` (hairline) solo cuando hace falta una línea: divisores, inputs y tablas.

En oscuro las superficies van de más oscura a más clara: mesa → hoja → tarjeta → lo que flota.

## Color y estados

El color es para los estados y cada tono tiene un significado. **No uses un tono por estética.**

| Tono | Qué es | Ejemplos |
|---|---|---|
| `working` (azul) | Trabajando o arrancando. | Una sesión trabajando, un turno en curso. |
| `attention` (ámbar) | **La alarma: algo te espera y frena.** | Una pregunta, un permiso, una tarea que frena, una sesión bloqueada, una compactación por decidir. |
| `pending` (violeta) | Para mirar cuando puedas; no frena. | Propuestas listas, resultados parciales, en cola, cambios sin subir, una conversación abierta en otro lado. |
| `done` (verde) | Terminó bien. | Terminó, levantada, logueado. |
| `error` (rojo) | Falló. | Error, se cayó, venció. |
| `idle` (gris) | Quieta o detenida. | Esperando, detenida. |

Por tono hay dos colores:
- `text-status-<tono>`: el **texto**. Pasa AA (≥ 4,5:1) sobre la hoja, la mesa, la tarjeta y su propio fondo suave, en claro y en oscuro.
- `bg-status-<tono>-lamp`: la **luz**, más viva. Solo va en puntos, barras y anillos, nunca de fondo de un texto.

Para fondos suaves usá `toneSoft[tono]` (`lib/status.ts`), que ya trae el par fondo y texto.

Componentes de estado (`components/status.tsx`):
- `<Lamp tone label?>`: la luz. Es decorativa: si nadie dice el estado en texto, pasale `label` (va `sr-only`). El error es un rombo.
- `<SessionLamp session quiet?>`: la luz de una sesión con su estado para el lector de pantalla. Usá `quiet` si el estado ya se lee al lado.
- `<TonePill tone>` y `<StatusPill session>`: pastillas con texto. El color nunca va solo.

## Movimiento

Todo transiciona en **180 ms** con `--ease-standard`. Es el valor por defecto de `transition-*`, así que no pongas `duration-*` salvo para algo especial. Con "reducir movimiento" no se anima nada, salvo los spinners. Si agregás una animación, que sea con CSS para que esa regla la alcance.

## Componentes de `ui/`

- **`Button`**:
  - `default` es la acción principal (una por vista);
  - `outline` y `secondary` son secundarias;
  - `ghost` va en barras y filas;
  - `destructive` (sólido) es para borrar o perder algo: el botón que **confirma** adentro de `ConfirmAction`. El que **abre** la confirmación va en `outline` (o como ítem `destructive` de un menú), con "…" al final ("Borrar proyecto…");
  - `link` va dentro de un texto.

  Tamaños: `xs`, `sm`, `default`, `lg` y sus `icon-*`. El foco es un anillo de 2 px.
- **`Dialog`**: el diálogo es otra hoja, sin bandeja gris abajo. Lleva `DialogTitle` (en Bricolage) y `DialogFooter` con la acción principal a la derecha. En un diálogo largo que scrollea, `<DialogFooter sticky>` deja las acciones fijas abajo.
- **`AlertDialog`**: `AlertDialogAction` acepta `onAction` asíncrono. Muestra el spinner, no se cierra hasta que termina y, si falla, queda abierto. Mientras espera, Cancelar y Esc no lo cierran.
- **`ConfirmAction`** (nuevo): para **lo irreversible** (borrar un proyecto, quitar una cuenta, detener todas las sesiones).
  ```tsx
  <ConfirmAction title="¿Detener todas las sesiones?" description="…" confirmLabel="Detener todas" onConfirm={() => api.stopAll(id)}>
    <Button variant="outline">Detener todas</Button>
  </ConfirmAction>
  ```
  - Sin hijo, se controla con `open` y `onOpenChange` (desde un ítem de menú).
  - `confirmText="inmos"` exige escribir el nombre: solo para lo grave.
  - Si `onConfirm` falla, muestra un toast con el error y queda abierto.
- **`undoable()`** (`lib/undo.ts`, nuevo): para **lo reversible** (descartar una propuesta, quitar de la cola, cerrar una tarea, detener una sesión). No pregunta: muestra un toast con "Deshacer" y la acción recién se ejecuta al vencer los 5 s.
  ```ts
  undoable({ message: "Propuesta descartada", run: () => api.discardDraft(id), onHide: () => hide(id), onRestore: () => show(id) })
  ```
  - `onHide` la saca de la pantalla al instante.
  - `onRestore` la vuelve si se deshace o si falla.
  - Si se cierra la pestaña antes de que venza, se ejecuta en ese momento.
- **`LoadError`** (nuevo): va en lugar de una lista o un panel que no se pudo cargar. **Nunca un vacío ni un esqueleto eterno.**
  ```tsx
  <LoadError what="el resumen del proyecto" error={err} onRetry={reload} />
  ```
  `compact` es para dentro de una fila.
- **`Kbd`**, **`KbdGroup`** y **`Shortcut`**: `<Shortcut keys="mod+k" />` muestra ⌘K en la Mac (también en WKWebView) y Ctrl K en el resto. Teclas con nombre: `mod`, `ctrl`, `alt`, `shift`, `enter`, `esc`, `up`, `down`, `backtick`. Dentro de un `TooltipContent` se adapta al fondo oscuro, así que los atajos van ahí y no en `title`. `isMac` y `keyLabel()` están exportados.
- **`Badge`**: etiquetas cortas (conteos, tipos). Para estados usá `TonePill`.
- **`Input`, `Textarea`, `Select`**: fondo de tarjeta y foco de 2 px.
- **`FieldSeparator`**: separa grupos de un formulario, con la etiqueta a la izquierda.
- **`Sheet`, `DropdownMenu`, `Popover`, `HoverCard`, `Tooltip`, toasts (sonner)**: ya traen `shadow-overlay` y sus radios.

## Voz y vocabulario

Todos los textos que ve el usuario siguen esto: la web, los avisos que arma el server y los de la app de escritorio.

### Voz
- **Al usuario se le habla de vos**, en castellano rioplatense: "Elegí la carpeta", "Escribí el nombre", "Te espera".
- **Toasts y avisos del sistema, impersonales.** Para lo que salió bien, la cosa y su participio: "App guardada", "Usuario copiado", "Conversación recuperada después de un /clear". Para lo que falló, "No se pudo" y el verbo: "No se pudo levantar web", con el motivo en la descripción.
  - Nunca en primera persona: no "Guardé", "Recuperé", "No pude actualizar", "Le pedí".
  - Lo que hizo una sesión va en tercera persona, con la sesión como sujeto: "API creó una tarea para vos", "API dejó una credencial".
- **Botones en infinitivo**, con el objeto cuando no es obvio: "Guardar", "Borrar proyecto", "Levantar web".
- **El mismo verbo de punta a punta.** El botón "Archivar" termina en el toast "Sesión archivada", no en "Sesión guardada".
- **Errores**: qué no se pudo hacer y, si se sabe, cómo seguir. Sin "Ups", sin disculpas y sin "algo salió mal".
- **Vacíos**: qué va ahí y cómo se llena ("Las sesiones que levantan un entorno lo dejan acá."), no "No hay datos".

### Un verbo por acción
| Verbo | Cuándo | Toast | Ejemplos |
|---|---|---|---|
| **Quitar** | Sacar algo de una lista; sigue existiendo afuera. | "… quitado" | quitar de la cola, un adjunto, una cuenta (su carpeta queda), un MCP del proyecto, una app (el repo no se toca) |
| **Borrar** | Se pierde. Siempre con `ConfirmAction`. | "… borrado" | borrar un proyecto, un entorno, una credencial, una sesión archivada |
| **Descartar** | Propuestas y borradores, que se pueden deshacer con `undoable()`. | "Propuesta descartada" | descartar una propuesta, el borrador de compactación |
| **Archivar** y **Restaurar** | Sale de la vista y vuelve tal cual. | "Sesión archivada", "Proyecto restaurado" | sesiones y proyectos |
| **Interrumpir** | El turno en curso; la sesión sigue viva. | "Turno interrumpido" | Esc, el botón del composer |
| **Detener** y **Reanudar** | El proceso de la sesión. Reanudar retoma la misma conversación. | "Sesión detenida", "Sesión reanudada" | detener una sesión, detener todas |
| **Levantar**, **Bajar** y **Reiniciar** | Las apps del proyecto. | "web levantada", "No se pudo levantar api" | Apps |
| **Hecha** y **No hace falta** | Cerrar una tarea para vos. | "Tarea hecha", "Tarea cerrada: no hace falta" | Tareas para vos |

No se usan: **Eliminar** (es Borrar), **Iniciar** para sesiones (es Reanudar) ni **Cancelar** como acción. Cancelar es solo el botón que cierra un diálogo sin hacer nada; lo programado se cancela con "Cancelar lo programado".

### Términos
- **Sesión**: cada Claude Code que corre en el dashboard. En la UI siempre se dice "sesión". **Worker** se usa solo para distinguirla de la orquestadora, por ejemplo "Para todos los workers" en los ajustes.
- **Orquestadora**: la sesión que coordina el proyecto. Va en femenino y nunca "orquestador".
- **Propuesta**: un prompt que arma la orquestadora y aprobás vos. Puede estar **en preparación** o **lista para enviar**, y se **envía** o se **descarta**.
- **Cola de resultados**: lo que reportaron las sesiones y espera que la orquestadora lo revise.
- **Bandeja**: todo lo que espera una decisión tuya, de todos los proyectos.
- **Tareas para vos**: lo que las sesiones necesitan que hagas vos (un login, algo en otro sistema).
- **El ícono de control-plane en la barra de arriba**. En la Mac: "en la barra de menú".
- **Herramientas, Entornos, Apps, Programado**: con mayúscula, porque son nombres de secciones.

### "Te necesita" y "te espera"
Una sola regla en toda la app. Los predicados están en `@shared/inbox-count`:
- **Te necesita**: solo una **sesión** que espera algo tuyo (`sessionWaits`, `status === "needs_input"`): una pregunta, un permiso o una compactación por decidir. Es "1 te necesita" o "3 te necesitan". Tono `attention`.
- **Te espera**: una **tarea para vos que frena** a una sesión (`taskWaits`). Tono `attention`.
- **El número de la Bandeja** (botón, ícono de la app, dock): `inboxCounts().total`, que suma las dos cosas de arriba más las propuestas listas (`draftWaits`). Va neutro, como conteo, porque mezcla cosas que frenan con cosas que no.
- Una propuesta lista o un resultado en cola no "te necesitan": son `pending`.
- **"Bloqueada"** (una sesión que reportó que está trabada) va en tono `attention`, porque frena, pero **no cuenta** como "te necesita": la resuelve la orquestadora con la cola. **"Por compactar"** sí cuenta: es `needs_input`.
- En la web, usá `sessionNeedsYou(s)` de `lib/status.ts`, que es lo mismo que `sessionWaits`, para contar y para decidir si dice "te necesita". No cuentes "todo lo ámbar" de `sessionStatus`.

### Formato
- **Mayúsculas**: solo la primera palabra y los nombres propios ("Nueva sesión", "Tareas para vos"). Nada en versalitas ni todo en mayúsculas, salvo los nombres de sesión que el usuario escribió así.
- **Tiempo**:
  - relativo, con `timeAgo()`: "hace 5 min", "hace 2 h", "ayer";
  - hora: "09:46";
  - fecha corta: "lun 6/10";
  - la fecha completa va en el `title`.
- **Números**: con `toLocaleString("es-AR")`, punto para los miles y coma para los decimales: "1.250", "US$ 1,85". Para tokens, "425 k" y "3,4 M".
- **Plurales**: siempre resueltos ("1 sesión", "3 sesiones"), nunca "sesión(es)".
- **Puntos suspensivos**: el carácter "…" (no tres puntos). Van en lo que todavía pasa ("Cargando…", "Compactando…") y en los botones que abren algo antes de hacer la acción ("Borrar proyecto…").
- **Comillas**: las rectas, "así", para citar lo que escribió alguien o el nombre de una tarea.
- **Código**: los comandos y nombres de archivo van entre `backticks` en markdown, o en `font-mono` en la UI. Las rutas, según la regla de abajo.
- **Rutas**:
  - en los lugares de lectura (tarjetas, encabezados, filas, el título de un panel) va **el nombre de la carpeta**, en la voz de la UI (`basename()` de `lib/format`);
  - la ruta completa va en el `title` y en el detalle;
  - la ruta en `font-mono` solo cuando es el dato en sí: un comando, el archivo que tocó una herramienta, el campo donde se escribe.

## Acciones que pegan al server

Para un botón que pega al server, usá `useAction` (`lib/use-action.ts`, de TRAY): deshabilita el botón mientras espera y evita el doble pedido. Combinalo con `ConfirmAction` o con `undoable()` según si la acción se puede deshacer.

## `cn`

Importalo de `@/lib/utils`, no de `"cn"`: el de utils conoce los tokens propios (`text-2xs`, `text-ui` y `shadow-raised/overlay/sheet`). Con el otro, `text-ui` se toma por un color y se come el color del texto.

## Fuentes

Son de Fontsource, con licencia OFL (las licencias están en `web/fonts/`). Solo se carga el eje de peso, para latín y latín extendido. Funcionan en el navegador, en WebKitGTK (la app en Linux) y en WKWebView (la Mac).
