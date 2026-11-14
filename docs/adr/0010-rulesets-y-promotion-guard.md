# ADR-0010 — Protección de ramas con Rulesets + `promotion-guard`

- **Estado:** Aceptado
- **Fecha:** 2026-11-14

## Contexto
Las ramas `dev`, `test` y `prod` representan ambientes estáticos. La especificación exige cuatro cosas:
- prohibir el force push;
- prohibir el push directo;
- obligar a pasar por PR;
- exigir checks de CI en verde.

Además pide un flujo de promoción **lineal**: `feature/* → dev → test → prod`.

## Decisión
- **Repositorio público en GitHub.** Los rulesets son gratis en repos públicos.
- **Ruleset `protected-envs`**, versionado en `.github/rulesets/protected-envs.json` y aplicado a `dev`, `test` y `prod`:
  - `non_fast_forward`: bloquea `git push --force`.
  - `deletion`: impide borrar las ramas.
  - `pull_request`: el push directo se rechaza y todo cambio entra por PR. Se exigen 0 aprobaciones porque el proyecto es individual.
  - `allowed_merge_methods: ["merge"]`: solo *merge commit*. Con squash o rebase, `dev` y `test` tendrían commits distintos para el mismo cambio, y la siguiente promoción generaría conflictos cruzados.
  - `required_status_checks`: por ahora `promotion-guard`. El Día 5 se agregan `lint-build`, `unit-tests`, `integration-tests`, `e2e-tests` y `terraform-plan`.
  - **`bypass_actors: []`**: ni el administrador puede saltarse las reglas.
- **Job `promotion-guard`** (`.github/workflows/pr.yml`). Falla el PR en tres casos:
  - el destino es `test` y el origen no es `dev`;
  - el destino es `prod` y el origen no es `test`;
  - el destino es `dev` y el origen no es `feature/*`, `fix/*`, `chore/*` ni `docs/*`.

  Así la cadena de promoción la hace cumplir la máquina, no la disciplina.

## Consecuencias
- Demo de la pregunta 6.2: `git push origin test` y `git push --force origin test` son rechazados por el ruleset (`GH013: Repository rule violations`).
- El ruleset se aplica **después** de crear las tres ramas. De lo contrario, el primer push también quedaría bloqueado.
- Los jobs que necesitan Floci/kind (`terraform-plan`, deploy) corren en un *self-hosted runner* local. En un repo público, los workflows de forks requieren aprobación manual.
