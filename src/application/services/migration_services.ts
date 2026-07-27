/** Application-owned orchestration boundary over a typed outbound port. */
export function makeMigrationServices<T extends object>(migrations: T): T {
  return Object.freeze(migrations);
}
