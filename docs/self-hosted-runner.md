# Self-hosted runner (PC con Floci + kind)

Los jobs `terraform-plan` (de `pr.yml`) y `deploy` (de `deploy.yml`) corren en este PC. Ahí viven el Floci persistente, que guarda el tfstate y las tablas de cada ambiente, el clúster kind y el registro `localhost:5001`. Los demás jobs usan runners de GitHub.

## Requisitos en el PC
Todo esto debe estar en el `PATH` de la terminal donde corre el runner:

- Docker Desktop encendido, con los contenedores `aegisvolt-floci`, `kind-registry` y los 3 nodos de kind.
- Git for Windows: los workflows usan `shell: bash`, y **`C:\Program Files\Git\bin` debe estar antes que `C:\Windows\System32`** en el `PATH`. Si no, Windows toma el `bash.exe` de WSL. Agregarlo al `Path` del usuario no basta, porque Windows pone primero el del sistema. Por eso se antepone en la sesión, al encender el runner (ver **Uso**).
- `kubectl` con el contexto `kind-aegisvolt` y el plugin `kubectl-argo-rollouts` (en `~/.local/bin`).
- `terraform` 1.17.1. Si no está, `scripts/tf.sh` usa la imagen de Docker.
- `gh` (GitHub CLI), para comentar el plan en el PR.

## Instalación (una vez)
1. En GitHub, ve a **Settings → Actions → Runners → New self-hosted runner → Windows x64** y sigue los comandos que muestra. Descárgalo en `C:\actions-runner`, no dentro del repo.
2. Al configurarlo:
   ```powershell
   .\config.cmd --url https://github.com/JCampos06/AegisVolt --token <TOKEN> --name aegisvolt-pc --labels aegisvolt --work _work
   ```
   La etiqueta **`aegisvolt`** es la que buscan los workflows (`runs-on: [self-hosted, aegisvolt]`).
3. Cuando pregunte si quieres instalarlo como servicio, responde **No**. Como servicio corre con otro usuario, que no ve tu Docker, tu kubeconfig ni tu `PATH`.

## Uso
- **Para encenderlo** (mientras quieras que corran los pipelines):
  ```powershell
  cd C:\actions-runner
  $env:Path = "C:\Program Files\Git\bin;" + $env:Path   # Git Bash antes que el bash de WSL
  .\run.cmd
  ```
- **Para apagarlo:** `Ctrl+C`.

## Seguridad (repo público)
- En **Settings → Actions → General → Fork pull request workflows**, activa *Require approval for all outside collaborators*.
- `terraform-plan` tiene `if: head.repo == este repo`, así que nunca ejecuta código de un fork en el PC.
- `deploy.yml` solo se dispara con `push` a `dev`, `test` o `prod`, y eso solo pasa con un merge aprobado por el ruleset.
- Ningún workflow usa secretos reales: Floci acepta credenciales `test/test`.

## Si el runner está apagado
`terraform-plan` es un check obligatorio, así que el PR queda esperando hasta que el runner se enciende. Es intencional: no se fusiona nada sin el plan del ambiente destino.
