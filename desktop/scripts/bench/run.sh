#!/bin/bash
# Banco de la app de escritorio: un GNOME headless aislado (Wayland + Xwayland, su propio D-Bus,
# portapapeles y dconf) para lanzar la app de desarrollo, capturar ventanas y tocar diálogos sin
# mouse. Todo vive en ~/.cache/cp-ux/escritorio/bench (o CP_DESK_BENCH); nunca toca tu sesión.
#
#   run.sh start [--tray]    levanta el GNOME (--tray: con la extensión AppIndicator)
#   run.sh env               imprime los export para usar el GNOME desde otra shell (eval "$(run.sh env)")
#   run.sh app <bin> [args]  lanza la app (dev) ahí; THEME=dark para el tema oscuro
#   run.sh stop              baja todo, por pid
#
# Más herramientas: bench.py (capturas, teclas y mouse reales, diálogos por AT-SPI, menú del ícono),
# screens.py, dialogs.sh, clipboard.py (portapapeles), dragsrc.py (arrastrar archivos),
# toasts.mjs y poke.mjs (avisos del server) y page.mjs (JS en la página).
#
# HOME y XDG_* se exportan ANTES de dbus-run-session: los servicios que activa el bus (dconf, gvfs…)
# heredan el entorno del dbus-daemon, y si no, gsettings escribiría en tu ~/.config/dconf real.
set -e
B="${CP_DESK_BENCH:-${REAL_HOME:-$HOME}/.cache/cp-ux/escritorio/bench}"
REAL_HOME="${REAL_HOME:-$HOME}"
X="$B/xdg"
iso_env() {
  export HOME="$B/home" XDG_RUNTIME_DIR="$X" XDG_CONFIG_HOME="$B/home/.config" \
    XDG_DATA_HOME="$B/home/.local/share" XDG_CACHE_HOME="$B/home/.cache" XDG_STATE_HOME="$B/home/.local/state"
}
case "$1" in
start)
  mkdir -p "$X" "$B/home/.config" && chmod 700 "$X"
  [ -S "$X/cp-desk" ] && { echo "ya está arriba"; exit 0; }
  (
    iso_env
    unset DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY DISPLAY XAUTHORITY
    setsid dbus-run-session -- bash -c '
      echo "export DBUS_SESSION_BUS_ADDRESS=\"$DBUS_SESSION_BUS_ADDRESS\"" > "'"$B"'/bus.sh"
      exec gnome-shell --headless --wayland --wayland-display=cp-desk --virtual-monitor 1280x800' \
      > "$B/shell.log" 2>&1 < /dev/null &
  )
  for _ in $(seq 60); do [ -S "$X/cp-desk" ] && ls "$X"/.mutter-Xwaylandauth.* > /dev/null 2>&1 && break; sleep 0.25; done
  for _ in $(seq 40); do "$0" env | grep -q "DISPLAY=':" && break; sleep 0.25; done
  eval "$("$0" env)"
  # Verificación: el dconf del bus aislado tiene que tener el HOME aislado.
  gsettings get org.gnome.shell enabled-extensions > /dev/null
  for p in $(pgrep -x dconf-service); do
    if tr '\0' '\n' < /proc/$p/environ | grep -qx "XDG_RUNTIME_DIR=$X"; then
      tr '\0' '\n' < /proc/$p/environ | grep -qx "HOME=$B/home" || { echo "dconf-service con el HOME real: corto"; "$0" stop; exit 1; }
    fi
  done
  if [ "$2" = "--tray" ]; then
    gsettings set org.gnome.shell enabled-extensions "['ubuntu-appindicators@ubuntu.com']"
  fi
  echo "arriba: $B"
  ;;
env)
  . "$B/bus.sh"
  disp=""
  # Mutter levanta Xwayland recién cuando se conecta un cliente X: el display sale del socket que
  # escucha el gnome-shell de esta sesión.
  for p in $(pgrep -x Xwayland); do
    tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$X" && disp=$(tr '\0' ' ' < /proc/$p/cmdline | awk '{print $2}')
  done
  [ -z "$disp" ] && for p in $(pgrep -x gnome-shell); do
    if tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$X"; then
      n=$(ss -xlp | grep "pid=$p," | grep -o '/tmp/.X11-unix/X[0-9]*' | sed 's/.*X//' | sort -n | head -1)
      [ -n "$n" ] && disp=":$n"
    fi
  done
  echo "export HOME='$B/home' XDG_RUNTIME_DIR='$X' XDG_CONFIG_HOME='$B/home/.config' XDG_DATA_HOME='$B/home/.local/share' XDG_CACHE_HOME='$B/home/.cache'"
  echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS' WAYLAND_DISPLAY=cp-desk DISPLAY='$disp' XAUTHORITY='$(ls "$X"/.mutter-Xwaylandauth.* | head -1)' GDK_BACKEND=x11"
  echo "export BENCH='$B' REAL_HOME='$REAL_HOME'"
  ;;
app)
  shift
  eval "$("$0" env)"
  bin="$1"; shift
  # La app de desarrollo, con puerto, datos y Claude de prueba (ver bench.env).
  [ -f "$B/bench.env" ] && . "$B/bench.env"
  # El tema: el de GTK (diálogos) y el color-scheme de GNOME, que WebKitGTK toma por el portal.
  if [ "$THEME" = dark ]; then
    export GTK_THEME=Adwaita:dark; gsettings set org.gnome.desktop.interface color-scheme prefer-dark
  else
    export GTK_THEME=Adwaita; gsettings set org.gnome.desktop.interface color-scheme prefer-light
  fi
  unset NODE_ENV CLAUDECODE
  setsid "$bin" "$@" > "$B/app.log" 2>&1 < /dev/null &
  echo "app pid $!"
  ;;
stop)
  fusermount3 -u "$X/gvfs" 2>/dev/null || true
  fusermount3 -u "$X/doc" 2>/dev/null || true
  for d in /proc/[0-9]*; do
    [ -O "$d" ] || continue
    if { tr '\0' '\n' < "$d/environ"; } 2>/dev/null | grep -qx -e "XDG_RUNTIME_DIR=$X" -e "HOME=$B/home"; then
      kill "${d#/proc/}" 2>/dev/null && echo "SIGTERM a ${d#/proc/} ($(cat "$d/comm" 2>/dev/null))"
    fi
  done
  rm -f "$B/bus.sh"
  ;;
*) sed -n '2,12p' "$0"; exit 1 ;;
esac
