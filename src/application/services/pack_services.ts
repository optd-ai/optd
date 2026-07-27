import type { MigrationPlan } from "../../domain/migrations/pack_migration.ts";

export type PackPreviewDto = {
  candidate: {
    reused: boolean;
    revision_count_before: number;
    revision_count_after: number;
  };
  pack: unknown;
  plan: MigrationPlan;
  active: false;
};
