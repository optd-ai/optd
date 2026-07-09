import { validatePackYamlFiles } from "../typebox/pack-yaml-validation-spike.ts";

type File = { path: string; text: string };

export function diffValidatedPacks(currentFiles: File[], nextFiles: File[]) {
  const current = validatePackYamlFiles(currentFiles);
  const next = validatePackYamlFiles(nextFiles);
  if (!current.ok || !next.ok) {
    return { ok: false, errors: [...current.errors, ...next.errors] };
  }
  const currentResources = resources(
    current.normalized as Record<string, unknown>,
  );
  const nextResources = resources(next.normalized as Record<string, unknown>);
  const issues = [];
  for (const [name, spec] of Object.entries(nextResources)) {
    if (!currentResources[name]) {
      issues.push({
        type: "add_resource",
        class: "safe",
        status: "ready",
        resource: name,
      });
    } else {
      const oldFields = (currentResources[name] as any).spec.fields ?? {};
      const newFields = (spec as any).spec.fields ?? {};
      for (const [field, fieldSpec] of Object.entries(newFields as any)) {
        if (!oldFields[field]) {
          issues.push({
            type: (fieldSpec as any).required
              ? "add_required_field"
              : "add_field",
            class: (fieldSpec as any).required ? "risky" : "safe",
            status: (fieldSpec as any).required ? "blocked" : "ready",
            resource: name,
            field,
          });
        } else if (oldFields[field].type !== (fieldSpec as any).type) {
          issues.push({
            type: "change_field_type",
            class: "destructive",
            status: "blocked",
            resource: name,
            field,
          });
        }
      }
      for (const field of Object.keys(oldFields)) {
        if (!newFields[field]) {
          issues.push({
            type: "remove_field",
            class: "destructive",
            status: "staged",
            resource: name,
            field,
          });
        }
      }
    }
  }
  for (const name of Object.keys(currentResources)) {
    if (!nextResources[name]) {
      issues.push({
        type: "remove_resource",
        class: "destructive",
        status: "staged",
        resource: name,
      });
    }
  }
  return {
    ok: true,
    issues,
    sql: issues.filter((i) => i.type === "add_field").map((i) =>
      `alter table "res_${i.resource}" add column "${i.field}" text;`
    ),
  };
}

function resources(normalized: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(normalized).filter(([path]) => path.startsWith("resources/"))
      .map(([, doc]: any) => [doc.metadata.name, doc]),
  );
}
