"""Configuración compartida de los flows de AegisVolt.

Los flows corren en el worker de Prefect (docker compose de esta carpeta), que
está conectado a la red docker "kind":

  - Floci (DynamoDB / CloudWatch)  -> http://aegisvolt-floci:4566
  - Ingress NGINX de kind          -> http://aegisvolt-control-plane:80
    con el header Host <env>.aegisvolt.localhost para elegir el ambiente.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

import boto3
import httpx

ENVS = ("dev", "test", "prod")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL", "http://aegisvolt-floci:4566")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
INGRESS_URL = os.getenv("INGRESS_URL", "http://aegisvolt-control-plane:80")
NAME_PREFIX = os.getenv("NAME_PREFIX", "aegisvolt")


def table_name(kind: str, env: str) -> str:
    return f"{NAME_PREFIX}-{kind}-{env}"


def dynamodb():
    return boto3.resource(
        "dynamodb",
        endpoint_url=AWS_ENDPOINT_URL,
        region_name=AWS_REGION,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY", "test"),
    )


def cloudwatch():
    return boto3.client(
        "cloudwatch",
        endpoint_url=AWS_ENDPOINT_URL,
        region_name=AWS_REGION,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY", "test"),
    )


@dataclass
class GqlResult:
    ok: bool
    ms: float
    status: int | None
    data: dict[str, Any] | None
    error: str | None


def graphql(env: str, query: str, timeout: float = 5.0) -> GqlResult:
    """POST /graphql del gateway del ambiente, por el Ingress de kind."""
    started = time.perf_counter()
    try:
        res = httpx.post(
            f"{INGRESS_URL}/graphql",
            json={"query": query},
            headers={"Host": f"{env}.aegisvolt.localhost", "x-correlation-id": f"prefect-health-{env}"},
            timeout=timeout,
        )
        ms = (time.perf_counter() - started) * 1000
        body = res.json()
        if res.status_code != 200 or body.get("errors"):
            return GqlResult(False, ms, res.status_code, body.get("data"), str(body.get("errors") or res.text)[:300])
        return GqlResult(True, ms, res.status_code, body.get("data"), None)
    except Exception as exc:  # red caída, timeout, JSON inválido
        return GqlResult(False, (time.perf_counter() - started) * 1000, None, None, f"{type(exc).__name__}: {exc}"[:300])


def trace_hint(correlation_id: str, env: str) -> str:
    return f"bash scripts/trace-saga.sh {correlation_id} {env}"
