#!/usr/bin/env bash
# Ejecuta una de las 3 rutas de la SAGA contra el gateway y la rastrea en CloudWatch.
#
#   bash scripts/demo-saga.sh <dev|test|prod> ok        # COMPLETED (y luego libera el conector)
#   bash scripts/demo-saga.sh <dev|test|prod> lowfunds  # hold 402 -> release -> COMPENSATED
#   bash scripts/demo-saga.sh <dev|test|prod> fault     # flag de fallo -> refund -> release -> COMPENSATED
#
# GATEWAY_URL (por defecto http://localhost:4000/graphql) apunta al gateway del ambiente.
set -euo pipefail
export MSYS_NO_PATHCONV=1

ENV="${1:?Uso: demo-saga.sh <dev|test|prod> <ok|lowfunds|fault>}"
SCENARIO="${2:?Uso: demo-saga.sh <dev|test|prod> <ok|lowfunds|fault>}"
URL="${GATEWAY_URL:-http://localhost:4000/graphql}"
DIR="$(cd "$(dirname "$0")" && pwd)"

case "$SCENARIO" in
  ok)       FLEET=FLEET-NORTE-EV; STATION=BOG-01; CONNECTOR=C1 ;;
  lowfunds) FLEET=FLEET-LOWFUNDS; STATION=BOG-02; CONNECTOR=C1 ;;
  fault)    FLEET=FLEET-ANDES-EV; STATION=MDE-01; CONNECTOR=C1 ;;
  *) echo "Escenario inválido: $SCENARIO (ok|lowfunds|fault)" >&2; exit 1 ;;
esac

gql() { # gql '<query>' '<variables json>'
  # node:http en vez de fetch: permite ir a 127.0.0.1 con el header Host cuando la URL
  # es <env>.aegisvolt.localhost (Ingress de kind); Windows no resuelve *.localhost.
  node -e '
    const http = require("node:http");
    const [url, query, vars] = process.argv.slice(1);
    const u = new URL(url);
    const body = JSON.stringify({ query, variables: JSON.parse(vars) });
    const fail = (m) => { console.error("Gateway no disponible en " + url + ": " + m); process.exit(1); };
    const req = http.request({
      hostname: u.hostname.endsWith(".localhost") ? "127.0.0.1" : u.hostname,
      port: u.port || 80, path: u.pathname + u.search, method: "POST",
      headers: { host: u.host, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => {
        let j; try { j = JSON.parse(data); } catch { fail("HTTP " + res.statusCode + " " + data.slice(0, 200)); }
        if (j.errors) { console.error(JSON.stringify(j.errors, null, 2)); process.exit(1); }
        console.log(JSON.stringify(j.data));
      });
    });
    req.on("error", (e) => fail(e.message));
    req.end(body);' "$URL" "$1" "${2:-{\}}"
}

ACTUAL_ENV=$(gql '{ environment }' | node -pe 'JSON.parse(require("fs").readFileSync(0)).environment')
[ "$ACTUAL_ENV" = "$ENV" ] || { echo "El gateway en $URL corre en '$ACTUAL_ENV', no en '$ENV'." >&2; exit 1; }

if [ "$SCENARIO" = "fault" ]; then
  bash "$DIR/toggle-flag.sh" "$ENV" SIMULATE_CHARGER_HARDWARE_FAULT true
  trap 'bash "$DIR/toggle-flag.sh" "$ENV" SIMULATE_CHARGER_HARDWARE_FAULT false' EXIT
  echo "Esperando 6 s a que expire la caché de flags (5 s)..."; sleep 6
fi

ID="demo-${SCENARIO}-$(node -e 'console.log(require("crypto").randomUUID().slice(0, 8))')"
echo; echo "[$ENV] startChargingSession  fleet=$FLEET  conector=$STATION/$CONNECTOR  correlationId=$ID"
SAGA=$(gql 'mutation($i: StartChargingInput!) { startChargingSession(input: $i) {
  correlationId status amount surgeMultiplier failure { step code message } steps { step action outcome httpStatus errorCode } } }' \
  "{\"i\":{\"fleetId\":\"$FLEET\",\"stationId\":\"$STATION\",\"connectorId\":\"$CONNECTOR\",\"kwh\":10,\"correlationId\":\"$ID\"}}")

echo "$SAGA" | node -e '
const s = JSON.parse(require("fs").readFileSync(0)).startChargingSession;
console.log(`\n  estado: ${s.status}   monto: ${s.amount ?? "-"} COP   recargo: x${s.surgeMultiplier ?? 1}`);
if (s.failure) console.log(`  fallo:  paso ${s.failure.step} -> ${s.failure.code} (${s.failure.message})`);
console.log("\n  pasos:");
for (const st of s.steps.filter(x => x.outcome !== "STARTED"))
  console.log(`   ${st.action === "COMPENSATE" ? "↩" : "→"} ${st.step.padEnd(9)} ${st.outcome.padEnd(9)} ${st.errorCode ?? ""}`);'

echo; echo "  verificación:"
gql "query { wallet(fleetId: \"$FLEET\") { balance } station(id: \"$STATION\") { connectors { id status } } }" | node -e '
const d = JSON.parse(require("fs").readFileSync(0)); const c = d.station.connectors.find(x => x.id === process.argv[1]);
console.log(`   saldo ${process.argv[2]}: ${d.wallet.balance} COP   conector ${process.argv[1]}: ${c.status}`);' "$CONNECTOR" "$FLEET"

if [ "$SCENARIO" = "ok" ]; then
  gql "mutation { stopChargingSession(sessionId: \"$ID\") { status } }" >/dev/null && echo "   stopChargingSession -> conector liberado"
fi

echo; echo "Rastreo en CloudWatch (los logs llegan en ~2 s):"; sleep 3
bash "$DIR/trace-saga.sh" "$ID" "$ENV" || true
