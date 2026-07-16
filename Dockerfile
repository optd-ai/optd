# syntax=docker/dockerfile:1

FROM denoland/deno:debian-2.8.3 AS deps
WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
RUN deno cache src/main_server.ts src/main_optctl.ts

FROM deps AS optctl
RUN test -x /bin/cat \
  && deno compile \
  --no-prompt \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  --allow-run \
  --allow-sys=uid \
  --output /opt/operant/bin/optctl \
  src/main_optctl.ts

FROM denoland/deno:debian-2.8.3

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    postgresql \
    postgresql-client \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /deno-dir /deno-dir
COPY --from=optctl /opt/operant/bin/optctl /usr/local/bin/optctl
COPY deno.json deno.lock ./
COPY src ./src
COPY prototypes ./prototypes
COPY scripts/container-entrypoint.sh /usr/local/bin/operant-entrypoint

ENV DENO_DIR=/deno-dir \
  OPERANT_HOST=0.0.0.0 \
  OPERANT_PORT=8789 \
  OPERANT_DATA_DIR=/data \
  OPERANT_PG_BIN_DIR=/usr/lib/postgresql/17/bin

RUN chmod +x /usr/local/bin/operant-entrypoint /usr/local/bin/optctl \
  && mkdir -p /data \
  && chown -R deno:deno /app /data /deno-dir /usr/local/bin/optctl

USER deno
EXPOSE 8789
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD curl -fsS http://127.0.0.1:${OPERANT_PORT}/ready >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "operant-entrypoint"]
CMD ["server"]
