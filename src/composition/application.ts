import { SystemClock } from "../application/ports/clock.ts";
import { makePostgresMetadataRepository } from "../adapters/outbound/postgres/repositories/metadata_catalog_repository.ts";
import { makeStageChangesetService } from "../application/services/changesets/stage_changesets.ts";
import { PostgresStageRepository } from "../adapters/outbound/postgres/stage_repository.ts";
import { PostgresCommitRepository } from "../adapters/outbound/postgres/commit_repository.ts";
import { makeCommitChangesetService } from "../application/services/commit/commit_changeset.ts";
import {
  makePostgresPackRepository,
  yamlPackParser,
} from "../adapters/outbound/postgres/repositories/pack_application_repository.ts";
import {
  evaluateObjectPolicy,
  makePostgresQueryObjectRepository,
} from "../adapters/outbound/postgres/query_policy_sql.ts";
import { makePostgresMigrationPersistence } from "../adapters/outbound/postgres/repositories/migration_application_repository.ts";
import {
  loadOutboxConfig,
  makeDeliveryHookExecutor,
  makeOutboxCursorPort,
  makePostgresDeliverySecretResolver,
  makePostgresOutboxLifecyclePort,
  makePostgresPinnedDeliveryHookCatalog,
} from "../adapters/outbound/postgres/repositories/outbox_processing_repository.ts";
import { PostgresOutboxRepository } from "../adapters/outbound/postgres/outbox_repository.ts";
import {
  DenoHookRunner,
  type DenoHookRunnerOptions,
  type HookDefinition,
  type HookEnvelope,
} from "../adapters/outbound/deno-hooks/hook_runner.ts";
import { makePostgresSecretLifecyclePersistence } from "../adapters/outbound/postgres/repositories/hook_secret_lifecycle_repository.ts";
import { makePostgresHookSecretGrantPersistence } from "../adapters/outbound/postgres/repositories/hook_secret_grant_repository.ts";
import {
  EnvelopeCrypto,
  makeEnvelopeSecretCipher,
} from "../adapters/outbound/crypto/envelope.ts";
import { PostgresHookSecretRepository } from "../adapters/outbound/postgres/hook_secret_repository.ts";
import {
  DenoHookExecutor,
  makeHookSecretResolver,
} from "../adapters/outbound/deno-hooks/trusted_stage_hook_adapter.ts";
import { TrustedStageHookCoordinator } from "../application/services/hooks/trusted_stage_hook_coordinator.ts";
import { OPERANT_VERSION } from "../config/runtime.ts";
import type { Queryable, Sql } from "../adapters/outbound/postgres/client.ts";
import { PostgresTransactionManager } from "../adapters/outbound/postgres/transaction_manager.ts";
import { PostgresAuthRepository } from "../adapters/outbound/postgres/auth_repository.ts";
import { PostgresProjectRepository } from "../adapters/outbound/postgres/project_repository.ts";
import { makeBootstrapService } from "../application/services/auth/bootstrap.ts";
import { makeAgentAuthService } from "../application/services/auth/agent.ts";
import {
  loadPasswordPolicy,
  makeHumanAuthService,
} from "../application/services/auth/human.ts";
import { makeProjectService } from "../application/services/projects/manage_projects.ts";
import { PostgresAuthorizationRepository } from "../adapters/outbound/postgres/authorization_repository.ts";
import { makeAuthorizationService } from "../application/services/authorization/manage_assignments.ts";
import { PostgresObjectReadBoundary } from "../adapters/outbound/postgres/object_read_boundary.ts";
import { PostgresObjectReader } from "../adapters/outbound/postgres/object_reader.ts";
import { HistoryCursorSigner } from "../domain/history/cursor.ts";
import { QueryCursorSigner } from "../domain/queries/cursor.ts";
import { canonicalSha256 } from "../domain/ids/canonical_json.ts";
import { makePostgresExpressionDefinitionPort } from "../adapters/outbound/postgres/repositories/expression_repository.ts";
import { err } from "../domain/errors/result.ts";
import { uuidV7 } from "../domain/ids/uuid_v7.ts";
import type { StageHookCoordinator } from "../domain/changesets/stage.ts";
import { makePostgresActionStageRepository } from "../adapters/outbound/postgres/repositories/action_stage_repository.ts";
import { makePostgresSeedStageRepository } from "../adapters/outbound/postgres/repositories/seed_stage_repository.ts";

import { makeInspectMetadataService } from "../application/services/inspect_metadata.ts";
import { makePackServices } from "../application/services/pack_services.ts";
import { makeQueryObjectsService } from "../application/services/query_objects.ts";
import { makeMigrationServices } from "../application/services/migration_services.ts";
import { makeProcessOutboxService } from "../application/services/process_outbox.ts";
import { makeSecretsService } from "../application/services/secrets/manage_secrets.ts";
import { makeHookSecretGrantService } from "../application/services/secrets/manage_grants.ts";
import { makeObjectReadService } from "../application/services/objects/read_objects.ts";
import { makeExpressionService } from "../application/services/queries/expressions.ts";
import { makeStageActionService } from "../application/services/actions/stage_actions.ts";
import { makeStageSeedsService } from "../application/services/seeds/stage_seeds.ts";

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
    persistence: makePostgresSecretLifecyclePersistence({
      sql: sql as Queryable,
      tx,
    }),
    authorization: authorizationRepository,
    cipher: makeEnvelopeSecretCipher(cryptoAdapter),
  });
  const hookSecretGrants = makeHookSecretGrantService({
    persistence: makePostgresHookSecretGrantPersistence({
      sql: sql as Queryable,
      tx,
      authorizeInTransaction: (lockedSql, auth, action) =>
        new PostgresAuthorizationRepository(lockedSql as Sql).authorize({
          auth,
          boundary: { type: "system" },
          action,
          resource: "system:hook-secret-grant",
        }),
    }),
    authorization: authorizationRepository,
  });
  const hookSecretRepository = new PostgresHookSecretRepository(
    sql,
    cryptoAdapter,
  );
  const stageHookCoordinator = options.stageHookCoordinator ??
    new TrustedStageHookCoordinator(
      makeHookSecretResolver(hookSecretRepository),
      new DenoHookExecutor(options.hookRunnerOptions),
    );
  const stageRepository = new PostgresStageRepository(
    sql,
    (transactionSql) => new PostgresAuthorizationRepository(transactionSql),
  );
  const stageChangesets = makeStageChangesetService(
    stageRepository,
    stageHookCoordinator,
  );
  const changesets = {
    ...stageChangesets,
    ...makeCommitChangesetService(new PostgresCommitRepository(sql), {
      lockTimeout: Deno.env.get("OPERANT_COMMIT_LOCK_TIMEOUT"),
      maximumLockTimeout: Deno.env.get("OPERANT_COMMIT_LOCK_TIMEOUT_MAX"),
    }),
  };
  const maximumHashes = Number(
    Deno.env.get("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES") ?? "4",
  );
  const authentication = new PostgresAuthRepository(
    sql,
    options.bootstrapToken,
    maximumHashes,
  );
  const passwordPolicy = loadPasswordPolicy(Deno.env);
  let historyCursors: HistoryCursorSigner | undefined;
  const authorization = makeAuthorizationService(authorizationRepository);
  const queryRepository = makePostgresQueryObjectRepository({ sql });
  const queryCursors = () => {
    const signer = QueryCursorSigner.fromEnvironment();
    return {
      shapeDigest: canonicalSha256,
      decode: signer.decode.bind(signer),
      encode: signer.encode.bind(signer),
    };
  };
  return {
    authentication,
    bootstrap: makeBootstrapService(authentication, passwordPolicy),
    humanAuth: makeHumanAuthService(authentication, passwordPolicy),
    agentAuth: makeAgentAuthService(authentication),
    projects: makeProjectService(new PostgresProjectRepository(sql)),
    authorization,
    metadata: makeInspectMetadataService({
      catalog: makePostgresMetadataRepository(sql),
      clock,
      version: OPERANT_VERSION,
      authorization: authorizationRepository,
    }),
    objectReads: makeObjectReadService({
      boundary: new PostgresObjectReadBoundary(sql, {
        reader: (lockedSql) => new PostgresObjectReader(lockedSql),
        authorization: (lockedSql) =>
          new PostgresAuthorizationRepository(lockedSql as Sql),
        policy: (lockedSql) => ({
          evaluate: (input, auth) =>
            evaluateObjectPolicy(
              lockedSql,
              { ...input, actions: [...input.actions] },
              auth,
            ),
        }),
      }),
      cursors: () => historyCursors ??= HistoryCursorSigner.fromEnvironment(),
    }),
    packs: makePackServices(
      yamlPackParser,
      makePostgresPackRepository({
        sql: sql as Queryable,
        tx,
      }),
      authorizationRepository,
    ),

    changesets,
    migrations: makeMigrationServices({
      persistence: makePostgresMigrationPersistence({
        sql: sql as Queryable,
        tx,
        authorizeApplyInTransaction: (lockedSql, auth) =>
          new PostgresAuthorizationRepository(lockedSql as Sql).authorize({
            auth,
            boundary: { type: "system" },
            action: "migration.apply",
            resource: "system:migration",
          }),
      }),
      authorization: authorizationRepository,
      retry: migrationRetryConfig(Deno.env),
      random: Math.random,
      sleep: (milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    }),

    hookSecretGrants,
    queries: makeQueryObjectsService(queryRepository, queryCursors),
    expressions: makeExpressionService(
      makePostgresExpressionDefinitionPort(sql as Queryable),
    ),
    outbox: makeProcessOutboxService({
      repository: makePostgresOutboxLifecyclePort(
        new PostgresOutboxRepository(
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
      ),
      authorization: authorizationRepository,
      catalog: makePostgresPinnedDeliveryHookCatalog(sql as Queryable),
      secrets: makePostgresDeliverySecretResolver(hookSecretRepository),
      hooks: makeDeliveryHookExecutor((secretValues) => {
        const runner = new DenoHookRunner({
          ...options.hookRunnerOptions,
          secretValues: { ...secretValues },
        });
        return {
          run: (hook, input) =>
            runner.run(hook as HookDefinition, input as HookEnvelope),
        };
      }),
      cursors: makeOutboxCursorPort(),
      config: loadOutboxConfig(Deno.env.toObject()),
      random: Math.random,
      now: () => new Date(),
      workerId: uuidV7(),
    }),
    secrets,
    actions: stageHookCoordinator instanceof TrustedStageHookCoordinator
      ? makeStageActionService(
        {
          ...makePostgresActionStageRepository(sql, changesets),
          executeHooks: (request) =>
            stageHookCoordinator.runActionStage(request),
        },
      )
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
    seeds: makeStageSeedsService(
      makePostgresSeedStageRepository(
        sql,
        changesets,
        authorizationRepository,
      ),
    ),
  };
}

function migrationRetryConfig(env: typeof Deno.env) {
  const jitterMinimumMs = boundedEnvironmentInteger(
    env.get("OPERANT_PACK_APPLY_RETRY_JITTER_MIN_MS"),
    1,
    0,
    1_000,
  );
  return {
    maximumRetries: boundedEnvironmentInteger(
      env.get("OPERANT_PACK_APPLY_MAX_RETRIES"),
      2,
      0,
      10,
    ),
    jitterMinimumMs,
    jitterMaximumMs: boundedEnvironmentInteger(
      env.get("OPERANT_PACK_APPLY_RETRY_JITTER_MAX_MS"),
      25,
      jitterMinimumMs,
      5_000,
    ),
  };
}

function boundedEnvironmentInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}
