#!/usr/bin/env bash
# Instala o actualiza la app de escritorio desde este repo, en macOS o Linux (Ubuntu/Debian).
#
#   npm run app:install                   compila e instala (o actualiza)
#   npm run app:install -- --dry-run      muestra lo que haría, sin compilar ni instalar nada
#   npm run app:install -- --no-install   compila y deja el paquete, sin instalarlo
#
# Solo para probar (ver CONTRIBUTING): CONTROL_PLANE_INSTALL_BIN=<binario> reinicia ese binario
# como si actualizara (--quit --restart-for-update y volver a abrirlo), sin compilar ni instalar nada.
#
# Correrlo de nuevo actualiza: compila lo que haya en el repo (después de un `git pull`) y reemplaza
# la app instalada. Las sesiones no se cortan: el server sigue corriendo y la app lo adopta al abrir.
set -euo pipefail

DRY=0
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "No conozco la opción $arg. Probá con --help." >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAURI_DIR="$ROOT/desktop/src-tauri"
LOG="${TMPDIR:-/tmp}/control-plane-install.log"
OS="$(uname -s)"

say() { printf '▸ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

# El node a usar, como lo busca la app: el que resolvió ella (CONTROL_PLANE_NODE), el del PATH si
# es ≥ 24 o, si no, el de las rutas de respaldo (Homebrew, ~/.local/bin, Volta, nvm, fnm). Una app
# abierta desde el lanzador no trae el PATH de tu shell: sin esto no ve el node de nvm.
node_major_of() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
use_node() {
  local n="${CONTROL_PLANE_NODE:-}" d best=""
  if [[ -n "$n" ]]; then
    [[ "$n" == */* ]] || n="$(command -v "$n" || true)"
    [[ -n "$n" && -x "$n" ]] || die "CONTROL_PLANE_NODE=${CONTROL_PLANE_NODE} no es un ejecutable."
    PATH="$(dirname "$n"):$PATH"
    export PATH
    return 0
  fi
  if command -v node >/dev/null && (($(node_major_of node) >= 24)); then return 0; fi
  for d in /opt/homebrew/bin /usr/local/bin "${HOME:-}/.local/bin" "${HOME:-}/.volta/bin" "${HOME:-}/.bun/bin" \
    "${HOME:-}"/.nvm/versions/node/*/bin "${HOME:-}"/.local/share/fnm/node-versions/*/installation/bin \
    "${HOME:-}/Library/Application Support/fnm/node-versions"/*/installation/bin; do
    # En nvm y fnm, las carpetas van en orden: queda la última que sirve (la más nueva).
    if [[ -x "$d/node" ]] && (($(node_major_of "$d/node") >= 24)); then
      best="$d"
      case "$d" in */.nvm/* | */fnm/*) ;; *) break ;; esac
    fi
  done
  if [[ -n "$best" ]]; then
    PATH="$best:$PATH"
    export PATH
  fi
}
# Corre un comando, o solo lo muestra con --dry-run.
run() {
  if ((DRY)); then
    printf '  (haría) %s\n' "$*"
  else
    "$@"
  fi
}
# Pregunta s/N. Sin terminal (o con --dry-run) contesta que no.
ask() {
  ((DRY)) && return 1
  [[ -t 0 ]] || return 1
  local r
  read -r -p "$1 [s/N] " r
  [[ "$r" =~ ^[sS] ]]
}

case "$OS" in
  Darwin | Linux) ;;
  *) die "Esta app es para macOS y Linux; $OS no está soportado." ;;
esac
((DRY)) && say "Modo prueba (--dry-run): no compilo ni instalo nada."

# Modo prueba: reiniciar otro binario (uno de release, dentro de un dbus-run-session), sin
# compilar ni instalar. Solo Linux.
TEST_BIN="${CONTROL_PLANE_INSTALL_BIN:-}"
if [[ -n "$TEST_BIN" ]]; then
  [[ "$OS" == Linux ]] || die "CONTROL_PLANE_INSTALL_BIN es solo para probar en Linux."
  [[ -x "$TEST_BIN" ]] || die "CONTROL_PLANE_INSTALL_BIN=$TEST_BIN no es un ejecutable."
  # Un binario de release comparte la instancia única con la app instalada: en el bus de siempre,
  # el --quit le llegaría a ella.
  [[ "${DBUS_SESSION_BUS_ADDRESS:-}" != "unix:path=/run/user/$(id -u)/bus" ]] ||
    die "El modo prueba va dentro de dbus-run-session (si no, le llega a la app instalada)."
  say "Modo prueba: reinicio $TEST_BIN sin compilar ni instalar."
  NO_INSTALL=0
fi

# ---- 1. Lo que hace falta ----

use_node
command -v node >/dev/null || die "No encuentro Node. Instalá Node 24 (nvm, fnm o nodejs.org) y volvé a probar."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
((NODE_MAJOR >= 24)) || die "Tenés Node $(node --version) y hace falta el 24 o más nuevo."
VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
say "Node $(node --version) · control-plane $VERSION"

if [[ -n "$TEST_BIN" ]]; then
  : # modo prueba: no se compila, no hacen falta las herramientas
elif [[ "$OS" == Darwin ]] && ! xcode-select -p >/dev/null 2>&1; then
  say "Faltan las herramientas de línea de comandos de Xcode: abro el instalador del sistema."
  run xcode-select --install || true
  die "Cuando termine la instalación, volvé a correr \`npm run app:install\`."
fi

if [[ -z "$TEST_BIN" ]] && ! command -v cargo >/dev/null && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi
if [[ -z "$TEST_BIN" ]] && ! command -v cargo >/dev/null; then
  say "Falta Rust, que hace falta para compilar la app. Se instala con rustup en ~/.cargo (sin sudo)."
  if ((DRY)); then
    printf '  (preguntaría e instalaría rustup con --profile minimal)\n'
  elif ask "¿Lo instalo ahora?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    # shellcheck source=/dev/null
    . "$HOME/.cargo/env"
  else
    die "Sin Rust no se puede compilar. Instalalo desde https://rustup.rs y volvé a probar."
  fi
fi
[[ -z "$TEST_BIN" ]] && say "$(cargo --version)"

if [[ "$OS" == Linux && -z "$TEST_BIN" ]]; then
  command -v dpkg-query >/dev/null || die "En Linux, por ahora, solo Ubuntu y Debian (hace falta apt)."
  # Las librerías para compilar Tauri (las del README, sin las del AppImage).
  PKGS=(build-essential curl wget file libwebkit2gtk-4.1-dev libxdo-dev libssl-dev
    libayatana-appindicator3-dev librsvg2-dev)
  MISSING=()
  for p in "${PKGS[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || MISSING+=("$p")
  done
  if ((${#MISSING[@]})); then
    say "Faltan librerías para compilar: sudo apt install ${MISSING[*]}"
    if ((DRY)); then
      printf '  (preguntaría si las instalo)\n'
    elif ask "¿Las instalo ahora? (te va a pedir la contraseña)"; then
      sudo env DEBIAN_FRONTEND=noninteractive apt install -y "${MISSING[@]}"
    else
      die "Instalalas con el comando de arriba y volvé a correr \`npm run app:install\`."
    fi
  fi
fi

# ---- 2. Compilar ----

if [[ "$OS" == Darwin ]]; then
  BUNDLE=app
  PKG="$TAURI_DIR/target/release/bundle/macos/control-plane.app"
else
  BUNDLE=deb
  ARCH="$(dpkg --print-architecture)"
  PKG="$TAURI_DIR/target/release/bundle/deb/control-plane_${VERSION}_${ARCH}.deb"
fi

cd "$ROOT"
# NODE_ENV=production haría que npm saltee lo que hace falta para compilar. Y `npm run` le pasa al
# npm de adentro su allow-scripts como variable, que `npm ci` rechaza (EALLOWSCRIPTS): sin ella, el
# npm de adentro lee tu configuración como siempre.
npm_() { env -u NODE_ENV -u npm_config_allow_scripts npm "$@"; }

if [[ -n "$TEST_BIN" ]]; then
  :
elif ((DRY)); then
  run npm ci
  run npm run tauri -w desktop -- build --bundles "$BUNDLE"
else
  : >"$LOG"
  say "Instalando dependencias (npm ci)… el detalle queda en $LOG"
  if ! npm_ ci >>"$LOG" 2>&1; then
    if grep -q EALLOWSCRIPTS "$LOG"; then
      warn "npm ci frenó porque tu npm pide aprobar los scripts de instalación (EALLOWSCRIPTS)."
      warn "Pruebo con npm install, que usa lo que ya tengas aprobado."
      npm_ install >>"$LOG" 2>&1 || die "Falló npm install. Mirá $LOG."
    else
      die "Falló npm ci. Mirá $LOG."
    fi
  fi
  say "Compilando la app (solo el $BUNDLE: tarda unos minutos la primera vez)…"
  npm_ run tauri -w desktop -- build --bundles "$BUNDLE" >>"$LOG" 2>&1 ||
    die "Falló la compilación. Mirá el final de $LOG."
  [[ -e "$PKG" ]] || die "Compiló pero no encuentro $PKG. Mirá $LOG."
  say "Listo: $PKG"
fi

if ((NO_INSTALL)); then
  say "Con --no-install no instalo nada. El paquete queda en $PKG."
  exit 0
fi

# ---- 3. Instalar ----

# ¿El binario instalado sabe reiniciarse para actualizar (`--quit --restart-for-update`: el server
# guarda las sesiones activas, se detiene y la app sale)? Se busca el texto en el binario, sin
# ejecutarlo: correrlo con un flag que no conoce le llegaría a la app abierta como una segunda
# apertura.
knows_restart() { grep -qaF -- "--quit --restart-for-update" "$1" 2>/dev/null; }
# Cerrar ahora incluye detener el server (el camino ordenado, hasta 15 s y lo que tarde en guardar).
WAIT_SECS=45

if [[ "$OS" == Darwin ]]; then
  DEST=/Applications
  if [[ ! -w "$DEST" ]]; then
    DEST="$HOME/Applications"
    say "No puedo escribir en /Applications: la instalo en $DEST."
    run mkdir -p "$DEST"
  fi
  TARGET="$DEST/control-plane.app"
  is_running() { [[ "$(osascript -e 'application "control-plane" is running' 2>/dev/null)" == true ]]; }
  if is_running; then
    EXE=""
    if [[ -d "$TARGET" ]]; then
      EXE="$TARGET/Contents/MacOS/$(defaults read "$TARGET/Contents/Info" CFBundleExecutable 2>/dev/null)"
    fi
    if [[ -x "$EXE" ]] && knows_restart "$EXE"; then
      say "Cierro la app abierta: el server guarda las sesiones activas y se detiene; la nueva lo vuelve a lanzar y las retoma."
      run "$EXE" --quit --restart-for-update
    else
      # Una app de antes no sabe reiniciarse para actualizar: salir como desde el Dock deja su
      # server corriendo. La nueva lo detecta al abrir y lo reinicia (sola si no hay sesiones
      # trabajando; si hay, desde el menú del ícono).
      say "La app abierta es de una versión anterior: la cierro, pero su server queda corriendo."
      say "Al abrirse, la nueva lo reinicia sola (si hay sesiones trabajando, te lo ofrece en el menú del ícono → Reiniciar el server)."
      run osascript -e 'quit app "control-plane"'
    fi
    if ((!DRY)); then
      for _ in $(seq $((WAIT_SECS * 2))); do
        is_running || break
        sleep 0.5
      done
      is_running && warn "La app no se cerró en ${WAIT_SECS} s: la reemplazo igual; si queda la vieja, cerrala y abrila."
    fi
  fi
  # Copia aparte y después el cambio, así nunca queda una app a medias.
  run rm -rf "$TARGET.nueva"
  run ditto "$PKG" "$TARGET.nueva"
  run rm -rf "$TARGET"
  run mv "$TARGET.nueva" "$TARGET"
  run xattr -dr com.apple.quarantine "$TARGET" || true
  run open "$TARGET"
  WHERE="$TARGET"
else
  BIN="${TEST_BIN:-/usr/bin/control-plane-desktop}"
  # La app (no sus procesos de WebKit): el binario como primer argumento de la línea de comando.
  app_pids() { pgrep -f "^$(printf '%s' "$BIN" | sed 's/[.[\*^$]/\\&/g')( |$)"; }
  # Antes de instalar: ¿está abierta, y sabe reiniciarse para actualizar? (Después del apt, el
  # binario ya es el nuevo.)
  OPEN=0
  KNOWS=0
  if app_pids >/dev/null; then
    OPEN=1
    knows_restart "$BIN" && KNOWS=1
  fi
  # 1. Instalar, con la app todavía abierta: si falla o se cancela, la app nunca se cerró.
  if [[ -n "$TEST_BIN" ]]; then
    say "Modo prueba: no instalo ningún paquete."
  else
    say "Instalo el paquete (te va a pedir la contraseña)…"
    run sudo env DEBIAN_FRONTEND=noninteractive apt install -y "$PKG"
  fi
  # 2. Cerrarla: el server guarda las sesiones activas y se detiene. La nueva lanza el server
  #    nuevo y las retoma: app y server se actualizan juntos.
  RESTART=0
  if ((OPEN && KNOWS)); then
    say "Cierro la app abierta: el server guarda las sesiones activas y se detiene; la nueva lo vuelve a lanzar y las retoma."
    run "$BIN" --quit --restart-for-update
    RESTART=1
    if ((!DRY)); then
      for _ in $(seq $((WAIT_SECS * 2))); do
        app_pids >/dev/null || break
        sleep 0.5
      done
      if app_pids >/dev/null; then
        warn "La app no se cerró en ${WAIT_SECS} s: no la vuelvo a abrir."
        RESTART=0
      fi
    fi
  fi
  WHERE="$BIN"
  if ((RESTART)); then
    if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
      say "No veo una sesión gráfica en esta terminal: abrí control-plane desde el lanzador."
    else
      # Sin atarla a esta terminal y sin lo que la app no tiene que heredar de ella: NODE_ENV,
      # lo de npm y, si esto corre desde una sesión del dashboard, las CONTROL_PLANE_* del server.
      # (En modo prueba se conservan las CONTROL_PLANE_*: son el puerto y las carpetas de prueba.)
      UNSET=(-u NODE_ENV)
      while IFS= read -r v; do
        case "$v" in
          npm_*) UNSET+=(-u "$v") ;;
          CONTROL_PLANE_*) [[ -n "$TEST_BIN" ]] || UNSET+=(-u "$v") ;;
        esac
      done < <(compgen -e)
      say "Vuelvo a abrir la app."
      if ((DRY)); then
        printf '  (haría) env %s setsid %s\n' "${UNSET[*]}" "$BIN"
      else
        env "${UNSET[@]}" setsid "$BIN" </dev/null >/dev/null 2>&1 &
      fi
    fi
  elif ((OPEN)); then
    say "La app abierta es de una versión anterior, que no sabe reiniciarse para actualizar: no la cierro."
    say "Para pasar a la nueva: menú del ícono → Salir → \"Detener y salir\", y volvé a abrirla desde el"
    say "lanzador: arranca con el server nuevo (las sesiones se reanudan cuando les escribís)."
    say "Si la cerrás dejando el server, la nueva lo detecta y te ofrece reiniciarlo (menú del ícono →"
    say "Reiniciar el server)."
  fi
fi

# ---- 4. Resumen ----

echo
if ((DRY)); then
  say "Eso es lo que haría. Para hacerlo de verdad: npm run app:install"
elif [[ -n "$TEST_BIN" ]]; then
  say "Modo prueba terminado: no se instaló nada."
else
  say "control-plane $VERSION instalada en $WHERE."
  say "Si algo falla, el detalle de la compilación está en $LOG; el de la app, en \"Ver log del server\" del menú del ícono."
fi
