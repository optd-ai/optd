import { SystemClock } from "./ports/clock.ts";
import { makeInspectMetadataService } from "./services/inspect_metadata.ts";
import { makeStageChangesetService } from "./services/changesets/stage_changesets.ts";
import { PostgresStageRepository } from "../adapters/outbound/postgres/stage_repository.ts";
import { PostgresCommitRepository } from "../adapters/outbound/postgres/commit_repository.ts";
import { makeCommitChangesetService } from "./services/commit/commit_changeset.ts";
import { makePackServices } from "./services/pack_services.ts";
import { makeQueryObjectsService } from "./services/query_objects.ts";
import { makeMigrationServices } from "./services/migration_services.ts";
import { makeProcessOutboxService } from "./services/process_outbox.ts";
import { PostgresOutboxRepository } from "../adapters/outbound/postgres/outbox_repository.ts";
import type { DenoHookRunnerOptions } from "../adapters/outbound/deno-hooks/hook_runner.ts";
import { makeSecretsService } from "./services/secrets/manage_secrets.ts";
import { makeHookSecretGrantService } from "./services/secrets/manage_grants.ts";
import { EnvelopeCrypto } from "../adapters/outbound/crypto/envelope.ts";
import { PostgresHookSecretRepository } from "../adapters/outbound/postgres/hook_secret_repository.ts";
import { TrustedStageHookCoordinator } from "./services/hooks/stage_hook_coordinator.ts";
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
import { PostgresAuthorizationRepository } from "../adapters/outbound/postgres/authorization_repository.ts";
import { makeAuthorizationService } from "./services/authorization/manage_assignments.ts";
import { PostgresObjectReadBoundary } from "../adapters/outbound/postgres/object_read_boundary.ts";
import { makeObjectReadService } from "./services/objects/read_objects.ts";
import { HistoryCursorSigner } from "../domain/history/cursor.ts";
import { makeExpressionService } from "./services/queries/expressions.ts";
import { err } from "../domain/errors/result.ts";
import type { StageHookCoordinator } from "../domain/changesets/stage.ts";
import { makeStageActionService } from "./services/actions/stage_actions.ts";
import { makeStageSeedsService } from "./services/seeds/stage_seeds.ts";

export function makeApplication(
  sql: Sql,
  options: {
    bootstrapToken?: string;
    stageHookCoordinator?: StageHookCoordinator;
    hookRunnerOptions?: DenoHookRunnerOptions;
  } = {},
) {
  const clock = new SystemClock();
  const tx = new PostgresTransactionManager(sql);
  const authorizationRepository = new PostgresAuthorizationRepository(sql);
  const cryptoAdapter = new EnvelopeCrypto();
  const secrets = makeSecretsService({
    sql: sql as Queryable,
    tx,
    authorization: authorizationRepository,
    crypto: cryptoAdapter,
  });
  const hookSecretGrants = makeHookSecretGrantService({
    sql: sql as Queryable,
    tx,
    authorization: authorizationRepository,
    authorizeInTransaction: (lockedSql, auth, action) =>
      new PostgresAuthorizationRepository(lockedSql as Sql).authorize({
        auth,
        boundary: { type: "system" },
        action,
        resource: "system:hook-secret-grant",
      }),
  });
  const hookSecretRepository = new PostgresHookSecretRepository(
    sql,
    cryptoAdapter,
  );
  const stageHookCoordinator = options.stageHookCoordinator ??
    new TrustedStageHookCoordinator(
      hookSecretRepository,
      options.hookRunnerOptions,
    );
  const stageRepository = new PostgresStageRepository(sql);
  const stageChangesets = makeStageChangesetService(
    stageRepository,
    stageHookCoordinator,
  );
  const changesets = {
    ...stageChangesets,
    ...makeCommitChangesetService(new PostgresCommitRepository(sql)),
  };
  const maximumHashes = Number(
    Deno.env.get("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES") ?? "4",
  );
  const authentication = new PostgresAuthRepository(
    sql,
    options.bootstrapToken,
    maximumHashes,
  );
  const passwordPolicy = loadPasswordPolicy();
  let historyCursors: HistoryCursorSigner | undefined;
  const authorization = makeAuthorizationService(authorizationRepository);
  return {
    authentication,
    bootstrap: makeBootstrapService(authentication, passwordPolicy),
    humanAuth: makeHumanAuthService(authentication, passwordPolicy),
    agentAuth: makeAgentAuthService(authentication),
    projects: makeProjectService(new PostgresProjectRepository(sql)),
    authorization,
    metadata: makeInspectMetadataService({
      sql,
      clock,
      version: OPERANT_VERSION,
      authorization: authorizationRepository,
    }),
    objectReads: makeObjectReadService({
      boundary: new PostgresObjectReadBoundary(sql),
      cursors: () => historyCursors ??= HistoryCursorSigner.fromEnvironment(),
    }),
    packs: makePackServices({
      sql: sql as Queryable,
      authorization: authorizationRepository,
      tx,
    }),
    changesets,
    migrations: makeMigrationServices({
      sql: sql as Queryable,
      authorization: authorizationRepository,
      tx,
      authorizeApplyInTransaction: (lockedSql, auth) =>
        new PostgresAuthorizationRepository(lockedSql as Sql).authorize({
          auth,
          boundary: { type: "system" },
          action: "migration.apply",
          resource: "system:migration",
        }),
    }),
    hookSecretGrants,
    queries: makeQueryObjectsService({ sql }),
    expressions: makeExpressionService(sql as Queryable),
    outbox: makeProcessOutboxService({
      sql: sql as Queryable,
      repository: new PostgresOutboxRepository(
        sql,
        async (lockedSql, auth, action) =>
          (await new PostgresAuthorizationRepository(lockedSql as Sql)
            .authorize({
              auth,
              boundary: { type: "system" },
              action,
              resource: "system:outbox",
            })).ok,
      ),
      authorization: authorizationRepository,
      secrets: hookSecretRepository,
      hookRunnerOptions: options.hookRunnerOptions,
    }),
    secrets,
    actions: stageHookCoordinator instanceof TrustedStageHookCoordinator
      ? makeStageActionService(sql, stageHookCoordinator, changesets)
      : {
        stage: () =>
          Promise.resolve(
            err({
              code: "unavailable",
              message: "action staging coordinator is unavailable",
              severity: "unavailable",
              details: {},
            }),
          ),
      },
    seeds: makeStageSeedsService(sql, changesets),
  };
}
