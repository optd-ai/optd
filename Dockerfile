# syntax=docker/dockerfile:1

ARG DENO_IMAGE=denoland/deno:debian-2.8.3@sha256:438618d8c0678c3154fc77ad6edad61f38cbc42803a181e7908d3e2c9e645022
ARG POSTGRES_IMAGE=postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296

FROM ${DENO_IMAGE} AS build
WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
RUN deno cache --frozen src/main_server.ts src/main_optctl.ts \
  && deno compile --frozen --no-prompt --allow-all \
    --output /opt/optd/bin/optd src/main_server.ts \
  && deno compile --frozen --no-prompt \
    --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys=uid \
    --output /opt/optd/bin/optctl src/main_optctl.ts

FROM ${POSTGRES_IMAGE} AS tini
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini=0.19.0-1+b3 \
  && rm -rf /var/lib/apt/lists/*

FROM ${POSTGRES_IMAGE} AS rootfs

USER root
RUN groupadd --gid 1993 optd \
  && useradd --uid 1993 --gid 1993 --no-create-home --home-dir /data --shell /usr/sbin/nologin optd \
  && mkdir -p /data /opt/optd/bin \
  && chown -R 1993:1993 /data /opt/optd
COPY --from=build /usr/bin/deno /usr/local/bin/deno
COPY --from=build /deno-dir /opt/optd/deno-dir
COPY --from=build /opt/optd/bin/optd /opt/optd/bin/optctl /usr/local/bin/
COPY --from=tini /usr/bin/tini /usr/bin/tini
COPY deno.json deno.lock /opt/optd/
COPY src/adapters/outbound/postgres/auth_password_worker.ts /opt/optd/runtime/auth_password_worker.ts
COPY prototypes/crm-default-pack /opt/optd/prototypes/crm-default-pack
COPY prototypes/project-management-pack /opt/optd/prototypes/project-management-pack
COPY scripts/container-entrypoint.sh /usr/local/bin/optd-entrypoint
RUN chmod 0555 /usr/local/bin/optd /usr/local/bin/optctl \
    /usr/local/bin/deno /usr/local/bin/optd-entrypoint /usr/bin/tini \
  && chown -R 1993:1993 /opt/optd

# The official postgres image declares /var/lib/postgresql as a volume and
# port 5432 as exposed metadata. Docker cannot remove inherited metadata, so
# copy the prepared filesystem into a metadata-clean final image.
FROM scratch AS runtime
ARG OPTD_VERSION=0.1.0-dev
ARG OPTD_REVISION=unknown
ARG OPTD_SOURCE=https://github.com/optd-ai/optd
COPY --from=rootfs / /
LABEL org.opencontainers.image.title="optd" \
  org.opencontainers.image.version="${OPTD_VERSION}" \
  org.opencontainers.image.revision="${OPTD_REVISION}" \
  org.opencontainers.image.source="${OPTD_SOURCE}"
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin \
  LANG=en_US.utf8 \
  OPTD_HOST=0.0.0.0 \
  OPTD_PORT=8789 \
  OPTD_DATA_DIR=/data \
  OPTD_PG_BIN_DIR=/usr/lib/postgresql/18/bin \
  OPTD_DENO_BIN=/usr/local/bin/deno \
  OPTD_AUTH_PASSWORD_WORKER=/opt/optd/runtime/auth_password_worker.ts \
  DENO_DIR=/opt/optd/deno-dir
WORKDIR /opt/optd
USER 1993:1993
EXPOSE 8789
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["deno", "eval", "const p=Deno.env.get('OPTD_PORT')??'8789';const r=await fetch(`http://127.0.0.1:${p}/ready`);if(!r.ok)Deno.exit(1)"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/optd-entrypoint"]
CMD ["server"]
