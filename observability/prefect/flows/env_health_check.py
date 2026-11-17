"""Flow env_health_check (cada 5 min).

Para cada ambiente (dev, test, prod) verifica, a través del Ingress, que cada
componente responde y mide su latencia:

  gateway                       { environment }  (y que sea el ambiente correcto)
  station-reservation-service   { stations { id } }
  billing-wallet-service        { quote(...) { amount } }
  energy-dispatch-service       { session(sessionId: "health-probe") { status } }  (null = sano)
  feature flags (DynamoDB)      { featureFlags { name } }
  frontend                      GET /  (SPA servida por nginx)

Publica una tabla por ambiente como artifact. El flow termina en Failed si algún
componente no responde, para que se vea en rojo en la UI de Prefect.
"""

from __future__ import annotations

import time

import httpx
from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact

from common import ENVS, INGRESS_URL, graphql

CHECKS = {
    "graphql-gateway": "{ environment }",
    "station-reservation-service": "{ stations { id } }",
    "billing-wallet-service": "{ quote(kwh: 10, powerKw: 50) { amount } }",
    "energy-dispatch-service": '{ session(sessionId: "health-probe") { status } }',
    "feature-flags": "{ featureFlags { name enabled } }",
}
SLOW_MS = 1000


@task(retries=2, retry_delay_seconds=5, log_prints=True)
def check_env(env: str) -> list[dict]:
    rows: list[dict] = []
    for component, query in CHECKS.items():
        r = graphql(env, query)
        ok = r.ok
        detail = r.error or ""
        if ok and component == "graphql-gateway" and (r.data or {}).get("environment") != env:
            ok, detail = False, f"el gateway reporta el ambiente {(r.data or {}).get('environment')!r}"
        rows.append({"env": env, "componente": component, "ok": ok, "latencia_ms": round(r.ms, 1), "detalle": detail or ("lento" if r.ms > SLOW_MS else "")})

    started = time.perf_counter()
    try:
        res = httpx.get(f"{INGRESS_URL}/", headers={"Host": f"{env}.aegisvolt.localhost"}, timeout=5)
        ok = res.status_code == 200 and '<div id="root">' in res.text
        detail = "" if ok else f"HTTP {res.status_code}"
    except Exception as exc:
        ok, detail = False, f"{type(exc).__name__}: {exc}"[:300]
    rows.append({"env": env, "componente": "frontend", "ok": ok, "latencia_ms": round((time.perf_counter() - started) * 1000, 1), "detalle": detail})

    down = [r["componente"] for r in rows if not r["ok"]]
    print(f"[{env}] {len(rows) - len(down)}/{len(rows)} componentes OK" + (f"; caídos: {', '.join(down)}" if down else ""))
    if down:
        # Con retries=2 Prefect reintenta antes de declarar el ambiente caído.
        raise RuntimeError(f"[{env}] componentes sin respuesta: {', '.join(down)}")
    return rows


@flow(name="env-health-check", log_prints=True)
def env_health_check(envs: list[str] = list(ENVS)) -> dict[str, bool]:
    logger = get_run_logger()
    futures = {env: check_env.submit(env) for env in envs}
    summary: dict[str, bool] = {}
    table: list[dict] = []
    for env, fut in futures.items():
        try:
            rows = fut.result()
            summary[env] = True
        except Exception as exc:  # el ambiente sigue caído tras los reintentos
            logger.error("%s", exc)
            rows = [{"env": env, "componente": "*", "ok": False, "latencia_ms": None, "detalle": str(exc)[:300]}]
            summary[env] = False
        table.extend(rows)

    create_table_artifact(key="env-health", table=table, description="Salud y latencia por ambiente y componente")
    lines = ["# Salud de los ambientes", "", "| Ambiente | Estado |", "|---|---|"]
    lines += [f"| {env} | {'OK' if ok else 'CAÍDO'} |" for env, ok in summary.items()]
    create_markdown_artifact(key="env-health-summary", markdown="\n".join(lines), description="Resumen de salud")

    if not all(summary.values()):
        raise RuntimeError(f"Ambientes con fallas: {[e for e, ok in summary.items() if not ok]}")
    return summary


if __name__ == "__main__":
    env_health_check()
