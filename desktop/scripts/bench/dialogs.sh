#!/bin/bash
# Captura los diálogos nativos de la app que está corriendo en el banco: menú del ícono, salir,
# el aviso de la primera vez que se cierra la ventana, "Buscar ahora" (las tres respuestas),
# actualizar con sesiones trabajando, "No se pudo actualizar" (en la web) y el selector de Node.
# Uso: dialogs.sh <carpeta> <light|dark>    (con la app lanzada por run.sh app y seed.sh corrido)
set -e
D=$(dirname "$0"); OUT=$1; T=$2; B="$BENCH"
mkdir -p "$OUT"
b() { python3 "$D/bench.py" "$@"; }
w() { sleep "${1:-1.5}"; }
b menu > "$OUT/menu-icono-$T.txt"
b menu-click Salir; w; b shot "Salir de control-plane" "$OUT/salir-$T.png"; b press Cancelar; w 1
b menu-click Abrir; w 1; b close control-plane; w; b shot "control-plane" "$OUT/cerrar-ventana-$T.png" || true
b a11y | grep -q "Entendido" && b press Entendido || b press OK || true; w 1
if b menu | grep -q "Buscar ahora"; then
  echo '{"tag_name":"v9.9.9","draft":false,"prerelease":false}' > "$B/upd/latest"
  b menu-click "Buscar ahora"; w; b shot "v9.9.9" "$OUT/buscar-ahora-nueva-$T.png"; b press "Más tarde"; w 1
  echo '{"tag_name":"v0.0.1","draft":false,"prerelease":false}' > "$B/upd/latest"
  b menu-click "Buscar ahora"; w; b shot "ltima" "$OUT/buscar-ahora-ultima-$T.png"; b press OK; w 1
  mv "$B/upd/latest" "$B/upd/latest.off"
  b menu-click "Buscar ahora"; w 3; b shot "actualizaciones" "$OUT/buscar-ahora-error-$T.png"; b press OK; w 1
  mv "$B/upd/latest.off" "$B/upd/latest"; echo '{"tag_name":"v9.9.9","draft":false,"prerelease":false}' > "$B/upd/latest"
  b menu-click "Buscar ahora"; w; b press "Más tarde"; w 1
fi
b menu-click Abrir; w 1
b menu-click "Actualizar a v9.9.9"; w; b shot "Actualizar control-plane" "$OUT/actualizar-$T.png"
b press "Actualizar ahora"; w 4
node "$D/page.mjs" '[...document.querySelectorAll("[data-sonner-toast] button")].find(b=>b.textContent==="Ver log")?.click(), "ok"' > /dev/null; w 1
b shot "control-plane" "$OUT/no-se-pudo-actualizar-$T.png"
node "$D/page.mjs" 'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})), "ok"' > /dev/null
