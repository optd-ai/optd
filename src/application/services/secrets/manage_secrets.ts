/** Application-owned orchestration boundary over a typed outbound port. */
export function makeSecretsService<T extends object>(secrets: T): T {
  return Object.freeze(secrets);
}
