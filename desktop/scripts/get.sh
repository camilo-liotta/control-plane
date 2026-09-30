#!/usr/bin/env bash
# Instala o actualiza la app de escritorio de control-plane desde los releases de GitHub, sin
# compilar. En macOS (Apple Silicon o Intel) y Linux (x86_64).
#
#   curl -fsSL https://raw.githubusercontent.com/camilo-liotta/control-plane/main/desktop/scripts/get.sh | bash
#
# Con el repo clonado, la otra forma es `npm run app:install` (compila lo que tengas). Este script
# va suelto: por eso repite la lógica de instalación de desktop/scripts/install.sh. Si cambiás
# una, cambiá la otra.
set -euo pipefail

REPO="camilo-liotta/control-plane"
APP="control-plane"

usage() {
  cat <<EOF
Instala o actualiza la app de escritorio de control-plane, sin compilar.

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/desktop/scripts/get.sh | bash
  curl -fsSL …/get.sh | bash -s -- --version 0.2.0 --dry-run

Opciones:
  --version X.Y.Z   esa versión, en lugar de la última publicada
  --dry-run         baja y verifica el paquete, y muestra lo que haría sin instalar nada
  --from <carpeta>  usa los archivos de esa carpeta (con su SHA256SUMS) en lugar de bajarlos:
                    sirve para probar los artifacts de un build
  -h, --help        esta ayuda

Las que usa la app cuando se actualiza sola ("Actualizar a vX.Y.Z" en el menú del ícono):
  --app-pid <pid>     el pid de la app abierta: se la cierra dejando el server y se la reabre
  --appimage <ruta>   reemplaza ese AppImage (el que está corriendo), aunque haya apt
  --mac-app <ruta>    en la Mac, reemplaza esa control-plane.app (la que está corriendo)

Baja el paquete de https://github.com/$REPO/releases y lo verifica contra SHA256SUMS antes de
tocar nada. Si la app está abierta, la cierra sin cortar las sesiones (el server sigue corriendo)
y la versión nueva lo adopta al abrir.
EOF
}

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

DRY=0
APP_PID=""
APPIMAGE_TARGET=""
MAC_APP=""
# Si hay que reabrir la app vieja cuando algo falla después de cerrarla (Mac).
REOPEN_ON_FAIL=""
# Corre un comando, o solo lo muestra con --dry-run.
run() {
  if ((DRY)); then
    printf '  (haría) %s\n' "$*"
  else
    "$@"
  fi
}

# ¿El binario instalado sabe reiniciarse para actualizar (`--quit --restart-for-update`: el server
# guarda las sesiones activas, se detiene y la app sale)? Se busca el texto en el binario, sin
# ejecutarlo: correrlo con un flag que no conoce le llegaría a la app abierta como una segunda
# apertura.
knows_restart() { grep -qaF -- "--quit --restart-for-update" "$1" 2>/dev/null; }
# Cerrar ahora incluye detener el server (el camino ordenado, hasta 15 s y lo que tarde en guardar).
WAIT_SECS=45

fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"; }

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

main() {
  local want="" from=""
  while (($#)); do
    case "$1" in
      --dry-run) DRY=1 ;;
      --version)
        [[ $# -ge 2 ]] || die "Falta la versión después de --version (por ejemplo --version 0.2.0)."
        want="${2#v}"
        shift
        ;;
      --from)
        [[ $# -ge 2 ]] || die "Falta la carpeta después de --from."
        from="$2"
        shift
        ;;
      --app-pid)
        [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || die "--app-pid necesita un número."
        kill -0 "$2" 2>/dev/null || die "No hay ningún proceso con el pid $2."
        APP_PID="$2"
        shift
        ;;
      --appimage)
        [[ $# -ge 2 && "$2" == /* && -f "$2" ]] || die "--appimage necesita la ruta completa de un AppImage que exista."
        APPIMAGE_TARGET="$2"
        shift
        ;;
      --mac-app)
        [[ $# -ge 2 && "$2" == /*.app && -d "$2" ]] || die "--mac-app necesita la ruta completa de una .app que exista."
        MAC_APP="$2"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "No conozco la opción $1. Probá con --help." ;;
    esac
    shift
  done
  if [[ -n "$want" && ! "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    die "\"$want\" no es una versión (X.Y.Z, por ejemplo 0.2.0)."
  fi

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin | Linux) ;;
    *) die "Esta app es para macOS y Linux; $os no está soportado." ;;
  esac
  [[ -z "$MAC_APP" || "$os" == Darwin ]] || die "--mac-app es solo para la Mac."
  [[ -z "$APPIMAGE_TARGET" || "$os" == Linux ]] || die "--appimage es solo para Linux."
  if [[ "$os" == Linux && "$arch" != x86_64 ]]; then
    die "En Linux, por ahora, solo hay paquetes para x86_64 (esta máquina es $arch). Con el repo clonado podés compilarla: npm run app:install."
  fi
  ((DRY)) && say "Modo prueba (--dry-run): bajo y verifico el paquete, pero no instalo nada."

  # ---- 1. Lo que hace falta ----

  command -v curl >/dev/null || die "Hace falta curl."
  use_node
  command -v node >/dev/null || die "No encuentro Node. Instalá Node 24 (nvm, fnm o nodejs.org) y volvé a probar."
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  ((node_major >= 24)) || die "Tenés Node $(node --version) y hace falta el 24 o más nuevo."

  # ---- 2. Qué versión y qué archivo ----

  local version base
  if [[ -n "$from" ]]; then
    [[ -d "$from" ]] || die "--from $from no es una carpeta."
    from="$(cd "$from" && pwd)"
    [[ -f "$from/SHA256SUMS" ]] || die "En $from no hay SHA256SUMS."
    if [[ -z "$want" ]]; then
      want="$(sed -n 's/.*control-plane_\([^_]*\)_.*/\1/p' "$from/SHA256SUMS" | head -n 1)"
      [[ -n "$want" ]] || die "No encuentro la versión en $from/SHA256SUMS: pasala con --version."
    fi
    version="$want"
  elif [[ -n "$want" ]]; then
    version="$want"
  else
    # /releases/latest redirige al último publicado (no a borradores ni prereleases).
    local url
    url="$(curl -fsSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
      die "No pude consultar los releases en GitHub. ¿Hay internet?"
    case "$url" in
      */releases/tag/v*) version="${url##*/releases/tag/v}" ;;
      *) die "Todavía no hay ninguna versión publicada en https://github.com/$REPO/releases." ;;
    esac
  fi
  base="https://github.com/$REPO/releases/download/v$version"

  local file mode
  if [[ "$os" == Darwin ]]; then
    mode=mac
    file="${APP}_${version}_universal.app.tar.gz"
  elif [[ -n "$APPIMAGE_TARGET" ]]; then
    mode=appimage
    file="${APP}_${version}_amd64.AppImage"
  elif command -v apt-get >/dev/null && command -v dpkg >/dev/null; then
    mode=deb
    file="${APP}_${version}_amd64.deb"
  else
    mode=appimage
    file="${APP}_${version}_amd64.AppImage"
  fi
  say "Node $(node --version) · control-plane $version · $file"

  # ---- 3. Bajar y verificar ----

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/control-plane-get.XXXXXX")"
  trap on_exit EXIT
  # apt lee el .deb con su propio usuario: que pueda entrar a la carpeta.
  chmod 755 "$TMP"
  if [[ -n "$from" ]]; then
    [[ -f "$from/$file" ]] || die "En $from no está $file."
    cp "$from/SHA256SUMS" "$from/$file" "$TMP/"
  else
    say "Bajo ${file}…"
    fetch "$base/SHA256SUMS" "$TMP/SHA256SUMS" ||
      die "No encontré la versión $version en https://github.com/$REPO/releases (¿está publicada?)."
    fetch "$base/$file" "$TMP/$file" || die "No pude bajar $base/$file."
  fi
  local expected actual
  expected="$(awk -v f="$file" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS")"
  [[ -n "$expected" ]] || die "SHA256SUMS no tiene $file: no lo instalo."
  actual="$(sha256_of "$TMP/$file")"
  [[ "$actual" == "$expected" ]] ||
    die "El sha256 de $file no coincide con SHA256SUMS (bajó $actual, esperaba $expected): no lo instalo."
  chmod 644 "$TMP/$file"
  say "Verificado (sha256 ${actual:0:16}…)."

  # ---- 4. Instalar ----

  case "$mode" in
    mac) install_mac "$TMP/$file" ;;
    deb | appimage) install_linux "$mode" "$TMP/$file" ;;
  esac

  # ---- 5. Resumen ----

  echo
  if ((DRY)); then
    say "Eso es lo que haría. Para hacerlo de verdad, corré lo mismo sin --dry-run."
  else
    say "control-plane $version instalada en $WHERE."
    if [[ "$mode" == mac ]]; then
      say "No tiene firma de Apple: si la Mac no te deja abrirla, mirá \"La primera vez, sin firma de Apple\" en el README."
    fi
    say "Si algo falla, el detalle está en \"Ver log del server\" del menú del ícono."
  fi
}

# Al salir: borrar lo bajado y, si algo falló después de cerrar la app (Mac), reabrir la que quede.
on_exit() {
  local code=$?
  if ((code != 0)) && [[ -n "$REOPEN_ON_FAIL" && -d "$REOPEN_ON_FAIL" ]]; then
    warn "Algo falló después de cerrar la app: vuelvo a abrir la que estaba."
    open "$REOPEN_ON_FAIL" || true
  fi
  rm -rf "${TMP:-}"
}

# ¿Sigue abierta la app? Con --app-pid, ese proceso; si no, la búsqueda de cada sistema.
still_open() {
  if [[ -n "$APP_PID" ]]; then
    kill -0 "$APP_PID" 2>/dev/null
  else
    "$@"
  fi
}

# Espera hasta WAIT_SECS a que la app se cierre. Devuelve 1 si sigue abierta.
wait_closed() {
  ((DRY)) && return 0
  local i=0
  while ((i < WAIT_SECS * 2)) && still_open "$@"; do
    sleep 0.5
    i=$((i + 1))
  done
  ! still_open "$@"
}

install_mac() {
  local tarball="$1" pkg dest target
  tar -xzf "$tarball" -C "$TMP"
  pkg="$TMP/$APP.app"
  [[ -d "$pkg" ]] || die "El paquete no trae $APP.app."

  if [[ -n "$MAC_APP" ]]; then
    target="$MAC_APP"
  else
    dest=/Applications
    if [[ ! -w "$dest" ]]; then
      dest="$HOME/Applications"
      say "No puedo escribir en /Applications: la instalo en $dest."
      run mkdir -p "$dest"
    fi
    target="$dest/$APP.app"
  fi
  # 1. Preparar la nueva al lado, con la app todavía abierta.
  run rm -rf "$target.nueva"
  run ditto "$pkg" "$target.nueva"
  run xattr -dr com.apple.quarantine "$target.nueva" || true

  # 2. Cerrarla (si está abierta): la app y el server se actualizan juntos.
  if still_open mac_running; then
    local exe=""
    if [[ -d "$target" ]]; then
      exe="$target/Contents/MacOS/$(defaults read "$target/Contents/Info" CFBundleExecutable 2>/dev/null)"
    fi
    # Con --app-pid, la que llama es de esta versión: ya sabe --restart-for-update.
    if [[ -n "$APP_PID" ]] || { [[ -x "$exe" ]] && knows_restart "$exe"; }; then
      say "Cierro la app abierta: el server guarda las sesiones activas y se detiene; la nueva lo vuelve a lanzar y las retoma."
      run "$exe" --quit --restart-for-update
    else
      # Una app de antes no sabe reiniciarse para actualizar: salir como desde el Dock deja su
      # server corriendo. La nueva lo detecta al abrir y lo reinicia (sola si no hay sesiones
      # trabajando; si hay, desde el menú del ícono).
      say "La app abierta es de una versión anterior: la cierro, pero su server queda corriendo."
      say "Al abrirse, la nueva lo reinicia sola (si hay sesiones trabajando, te lo ofrece en el menú del ícono → Reiniciar el server)."
      run osascript -e "quit app \"$APP\""
    fi
    ((DRY)) || REOPEN_ON_FAIL="$target"
    wait_closed mac_running ||
      warn "La app no se cerró en ${WAIT_SECS} s: la reemplazo igual; si queda la vieja, cerrala y abrila."
  fi

  # 3. Cambiar: la vieja a un costado, la nueva en su lugar; si algo falla, vuelve la vieja.
  run rm -rf "$target.vieja"
  if [[ -e "$target" ]]; then
    run mv "$target" "$target.vieja"
  fi
  if ! run mv "$target.nueva" "$target"; then
    [[ -e "$target.vieja" ]] && mv "$target.vieja" "$target"
    die "No pude poner la versión nueva en $target."
  fi
  run rm -rf "$target.vieja"
  REOPEN_ON_FAIL=""
  run open "$target"
  WHERE="$target"
}

mac_running() { [[ "$(osascript -e "application \"$APP\" is running" 2>/dev/null)" == true ]]; }

install_linux() {
  local mode="$1" pkg="$2" bin
  if [[ -n "$APPIMAGE_TARGET" ]]; then
    bin="$APPIMAGE_TARGET"
  elif [[ "$mode" == deb ]]; then
    bin=/usr/bin/control-plane-desktop
  else
    bin="$HOME/.local/bin/$APP.AppImage"
  fi

  # Antes de instalar: ¿está abierta, y sabe reiniciarse para actualizar? Después del apt, el
  # binario ya es el nuevo. Con --app-pid la llama la propia app, que sabe; un .AppImage no se
  # puede revisar con grep (está comprimido).
  local open=0 knows=0
  if [[ -n "$APP_PID" ]]; then
    # Se vuelve a mirar ahora (después de bajar y verificar): si la app ya no está, no hay nada
    # que cerrar ni reabrir.
    if kill -0 "$APP_PID" 2>/dev/null; then
      open=1
      knows=1
    fi
  elif app_pids "$bin" >/dev/null; then
    open=1
    knows_restart "$bin" && knows=1
  fi

  # 1. Instalar, con la app todavía abierta (sigue con su archivo hasta que se cierre). Si esto
  #    falla o se cancela, la app nunca se cerró.
  if [[ "$mode" == deb ]]; then
    if [[ -t 0 ]]; then
      say "Instalo el paquete (te va a pedir la contraseña)…"
      run sudo apt install -y "$pkg"
    elif command -v pkexec >/dev/null && [[ -x /usr/bin/apt ]]; then
      # Sin terminal (la lanzó la app): el sistema muestra su diálogo para la contraseña. apt por
      # su ruta: corre como root, no puede ser el primero que aparezca en el PATH.
      say "Instalo el paquete (el sistema te va a pedir la contraseña)…"
      run pkexec /usr/bin/apt install -y "$pkg"
    else
      die "Para instalar el .deb hace falta pkexec o correr esto desde una terminal."
    fi
  else
    say "Dejo el AppImage en $bin."
    run mkdir -p "$(dirname "$bin")"
    # Copia aparte y después el cambio: la app abierta sigue con su archivo hasta que la cierres.
    run cp "$pkg" "$bin.nueva"
    run chmod 755 "$bin.nueva"
    run mv -f "$bin.nueva" "$bin"
    if [[ -z "$APPIMAGE_TARGET" ]]; then
      case ":$PATH:" in
        *":$(dirname "$bin"):"*) ;;
        *) say "Ojo: $(dirname "$bin") no está en tu PATH; abrila con la ruta completa." ;;
      esac
    fi
  fi
  WHERE="$bin"

  # 2. Cerrar la vieja (el server guarda las sesiones activas y se detiene) y abrir la nueva, que
  #    lanza el server nuevo y las retoma. App y server se actualizan juntos.
  if ((open && knows)); then
    say "Cierro la app abierta: el server guarda las sesiones activas y se detiene; la nueva lo vuelve a lanzar y las retoma."
    run "$bin" --quit --restart-for-update
    if ! wait_closed app_pids "$bin"; then
      warn "La app no se cerró en ${WAIT_SECS} s: no la vuelvo a abrir."
      return 0
    fi
    if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
      say "No veo una sesión gráfica en esta terminal: abrí control-plane desde el lanzador."
    else
      # Sin atarla a esta terminal y sin lo que la app no tiene que heredar de ella: NODE_ENV,
      # lo de npm y, si esto corre desde una sesión del dashboard, las CONTROL_PLANE_* del server.
      local unset_=(-u NODE_ENV) v
      while IFS= read -r v; do
        case "$v" in
          npm_* | CONTROL_PLANE_*) unset_+=(-u "$v") ;;
        esac
      done < <(compgen -e)
      say "Vuelvo a abrir la app."
      if ((DRY)); then
        printf '  (haría) env %s setsid %s\n' "${unset_[*]}" "$bin"
      else
        env "${unset_[@]}" setsid "$bin" </dev/null >/dev/null 2>&1 &
      fi
    fi
  elif ((open)); then
    say "La app abierta es de una versión anterior, que no sabe reiniciarse para actualizar: no la cierro."
    say "Para pasar a la nueva: menú del ícono → Salir → \"Detener y salir\", y volvé a abrirla desde el"
    say "lanzador: arranca con el server nuevo (las sesiones se reanudan cuando les escribís)."
    say "Si la cerrás dejando el server, la nueva lo detecta y te ofrece reiniciarlo (menú del ícono →"
    say "Reiniciar el server)."
  fi
}

# La app (no sus procesos de WebKit): el binario como primer argumento de la línea de comando.
app_pids() { pgrep -f "^$(printf '%s' "$1" | sed 's/[.[\*^$]/\\&/g')( |$)"; }

# Todo adentro de main: si la descarga del script se corta a la mitad, bash no corre nada.
main "$@"
