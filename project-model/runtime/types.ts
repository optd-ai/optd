export const PROJECT_MODEL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PROJECT_MODEL_PATH = "project-model/model.json";
export const DEFAULT_FOCUS_SESSION_DIR = ".ai/model-sessions";

export type ModelMode = "candidate" | "authoritative";
export type ObjectType =
  | "workstream"
  | "intent"
  | "concept"
  | "evidence"
  | "assumption"
  | "question"
  | "tension"
  | "scenario"
  | "proposal"
  | "decision"
  | "commitment"
  | "discovery";

export type IntroducedBy =
  | "user"
  | "agent"
  | "repository"
  | "external"
  | "prototype"
  | "migration"
  | "execution";
export type Confidence = "low" | "medium" | "high";
export type RelationshipKind =
  | "supports"
  | "challenges"
  | "depends_on"
  | "addresses"
  | "derived_from"
  | "supersedes"
  | "affects"
  | "related_to";

export interface RepositoryScope {
  kind: "repository";
}
export interface WorkstreamScope {
  kind: "workstreams";
  workstreamIds: string[];
}
export type ModelScope = RepositoryScope | WorkstreamScope;

export interface ModelRelationship {
  kind: RelationshipKind;
  targetId: string;
  note?: string;
}

export interface AcceptanceReceipt {
  mode: "direct_direction" | "accepted_existing" | "migration_cutover";
  actor: "user";
  acceptedAt: string;
  contentHash: string;
  interactionRef?: string;
  batchRef?: string;
}

export interface ModelObjectBase {
  id: string;
  title: string;
  body: string;
  state: string;
  scope: ModelScope;
  introducedBy: IntroducedBy;
  sourceRefs: string[];
  relationships: ModelRelationship[];
  createdAt: string;
  updatedAt: string;
  acceptance?: AcceptanceReceipt;
  confidence?: Confidence;
  legacyIds?: string[];
}

export interface WorkstreamObject extends ModelObjectBase {
  state: "active" | "deferred" | "closed";
}

export interface IntentObject extends ModelObjectBase {
  kind: "outcome" | "priority" | "value" | "success_signal" | "non_goal";
  state: "proposed" | "accepted" | "superseded" | "retired";
}

export interface ConceptObject extends ModelObjectBase {
  state: "proposed" | "accepted" | "disputed" | "superseded" | "retired";
  aliases?: string[];
  examples?: string[];
  counterexamples?: string[];
}

export interface EvidenceObject extends ModelObjectBase {
  state: "current" | "stale" | "invalidated";
  confidence?: Confidence;
}

export interface AssumptionObject extends ModelObjectBase {
  state: "open" | "supported" | "challenged" | "invalidated" | "retired";
  confidence?: Confidence;
  impactIfWrong?: string;
  reviewWhen?: string;
}

export interface QuestionObject extends ModelObjectBase {
  kind: "uncertainty" | "tradeoff" | "contradiction" | "reconsideration";
  state: "open" | "answered" | "deferred" | "obsolete";
  answerObjectIds?: string[];
}

export interface TensionObject extends ModelObjectBase {
  state: "active" | "resolved" | "deferred" | "retired";
  poleObjectIds: string[];
  resolutionObjectIds?: string[];
}

export interface ScenarioObject extends ModelObjectBase {
  kind: "ordinary" | "boundary" | "failure" | "tradeoff" | "surprising";
  state: "proposed" | "accepted" | "invalidated" | "superseded" | "retired";
  context?: string;
  action?: string;
  expectedOutcome?: string;
}

export interface ProposalObject extends ModelObjectBase {
  state:
    | "candidate"
    | "recommended"
    | "selected"
    | "rejected"
    | "withdrawn"
    | "superseded";
  rationale?: string;
  tradeoffs?: string[];
}

export interface DecisionObject extends ModelObjectBase {
  state: "candidate" | "accepted" | "suspended" | "superseded" | "retired";
  rationale?: string;
  selectedProposalIds?: string[];
  resolvesQuestionIds?: string[];
}

export interface CommitmentObject extends ModelObjectBase {
  state:
    | "proposed"
    | "not_reviewed"
    | "accepted"
    | "rejected"
    | "suspended"
    | "superseded"
    | "retired";
  rationale?: string;
}

export interface DiscoveryObject extends ModelObjectBase {
  state:
    | "untriaged"
    | "investigating"
    | "integrated"
    | "dismissed"
    | "deferred";
  confidence?: Confidence;
  implications?: string;
  proposedFollowup?: string;
}

export type ModelObject =
  | WorkstreamObject
  | IntentObject
  | ConceptObject
  | EvidenceObject
  | AssumptionObject
  | QuestionObject
  | TensionObject
  | ScenarioObject
  | ProposalObject
  | DecisionObject
  | CommitmentObject
  | DiscoveryObject;

export interface CurrentUnderstanding {
  body: string;
  generatedAt: string;
  sourceObjects: Array<{ id: string; semanticHash?: string }>; // Historical digest is read-compatible, not consent.
}

export interface SpecProjectionSection {
  id: string;
  title: string;
  objectIds: string[];
}

export interface SpecProjectionView {
  id: string;
  kind: "spec" | "index" | "prototype_index";
  path: string;
  title: string;
  summary?: string;
  sections?: SpecProjectionSection[];
  childViewIds?: string[];
  manualLinks?: Array<{ path: string; title: string; summary?: string }>;
}

export type MigrationSourceDisposition =
  | "unreviewed"
  | "mapped"
  | "retained"
  | "omitted";
export type MigrationArtifactDisposition =
  | "unresolved"
  | "create_generated"
  | "replace_generated"
  | "retain_reference"
  | "retain_evidence"
  | "block";

export interface MigrationSourceRecord {
  path: string;
  kind: string;
  disposition: MigrationSourceDisposition;
  observedHash: string;
  reason?: string;
}

export interface MigrationArtifactRecord {
  path: string;
  disposition: MigrationArtifactDisposition;
  observedHash: string | null;
  generatedHash?: string;
  reason?: string;
}

export interface MigrationMetadata {
  schemaVersion: 1;
  focusId?: string; // Historical routing only.
  phase: "inventory" | "draft" | "ready";
  sources: MigrationSourceRecord[];
  artifacts: MigrationArtifactRecord[];
  blockers: string[];
  updatedAt: string;
}

export interface ProjectMetadata {
  id: string;
  title: string;
  revision: number;
  mode: ModelMode;
  createdAt: string;
  updatedAt: string;
  currentUnderstanding?: CurrentUnderstanding;
  migration?: MigrationMetadata;
  reviews?: ModelReview[];
  projections: { specs: SpecProjectionView[] };
}

export interface ProjectModel {
  schemaVersion: typeof PROJECT_MODEL_SCHEMA_VERSION;
  project: ProjectMetadata;
  workstreams: WorkstreamObject[];
  intents: IntentObject[];
  concepts: ConceptObject[];
  evidence: EvidenceObject[];
  assumptions: AssumptionObject[];
  questions: QuestionObject[];
  tensions: TensionObject[];
  scenarios: ScenarioObject[];
  proposals: ProposalObject[];
  decisions: DecisionObject[];
  commitments: CommitmentObject[];
  discoveries: DiscoveryObject[];
}

export type ModelCollectionName = Exclude<
  keyof ProjectModel,
  "schemaVersion" | "project"
>;

export interface PreviousReviewSnapshot {
  modelHash: string;
  projectionVersion: number;
  workstreamIds: string[];
  objects: Array<{ id: string; semanticHash: string; state: string }>;
  presentedAt: string;
}

export interface ReviewDirection {
  collection: ModelCollectionName;
  id?: string;
  newId?: string;
  key?: string;
  state?: string;
  value?: Partial<ModelObjectBase> & Record<string, unknown>;
}

export interface ReviewOption {
  id: string;
  label: string;
  description: string;
  objectId?: string;
  semanticHash?: string; // Legacy review cache identity only.
  recommended?: boolean;
  rationale?: string;
  direction?: ReviewDirection;
  directionValuePatch?: Record<string, unknown> | null;
}

export interface ReviewPoint {
  id: string;
  title: string;
  context: string;
  purpose: "awareness" | "decision";
  question?: string;
  objectRefs: Array<{ id: string; semanticHash?: string }>;
  options: ReviewOption[];
  rejectDirection?: ReviewDirection;
  rejectDirectionValuePatch?: Record<string, unknown> | null;
  deferDirection?: ReviewDirection;
  deferDirectionValuePatch?: Record<string, unknown> | null;
}

export interface ModelReviewContent {
  id: string;
  title: string;
  createdAt: string;
  points: ReviewPoint[];
  presentedAt?: string;
}

export interface ModelOperationScope {
  workstreamIds: string[];
  objectIds?: string[];
}

/** Independent review records share the model's atomic commit, never a selected singleton. */
export interface ModelReview extends ModelReviewContent {
  revision: number;
  scope: ModelOperationScope;
  modelRevision: number;
  status: "pending" | "resolved";
  outcomes: Array<
    {
      pointId: string;
      action: "accept" | "reject" | "modify" | "defer";
      optionId?: string;
      direction?: ReviewDirection;
      recordedAt: string;
    }
  >;
}

export interface FocusSession {
  schemaVersion: 1;
  id: string;
  title: string;
  seed?: string;
  workstreamIds: string[];
  createdAt: string;
  updatedAt: string;
  status: "active" | "suspended";
  previousReview?: PreviousReviewSnapshot;
  activeReview?: ModelReviewContent;
}
