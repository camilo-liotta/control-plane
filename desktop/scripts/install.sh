#!/usr/bin/env bash
# Instala o actualiza la app de escritorio desde este repo, en macOS o Linux (Ubuntu/Debian).
#
#   npm run app:install                   compila e instala (o actualiza)
#   npm run app:install -- --dry-run      muestra lo que haría, sin compilar ni instalar nada
#   npm run app:install -- --no-install   compila y deja el paquete, sin instalarlo
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

# ---- 1. Lo que hace falta ----

command -v node >/dev/null || die "No encuentro Node. Instalá Node 24 (nvm, fnm o nodejs.org) y volvé a probar."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
((NODE_MAJOR >= 24)) || die "Tenés Node $(node --version) y hace falta el 24 o más nuevo."
VERSION="$(node -p "require('$TAURI_DIR/tauri.conf.json').version")"
say "Node $(node --version) · control-plane $VERSION"

if [[ "$OS" == Darwin ]] && ! xcode-select -p >/dev/null 2>&1; then
  say "Faltan las herramientas de línea de comandos de Xcode: abro el instalador del sistema."
  run xcode-select --install || true
  die "Cuando termine la instalación, volvé a correr \`npm run app:install\`."
fi

if ! command -v cargo >/dev/null && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null; then
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
command -v cargo >/dev/null && say "$(cargo --version)"

if [[ "$OS" == Linux ]]; then
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
      sudo apt install -y "${MISSING[@]}"
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

if ((DRY)); then
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

if [[ "$OS" == Darwin ]]; then
  DEST=/Applications
  if [[ ! -w "$DEST" ]]; then
    DEST="$HOME/Applications"
    say "No puedo escribir en /Applications: la instalo en $DEST."
    run mkdir -p "$DEST"
  fi
  TARGET="$DEST/control-plane.app"
  if [[ "$(osascript -e 'application "control-plane" is running' 2>/dev/null)" == true ]]; then
    # Salir así (como desde el Dock) no pregunta y deja el server corriendo: al reabrir, lo adopta.
    say "Cierro la app abierta (el server y las sesiones siguen)…"
    run osascript -e 'quit app "control-plane"'
    if ((!DRY)); then
      for _ in $(seq 30); do
        [[ "$(osascript -e 'application "control-plane" is running')" == true ]] || break
        sleep 0.5
      done
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
  RUNNING=0
  pgrep -f '^/usr/bin/control-plane-desktop' >/dev/null && RUNNING=1
  say "Instalo el paquete (te va a pedir la contraseña)…"
  run sudo apt install -y "$PKG"
  WHERE=/usr/bin/control-plane-desktop
  if ((RUNNING)); then
    say "La app está abierta y sigue con la versión anterior hasta que la reinicies. Para pasar a la"
    say "nueva sin cortar las sesiones: bandeja → Al salir ▸ \"Dejarlo corriendo\" → Salir, y volvé a"
    say "abrirla desde el lanzador (adopta el mismo server)."
  fi
fi

# ---- 4. Resumen ----

echo
if ((DRY)); then
  say "Eso es lo que haría. Para hacerlo de verdad: npm run app:install"
else
  say "control-plane $VERSION instalada en $WHERE."
  say "Si algo falla, el detalle de la compilación está en $LOG; el de la app, en \"Ver log del server\" de la bandeja."
fi
