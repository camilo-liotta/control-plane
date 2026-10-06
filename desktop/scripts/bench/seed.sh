#!/bin/bash
# Un proyecto con tres sesiones: dos trabajando (un turno largo del Claude falso) y una quieta.
set -e
P=${1:-4714}; B="http://127.0.0.1:$P"; H="Content-Type: application/json"
N=$(date +%s | tail -c 5)
REPO="${CP_DESK_BENCH:-$REAL_HOME/.cache/cp-ux/escritorio/bench}/repo-$N"
mkdir -p "$REPO"
pid=$(curl -s -X POST $B/api/projects -H "$H" -d "{\"name\":\"Demo $N\",\"repoPath\":\"$REPO\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
for n in UNO-$N DOS-$N TRES-$N; do
  sid=$(curl -s -X POST $B/api/projects/$pid/sessions -H "$H" -d "{\"name\":\"$n\",\"role\":\"prueba\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  [ $n != TRES-$N ] && curl -s -X POST $B/api/sessions/$sid/messages -H "$H" -d '{"text":"LARGO"}' > /dev/null
done
echo "proyecto $pid"
