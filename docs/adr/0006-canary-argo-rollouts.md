# ADR-0006 — Canary con Argo Rollouts, NGINX y análisis automático

- **Estado:** Aceptado
- **Fecha:** 2026-11-16

## Contexto
Cada merge a `dev`, `test` o `prod` despliega una versión nueva. Si esa versión falla, no debe afectar a todos los usuarios ni depender de que alguien esté mirando para devolverla.

Hay dos tipos de tráfico:
- el **externo**, que entra al gateway GraphQL por el Ingress;
- el **interno**, que el gateway envía a los 3 servicios REST por ClusterIP.

## Decisión
- **Argo Rollouts** (v1.10.2) reemplaza a los `Deployment`. Hay un `Rollout` por servicio en `k8s/base/`, y un overlay de Kustomize por ambiente (`k8s/overlays/<env>`) que fija el namespace, `APP_ENV`, las réplicas (2/3/5) y el host.
- **Pasos comunes**, definidos en un solo lugar (`k8s/base/canary-steps.yaml`): `20% → pausa 60 s → análisis → 50% → pausa 60 s → análisis → 100%`.
- **Frontend (día 6):** también canary por peso con NGINX, con su propio Ingress (`/`) y pasos más cortos (pausas de 30 s). Usa `frontend-analysis`, un Job que pide la SPA completa (`index.html`, el bundle con hash, `/healthz` y una ruta interna) 160 veces al Service canary y falla con un solo error, porque nginx no expone `/metrics.json` ni escribe en CloudWatch.
- **Gateway:** canary por peso con **NGINX**. Argo crea un Ingress `-canary` con `canary-weight` 20 y después 50, y lo vuelve a 0 al terminar. El peso aplica al tráfico real, no a la cantidad de pods.
- **Servicios internos:** canary por **réplicas**. El gateway llama al Service estable, que selecciona los pods de las dos versiones, y el peso es la proporción de pods de cada una. El Service `-canary` apunta solo a la versión nueva y lo usa el análisis.
- **`AnalysisTemplate canary-analysis`**, el mismo para los 4 servicios y los 3 ambientes. Los argumentos salen de las etiquetas y anotaciones del Rollout, y en cada paso corren tres métricas:
  1. **`probe-traffic`** (Job con curl): manda 60 peticiones al Service canary, para que haya qué medir aunque nadie esté usando la app.
  2. **`success-rate`** (provider `web`): lee `/metrics.json` del pod canary y exige `successRate >= 0.95`.
  3. **`cloudwatch-5xx`** (Job con `aws-cli`): suma la métrica `Http5xx` (el metric filter del log group `/aegisvolt/<env>/<servicio>`, dimensiones `Service` y `Version` = la del canary) de los últimos 10 minutos. Falla si hay más de 5.
- **Si una métrica falla, Argo aborta y vuelve al 100% estable sin intervención.** `scripts/k8s-deploy.sh` y `deploy.yml` esperan con `kubectl argo rollouts status`: un Rollout `Degraded` hace fallar el pipeline.
- **Imágenes inmutables:** el tag es el `git-sha` y se suben al registro local `localhost:5001`. La versión viaja en la etiqueta `app.kubernetes.io/version` y en `APP_VERSION`, y por eso los logs y la métrica de CloudWatch distinguen la versión estable de la canary. Cada ambiente construye su imagen desde el merge commit de su rama. El código es el mismo que se aprobó en el ambiente anterior, pero el artefacto es otro (ver *Mejora futura*).

## Alternativas consideradas
- **`Deployment` con `RollingUpdate`.** Solo revisa las probes, así que una versión que responde 500 pero pasa `/health` llega al 100%. Tampoco tiene pasos ni rollback por métricas.
- **Flagger.** Ofrece canary con análisis, pero depende de Prometheus o de un mesh para las métricas. Con Argo, el provider `web` y los Jobs alcanzan a `/metrics.json` y a CloudWatch sin instalar Prometheus.
- **Service mesh (Istio o Linkerd)** para dividir por peso también el tráfico interno. Es más exacto, pero demasiado pesado para kind en un PC. Con 3 a 5 réplicas, el peso por réplicas es suficiente.
- **Un solo análisis al final.** Detectaría el fallo después de exponer al 50% del tráfico. Analizar en el 20% limita el impacto.

## Consecuencias
- **Demo de rollback:** `bash scripts/k8s-deploy.sh test --faulty billing-wallet-service` despliega billing con `FAULTY_VERSION=true` (alrededor de 30% de 500). El análisis del 20% falla y Argo aborta. Se observa con `kubectl argo rollouts get rollout billing-wallet-service -n aegisvolt-test -w`. Para volver a la normalidad se despliega otra vez sin `--faulty`.
- **El gateway tiene 1 réplica** por el PubSub en memoria ([ADR-0005](0005-graphql-bff-y-rest-interno.md)). Durante un canary conviven 1 pod estable y 1 canary, y una subscription puede quedar en el pod que se retira, así que el cliente se reconecta.
- **Primer despliegue:** en el primer despliegue de un ambiente no hay versión estable, así que Argo va directo al 100%. El canary aplica a partir del segundo.
- **El mapeo de puertos de kind solo existe en el control-plane:** ingress-nginx debe correr ahí (`nodeSelector: ingress-ready=true`), y `scripts/kind-up.sh` lo asegura.
- **Mejora futura (*build once, deploy many*):** hoy, `dev → test` y `test → prod` vuelven a construir las imágenes porque cada merge commit tiene otro sha. Lo correcto sería promover el artefacto ya aprobado. Se haría así:
  - etiquetar con el hash del árbol de git (`git rev-parse HEAD^{tree}`), que no cambia en un merge de promoción;
  - en el deploy, reusar la imagen del registro si ya existe esa etiqueta, y construirla solo si falta.

  No se hizo porque no lo exige la especificación y porque cambiar el pipeline en el último día ponía en riesgo las demos. Mientras tanto, el canary analiza de nuevo cada versión en cada ambiente.
- **En AWS real**, el `AWS_ENDPOINT_URL` de Floci desaparece, las credenciales de los Jobs pasan a IRSA, el registro pasa a ser ECR y el Ingress NGINX queda detrás del API Gateway y del VPC Link ([ADR-0008](0008-topologia-red-vpc-vpce.md)).
