/** Application-owned orchestration boundary over a typed outbound port. */
export function makeObjectReadService<T extends object>(objects: T): T {
  return Object.freeze(objects);
}
