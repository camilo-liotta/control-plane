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
  - `destructive` (sólido) es para borrar o perder algo;
  - `link` va dentro de un texto.

  Tamaños: `xs`, `sm`, `default`, `lg` y sus `icon-*`. El foco es un anillo de 2 px.
- **`Dialog`**: el diálogo es otra hoja, sin bandeja gris abajo. Lleva `DialogTitle` (en Bricolage) y `DialogFooter` con la acción principal a la derecha.
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

## Acciones que pegan al server

Para un botón que pega al server, usá `useAction` (`lib/use-action.ts`, de TRAY): deshabilita el botón mientras espera y evita el doble pedido. Combinalo con `ConfirmAction` o con `undoable()` según si la acción se puede deshacer.

## `cn`

Importalo de `@/lib/utils`, no de `"cn"`: el de utils conoce los tokens propios (`text-2xs`, `text-ui` y `shadow-raised/overlay/sheet`). Con el otro, `text-ui` se toma por un color y se come el color del texto.

## Fuentes

Son de Fontsource, con licencia OFL (las licencias están en `web/fonts/`). Solo se carga el eje de peso, para latín y latín extendido. Funcionan en el navegador, en WebKitGTK (la app en Linux) y en WKWebView (la Mac).
