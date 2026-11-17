# Frontend de AegisVolt

Panel de operación de la red de carga. Lo usa un operador de flota y su trabajo principal es **mostrar la SAGA en vivo** (reservar conector → retener saldo → activar cargador, y su compensación cuando algo falla) sin que haya dudas sobre el ambiente en el que se está.

Código: [apps/frontend](../apps/frontend). Stack: React 19, Vite, Apollo Client 4 (HTTP + `graphql-ws`), Tailwind 4.

## Dirección visual

La identidad viene de los **tableros eléctricos industriales** y los **diagramas unifilares**: gris de gabinete, tinta azul de plano técnico y amarillo de señal "energizado".

| Token | Hex | Uso |
|---|---|---|
| `gabinete` | `#E4E6E3` | Fondo |
| `papel` | `#F7F8F6` | Paneles y tablas |
| `tinta` | `#1D2B3F` | Texto, cableado del diagrama, barra lateral |
| `energia` | `#F2B705` | Solo donde hay corriente o avance: conector cargando, tramo energizado, botón principal |
| `acero` | `#3A5A80` | Enlaces, foco de teclado, caminos de compensación |
| `ok` / `reservado` / `falla` | `#2F7D4F` / `#2F5FA8` / `#B3261E` | Estados |

- **Estados de conector:** nunca solo por color. Llevan forma (círculo vacío, círculo con punto, rayo, círculo tachado) y texto.
- **Franja de ambiente:** dev `#0F766E`, test `#6B3FA0`, prod `#B3261E` con rayado diagonal. Siempre visible.
- **Tipografía:** Barlow (texto) y Barlow Semi Condensed (títulos y cifras, con números tabulares). Va empaquetada con `@fontsource`, sin CDN externo.
- **Movimiento:** la única animación propia es la del diagrama cuando el operador inicia una carga. Respeta `prefers-reduced-motion`.

## El diagrama unifilar de la saga

[`saga-view.ts`](../apps/frontend/src/saga-view.ts) traduce el log de pasos de la saga (`steps[]` del orquestador) al estado de cada interruptor:

| Log | Interruptor |
|---|---|
| `EXECUTE … STARTED` | en curso |
| `EXECUTE … SUCCEEDED` | cerrado (la corriente pasa al siguiente tramo) |
| `EXECUTE … FAILED` | falla (abierto en rojo) |
| `COMPENSATE refund / release / stop` | devuelto / liberado / detenido; se dibuja el camino de retorno punteado |

Las sagas terminan en milisegundos, así que la vista muestra el log **de a un paso** (420 ms) para que el avance se vea. La subscription `sagaUpdated(correlationId)` y la respuesta de la mutation se combinan quedándose con la versión más avanzada. La lógica tiene pruebas unitarias en [apps/frontend/test](../apps/frontend/test).

## Una imagen para los 3 ambientes

El plan original proponía un build por ambiente (`VITE_GRAPHQL_URL`, `VITE_APP_ENV`). Se cambió a **una sola imagen promovida dev → test → prod**:

- **Mismo host:** UI y gateway comparten host. En kind, el Ingress `frontend` atiende `/` y el Ingress `graphql-gateway` atiende `/graphql`. La UI usa `/graphql` relativo y `ws(s)://<host>/graphql` para las subscriptions.
- **Ambiente en tiempo de ejecución:** se lee del gateway (`{ environment }`), así que la franja no puede mentir sobre el ambiente.
- **Versión:** la única variable de build es la versión (`VITE_APP_VERSION` = git sha), que se ve en la franja.

Así lo que se probó en test es byte a byte lo que llega a prod, igual que con los servicios.

## Entrega

- **Imagen:** [apps/frontend/Dockerfile](../apps/frontend/Dockerfile) hace el build con Vite y sirve con `nginx-unprivileged`. El sistema de archivos es de solo lectura (todo lo que nginx escribe va a `/tmp`). nginx también reenvía `/graphql` a `GRAPHQL_UPSTREAM` para docker compose y el acceso directo al Service.
- **Kubernetes:** [k8s/base/frontend.yaml](../k8s/base/frontend.yaml) define un Rollout con canary por peso en NGINX (20% → 50% → 100%) y su propio `frontend-analysis`. Ese análisis es un Job que pide `index.html`, el bundle con hash, `/healthz` y una ruta de la SPA 160 veces al Service canary y falla con un solo error.
- **Caché:** `index.html` va sin caché y `/assets/*` es inmutable (nombres con hash).

## Pruebas

- Unitarias (Vitest): derivación del diagrama, reproducción paso a paso, mensajes de error y URLs del gateway.
- E2E (Playwright, [tests/e2e](../tests/e2e)): franja de ambiente, estaciones y las 3 rutas de la saga desde la UI. En CI corren contra docker compose sobre un Floci efímero al que se le aplican los mismos módulos de Terraform de `infra/` (tablas, semillas y log groups).
