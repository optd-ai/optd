import { parse } from "npm:yaml";
import { validatePackFile } from "./typebox-spike.ts";

type PackFile = { path: string; text: string };

const allowed =
  /^(pack\.yaml|resources\/[a-z_][a-z0-9_]*\.yaml|hooks\/[a-z_][a-z0-9_]*\.yaml|policies\/[a-z_][a-z0-9_]*\.yaml)$/;

export function validatePackYamlFiles(files: PackFile[]) {
  const normalized: Record<string, unknown> = {};
  const errors: unknown[] = [];
  for (const file of files) {
    if (!allowed.test(file.path)) {
      errors.push({
        code: "unexpected_pack_path",
        path: file.path,
        message: "unexpected pack path",
      });
      continue;
    }
    let value: unknown;
    try {
      value = parse(file.text, { merge: true });
      normalized[file.path] = value;
    } catch (error) {
      errors.push({
        code: "yaml_parse_failed",
        path: file.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const validation = validatePackFile(file.path, value);
    if (!validation.ok) errors.push(...validation.errors);
  }
  return {
    ok: errors.length === 0,
    normalized: canonicalize(normalized),
    errors,
  };
}

function canonicalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
