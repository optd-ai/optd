# Chunk 0: Repository scaffolding and live validation harness

## Deliverable
Create the real MVP source/test skeleton and the reusable live-validation harness that every later chunk will extend.

## Scope
- Create the `src/` layout from `spec/mvp-implementation-boundaries.md`.
- Add an initial `deno.json` with stable tasks where useful (`fmt`, `test`, `scenario`, server/optctl entrypoints).
- Add shared stable error/result helpers, basic actor/id/time helpers, and app construction seams.
- Add minimal Hono server entrypoint with `GET /health`.
- Add minimal Cliffy `optctl home` command that calls the real server over HTTP and supports `--json`.
- Add a scenario harness that can allocate temp dirs, start/stop a real server listener, invoke `optctl` over HTTP, collect failure artifacts, and clean up.
- Add `tests/scenarios/00_bootstrap.ts`.

## Validation requirements
- Unit/adapter tests for stable error/result helpers.
- Live scenario must start a real server listener, call `GET /health` over HTTP, run `optctl home --json` against that URL, assert server/version/status fields, and fail if the server is not actually listening.
- Record the exact command used and result.

## Notes
- This chunk should not introduce real Postgres behavior beyond a clean seam/stub for later chunks.
- Keep boundaries clean: Hono only in inbound HTTP adapter; Cliffy only in CLI adapter.
