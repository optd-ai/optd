/** Application-owned orchestration boundary over a typed outbound port. */
export function makeHookSecretGrantService<T extends object>(grants: T): T {
  return Object.freeze(grants);
}
