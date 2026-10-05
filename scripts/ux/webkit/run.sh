#!/bin/bash
# Corre el banco de WebKitGTK en un gnome-shell headless aislado: su propio Wayland, su propio D-Bus y
# su propio portapapeles; no toca tu sesión. Los datos van en ~/.cache/cp-ux/webkit.
# Uso: run.sh <url> <light|dark> <captura.png>        Apagarlo: run.sh stop
set -e
BASE="${CP_UX_HOME:-$HOME/.cache/cp-ux}/webkit"
export XDG_RUNTIME_DIR="$BASE/xdg"
if [ "$1" = "stop" ]; then
  # Por pid: los procesos de esta sesión aislada (gnome-shell, su D-Bus y lo que levantó) son los que
  # tienen este XDG_RUNTIME_DIR en su entorno.
  for d in /proc/[0-9]*; do
    [ -O "$d" ] || continue
    if { tr '\0' '\n' < "$d/environ"; } 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"; then
      kill "${d#/proc/}" 2>/dev/null && echo "SIGTERM a ${d#/proc/} ($(cat "$d/comm" 2>/dev/null))"
    fi
  done
  fusermount3 -u "$XDG_RUNTIME_DIR/gvfs" 2>/dev/null || true
  rm -f "$BASE/shell.pid"
  exit 0
fi
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
if [ ! -S "$XDG_RUNTIME_DIR/cp-ux" ]; then
  env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS dbus-run-session -- \
    gnome-shell --headless --no-x11 --wayland-display=cp-ux --virtual-monitor 1440x900 > "$BASE/shell.log" 2>&1 &
  echo $! > "$BASE/shell.pid"
  for _ in $(seq 1 40); do [ -S "$XDG_RUNTIME_DIR/cp-ux" ] && break; sleep 0.5; done
fi
env -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY=cp-ux GDK_BACKEND=wayland \
  timeout 60 python3 "$(dirname "$0")/bench.py" "$@" 2> >(grep -v Deprecation >&2)
