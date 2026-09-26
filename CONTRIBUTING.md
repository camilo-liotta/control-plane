# Cómo contribuir

control-plane es un proyecto personal que se comparte por si le sirve a alguien más. Si lo usás y querés mejorarlo, bienvenido. Issues y PRs en castellano o en inglés (*English is fine too*).

## Reportar un bug

1. Buscá en los [issues](../../issues) si ya está reportado.
2. Abrí uno nuevo con la plantilla **Reportar un bug**. Lo que más ayuda:
   - Qué hiciste, qué esperabas y qué pasó.
   - Versiones: `git rev-parse --short HEAD` (control-plane), `claude --version`, `node --version`, sistema operativo y navegador.
   - Lo que muestra la terminal donde corre el server y, si es de la UI, la consola del navegador.
3. Antes de pegar logs o capturas, sacá tokens, rutas privadas y contenido de tus conversaciones.

Si es un problema de seguridad, no abras un issue: seguí [SECURITY.md](SECURITY.md).

## Pedir una mejora

Abrí un issue con la plantilla **Pedir una mejora**: qué problema te resuelve y cómo te lo imaginás. Para cambios grandes (una pantalla nueva, otra forma de orquestar, dependencias nuevas), conviene charlarlo en el issue antes de escribir el código.

## Preparar el entorno

Necesitás Node.js 24+, git y Claude Code instalado y logueado. Para la app de escritorio, además Rust (ver [Probar la app de escritorio](#probar-la-app-de-escritorio)).

```bash
npm install
npm run dev        # server en 4700 + Vite con recarga en http://localhost:4701
npm run typecheck
npm test           # tests del server (node:test)
npm run build      # compila la web
```

### Probar sin romper tu configuración de Claude Code

El dashboard escribe en la configuración real de Claude Code (plugins, MCP, skills, settings). Para probar cambios que tocan eso, no uses tu cuenta de todos los días:

- Levantá el server con su propia base: `CONTROL_PLANE_HOME=$(mktemp -d) CONTROL_PLANE_PORT=4710 npm run serve`.
- Agregá una **cuenta de prueba** cuyo directorio sea una carpeta temporal (**Administrar cuentas…**) y creá los proyectos de prueba con esa cuenta y un repo descartable.
- Ojo: algunos comandos de `claude` no validan lo que reciben (por ejemplo, `claude plugin enable` con un plugin que no existe igual escribe en tu `settings.json`).

### Probar la app de escritorio

La toolchain es la de [Compilar en Linux](README.md#compilar-en-linux) o [en la Mac](README.md#compilar-e-instalar-en-la-mac). Los chequeos:

```bash
npm run test -w desktop   # cargo fmt --check, clippy con -D warnings y cargo test
```

`npm test` no necesita Rust.

**Usá siempre `npm run dev -w desktop`**, que toma `desktop/src-tauri/tauri.dev.conf.json`:

- Identifier `app.control-plane.desktop.dev` y nombre "control-plane (dev)". La instancia única, los ajustes, los logs y el estado del server quedan separados de la app instalada.
- Antes de compilar corre `npm run stage` (la web y el bundle del server en `desktop/server-bundle/`, ignorado en git), así probás lo mismo que se instala.
- No uses `cargo run` a secas: tendría el identifier de la app instalada y compartiría con ella los ajustes y el `server-<puerto>.json`, y una segunda apertura enfocaría la instalada. Si tenés que compilar a mano, pasale otro identifier: `TAURI_CONFIG='{"identifier":"app.control-plane.desktop.dev.<algo>"}'`.

El comando de siempre, con datos y cuenta descartables:

```bash
CONTROL_PLANE_PORT=4710 CONTROL_PLANE_HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d) npm run dev -w desktop
```

Puertos y datos en la app de desarrollo:

- El puerto sale de `CONTROL_PLANE_PORT` del entorno de la app, si no del de tu shell de login, si no de los ajustes, si no el default: 4710. El 4700 se rechaza salvo con `CONTROL_PLANE_ALLOW_4700=1`, también en **Usar este puerto** y **Usar ese**.
- Sin `CONTROL_PLANE_HOME` usa `$TMPDIR/control-plane-dev-<puerto>`, y `~/.control-plane` se rechaza salvo con `CONTROL_PLANE_ALLOW_REAL_HOME=1`.
- **El build de release no tiene estas guardas.** Si probás un `.AppImage` o un binario de release, pasale siempre un puerto y carpetas temporales.

Para tener sesiones sin una cuenta de Claude, usá el Claude falso de los tests:

```bash
FAKE=$(mktemp -d)
node -e 'import("./server/test/fake-claude.ts").then((m) => console.log(m.writeFakeClaude(process.argv[1])))' "$FAKE"
CLAUDE_BIN=$FAKE/claude.mjs CONTROL_PLANE_PORT=4710 CONTROL_PLANE_HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d) npm run dev -w desktop
```

Probar sin mouse, con una segunda apertura del mismo binario (en desarrollo, `desktop/src-tauri/target/debug/control-plane-desktop`):

- `--quit`: sale como con **Salir** (pasa por **Al salir**). Anda también en release.
- `--action <id> [--port N]`: aprieta un botón de la pantalla que se ve. Solo en desarrollo. Los ids: `retry`, `launch`, `pick-node`, `get-node`, `open-anyway`, `cancel`, `set-port` (con `--port`), `use-that`, `wait`, `log` y `stop`.

Para abrirla como desde el menú de GNOME, sin heredar el entorno de tu terminal: `systemd-run --user --collect --unit=<nombre> -E CONTROL_PLANE_PORT=4710 -E CONTROL_PLANE_HOME=<carpeta> <binario>`, y la cortás con `systemctl --user stop <nombre>`.

Cuidados:

- Cortá procesos solo por pid. Nunca `pkill -f "node src/index.ts"`: es la misma línea de comando que tu dashboard de todos los días.
- Un server que quedó con **Dejarlo corriendo** sigue vivo. Su pid está en `server-<puerto>.json`, en la carpeta de datos de la app (`~/.local/share/app.control-plane.desktop.dev/` en Linux).
- No muevas `desktop/src-tauri/target/` de cargo entre worktrees.
- Si trabajás desde una sesión o una terminal lanzada por el propio dashboard, heredás `NODE_ENV=production` y `npm_config_allow_scripts`: instalá con `env -u NODE_ENV -u npm_config_allow_scripts npm ci` y corré los tests con `env -u NODE_ENV`.

## Pull requests

- Un cambio por PR, desde una rama propia, contra `main`.
- Contá qué cambia, por qué y cómo lo probaste. Si toca la UI, sumá una captura.
- `npm run typecheck` y `npm test` tienen que pasar. Si arreglás un bug del server, sumá un test que lo muestre.
- Si tocás `desktop/`, también `npm run test -w desktop`.
- Seguí el estilo del código que tocás: mismos nombres, mismos patrones, comentarios solo donde hacen falta. Nada de frameworks nuevos sin charlarlo antes.
- Los textos de la UI van en castellano rioplatense (voseo), con el mismo tono del resto.
- El dashboard es 100% local: nada de telemetría, servicios externos ni cuentas propias. Solo habla con Claude Code y con tu navegador.
- Si el cambio se ve desde afuera, actualizá el README.

Al contribuir aceptás que tu código se publique con la [licencia MIT](LICENSE) del proyecto y que seguís el [código de conducta](CODE_OF_CONDUCT.md).
