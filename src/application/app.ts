import { SystemClock } from "./ports/clock.ts";
import { makeInspectMetadataService } from "./services/inspect_metadata.ts";
import { makeChangesetServices } from "./services/changeset_services.ts";
import { makePackServices } from "./services/pack_services.ts";
import { makeQueryObjectsService } from "./services/query_objects.ts";
import { makeRunActionService } from "./services/run_action.ts";
import { makeMigrationServices } from "./services/migration_services.ts";
import { makeProcessOutboxService } from "./services/process_outbox.ts";
import { DenoHookRunner } from "../adapters/outbound/deno-hooks/hook_runner.ts";
import { makeSecretService } from "./services/manage_secret.ts";
import { OPERANT_VERSION } from "../config/runtime.ts";
import type { Queryable, Sql } from "../adapters/outbound/postgres/client.ts";
import { PostgresTransactionManager } from "../adapters/outbound/postgres/transaction_manager.ts";
import { PostgresAuthRepository } from "../adapters/outbound/postgres/auth_repository.ts";
import { PostgresProjectRepository } from "../adapters/outbound/postgres/project_repository.ts";
import { makeBootstrapService } from "./services/auth/bootstrap.ts";
import { makeAgentAuthService } from "./services/auth/agent.ts";
import {
  loadPasswordPolicy,
  makeHumanAuthService,
} from "./services/auth/human.ts";
import { makeProjectService } from "./services/projects/manage_projects.ts";

export function makeApplication(
  sql: Sql,
  options: { bootstrapToken?: string } = {},
) {
  const clock = new SystemClock();
  const tx = new PostgresTransactionManager(sql);
  const secrets = makeSecretService({ sql: sql as Queryable, tx });
  const hookRunner = new DenoHookRunner({
    secretResolver: (name) => secrets.resolveSecret(name),
  });
  const changesets = makeChangesetServices({
    sql: sql as Queryable,
    tx,
    hookRunner,
  });
  const maximumHashes = Number(
    Deno.env.get("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES") ?? "4",
  );
  const authentication = new PostgresAuthRepository(
    sql,
    options.bootstrapToken,
    maximumHashes,
  );
  const passwordPolicy = loadPasswordPolicy();
  return {
    authentication,
    bootstrap: makeBootstrapService(authentication, passwordPolicy),
    humanAuth: makeHumanAuthService(authentication, passwordPolicy),
    agentAuth: makeAgentAuthService(authentication),
    projects: makeProjectService(new PostgresProjectRepository(sql)),
    metadata: makeInspectMetadataService({
      sql,
      clock,
      version: OPERANT_VERSION,
    }),
    packs: makePackServices({ sql: sql as Queryable, tx }),
    changesets,
    migrations: makeMigrationServices({ sql: sql as Queryable, tx }),
    queries: makeQueryObjectsService({ sql: sql as Queryable }),
    outbox: makeProcessOutboxService({
      sql: sql as Queryable,
      tx,
      hookRunner,
    }),
    secrets,
    actions: makeRunActionService({
      sql: sql as Queryable,
      hookRunner,
      changesets,
    }),
  };
}
