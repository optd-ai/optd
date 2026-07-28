// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertMatch } from "jsr:@std/assert";
import { dirname, relative, resolve } from "jsr:@std/path";

export type ApplicationAdapterEdge = Readonly<{
  importer: string;
  target: string;
  occurrence: number;
  replacements: readonly string[];
}>;

const edge = (
  importer: string,
  target: string,
  replacement: string | readonly string[],
  occurrence = 1,
): ApplicationAdapterEdge => ({
  importer,
  target,
  occurrence,
  replacements: typeof replacement === "string" ? [replacement] : replacement,
});

/** Frozen migration inventory. Chunk 2 removes every entry rather than ratcheting it. */
export const EXPECTED_APPLICATION_ADAPTER_EDGES:
  readonly ApplicationAdapterEdge[] = [
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/stage_repository.ts",
      "src/application/ports/stage_repository.ts#StageRepository",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/commit_repository.ts",
      "src/application/ports/commit_repository.ts#CommitRepository",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/outbox_repository.ts",
      "src/application/ports/repair/repositories.ts#OutboxRepository",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/deno-hooks/hook_runner.ts",
      "src/application/ports/repair/repositories.ts#HookExecutor",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/crypto/envelope.ts",
      "src/application/ports/repair/repositories.ts#SecretCipher",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/hook_secret_repository.ts",
      "src/application/ports/repair/repositories.ts#HookSecretResolver",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#TransactionPort",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/transaction_manager.ts",
      "src/application/ports/transaction_manager.ts#TransactionManager",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/auth_repository.ts",
      "src/application/ports/authentication.ts#AuthRepository",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/project_repository.ts",
      "src/application/ports/project_repository.ts#ProjectRepository",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/authorization_repository.ts",
      "src/application/ports/authorization.ts#AuthorizationRepository",
    ),
    edge(
      "src/application/app.ts",
      "src/adapters/outbound/postgres/object_read_boundary.ts",
      "src/application/ports/repair/repositories.ts#ReadSessionPort",
    ),
    edge(
      "src/application/ports/object_reader.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#ReadSessionPort",
    ),
    edge(
      "src/application/services/actions/stage_actions.ts",
      "src/adapters/outbound/postgres/client.ts",
      [
        "src/application/ports/repair/repositories.ts#ActionCatalog",
        "src/application/ports/repair/repositories.ts#ActionTargetReader",
        "src/application/ports/repair/repositories.ts#PinnedActionHookCatalog",
        "src/application/ports/repair/repositories.ts#ActionStageAuthorityPort",
        "src/application/ports/repair/repositories.ts#ActionPolicyAuthorizer",
        "src/application/ports/repair/repositories.ts#HookExecutionEvidenceRepository",
      ],
    ),
    edge(
      "src/application/services/actions/stage_actions.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/targeted_action.ts#TargetedPolicyEvaluator",
      2,
    ),
    edge(
      "src/application/services/actions/stage_actions.ts",
      "src/adapters/outbound/postgres/object_read_boundary.ts",
      "src/application/ports/repair/repositories.ts#ReadSessionPort",
    ),
    edge(
      "src/application/services/changeset_services.ts",
      "src/adapters/outbound/postgres/client.ts",
      [
        "src/application/ports/repair/repositories.ts#DefinitionCatalog",
        "src/application/ports/repair/repositories.ts#ChangesetFactRepository",
        "src/application/ports/repair/repositories.ts#QueryPolicyRepository",
      ],
    ),
    edge(
      "src/application/services/changeset_services.ts",
      "src/adapters/outbound/deno-hooks/hook_runner.ts",
      "src/application/ports/repair/repositories.ts#HookExecutor",
    ),
    edge(
      "src/application/services/hooks/stage_hook_coordinator.ts",
      "src/adapters/outbound/deno-hooks/hook_runner.ts",
      "src/application/ports/repair/repositories.ts#HookExecutor",
    ),
    edge(
      "src/application/services/hooks/stage_hook_coordinator.ts",
      "src/adapters/outbound/postgres/hook_secret_repository.ts",
      "src/application/ports/repair/repositories.ts#HookSecretResolver",
    ),
    edge(
      "src/application/services/inspect_metadata.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#MetadataCatalog",
    ),
    edge(
      "src/application/services/inspect_metadata.ts",
      "src/adapters/outbound/postgres/pack_repository.ts",
      "src/application/ports/repair/repositories.ts#PackCatalog",
    ),
    edge(
      "src/application/services/manage_secret.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#SecretRepository",
    ),
    edge(
      "src/application/services/manage_secret.ts",
      "src/adapters/outbound/crypto/envelope.ts",
      "src/application/ports/repair/repositories.ts#SecretCipher",
    ),
    edge(
      "src/application/services/migration_services.ts",
      "src/adapters/outbound/postgres/pack_migration_repository.ts",
      "src/application/ports/repair/repositories.ts#MigrationRepository",
    ),
    edge(
      "src/application/services/migration_services.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#TransactionPort",
    ),
    edge(
      "src/application/services/pack_services.ts",
      "src/adapters/outbound/yaml/pack_loader.ts",
      "src/application/ports/repair/repositories.ts#PackParser",
    ),
    edge(
      "src/application/services/pack_services.ts",
      "src/adapters/outbound/postgres/pack_repository.ts",
      "src/application/ports/repair/repositories.ts#PackCatalog",
    ),
    edge(
      "src/application/services/pack_services.ts",
      "src/adapters/outbound/postgres/pack_migration_repository.ts",
      "src/application/ports/repair/repositories.ts#MigrationRepository",
    ),
    edge(
      "src/application/services/pack_services.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#TransactionPort",
    ),
    edge(
      "src/application/services/process_outbox.ts",
      "src/adapters/outbound/deno-hooks/hook_runner.ts",
      "src/application/ports/repair/repositories.ts#HookExecutor",
    ),
    edge(
      "src/application/services/process_outbox.ts",
      "src/adapters/outbound/postgres/outbox_repository.ts",
      "src/application/ports/repair/repositories.ts#OutboxRepository",
    ),
    edge(
      "src/application/services/process_outbox.ts",
      "src/adapters/outbound/postgres/hook_secret_repository.ts",
      "src/application/ports/repair/repositories.ts#HookSecretResolver",
    ),
    edge(
      "src/application/services/process_outbox.ts",
      "src/adapters/outbound/postgres/client.ts",
      [
        "src/application/ports/repair/repositories.ts#TransactionPort",
        "src/application/ports/repair/repositories.ts#PinnedDeliveryHookCatalog",
      ],
    ),
    edge(
      "src/application/services/queries/expressions.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#DefinitionCatalog",
    ),
    edge(
      "src/application/services/query_objects.ts",
      "src/adapters/outbound/postgres/client.ts",
      [
        "src/application/ports/repair/repositories.ts#QueryObjectRepository",
        "src/application/ports/repair/repositories.ts#QueryPolicyRepository",
        "src/application/ports/repair/targeted_action.ts#TargetedPolicyEvaluator",
        "src/application/ports/repair/targeted_action.ts#TargetedAuthorityCutoff",
      ],
    ),
    edge(
      "src/application/services/query_objects.ts",
      "src/adapters/outbound/postgres/object_read_boundary.ts",
      "src/application/ports/repair/repositories.ts#ReadSessionPort",
    ),
    edge(
      "src/application/services/run_action.ts",
      "src/adapters/outbound/postgres/client.ts",
      [
        "src/application/ports/repair/repositories.ts#ActionCatalog",
        "src/application/ports/repair/repositories.ts#PinnedActionHookCatalog",
        "src/application/ports/repair/repositories.ts#ActionTargetReader",
        "src/application/ports/repair/repositories.ts#ActionPolicyAuthorizer",
        "src/application/ports/repair/repositories.ts#HookExecutionEvidenceRepository",
      ],
    ),
    edge(
      "src/application/services/run_action.ts",
      "src/adapters/outbound/deno-hooks/hook_runner.ts",
      "src/application/ports/repair/repositories.ts#HookExecutor",
    ),
    edge(
      "src/application/services/secrets/manage_grants.ts",
      "src/adapters/outbound/postgres/client.ts",
      [
        "src/application/ports/repair/repositories.ts#HookSecretGrantRepository",
        "src/application/ports/authorization.ts#AuthorizationRepository",
      ],
    ),
    edge(
      "src/application/services/secrets/manage_secrets.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#SecretRepository",
    ),
    edge(
      "src/application/services/secrets/manage_secrets.ts",
      "src/adapters/outbound/crypto/envelope.ts",
      "src/application/ports/repair/repositories.ts#SecretCipher",
    ),
    edge(
      "src/application/services/seeds/stage_seeds.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/seeds.ts#SeedCatalog",
    ),
    edge(
      "src/application/services/seeds/stage_seeds.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/seeds.ts#SeedReconciliationRepository",
      2,
    ),
    edge(
      "src/application/services/seeds/stage_seeds.ts",
      "src/adapters/outbound/postgres/authorization_repository.ts",
      "src/application/ports/authorization.ts#AuthorizationRepository",
    ),
  ];

export const EXPECTED_IMPORTER_CAPABILITIES: Readonly<
  Record<string, readonly string[]>
> = {
  "src/application/app.ts": [
    "compose_stage_commit_outbox",
    "compose_pinned_hook_executor",
    "compose_secret_cipher_and_grants",
    "compose_transactions",
    "compose_auth_projects_authorization",
    "compose_read_boundary",
  ],
  "src/application/ports/object_reader.ts": [
    "immutable_auth_and_address_input",
    "read_object_and_history",
    "authorization_root_anchor",
    "repeated_policy_evaluation_in_same_read_session",
  ],
  "src/application/services/actions/stage_actions.ts": [
    "load_action_definition_and_availability",
    "curated_resource_reads",
    "immutable_object_version_evidence",
    "ordered_pinned_stage_hooks",
    "target_policy_evaluation",
    "authority_lock_transaction_with_root_target_and_facts_digest",
    "post_hook_stage_persistence_against_frozen_cutoff",
  ],
  "src/application/services/changeset_services.ts": [
    "definition_catalog",
    "immutable_changeset_fact_persistence",
    "query_policy_cutoff",
    "pinned_hook_execution_and_evidence",
  ],
  "src/application/services/hooks/stage_hook_coordinator.ts": [
    "pinned_program_execution",
    "security_digest_secret_resolution",
    "immutable_secret_grant_evidence",
    "generic_hook_outputs_and_failure_evidence",
  ],
  "src/application/services/inspect_metadata.ts": [
    "metadata_inspection",
    "active_and_pinned_pack_revision",
  ],
  "src/application/services/manage_secret.ts": [
    "name_keyed_atomic_upsert_with_audit",
    "name_keyed_hard_delete_with_audit",
    "name_keyed_active_resolution",
    "row_version_aead",
  ],
  "src/application/services/migration_services.ts": [
    "plan_inspect_validate",
    "generated_sql",
    "atomic_apply",
    "durable_failed_and_retry_attempts",
    "authority_cutoff_transaction",
  ],
  "src/application/services/pack_services.ts": [
    "strict_pack_parse",
    "pack_revision_catalog",
    "migration_plan_and_apply",
    "atomic_pack_transaction",
  ],
  "src/application/services/process_outbox.ts": [
    "claim_complete_list_inspect_attempts",
    "operator_retry_cancel_drain_audit",
    "pinned_enabled_delivery_hook",
    "attachment_and_config_digest_verification",
    "security_digest_secret_grants",
    "event_after_commit_delivery_evidence",
    "operator_authority_transaction",
  ],
  "src/application/services/queries/expressions.ts": [
    "active_definition_schema",
  ],
  "src/application/services/query_objects.ts": [
    "query_view_history",
    "definition_role_policy_relationship_facts",
    "read_authority_lock",
    "target_policy_and_cutoff",
    "immutable_auth_address_and_root_anchor",
    "repeated_policy_evaluation_in_same_read_session",
  ],
  "src/application/services/run_action.ts": [
    "action_definition",
    "pinned_action_hook",
    "current_target_version",
    "target_policy_assertion",
    "action_stage_hook_execution_only",
    "immutable_stage_success_and_failure_evidence",
  ],
  "src/application/services/secrets/manage_grants.ts": [
    "grant_list_authorize",
    "lock_hook_slot_and_secret",
    "create_replace_revoke",
    "immutable_grant_audit",
  ],
  "src/application/services/secrets/manage_secrets.ts": [
    "secret_list_create_rotate_disable",
    "lock_and_active_resolution",
    "secret_audit_and_readiness",
    "row_version_aead",
  ],
  "src/application/services/seeds/stage_seeds.ts": [
    "active_definition_and_unique_key_catalog",
    "active_only_match",
    "freeze_and_revalidate_exact_object_version_id_presence",
    "ordinary_unique_conflict",
    "seed_authorization",
  ],
};

function canonical(path: string): string {
  return path.replaceAll("\\", "/");
}

async function applicationFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) files.push(...await applicationFiles(path));
    else if (entry.isFile && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.toSorted();
}

const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;

async function localImports(importer: string): Promise<string[]> {
  const source = await Deno.readTextFile(importer);
  return [...source.matchAll(importPattern)].map((match) => match[1]).filter(
    (specifier) => specifier.startsWith("."),
  ).map((specifier) =>
    canonical(relative(Deno.cwd(), resolve(dirname(importer), specifier)))
  );
}

async function actualEdges(): Promise<
  Omit<ApplicationAdapterEdge, "replacements">[]
> {
  const occurrences = new Map<string, number>();
  const result: Omit<ApplicationAdapterEdge, "replacements">[] = [];
  for (const importer of await applicationFiles("src/application")) {
    for (const target of await localImports(importer)) {
      if (!target.startsWith("src/adapters/")) continue;
      const key = `${importer}\0${target}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      result.push({ importer: canonical(importer), target, occurrence });
    }
  }
  return result;
}

async function transitiveAdapterPaths(): Promise<string[]> {
  const findings = new Set<string>();
  for (const root of await applicationFiles("src/application")) {
    const visit = async (
      file: string,
      path: readonly string[],
    ): Promise<void> => {
      if (path.includes(file)) return;
      for (const target of await localImports(file)) {
        const next = [...path, file, target];
        if (target.startsWith("src/adapters/")) {
          findings.add(next.join(" -> "));
          continue;
        }
        if (target.startsWith("src/") && target.endsWith(".ts")) {
          await visit(target, [...path, file]);
        }
      }
    };
    await visit(root, []);
  }
  return [...findings].toSorted();
}

Deno.test("application has zero direct or transitive adapter dependencies after the frozen migration", async () => {
  assertEquals(await actualEdges(), []);
  assertEquals(await transitiveAdapterPaths(), []);
  assertEquals(EXPECTED_APPLICATION_ADAPTER_EDGES.length, 45);
  for (const item of EXPECTED_APPLICATION_ADAPTER_EDGES) {
    for (const replacement of item.replacements) {
      assertMatch(replacement, /^src\/application\/ports\/.+#[A-Z]/);
    }
  }
});

Deno.test("application contains no concrete infrastructure implementation", async () => {
  const forbidden = [
    /\bDeno\.env\b/,
    /\bDeno\.(?:read|write|open|Command)\b/,
    /\bcrypto\.(?:randomUUID|subtle|getRandomValues)\b/,
    /\b(?:Queryable|quoteIdentifier|sqlBegin)\b/,
    /[`"']\s*(?:select|insert|update|delete|create|alter|drop)\s+/i,
  ];
  const findings: string[] = [];
  for (const file of await applicationFiles("src/application")) {
    const source = await Deno.readTextFile(file);
    for (const pattern of forbidden) {
      if (pattern.test(source)) findings.push(`${file}: ${pattern.source}`);
    }
  }
  assertEquals(findings, []);
});

Deno.test("every importing service freezes its complete semantic capability set", () => {
  const importers = [
    ...new Set(
      EXPECTED_APPLICATION_ADAPTER_EDGES.map(({ importer }) => importer),
    ),
  ].toSorted();
  assertEquals(
    Object.keys(EXPECTED_IMPORTER_CAPABILITIES).toSorted(),
    importers,
  );
  for (const importer of importers) {
    const capabilities = EXPECTED_IMPORTER_CAPABILITIES[importer];
    assertEquals(capabilities.length > 0, true, importer);
    assertEquals(new Set(capabilities).size, capabilities.length, importer);
  }
});

Deno.test("completed catalog and seed families keep orchestration inward", async () => {
  const seedApplication = await Deno.readTextFile(
    "src/application/services/seeds/stage_seeds.ts",
  );
  const seedAdapter = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/seed_stage_repository.ts",
  );
  const metadataApplication = await Deno.readTextFile(
    "src/application/services/inspect_metadata.ts",
  );
  const packApplication = await Deno.readTextFile(
    "src/application/services/pack_services.ts",
  );

  assertMatch(seedApplication, /validateSeedSelection/);
  assertMatch(seedApplication, /reconcileSeedRow/);
  assertEquals(seedAdapter.includes("reconcileSeedRow"), false);
  assertEquals(seedAdapter.includes("validateSeedSelection"), false);
  assertMatch(
    metadataApplication,
    /ports\/repair\/repositories\.ts/,
  );
  assertMatch(packApplication, /PackParser/);
});

Deno.test("action staging orchestration stays inward over granular capabilities", async () => {
  const application = await Deno.readTextFile(
    "src/application/services/actions/stage_actions.ts",
  );
  const adapter = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/action_stage_repository.ts",
  );

  assertMatch(application, /ActionCatalog/);
  assertMatch(application, /ActionTargetReader/);
  assertMatch(application, /PinnedActionHookCatalog/);
  assertMatch(application, /TargetedPolicyEvaluator/);
  assertMatch(application, /TargetedAuthorityCutoff/);
  assertMatch(application, /HookExecutionEvidenceRepository/);
  assertMatch(application, /lockAndEvaluate/);
  assertMatch(application, /executeHooks/);
  assertMatch(application, /port\.record/);
  assertEquals(application.includes("stageValidated"), false);
  assertEquals(adapter.includes("stageValidated"), false);
  assertEquals(adapter.includes("validateActionInput"), false);
  assertEquals(adapter.includes("resolveActionPolicyTargets"), false);
  assertEquals(adapter.includes("StageSource ="), false);
});

Deno.test("all frozen hook and action ports have production consumers and implementations", async () => {
  const application = await Promise.all([
    "src/application/services/actions/stage_actions.ts",
    "src/application/services/hooks/trusted_stage_hook_coordinator.ts",
  ].map((path) => Deno.readTextFile(path))).then((values) => values.join("\n"));
  const implementations = await Promise.all([
    "src/adapters/outbound/deno-hooks/trusted_stage_hook_adapter.ts",
    "src/adapters/outbound/postgres/repositories/action_stage_repository.ts",
    "src/composition/application.ts",
  ].map((path) => Deno.readTextFile(path))).then((values) => values.join("\n"));

  for (
    const port of [
      "HookExecutor",
      "HookSecretResolver",
      "TargetedPolicyEvaluator",
      "PinnedActionHookCatalog",
      "ActionTargetReader",
      "TargetedAuthorityCutoff",
      "HookExecutionEvidenceRepository",
    ]
  ) {
    assertMatch(application, new RegExp(`\\b${port}\\b`));
  }
  assertMatch(implementations, /DenoHookExecutor/);
  assertMatch(implementations, /makeHookSecretResolver/);
  assertMatch(implementations, /lockAndEvaluate/);
  assertMatch(implementations, /pinned/);
  assertMatch(implementations, /current/);
  assertMatch(implementations, /assertAllowed/);
  assertMatch(implementations, /record/);
  assertEquals(
    implementations.includes("TrustedStageHookCoordinator implements"),
    false,
  );
});

Deno.test("outbox orchestration stays inward over lifecycle capabilities", async () => {
  const application = await Deno.readTextFile(
    "src/application/services/process_outbox.ts",
  );
  const adapter = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/outbox_processing_repository.ts",
  );
  const composition = await Deno.readTextFile(
    "src/composition/application.ts",
  );

  assertMatch(application, /OutboxLifecyclePort/);
  assertMatch(application, /PinnedDeliveryHookCatalog/);
  assertMatch(application, /DeliverySecretResolver/);
  assertMatch(application, /DeliveryHookExecutor/);
  assertMatch(application, /processOne/);
  assertMatch(application, /retryDelayMs/);
  assertMatch(application, /parseDeliveryOutput/);
  assertMatch(application, /sanitizeOutboxAuthorizationResult/);
  assertEquals(application.includes("makeProcessOutboxService<T"), false);
  assertEquals(adapter.includes("processBatch"), false);
  assertEquals(adapter.includes("processOne"), false);
  assertEquals(adapter.includes("retryDelayMs"), false);
  assertEquals(adapter.includes("parseDeliveryOutput"), false);
  assertEquals(adapter.includes("makeProcessOutboxService"), false);
  assertMatch(composition, /makePostgresOutboxLifecyclePort/);
  assertMatch(composition, /makePostgresPinnedDeliveryHookCatalog/);
  assertMatch(composition, /makePostgresDeliverySecretResolver/);
  assertMatch(composition, /makeDenoDeliveryHookExecutor/);
});

Deno.test("composition owns concrete outbound adapter construction", async () => {
  const seed = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/seed_stage_repository.ts",
  );
  const objectRead = await Deno.readTextFile(
    "src/adapters/outbound/postgres/object_read_boundary.ts",
  );
  const outbox = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/outbox_processing_repository.ts",
  );
  const action = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/action_stage_repository.ts",
  );
  const stage = await Deno.readTextFile(
    "src/adapters/outbound/postgres/stage_repository.ts",
  );
  const composition = await Deno.readTextFile("src/composition/application.ts");

  assertEquals(seed.includes("PostgresAuthorizationRepository"), false);
  assertEquals(objectRead.includes("PostgresObjectReader"), false);
  assertEquals(objectRead.includes("PostgresAuthorizationRepository"), false);
  assertEquals(outbox.includes("PostgresOutboxRepository"), false);
  assertEquals(outbox.includes("PostgresHookSecretRepository"), false);
  assertEquals(action.includes("query_object_repository.ts"), false);
  assertEquals(stage.includes("query_object_repository.ts"), false);
  assertEquals(stage.includes("PostgresAuthorizationRepository"), false);
  assertMatch(action, /query_policy_sql\.ts/);
  assertMatch(stage, /query_policy_sql\.ts/);
  assertMatch(composition, /new PostgresObjectReader/);
  assertMatch(composition, /new PostgresOutboxRepository/);
  assertMatch(composition, /new PostgresHookSecretRepository/);
  assertMatch(composition, /new PostgresAuthorizationRepository/);
});

Deno.test("secret and grant orchestration stays inward over frozen lifecycle ports", async () => {
  const secretApplication = await Deno.readTextFile(
    "src/application/services/secrets/manage_secrets.ts",
  );
  const grantApplication = await Deno.readTextFile(
    "src/application/services/secrets/manage_grants.ts",
  );
  const secretAdapter = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/hook_secret_lifecycle_repository.ts",
  );
  const grantAdapter = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/hook_secret_grant_repository.ts",
  );
  const composition = await Deno.readTextFile("src/composition/application.ts");

  assertMatch(secretApplication, /SecretRepository/);
  assertMatch(secretApplication, /SecretCipher/);
  assertMatch(secretApplication, /validateMutation/);
  assertMatch(secretApplication, /authorization\.authorize/);
  assertMatch(secretApplication, /cipher\.encrypt/);
  assertMatch(secretApplication, /secretError/);
  assertMatch(grantApplication, /HookSecretGrantRepository/);
  assertMatch(grantApplication, /authorization\.authorize/);
  assertMatch(grantApplication, /HookSecretGrantPersistenceError/);
  assertEquals(secretApplication.includes("<T extends object>"), false);
  assertEquals(grantApplication.includes("<T extends object>"), false);
  assertEquals(secretAdapter.includes("validateMutation"), false);
  assertEquals(secretAdapter.includes("authorization.authorize"), false);
  assertEquals(secretAdapter.includes("EnvelopeCrypto()"), false);
  assertEquals(grantAdapter.includes("function invalid"), false);
  assertEquals(grantAdapter.includes("function grantError"), false);
  assertEquals(grantAdapter.includes("authorization.authorize"), false);
  assertMatch(composition, /makeEnvelopeSecretCipher/);
  assertMatch(composition, /makePostgresSecretLifecyclePersistence/);
  assertMatch(composition, /makePostgresHookSecretGrantPersistence/);
});

Deno.test("query orchestration owns same-session definition-aware decisions", async () => {
  const application = await Deno.readTextFile(
    "src/application/services/query_objects.ts",
  );
  const adapter = await Deno.readTextFile(
    "src/adapters/outbound/postgres/repositories/query_object_repository.ts",
  );
  const composition = await Deno.readTextFile("src/composition/application.ts");

  assertMatch(application, /QueryObjectRepository/);
  assertMatch(application, /QueryPolicyRepository/);
  assertMatch(application, /QueryReadSessionPort/);
  assertMatch(application, /resolveFields/);
  assertMatch(application, /resolveSort/);
  assertMatch(application, /QueryRepositoryError/);
  assertMatch(application, /queryRowDto/);
  assertMatch(application, /resolved_fields/);
  assertEquals(application.includes("<T extends object>"), false);
  assertEquals(adapter.includes("validationError"), false);
  assertEquals(adapter.includes("Result<QueryResponse>"), false);
  assertEquals(adapter.includes("resolveFields"), false);
  assertEquals(adapter.includes("resolveSort"), false);
  assertMatch(composition, /makeQueryObjectsService\(queryRepository\)/);
});

Deno.test("read/query/changeset/pack frozen ports have real consumers and adapters", async () => {
  const sources = await Promise.all([
    "src/application/services/queries/expressions.ts",
    "src/adapters/outbound/postgres/repositories/expression_repository.ts",
    "src/application/ports/object_reader.ts",
    "src/adapters/outbound/postgres/object_read_boundary.ts",
    "src/application/ports/authorization.ts",
    "src/adapters/outbound/postgres/authorization_repository.ts",
    "src/application/services/query_objects.ts",
    "src/adapters/outbound/postgres/repositories/query_object_repository.ts",
    "src/application/ports/stage_repository.ts",
    "src/adapters/outbound/postgres/stage_repository.ts",
    "src/application/services/pack_services.ts",
    "src/adapters/outbound/postgres/repositories/pack_application_repository.ts",
  ].map((path) => Deno.readTextFile(path)));

  const expected = [
    /DefinitionCatalog/,
    /ExpressionDefinitionPort/,
    /ObjectReaderPort/,
    /ObjectReader/,
    /AuthorizationReaderPort/,
    /AuthorizationRepository/,
    /QueryPolicyRepository/,
    /QueryReadSessionPort/,
    /ChangesetFactRepository/,
    /StageRepository/,
    /PackCatalog/,
    /PackPreviewPersistence/,
  ];
  expected.forEach((pattern, index) => assertMatch(sources[index], pattern));
});

Deno.test("high-surface concrete imports map to complete semantic ports", () => {
  const replacements = (importer: string, target: string) =>
    EXPECTED_APPLICATION_ADAPTER_EDGES.find((edge) =>
      edge.importer === importer && edge.target === target
    )?.replacements;

  assertEquals(
    replacements(
      "src/application/services/actions/stage_actions.ts",
      "src/adapters/outbound/postgres/client.ts",
    ),
    [
      "src/application/ports/repair/repositories.ts#ActionCatalog",
      "src/application/ports/repair/repositories.ts#ActionTargetReader",
      "src/application/ports/repair/repositories.ts#PinnedActionHookCatalog",
      "src/application/ports/repair/repositories.ts#ActionStageAuthorityPort",
      "src/application/ports/repair/repositories.ts#ActionPolicyAuthorizer",
      "src/application/ports/repair/repositories.ts#HookExecutionEvidenceRepository",
    ],
  );
  assertEquals(
    replacements(
      "src/application/services/process_outbox.ts",
      "src/adapters/outbound/postgres/outbox_repository.ts",
    ),
    ["src/application/ports/repair/repositories.ts#OutboxRepository"],
  );
  assertEquals(
    replacements(
      "src/application/services/process_outbox.ts",
      "src/adapters/outbound/postgres/client.ts",
    ),
    [
      "src/application/ports/repair/repositories.ts#TransactionPort",
      "src/application/ports/repair/repositories.ts#PinnedDeliveryHookCatalog",
    ],
  );
  assertEquals(
    replacements(
      "src/application/services/run_action.ts",
      "src/adapters/outbound/postgres/client.ts",
    ),
    [
      "src/application/ports/repair/repositories.ts#ActionCatalog",
      "src/application/ports/repair/repositories.ts#PinnedActionHookCatalog",
      "src/application/ports/repair/repositories.ts#ActionTargetReader",
      "src/application/ports/repair/repositories.ts#ActionPolicyAuthorizer",
      "src/application/ports/repair/repositories.ts#HookExecutionEvidenceRepository",
    ],
  );
  assertEquals(
    replacements(
      "src/application/services/migration_services.ts",
      "src/adapters/outbound/postgres/pack_migration_repository.ts",
    ),
    ["src/application/ports/repair/repositories.ts#MigrationRepository"],
  );
});
