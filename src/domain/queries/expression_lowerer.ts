export {
  ExpressionError as ExpressionLoweringError,
  type FieldSpec,
  type FieldType,
  type LoweredExpression as SqlLowerResult,
  lowerExpression,
  parseCel as parseWithBufCel,
} from "../expressions/cel.ts";

import { type ExpressionContext, lowerExpression } from "../expressions/cel.ts";

export type SqlLowerContext = ExpressionContext & {
  allowSelfAlias?: boolean;
};

export function lowerCelToSql(expression: string, context: SqlLowerContext) {
  return lowerExpression(expression, context);
}
