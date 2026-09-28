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

DRY=0
# Corre un comando, o solo lo muestra con --dry-run.
run() {
  if ((DRY)); then
    printf '  (haría) %s\n' "$*"
  else
    "$@"
  fi
}

# ¿El binario instalado entiende `--quit --keep-server` (salir dejando el server, sin preguntar)?
# Se busca el texto en el binario, sin ejecutarlo: correrlo con un flag que no conoce le llegaría
# a la app abierta como una segunda apertura.
knows_keep_server() { grep -qaF -- "--quit --keep-server" "$1" 2>/dev/null; }
WAIT_SECS=15

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
  if [[ "$os" == Linux && "$arch" != x86_64 ]]; then
    die "En Linux, por ahora, solo hay paquetes para x86_64 (esta máquina es $arch). Con el repo clonado podés compilarla: npm run app:install."
  fi
  ((DRY)) && say "Modo prueba (--dry-run): bajo y verifico el paquete, pero no instalo nada."

  # ---- 1. Lo que hace falta ----

  command -v curl >/dev/null || die "Hace falta curl."
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
  trap 'rm -rf "$TMP"' EXIT
  # apt lee el .deb con su propio usuario: que pueda entrar a la carpeta.
  chmod 755 "$TMP"
  if [[ -n "$from" ]]; then
    [[ -f "$from/$file" ]] || die "En $from no está $file."
    cp "$from/SHA256SUMS" "$from/$file" "$TMP/"
  else
    say "Bajo $file…"
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
    say "Si algo falla, el detalle está en \"Ver log del server\" de la bandeja."
  fi
}

install_mac() {
  local tarball="$1" pkg dest target
  tar -xzf "$tarball" -C "$TMP"
  pkg="$TMP/$APP.app"
  [[ -d "$pkg" ]] || die "El paquete no trae $APP.app."

  dest=/Applications
  if [[ ! -w "$dest" ]]; then
    dest="$HOME/Applications"
    say "No puedo escribir en /Applications: la instalo en $dest."
    run mkdir -p "$dest"
  fi
  target="$dest/$APP.app"
  if mac_running; then
    local exe=""
    if [[ -d "$target" ]]; then
      exe="$target/Contents/MacOS/$(defaults read "$target/Contents/Info" CFBundleExecutable 2>/dev/null)"
    fi
    say "Cierro la app abierta; el server y las sesiones siguen y la versión nueva lo adopta."
    if [[ -x "$exe" ]] && knows_keep_server "$exe"; then
      run "$exe" --quit --keep-server
    else
      # Una app vieja no conoce --keep-server: salir como desde el Dock tampoco pregunta y deja
      # el server corriendo.
      run osascript -e "quit app \"$APP\""
    fi
    if ((!DRY)); then
      local i=0
      while ((i < WAIT_SECS * 2)) && mac_running; do
        sleep 0.5
        i=$((i + 1))
      done
      mac_running && warn "La app no se cerró en ${WAIT_SECS} s: la reemplazo igual; si queda la vieja, cerrala y abrila."
    fi
  fi
  # Copia aparte y después el cambio, así nunca queda una app a medias.
  run rm -rf "$target.nueva"
  run ditto "$pkg" "$target.nueva"
  run rm -rf "$target"
  run mv "$target.nueva" "$target"
  run xattr -dr com.apple.quarantine "$target" || true
  run open "$target"
  WHERE="$target"
}

mac_running() { [[ "$(osascript -e "application \"$APP\" is running" 2>/dev/null)" == true ]]; }

install_linux() {
  local mode="$1" pkg="$2" bin
  if [[ "$mode" == deb ]]; then
    bin=/usr/bin/control-plane-desktop
  else
    bin="$HOME/.local/bin/$APP.AppImage"
  fi
  local restart=0
  if app_pids "$bin" >/dev/null; then
    if knows_keep_server "$bin"; then
      say "Cierro la app abierta; el server y las sesiones siguen y la versión nueva lo adopta."
      run "$bin" --quit --keep-server
      restart=1
      if ((!DRY)); then
        local i=0
        while ((i < WAIT_SECS * 2)) && app_pids "$bin" >/dev/null; do
          sleep 0.5
          i=$((i + 1))
        done
        if app_pids "$bin" >/dev/null; then
          warn "La app no se cerró en ${WAIT_SECS} s: no la vuelvo a abrir."
          restart=0
        fi
      fi
    else
      say "La app está abierta y es de una versión que no sabe salir dejando el server: no la cierro."
    fi
  fi

  if [[ "$mode" == deb ]]; then
    say "Instalo el paquete (te va a pedir la contraseña)…"
    run sudo apt install -y "$pkg"
  else
    say "No hay apt: dejo el AppImage en $bin."
    run mkdir -p "$(dirname "$bin")"
    # Copia aparte y después el cambio: la app abierta sigue con su archivo hasta que la cierres.
    run cp "$pkg" "$bin.nueva"
    run chmod 755 "$bin.nueva"
    run mv -f "$bin.nueva" "$bin"
    case ":$PATH:" in
      *":$(dirname "$bin"):"*) ;;
      *) say "Ojo: $(dirname "$bin") no está en tu PATH; abrila con la ruta completa." ;;
    esac
  fi
  WHERE="$bin"

  if ((restart)); then
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
  elif app_pids "$bin" >/dev/null 2>&1; then
    say "La app sigue abierta con la versión anterior hasta que la reinicies. Para pasar a la nueva"
    say "sin cortar las sesiones: bandeja → Al salir ▸ \"Dejarlo corriendo\" → Salir, y volvé a"
    say "abrirla desde el lanzador (adopta el mismo server)."
  fi
}

# La app (no sus procesos de WebKit): el binario como primer argumento de la línea de comando.
app_pids() { pgrep -f "^$(printf '%s' "$1" | sed 's/[.[\*^$]/\\&/g')( |$)"; }

# Todo adentro de main: si la descarga del script se corta a la mitad, bash no corre nada.
main "$@"
