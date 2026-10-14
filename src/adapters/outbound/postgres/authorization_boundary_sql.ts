export function authorizationBoundaryPredicate(
  alias: string,
  boundaryParameter: string,
  workspaceParameter: string,
): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) {
    throw new Error("invalid authorization boundary SQL alias");
  }
  if (
    !/^\$\d+$/.test(boundaryParameter) || !/^\$\d+$/.test(workspaceParameter)
  ) {
    throw new Error("authorization boundary SQL parameters must be positional");
  }
  return `(${alias}.boundary_type=${boundaryParameter} and ${alias}.workspace_id is not distinct from ${workspaceParameter}::uuid or ${boundaryParameter}='workspace' and ${alias}.boundary_type='all_workspaces')`;
}
