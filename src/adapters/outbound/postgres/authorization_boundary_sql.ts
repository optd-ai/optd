export function authorizationBoundaryPredicate(
  alias: string,
  boundaryParameter: string,
  projectParameter: string,
): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) {
    throw new Error("invalid authorization boundary SQL alias");
  }
  if (!/^\$\d+$/.test(boundaryParameter) || !/^\$\d+$/.test(projectParameter)) {
    throw new Error("authorization boundary SQL parameters must be positional");
  }
  return `(${alias}.boundary_type=${boundaryParameter} and ${alias}.project_id is not distinct from ${projectParameter}::uuid or ${boundaryParameter}='project' and ${alias}.boundary_type='all_projects')`;
}
