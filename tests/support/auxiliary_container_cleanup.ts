export class AuxiliaryContainerCleanupError extends Error {
  constructor(readonly containerName: string, cause: unknown) {
    super(`failed to clean up auxiliary container ${containerName}`, { cause });
    this.name = "AuxiliaryContainerCleanupError";
  }
}

export async function runAuxiliaryContainerCases<
  T extends { readonly name: string },
>(
  cases: readonly T[],
  runCase: (definition: T) => Promise<void>,
  cleanup: (name: string) => Promise<void>,
): Promise<void> {
  const registered = new Set<string>();
  const cleanupFailures: AuxiliaryContainerCleanupError[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;

  const cleanRegistered = async (name: string): Promise<void> => {
    try {
      await cleanup(name);
      registered.delete(name);
    } catch (error) {
      cleanupFailures.push(new AuxiliaryContainerCleanupError(name, error));
    }
  };

  try {
    for (const definition of cases) {
      registered.add(definition.name);
      try {
        await runCase(definition);
      } finally {
        await cleanRegistered(definition.name);
      }
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    for (const name of [...registered]) {
      await cleanRegistered(name);
    }
  }

  if (hasPrimaryError) {
    if (cleanupFailures.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, ...cleanupFailures],
      "auxiliary container case and cleanup failed",
      { cause: primaryError },
    );
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "auxiliary container cleanup failed",
    );
  }
}
