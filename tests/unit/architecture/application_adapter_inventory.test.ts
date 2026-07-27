import { assertEquals, assertMatch } from "jsr:@std/assert";
import { dirname, relative, resolve } from "jsr:@std/path";

export type ApplicationAdapterEdge = Readonly<{
  importer: string;
  target: string;
  occurrence: number;
  replacement: string;
}>;

const edge = (
  importer: string,
  target: string,
  replacement: string,
  occurrence = 1,
): ApplicationAdapterEdge => ({ importer, target, occurrence, replacement });

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
      "src/application/ports/repair/repositories.ts#ActionCatalog",
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
      "src/application/ports/repair/repositories.ts#DefinitionCatalog",
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
      "src/application/ports/repair/repositories.ts#TransactionPort",
    ),
    edge(
      "src/application/services/queries/expressions.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#DefinitionCatalog",
    ),
    edge(
      "src/application/services/query_objects.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#QueryObjectRepository",
    ),
    edge(
      "src/application/services/query_objects.ts",
      "src/adapters/outbound/postgres/object_read_boundary.ts",
      "src/application/ports/repair/repositories.ts#ReadSessionPort",
    ),
    edge(
      "src/application/services/run_action.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#ActionCatalog",
    ),
    edge(
      "src/application/services/run_action.ts",
      "src/adapters/outbound/deno-hooks/hook_runner.ts",
      "src/application/ports/repair/repositories.ts#HookExecutor",
    ),
    edge(
      "src/application/services/secrets/manage_grants.ts",
      "src/adapters/outbound/postgres/client.ts",
      "src/application/ports/repair/repositories.ts#HookSecretGrantRepository",
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

async function actualEdges(): Promise<
  Omit<ApplicationAdapterEdge, "replacement">[]
> {
  const occurrences = new Map<string, number>();
  const result: Omit<ApplicationAdapterEdge, "replacement">[] = [];
  const importPattern =
    /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
  for (const importer of await applicationFiles("src/application")) {
    const source = await Deno.readTextFile(importer);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = canonical(
        relative(Deno.cwd(), resolve(dirname(importer), specifier)),
      );
      if (!target.startsWith("src/adapters/")) continue;
      const key = `${importer}\0${target}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      result.push({ importer: canonical(importer), target, occurrence });
    }
  }
  return result;
}

Deno.test("application adapter inventory exactly matches the frozen migration set", async () => {
  const expected = EXPECTED_APPLICATION_ADAPTER_EDGES.map(
    ({ importer, target, occurrence }) => ({ importer, target, occurrence }),
  );
  assertEquals(await actualEdges(), expected);
  assertEquals(EXPECTED_APPLICATION_ADAPTER_EDGES.length, 45);
  for (const item of EXPECTED_APPLICATION_ADAPTER_EDGES) {
    assertMatch(item.replacement, /^src\/application\/ports\/.+#[A-Z]/);
  }
});
