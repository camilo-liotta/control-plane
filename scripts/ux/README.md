# Banco de UX

Sirve para ver y capturar la web con datos de mentira sin tocar tu control-plane:
- un **server sembrado** en el :4720 con proyectos, sesiones en todos los estados, propuestas, cola, tareas, apps, entornos y Programado;
- un **proxy** por área, que sirve tu `web/dist` con la API del sembrado;
- un **navegador headless** para las capturas.

Todo vive en **`~/.cache/cp-ux`** (o en `CP_UX_HOME`), nunca en `/tmp`:

| Qué | Dónde |
|---|---|
| Datos del server | `srv/` |
| HOME y PATH del server | `home/` y `bin/`, sin tu `~/.claude` ni tus CLIs |
| Repos de mentira | `repos/` |
| pids | `pids/` |
| logs | `logs/` |
| Claude falso | `claude.mjs` |

Los datos son inventados: no sumes nombres, emails ni rutas reales, que el repo es público.

## Vista previa (para ver la web entera antes de una versión)

Un solo comando, desde cualquier checkout del repo:

```bash
node scripts/ux/ux.mjs preview
```

- Trae `origin/main`, lo compila en un checkout propio (`~/.cache/cp-ux/preview/src`) y lo levanta con datos inventados en **http://127.0.0.1:4729**. No compila el `web/dist` del checkout donde lo corrés, que puede ser el que sirve tu dashboard.
- Tiene sus propios datos, HOME y PATH en `~/.cache/cp-ux/preview`: no toca el :4700, `~/.control-plane` ni `~/.claude`, ni el sembrado del :4720 de las capturas.
- Cada vez arranca con los datos de cero. `--keep` conserva lo que tocaste la última vez; `--port <n>` usa otro puerto.
- Enviar, interrumpir, la terminal y las apps de ejemplo andan contra el Claude falso. Lo que abriría algo en tu escritorio (el editor, el navegador) está escondido del PATH: falla con un aviso y no abre nada.

Para apagarla (por pid):

```bash
node scripts/ux/ux.mjs preview stop
```

## Levantarlo

```bash
env -u NODE_ENV npm run build -w web            # la web que va a servir el sembrado (y la del proxy)
node scripts/ux/ux.mjs server --reset           # server en :4720, con el código de este checkout
node scripts/ux/ux.mjs seed                     # siembra los datos (≈ 30 s)
node scripts/ux/ux.mjs browser                  # Edge o Chromium headless, CDP en :9340
```

- `server --from <checkout>` levanta el código de otro checkout. Por ejemplo, `--from ../control-plane--ux-actual` levanta la v0.5.0, que es el "antes".
- Si `server` encuentra el :4720 ocupado, no hace nada. Para ver si ya está arriba: `node scripts/ux/ux.mjs status`.

## Ver tu área

Compilá tu web y serví su `dist` en tu puerto, con la API del sembrado:

```bash
env -u NODE_ENV npm run build -w web
node scripts/ux/ux.mjs proxy 4721 web/dist
```

Puertos: SERVER 4721, TRAY 4722, CHAT 4723, MARCO 4724. El 4725 y los que siguen están libres.

## Capturar

```bash
node scripts/ux/ux.mjs shots --base http://127.0.0.1:4721 --out ~/.cache/cp-ux/mi-area
```

- `--set inventario` (por defecto): todas las pantallas, modales y menús, a 1440, 900 y 380 px.
- `--set claves`: sesión, resumen del proyecto y dos modales, a 1440.
- `--set bandeja`: Bandeja, paleta, ayuda de atajos y un toast.
- `--widths 1440,900,380`, `--themes light,dark` y `--only <texto>` (solo las pantallas cuyo nombre lo incluya).

Las capturas quedan como `<pantalla>--<light|dark>-<ancho>.png`. Los dos juegos de referencia son:
- `~/.cache/cp-ux/actual/`: la v0.5.0, antes de la pasada;
- `~/.cache/cp-ux/base/`: `main` con la base Estudio (#69 y #70).

Para un recorrido propio, `scripts/ux/cdp.mjs` exporta `open({ base, width, height })`, con `goto`, `theme`, `press`, `clickText`, `key`, `hover`, `mask`, `shot` y `close`.

Herramientas → CLIs no muestra los CLIs reales, porque el server corre con un PATH mínimo. Igual, el driver le tapa la lista.

## WebKitGTK (el motor de la app en Linux)

```bash
node scripts/ux/ux.mjs webkit http://127.0.0.1:4721/ dark ~/.cache/cp-ux/webkit.png
bash scripts/ux/webkit/run.sh stop
```

Corre en un gnome-shell headless aislado, con su propio Wayland y su propio D-Bus, así que no toca tu sesión. Imprime las fuentes cargadas, si anda oklch y color-mix, y el radio y la sombra de la hoja. Necesita `python3-gi` y `gir1.2-webkit2-4.1`.

## Apagar (siempre por pid)

```bash
node scripts/ux/ux.mjs status                   # qué está corriendo y con qué pid
node scripts/ux/ux.mjs stop proxy-4721
```

`stop all` apaga todo lo del banco. No toca tu control-plane del :4700 ni nada que no haya lanzado el banco.

## El Claude falso

Es el de los tests (`server/test/fake-claude.ts`), con algunos agregados en `fake-claude.mjs` y `fake-demo.js.txt`:
- `DEMO …`: un turno con pensamiento, herramientas y markdown;
- `PERMISO`: un pedido de permiso;
- `MUERE`: la sesión termina con error;
- una sesión con `FACTURACION` en el nombre tiene el contexto lleno y un borrador de compactación por decidir;
- `LARGO` se puede interrumpir (Esc dos veces o Interrumpir): el turno cierra como interrumpido;
- del de los tests vienen `LARGO` (un turno que no termina), `PREGUNTA`, `SUBAGENTE`, `CRON …` y `WAKEUP …`.
