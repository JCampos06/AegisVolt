"""Flow saga_consistency_audit (cada 10 min, por ambiente).

Audita las sagas del orquestador contra las bases de cada servicio (Database per
Service): el log de la saga dice qué pasó y cada servicio debe reflejarlo.

  Huérfanas      PENDING / RESERVED / CHARGED / COMPENSATING sin cambios hace
                 más de `stale_minutes` (una compensación agotó sus reintentos o
                 el gateway se cayó a mitad de la saga) -> requieren intervención.
  COMPENSATED    si se retuvo saldo, la retención debe estar REFUNDED; si se
                 reservó el conector, la reserva debe estar RELEASED y el
                 conector ya no debe apuntar a la saga.
  COMPLETED      la retención sigue HELD (el cobro) y la sesión de carga existe
                 (ACTIVE, o STOPPED si ya terminó).

Lee DynamoDB en modo solo lectura (índice status-updatedAt-index, sin Scan).
Publica una tabla y un resumen markdown por ambiente, y la métrica
AegisVolt/Prefect SagaInconsistencies (dimensión Env) en CloudWatch.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from boto3.dynamodb.conditions import Key
from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact

from common import ENVS, cloudwatch, dynamodb, table_name, trace_hint

IN_FLIGHT = ("PENDING", "RESERVED", "CHARGED", "COMPENSATING")
INDEX = "status-updatedAt-index"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _query_status(table, status: str, **range_cond) -> list[dict]:
    cond = Key("status").eq(status)
    if "before" in range_cond:
        cond = cond & Key("updatedAt").lt(range_cond["before"])
    if "after" in range_cond:
        cond = cond & Key("updatedAt").gt(range_cond["after"])
    items: list[dict] = []
    kwargs = {"IndexName": INDEX, "KeyConditionExpression": cond}
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _succeeded(saga: dict, step: str) -> bool:
    return any(s.get("step") == step and s.get("action") == "EXECUTE" and s.get("outcome") == "SUCCEEDED" for s in saga.get("steps", []))


def _get(table, pk: str, sk: str = "META") -> dict | None:
    return table.get_item(Key={"PK": pk, "SK": sk}).get("Item")


def _row(env: str, saga: dict, check: str, ok: bool, detail: str = "") -> dict:
    cid = saga.get("correlationId", "?")
    return {
        "env": env,
        "correlation_id": cid,
        "estado": saga.get("status"),
        "flota": saga.get("fleetId"),
        "conector": f"{saga.get('stationId')}/{saga.get('connectorId')}",
        "verificación": check,
        "ok": ok,
        "detalle": detail,
        "rastreo": "" if ok else trace_hint(cid, env),
    }


@task(retries=2, retry_delay_seconds=5, log_prints=True)
def audit_env(env: str, stale_minutes: int, lookback_hours: int) -> list[dict]:
    db = dynamodb()
    sagas = db.Table(table_name("sagas", env))
    billing = db.Table(table_name("billing", env))
    reservations = db.Table(table_name("reservations", env))
    dispatch = db.Table(table_name("dispatch", env))
    now = datetime.now(timezone.utc)
    rows: list[dict] = []

    # 1. Huérfanas
    cutoff = _iso(now - timedelta(minutes=stale_minutes))
    for status in IN_FLIGHT:
        for s in _query_status(sagas, status, before=cutoff):
            rows.append(_row(env, s, "huérfana", False, f"sin cambios desde {s.get('updatedAt')} (> {stale_minutes} min)"))

    since = _iso(now - timedelta(hours=lookback_hours))

    # 2. Compensadas: saldo devuelto y conector liberado
    for s in _query_status(sagas, "COMPENSATED", after=since):
        cid, fleet = s["correlationId"], s.get("fleetId")
        problems = []
        if _succeeded(s, "hold"):
            tx = _get(billing, f"WALLET#{fleet}", f"TX#{cid}")
            if not tx or tx.get("status") != "REFUNDED":
                problems.append(f"retención {tx.get('status') if tx else 'inexistente'} (se esperaba REFUNDED)")
        if _succeeded(s, "reserve"):
            res = _get(reservations, f"RESERVATION#{cid}")
            if not res or res.get("status") != "RELEASED":
                problems.append(f"reserva {res.get('status') if res else 'inexistente'} (se esperaba RELEASED)")
            conn = _get(reservations, f"STATION#{s.get('stationId')}", f"CONNECTOR#{s.get('connectorId')}")
            if conn and conn.get("sagaId") == cid:
                problems.append(f"el conector sigue tomado por la saga ({conn.get('status')})")
        rows.append(_row(env, s, "compensación aplicada", not problems, "; ".join(problems) or "saldo devuelto y conector liberado"))

    # 3. Completadas: cobro retenido y sesión creada
    for s in _query_status(sagas, "COMPLETED", after=since):
        cid, fleet = s["correlationId"], s.get("fleetId")
        problems = []
        tx = _get(billing, f"WALLET#{fleet}", f"TX#{cid}")
        if not tx or tx.get("status") != "HELD":
            problems.append(f"retención {tx.get('status') if tx else 'inexistente'} (se esperaba HELD)")
        session = _get(dispatch, f"SESSION#{cid}")
        if not session or session.get("status") not in ("ACTIVE", "STOPPED"):
            problems.append(f"sesión {session.get('status') if session else 'inexistente'} (se esperaba ACTIVE o STOPPED)")
        detail = "; ".join(problems) or f"cobro retenido, sesión {session.get('status') if session else ''}"
        rows.append(_row(env, s, "carga activa", not problems, detail))

    bad = [r for r in rows if not r["ok"]]
    print(f"[{env}] sagas auditadas: {len(rows)}, inconsistencias: {len(bad)}")
    for r in bad:
        print(f"[{env}] {r['correlation_id']} {r['estado']}: {r['detalle']}  ->  {r['rastreo']}")
    return rows


@task(retries=2, retry_delay_seconds=5)
def publish(env: str, rows: list[dict]) -> int:
    bad = [r for r in rows if not r["ok"]]
    compensated = [r for r in rows if r["estado"] == "COMPENSATED"]

    create_table_artifact(
        key=f"saga-audit-{env}",
        table=rows or [{"env": env, "correlation_id": "-", "verificación": "sin sagas en la ventana", "ok": True}],
        description=f"Auditoría de consistencia de sagas en {env}",
    )
    md = [f"# Auditoría de sagas en {env}", "", f"Sagas revisadas: **{len(rows)}**. Inconsistencias: **{len(bad)}**.", ""]
    if compensated:
        md += ["## Sagas compensadas", "", "| correlationId | Conector | Resultado |", "|---|---|---|"]
        md += [f"| `{r['correlation_id']}` | {r['conector']} | {'OK' if r['ok'] else 'REVISAR'}: {r['detalle']} |" for r in compensated]
        md.append("")
    if bad:
        md += ["## Requieren intervención", ""]
        md += [f"- `{r['correlation_id']}` ({r['estado']}): {r['detalle']}. Rastreo: `{r['rastreo']}`" for r in bad]
    create_markdown_artifact(key=f"saga-audit-{env}-summary", markdown="\n".join(md), description=f"Resumen de la auditoría en {env}")

    cloudwatch().put_metric_data(
        Namespace="AegisVolt/Prefect",
        MetricData=[{"MetricName": "SagaInconsistencies", "Dimensions": [{"Name": "Env", "Value": env}], "Value": len(bad), "Unit": "Count"}],
    )
    return len(bad)


@flow(name="saga-consistency-audit", log_prints=True)
def saga_consistency_audit(envs: list[str] = list(ENVS), stale_minutes: int = 5, lookback_hours: int = 24) -> dict[str, int]:
    logger = get_run_logger()
    result: dict[str, int] = {}
    for env in envs:
        rows = audit_env(env, stale_minutes, lookback_hours)
        result[env] = publish(env, rows)
    logger.info("Inconsistencias por ambiente: %s", result)
    return result


if __name__ == "__main__":
    saga_consistency_audit()
