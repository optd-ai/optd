/** Application-owned orchestration boundary over a typed outbound port. */
export function makeExpressionService<T extends object>(expressions: T): T {
  return Object.freeze(expressions);
}
