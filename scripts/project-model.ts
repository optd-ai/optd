import { resolve } from "node:path";
import {
  normalizeModel,
  validateProjectModel,
} from "../project-model/runtime/model.ts";
import { SpecProjector } from "../project-model/runtime/projector.ts";
import type { ProjectModel } from "../project-model/runtime/types.ts";

/** Read-only: authority is reviewed elsewhere; this command cannot repair it. */
export async function checkProjectModel(root: string): Promise<number> {
  const input: ProjectModel = JSON.parse(
    await Deno.readTextFile(resolve(root, "project-model/model.json")),
  );
  const errors = validateProjectModel(input);
  if (input.project?.mode !== "authoritative") {
    errors.push("project.mode must be authoritative for repository checks");
  }
  if (errors.length) {
    throw new Error(`Invalid project model:\n- ${errors.join("\n- ")}`);
  }
  const result = await new SpecProjector(root).check(normalizeModel(input));
  if (result.driftPaths.length || result.stalePaths.length) {
    throw new Error(
      `Specification drift: ${
        result.driftPaths.join(", ")
      }\nStale generated specifications: ${result.stalePaths.join(", ")}`,
    );
  }
  return result.rendered.length;
}

if (import.meta.main) {
  if (
    Deno.args.length > 1 ||
    (Deno.args[0] !== undefined && Deno.args[0] !== "check")
  ) {
    console.error("Usage: deno task model:check (read-only)");
    Deno.exit(2);
  }
  try {
    const count = await checkProjectModel(resolve(import.meta.dirname!, ".."));
    console.log(
      `Project model and ${count} specifications: zero drift, zero stale paths (read-only).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
