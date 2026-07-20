import { query, type Queryable } from "./client.ts";
import { canonicalSha256 } from "../../../domain/ids/canonical_json.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export type PlatformMigration = {
  id: string;
  sql: string;
  migrate?: (sql: Queryable) => Promise<void>;
  applicationChecksum?: string;
  finalSql?: string;
};

export type MigrationApplyResult = {
  applied: string[];
};

export type MigrationStatus = {
  ok: boolean;
  appliedCount: number;
  latestId: string | null;
};

export const platformMigrations: PlatformMigration[] = [
  {
    id: "1000_platform_core",
    sql: `
      create table if not exists platform_kv (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )
    `,
  },
  {
    id: "1001_pack_registry",
    sql: `
      create table if not exists pack_revisions (
        revision text primary key,
        namespace text not null,
        name text not null,
        version text not null,
        active boolean not null,
        manifest jsonb not null,
        normalized jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists pack_revisions_active_idx on pack_revisions(namespace, name, active);
      create table if not exists pack_source_files (
        revision text not null references pack_revisions(revision) on delete cascade,
        path text not null,
        digest text not null,
        kind text not null,
        content text not null,
        primary key(revision, path)
      );
      create table if not exists resource_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists relationship_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists lifecycle_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists action_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists hook_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        script_path text not null,
        script_digest text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists policy_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists seed_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        resource text not null,
        key_field text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      )
    `,
  },
  {
    id: "1002_generated_sql_objects",
    sql: `
      create table if not exists generated_sql_objects (
        revision text not null references pack_revisions(revision) on delete cascade,
        kind text not null check (kind in ('resource_table', 'relationship_table')),
        namespace text not null,
        name text not null,
        table_name text not null,
        ddl text not null,
        created_at timestamptz not null default now(),
        primary key(revision, kind, namespace, name)
      );
      create index if not exists generated_sql_objects_table_name_idx on generated_sql_objects(table_name)
    `,
  },
  {
    id: "1003_changesets_history_events_comments",
    sql: `
      create table if not exists changesets (
        id text primary key,
        actor_id text not null,
        status text not null check (status in ('previewed', 'committed')),
        request_json jsonb not null,
        preview_json jsonb not null default '{}'::jsonb,
        idempotency_key text,
        source text,
        committed_at timestamptz,
        created_at timestamptz not null default now(),
        unique(actor_id, idempotency_key)
      );
      create table if not exists object_versions (
        id text primary key,
        resource text not null,
        object_id text not null,
        version integer not null,
        previous_version_id text null references object_versions(id),
        changeset_id text not null references changesets(id),
        operation text not null,
        resource_revision text not null,
        snapshot_json jsonb not null,
        changed_fields text[] not null default '{}',
        actor_id text not null,
        created_at timestamptz not null default now(),
        unique(resource, object_id, version)
      );
      create table if not exists audit_events (
        id text primary key,
        changeset_id text null references changesets(id),
        object_version_id text null references object_versions(id),
        actor_id text not null,
        event_type text not null,
        resource text null,
        object_id text null,
        action text null,
        decision text null,
        policy_summary_json jsonb null,
        validation_summary_json jsonb null,
        hook_execution_ids text[] not null default '{}',
        request_metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create table if not exists events (
        id text primary key,
        changeset_id text not null references changesets(id),
        object_version_id text null references object_versions(id),
        event_type text not null,
        resource text null,
        object_id text null,
        occurred_at timestamptz not null default now(),
        payload_json jsonb not null default '{}'::jsonb
      );
      create table if not exists comments (
        id text primary key,
        resource text not null,
        object_id text not null,
        changeset_id text not null references changesets(id),
        object_version_id text null references object_versions(id),
        actor_id text not null,
        body text not null,
        created_at timestamptz not null default now()
      );
      create index if not exists object_versions_object_idx on object_versions(resource, object_id, version desc);
      create index if not exists audit_events_object_idx on audit_events(resource, object_id, created_at desc);
      create index if not exists events_object_idx on events(resource, object_id, occurred_at desc);
      create index if not exists comments_object_idx on comments(resource, object_id, created_at desc)
    `,
  },
  {
    id: "1004_hooks_outbox",
    sql: `
      create table if not exists hook_executions (
        id text primary key,
        hook text not null,
        phase text not null,
        revision text not null,
        script_digest text not null,
        actor_id text not null,
        status text not null check (status in ('succeeded','failed')),
        duration_ms integer not null,
        exit_code integer null,
        logs text not null default '',
        result_json jsonb null,
        error_json jsonb null,
        created_at timestamptz not null default now()
      );
      create table if not exists outbox (
        id text primary key,
        hook text not null,
        phase text not null,
        status text not null default 'pending' check (status in ('pending','running','succeeded','failed','dead_letter')),
        attempts integer not null default 0,
        available_at timestamptz not null default now(),
        locked_by text null,
        locked_at timestamptz null,
        last_error text null,
        payload_json jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists outbox_status_available_idx on outbox(status, available_at);
      create index if not exists hook_executions_hook_idx on hook_executions(hook, created_at desc)
    `,
  },
  {
    id: "1005_pack_migration_plans",
    sql: `
      create table if not exists pack_migration_plans (
        id text primary key,
        namespace text not null,
        name text not null,
        from_revision text not null references pack_revisions(revision),
        to_revision text not null,
        status text not null,
        plan_digest text not null,
        candidate_normalized jsonb not null,
        candidate_manifest jsonb not null,
        candidate_source_files jsonb not null,
        plan_json jsonb not null,
        sql_preview jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists pack_migration_plans_pack_idx on pack_migration_plans(namespace, name, created_at desc);
      create index if not exists pack_migration_plans_digest_idx on pack_migration_plans(plan_digest)
    `,
  },
  {
    id: "1006_durable_outbox_lifecycle",
    sql: `
      alter table outbox add column if not exists event_id text null references events(id);
      alter table outbox add column if not exists hook_revision text null;
      alter table outbox add column if not exists script_digest text null;
      alter table outbox add column if not exists envelope_json jsonb not null default '{}'::jsonb;
      alter table outbox add column if not exists updated_at timestamptz not null default now();
      create index if not exists outbox_claim_idx on outbox(status, available_at, created_at, id);
      create index if not exists outbox_event_idx on outbox(event_id);
      create index if not exists hook_executions_hook_phase_idx on hook_executions(hook, phase, created_at desc)
    `,
  },
  {
    id: "1007_platform_secrets",
    sql: `
      create table if not exists platform_secrets(
        name text primary key,
        description text,
        ciphertext bytea not null,
        nonce bytea not null,
        algorithm text not null,
        key_id text not null,
        created_by text not null,
        updated_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists platform_secrets_updated_at_idx on platform_secrets(updated_at desc)
    `,
  },
  {
    id: "1008_authentication_projects",
    sql: `
      create table principals (
        id uuid primary key,
        type text not null check (type in ('human_user', 'agent_user', 'system')),
        active boolean not null,
        created_at timestamptz not null default now()
      );
      create table human_users (
        id uuid primary key,
        principal_id uuid not null unique references principals(id),
        username text not null unique,
        display_name text not null,
        status text not null check (status in ('active', 'disabled')),
        created_at timestamptz not null default now()
      );
      create table password_credentials (
        human_user_id uuid primary key references human_users(id),
        profile text not null,
        phc_hash text not null,
        password_changed_at timestamptz not null default now()
      );
      create table system_roles (
        id text primary key,
        display_name text not null,
        active boolean not null
      );
      insert into system_roles(id, display_name, active) values
        ('system:super_admin', 'Super Administrator', true),
        ('system:admin', 'Administrator', true);
      create table role_assignments (
        id uuid primary key,
        principal_id uuid not null references principals(id),
        role_id text not null references system_roles(id),
        boundary_type text not null check (boundary_type in ('system', 'all_projects', 'project')),
        project_id uuid,
        active boolean not null,
        created_at timestamptz not null default now(),
        check ((boundary_type = 'project') = (project_id is not null))
      );
      create table auth_sessions (
        id uuid primary key,
        principal_id uuid not null references principals(id),
        human_user_id uuid not null references human_users(id),
        credential_kind text not null check (credential_kind in ('human_full', 'authorization_request')),
        token_digest text not null unique,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );
      create table auth_contexts (
        id uuid primary key,
        principal_id uuid not null references principals(id),
        human_user_id uuid not null references human_users(id),
        session_id uuid not null references auth_sessions(id),
        credential_kind text not null,
        roles text[] not null,
        created_at timestamptz not null
      );
      create function reject_auth_context_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'auth contexts are immutable';
      end
      $$;
      create trigger auth_contexts_immutable
        before update or delete on auth_contexts
        for each row execute function reject_auth_context_mutation();
      create table bootstrap_state (
        singleton boolean primary key check (singleton),
        token_digest text,
        completed boolean not null,
        completed_at timestamptz,
        completed_by_human_user_id uuid references human_users(id),
        updated_at timestamptz not null default now()
      );
      create table projects (
        id uuid primary key,
        slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{0,62}$'),
        display_name text not null,
        description text,
        status text not null default 'active' check (status in ('active', 'archived')),
        version bigint not null default 1,
        created_by_auth_context_id uuid not null references auth_contexts(id),
        updated_by_auth_context_id uuid not null references auth_contexts(id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        archived_at timestamptz
      );
      alter table role_assignments add constraint role_assignments_project_fk foreign key(project_id) references projects(id);
      create table auth_audit_events (
        id uuid primary key,
        event_type text not null check (event_type in (
          'auth.bootstrap.completed',
          'auth.human_user.created',
          'auth.role_assignment.created',
          'auth.session.created'
        )),
        auth_context_id uuid references auth_contexts(id),
        principal_id uuid references principals(id),
        human_user_id uuid references human_users(id),
        session_id uuid references auth_sessions(id),
        role_assignment_id uuid references role_assignments(id),
        role_id text references system_roles(id),
        credential_kind text,
        boundary_type text,
        details jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create function reject_auth_audit_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'auth audit events are immutable';
      end
      $$;
      create trigger auth_audit_events_immutable
        before update or delete on auth_audit_events
        for each row execute function reject_auth_audit_mutation();
      create table project_audit_events (
        id uuid primary key,
        auth_context_id uuid not null references auth_contexts(id),
        project_id uuid references projects(id),
        action text not null check (action in ('project.read', 'project.create', 'project.update', 'project.archive')),
        decision text not null check (decision in ('allowed', 'denied')),
        details jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index auth_sessions_token_digest_idx on auth_sessions(token_digest) where revoked_at is null;
      create index projects_status_slug_idx on projects(status, slug);
      create index auth_audit_human_idx on auth_audit_events(human_user_id, created_at);
      create index auth_audit_session_idx on auth_audit_events(session_id, created_at);
      create index project_audit_context_idx on project_audit_events(auth_context_id, created_at)
    `,
  },
  {
    id: "1009_human_auth_recovery",
    sql: `
      alter table human_users add column disabled_at timestamptz;
      create table login_throttles (
        username text primary key,
        failure_count integer not null default 0,
        next_allowed_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create table password_reset_requests (
        id text primary key,
        human_user_id uuid references human_users(id),
        username text not null,
        idempotency_key text not null,
        nonce_digest text not null,
        capability_digest text,
        status text not null check(status in ('pending','approved','denied','cancelled','completed','expired')),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        decided_by_auth_context_id uuid references auth_contexts(id),
        decided_at timestamptz,
        redeemed_at timestamptz,
        completed_at timestamptz,
        unique(username,idempotency_key)
      );
      create table recovery_challenges (
        id uuid primary key,
        human_user_id uuid not null references human_users(id),
        token_digest text,
        enable_user boolean not null,
        restore_super_admin boolean not null,
        status text not null check(status in ('active','completed','cancelled','expired')),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        completed_at timestamptz,
        cancelled_at timestamptz,
        expired_at timestamptz
      );
      alter table auth_audit_events drop constraint auth_audit_events_event_type_check;
      alter table auth_audit_events add constraint auth_audit_events_event_type_check check(event_type in (
        'auth.bootstrap.completed','auth.human_user.created','auth.human_user.enabled','auth.human_user.disabled',
        'auth.role_assignment.created','auth.session.created','auth.session.revoked','auth.sessions.revoked_all',
        'auth.login.succeeded','auth.password.changed','auth.password_reset.approved','auth.password_reset.denied',
        'auth.password_reset.completed','auth.recovery.initiated','auth.recovery.completed','auth.recovery.cancelled','auth.recovery.expired'
      ));
      create index login_throttles_updated_idx on login_throttles(updated_at);
      create index password_reset_target_idx on password_reset_requests(human_user_id,created_at);
      create unique index recovery_one_active_target_idx on recovery_challenges(human_user_id) where status='active';
    `,
  },
  {
    id: "1010_password_reset_wait_throttle",
    sql: `
      alter table password_reset_requests add column version bigint not null default 1;
      create table password_reset_watch_tickets (
        token_digest text primary key,
        request_id text not null references password_reset_requests(id),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        used_at timestamptz
      );
      create table password_reset_throttles (
        username text primary key,
        request_count integer not null default 0,
        window_started_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index password_reset_watch_ticket_expiry_idx on password_reset_watch_tickets(expires_at);
      create index password_reset_throttle_updated_idx on password_reset_throttles(updated_at);
    `,
  },
  {
    id: "1011_agent_authorization",
    sql: `
      alter table auth_sessions drop constraint auth_sessions_credential_kind_check;
      alter table auth_sessions add constraint auth_sessions_credential_kind_check check(credential_kind in ('human_full','authorization_request','agent_authorization'));
      alter table auth_sessions add column authorization_id uuid;
      alter table auth_contexts add column authorization_id uuid;

      create table agent_users (
        id uuid primary key,
        principal_id uuid not null unique references principals(id),
        human_user_id uuid not null references human_users(id),
        name text,
        created_at timestamptz not null default now()
      );
      create table agent_authorizations (
        id uuid primary key,
        agent_user_id uuid not null references agent_users(id),
        human_user_id uuid not null references human_users(id),
        parent_authorization_id uuid references agent_authorizations(id),
        root_authorization_id uuid,
        approved_by_auth_context_id uuid not null references auth_contexts(id),
        created_at timestamptz not null default now(),
        revoked_at timestamptz,
        superseded_at timestamptz
      );
      alter table agent_authorizations add constraint agent_authorization_root_fk foreign key(root_authorization_id) references agent_authorizations(id) deferrable initially deferred;
      alter table auth_sessions add constraint auth_sessions_authorization_fk foreign key(authorization_id) references agent_authorizations(id);
      alter table auth_contexts add constraint auth_contexts_authorization_fk foreign key(authorization_id) references agent_authorizations(id);
      create table agent_authorization_roles (
        id uuid primary key,
        authorization_id uuid not null references agent_authorizations(id),
        role_id text not null references system_roles(id),
        boundary_type text not null check(boundary_type in ('system','all_projects','project')),
        project_id uuid references projects(id),
        unique nulls not distinct(authorization_id,role_id,boundary_type,project_id),
        check((boundary_type='project')=(project_id is not null))
      );
      create table agent_authorization_requests (
        id uuid primary key,
        requester_session_id uuid not null references auth_sessions(id),
        requester_authorization_id uuid references agent_authorizations(id),
        human_user_id uuid not null references human_users(id),
        idempotency_key text not null,
        roles text[] not null,
        boundary_type text not null check(boundary_type in ('system','all_projects','project')),
        project_id uuid references projects(id),
        reason text not null,
        agent_name text,
        nonce_digest text not null,
        status text not null check(status in ('pending','approved','denied','cancelled','invalidated')),
        version bigint not null default 1,
        authorization_id uuid references agent_authorizations(id),
        decided_by_auth_context_id uuid references auth_contexts(id),
        denial_reason text,
        decision_snapshot jsonb,
        created_at timestamptz not null default now(),
        decided_at timestamptz,
        redeemed_at timestamptz,
        unique(requester_session_id,idempotency_key),
        check((boundary_type='project')=(project_id is not null))
      );
      create table agent_authorization_watch_tickets (
        token_digest text primary key,
        request_id uuid not null references agent_authorization_requests(id),
        expires_at timestamptz not null,
        used_at timestamptz
      );
      create unique index agent_auth_active_session_idx on auth_sessions(authorization_id) where credential_kind='agent_authorization' and revoked_at is null;
      create index agent_auth_anchor_idx on agent_authorizations(human_user_id,created_at);
      create index agent_request_anchor_idx on agent_authorization_requests(human_user_id,created_at);

      alter table auth_audit_events drop constraint auth_audit_events_event_type_check;
      alter table auth_audit_events add constraint auth_audit_events_event_type_check check(event_type in (
        'auth.bootstrap.completed','auth.human_user.created','auth.human_user.enabled','auth.human_user.disabled',
        'auth.role_assignment.created','auth.session.created','auth.session.revoked','auth.sessions.revoked_all',
        'auth.login.succeeded','auth.password.changed','auth.password_reset.approved','auth.password_reset.denied',
        'auth.password_reset.completed','auth.recovery.initiated','auth.recovery.completed','auth.recovery.cancelled','auth.recovery.expired',
        'auth.authorization_request.created','auth.authorization_request.approved','auth.authorization_request.denied','auth.authorization_request.cancelled',
        'auth.authorization.redeemed','auth.authorization.revoked'
      ));
    `,
  },
  {
    id: "1012_authorization_grantability",
    sql: `
      create table role_definition_versions (
        id uuid primary key,
        role_id text not null references system_roles(id),
        version integer not null check(version > 0),
        active boolean not null,
        created_at timestamptz not null default now(),
        unique(role_id,version)
      );
      create unique index role_definition_one_active_idx
        on role_definition_versions(role_id) where active;
      insert into role_definition_versions(id,role_id,version,active) values
        ('01900000-0000-7000-8000-000000000101','system:super_admin',1,true),
        ('01900000-0000-7000-8000-000000000102','system:admin',1,true);

      create table policy_definition_versions (
        id uuid primary key,
        policy_id text not null,
        version integer not null check(version > 0),
        active boolean not null,
        created_at timestamptz not null default now(),
        unique(policy_id,version)
      );
      create unique index policy_definition_one_active_idx
        on policy_definition_versions(policy_id) where active;
      create table policy_rules (
        id uuid primary key,
        policy_definition_version_id uuid not null references policy_definition_versions(id),
        role_id text not null references system_roles(id),
        capability text not null,
        created_at timestamptz not null default now(),
        unique(policy_definition_version_id,role_id,capability)
      );
      create table policy_assignments (
        id uuid primary key,
        policy_definition_version_id uuid not null references policy_definition_versions(id),
        boundary_type text not null check(boundary_type in ('system','all_projects','project')),
        project_id uuid references projects(id),
        active boolean not null,
        created_at timestamptz not null default now(),
        disabled_at timestamptz,
        check((boundary_type='project')=(project_id is not null))
      );
      create index policy_assignment_boundary_idx
        on policy_assignments(boundary_type,project_id) where active;
    `,
  },
  {
    id: "1013_authorization_assignments",
    sql: `
      alter table system_roles add column description text;
      alter table system_roles add column axi_summary text;
      alter table role_assignments add column version bigint not null default 1;
      alter table role_assignments add column created_by_auth_context_id uuid references auth_contexts(id);
      alter table role_assignments add column disabled_by_auth_context_id uuid references auth_contexts(id);
      alter table role_assignments add column disabled_at timestamptz;
      create unique index role_assignment_one_active_idx
        on role_assignments(principal_id,role_id,boundary_type,project_id) nulls not distinct where active;

      alter table policy_rules add column resource text not null default '*';
      alter table policy_rules add column condition_kind text not null default 'unconditional'
        check(condition_kind in ('unconditional','abac','rebac'));
      alter table policy_rules add column summary text;
      alter table policy_rules add column predicate text;
      alter table policy_assignments add column version bigint not null default 1;
      alter table policy_assignments add column source text not null default 'operator'
        check(source in ('operator','pack_default','platform'));
      alter table policy_assignments add column created_by_auth_context_id uuid references auth_contexts(id);
      alter table policy_assignments add column disabled_by_auth_context_id uuid references auth_contexts(id);

      create table auth_context_role_assignments (
        auth_context_id uuid not null references auth_contexts(id),
        role_id text not null references system_roles(id),
        boundary_type text not null check(boundary_type in ('system','all_projects','project')),
        project_id uuid references projects(id),
        check((boundary_type='project')=(project_id is not null))
      );
      create unique index auth_context_role_assignment_unique_idx
        on auth_context_role_assignments(auth_context_id,role_id,boundary_type,project_id) nulls not distinct;
      create function snapshot_auth_context_roles() returns trigger language plpgsql as $$
      begin
        if new.credential_kind='human_full' then
          insert into auth_context_role_assignments(auth_context_id,role_id,boundary_type,project_id)
            select new.id,role_id,boundary_type,project_id from role_assignments
             where principal_id=new.principal_id and active;
        elsif new.credential_kind='agent_authorization' then
          insert into auth_context_role_assignments(auth_context_id,role_id,boundary_type,project_id)
            select new.id,role_id,boundary_type,project_id from agent_authorization_roles
             where authorization_id=new.authorization_id;
        end if;
        return new;
      end
      $$;
      create trigger auth_context_roles_snapshot after insert on auth_contexts
        for each row execute function snapshot_auth_context_roles();
      create function reject_auth_context_role_mutation() returns trigger language plpgsql as $$
      begin raise exception 'auth context role snapshots are immutable'; end
      $$;
      create trigger auth_context_roles_immutable before update or delete on auth_context_role_assignments
        for each row execute function reject_auth_context_role_mutation();

      update system_roles set description='Unrestricted authenticated platform administrator',
        axi_summary='Reserved for trusted platform administration.' where id='system:super_admin';
      update system_roles set description='Delegated platform administrator',
        axi_summary='Administers platform and project boundaries through active policy.' where id='system:admin';
      insert into policy_definition_versions(id,policy_id,version,active) values
        ('01900000-0000-7000-8000-000000000201','system:administration',1,true);
      insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,summary) values
        ('01900000-0000-7000-8000-000000000211','01900000-0000-7000-8000-000000000201','system:admin','role.assignment.manage','*','unconditional','Manage roles already held in this boundary.'),
        ('01900000-0000-7000-8000-000000000212','01900000-0000-7000-8000-000000000201','system:admin','policy.assignment.manage','*','unconditional','Manage policy activation in this boundary.'),
        ('01900000-0000-7000-8000-000000000213','01900000-0000-7000-8000-000000000201','system:admin','auth.request.decide','*','unconditional','Decide same-anchor authorization requests for held roles.'),
        ('01900000-0000-7000-8000-000000000214','01900000-0000-7000-8000-000000000201','system:admin','project.read','*','unconditional',null),
        ('01900000-0000-7000-8000-000000000215','01900000-0000-7000-8000-000000000201','system:admin','project.create','*','unconditional',null),
        ('01900000-0000-7000-8000-000000000216','01900000-0000-7000-8000-000000000201','system:admin','project.update','*','unconditional',null),
        ('01900000-0000-7000-8000-000000000217','01900000-0000-7000-8000-000000000201','system:admin','project.archive','*','unconditional',null);
      insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active,source) values
        ('01900000-0000-7000-8000-000000000222','01900000-0000-7000-8000-000000000201','all_projects',null,true,'platform');

      create table authorization_audit_events (
        id uuid primary key,
        auth_context_id uuid not null references auth_contexts(id),
        event_type text not null check(event_type in (
          'role_assignment.created','role_assignment.disabled','role_assignment.disable_rejected',
          'policy_assignment.created','policy_assignment.disabled','policy_assignment.disable_rejected',
          'policy.allowed','policy.denied','policy.bypassed'
        )),
        assignment_id uuid,
        details jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create function reject_authorization_audit_mutation() returns trigger language plpgsql as $$
      begin raise exception 'authorization audit events are immutable'; end
      $$;
      create trigger authorization_audit_immutable before update or delete on authorization_audit_events
        for each row execute function reject_authorization_audit_mutation();
    `,
  },
  {
    id: "1014_strict_global_pack_candidates",
    sql: `
      create table pack_candidate_revisions (
        id uuid primary key,
        publisher text not null check (publisher ~ '^[a-z][a-z0-9-]{0,62}$'),
        pack_name text not null check (pack_name ~ '^[a-z][a-z0-9_]{0,62}$'),
        version text not null,
        source_digest text not null check (source_digest ~ '^sha256:[0-9a-f]{64}$'),
        content_digest text not null check (content_digest ~ '^sha256:[0-9a-f]{64}$'),
        manifest jsonb not null,
        normalized jsonb not null,
        source_files jsonb not null,
        created_at timestamptz not null default now(),
        unique (publisher, pack_name, source_digest)
      );
      create table pack_active_revisions (
        publisher text not null,
        pack_name text not null,
        candidate_revision_id uuid not null references pack_candidate_revisions(id),
        activated_at timestamptz not null,
        primary key (publisher, pack_name)
      );
      create table pack_runtime_tables (
        publisher text not null,
        pack_name text not null,
        definition_kind text not null,
        definition_name text not null,
        table_name text not null unique,
        primary key (publisher, pack_name, definition_kind, definition_name)
      );
      create table pack_migration_plans_v1 (
        id uuid primary key,
        publisher text not null,
        pack_name text not null,
        from_pack_revision_id uuid null references pack_candidate_revisions(id),
        to_pack_revision_id uuid not null references pack_candidate_revisions(id),
        candidate_source_digest text not null,
        plan_digest text not null check (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
        created_auth_context_id uuid not null references auth_contexts(id),
        class text not null check (class in ('safe','risky','destructive')),
        status text not null check (status in ('ready','blocked','applied')),
        live_facts_digest text not null,
        plan_json jsonb not null,
        sql_preview jsonb not null,
        created_at timestamptz not null default now()
      );
      create index pack_migration_plans_v1_pack_idx on pack_migration_plans_v1(publisher, pack_name, created_at desc);
      create table pack_migration_validations (
        id uuid primary key,
        plan_id uuid not null references pack_migration_plans_v1(id),
        status text not null check (status in ('ready','blocked')),
        live_facts_digest text not null,
        blockers jsonb not null,
        auth_context_id uuid not null references auth_contexts(id),
        created_at timestamptz not null default now()
      );
      create index pack_migration_validations_plan_idx on pack_migration_validations(plan_id, created_at desc, id desc);
      create table pack_migration_confirmation_tokens (
        id uuid primary key,
        plan_id uuid not null references pack_migration_plans_v1(id),
        validation_id uuid not null references pack_migration_validations(id),
        token_digest text not null unique,
        expires_at timestamptz not null,
        auth_context_id uuid not null references auth_contexts(id),
        consumed_at timestamptz null,
        created_at timestamptz not null default now()
      );
      create function operant_immutable_pack_candidate() returns trigger language plpgsql as $$
      begin raise exception 'pack candidate revisions are immutable'; end $$;
      create trigger pack_candidate_revisions_immutable before update or delete on pack_candidate_revisions for each row execute function operant_immutable_pack_candidate();
      create function operant_immutable_migration_plan() returns trigger language plpgsql as $$
      begin raise exception 'migration plan content is immutable'; end $$;
      create trigger pack_migration_plans_v1_immutable before update or delete on pack_migration_plans_v1 for each row execute function operant_immutable_migration_plan();
    `,
  },
  {
    id: "1015_atomic_pack_apply",
    sql: `
      alter table pack_migration_confirmation_tokens
        add column principal_id uuid references principals(id),
        add column authorization_root_id text,
        add column plan_digest text,
        add column live_facts_digest text,
        add column destructive_change_ids jsonb;
      create table pack_migration_applications (
        id uuid primary key,
        plan_id uuid not null unique references pack_migration_plans_v1(id),
        plan_digest text not null,
        candidate_revision_id uuid not null references pack_candidate_revisions(id),
        auth_context_id uuid not null references auth_contexts(id),
        principal_id uuid not null references principals(id),
        authorization_root_id text not null,
        applied_at timestamptz not null default now()
      );
      create table pack_migration_attempts (
        id uuid primary key,
        plan_id uuid not null references pack_migration_plans_v1(id),
        auth_context_id uuid not null references auth_contexts(id),
        outcome text not null,
        details jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create table pack_migration_audit_events (
        id uuid primary key,
        plan_id uuid not null references pack_migration_plans_v1(id),
        application_id uuid references pack_migration_applications(id),
        auth_context_id uuid not null references auth_contexts(id),
        principal_id uuid not null references principals(id),
        authorization_root_id text not null,
        action text not null check(action='migration.apply'),
        decision text not null check(decision in ('allowed','denied')),
        details jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create function operant_immutable_migration_record() returns trigger language plpgsql as $$
      begin raise exception 'migration records are append-only'; end $$;
      create trigger pack_migration_applications_immutable before update or delete on pack_migration_applications for each row execute function operant_immutable_migration_record();
      create trigger pack_migration_attempts_immutable before update or delete on pack_migration_attempts for each row execute function operant_immutable_migration_record();
      create trigger pack_migration_audit_immutable before update or delete on pack_migration_audit_events for each row execute function operant_immutable_migration_record();
      create index pack_migration_attempts_plan_idx on pack_migration_attempts(plan_id,created_at,id);
      create index pack_migration_audit_plan_idx on pack_migration_audit_events(plan_id,created_at,id);
    `,
  },
  {
    id: "1016_project_object_history",
    sql: `
      -- Pre-Project history was never a supported deployed baseline. Invalidate it
      -- rather than retaining ambiguous text identifiers or actor provenance.
      drop table if exists comments;
      alter table audit_events drop constraint if exists audit_events_object_version_id_fkey;
      alter table events drop constraint if exists events_object_version_id_fkey;
      update audit_events set object_version_id=null where object_version_id is not null;
      update events set object_version_id=null where object_version_id is not null;
      alter table audit_events alter column object_version_id type uuid using object_version_id::uuid;
      alter table events alter column object_version_id type uuid using object_version_id::uuid;
      drop table if exists object_versions;

      create table changeset_commits (
        id uuid primary key,
        committed_auth_context_id uuid not null references auth_contexts(id),
        committed_at timestamptz not null default now()
      );

      create table object_versions (
        id uuid primary key,
        project_id uuid not null references projects(id),
        definition_kind text not null check (definition_kind in ('resource','relationship')),
        resource_identity text not null check (resource_identity ~ '^[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62}$'),
        object_id uuid not null,
        version integer not null check (version > 0),
        previous_version_id uuid references object_versions(id) deferrable initially deferred,
        changeset_commit_id uuid not null references changeset_commits(id),
        operation text not null check (operation in ('create','update','archive','transition','link','unlink')),
        resource_revision uuid not null references pack_candidate_revisions(id),
        snapshot_json jsonb not null check (jsonb_typeof(snapshot_json) = 'object'),
        changed_fields text[] not null default '{}',
        auth_context_id uuid not null references auth_contexts(id),
        created_at timestamptz not null default now(),
        unique(project_id, definition_kind, resource_identity, object_id, version),
        unique(project_id, definition_kind, resource_identity, object_id, id),
        unique(project_id, object_id, id),
        check ((version = 1 and previous_version_id is null) or (version > 1 and previous_version_id is not null))
      );
      create index object_versions_timeline_idx on object_versions(project_id,definition_kind,resource_identity,object_id,created_at desc,id desc);
      alter table audit_events add constraint audit_events_object_version_id_fkey
        foreign key(object_version_id) references object_versions(id);
      alter table events add constraint events_object_version_id_fkey
        foreign key(object_version_id) references object_versions(id);

      create table comments (
        id uuid primary key,
        project_id uuid not null references projects(id),
        definition_kind text not null check (definition_kind in ('resource','relationship')),
        resource_identity text not null check (resource_identity ~ '^[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62}$'),
        object_id uuid not null,
        target_object_version_id uuid not null,
        changeset_commit_id uuid not null references changeset_commits(id),
        auth_context_id uuid not null references auth_contexts(id),
        body text not null check (body ~ '\\S'),
        created_at timestamptz not null default now(),
        foreign key(project_id,definition_kind,resource_identity,object_id,target_object_version_id)
          references object_versions(project_id,definition_kind,resource_identity,object_id,id) deferrable initially deferred
      );
      create index comments_timeline_idx on comments(project_id,definition_kind,resource_identity,object_id,created_at desc,id desc);

      create function operant_reject_history_mutation() returns trigger language plpgsql as $$
      begin raise exception 'object history and comments are append-only'; end $$;
      create trigger object_versions_immutable before update or delete on object_versions for each row execute function operant_reject_history_mutation();
      create trigger comments_immutable before update or delete on comments for each row execute function operant_reject_history_mutation();
      create trigger changeset_commits_immutable before update or delete on changeset_commits for each row execute function operant_reject_history_mutation();

      create function operant_validate_version_chain() returns trigger language plpgsql as $$
      declare prior object_versions%rowtype;
      begin
        if new.previous_version_id is not null then
          select * into prior from object_versions where id=new.previous_version_id;
          if prior.id is null or prior.project_id<>new.project_id or prior.definition_kind<>new.definition_kind
             or prior.resource_identity<>new.resource_identity or prior.object_id<>new.object_id or prior.version<>new.version-1 then
            raise exception 'invalid object version chain';
          end if;
        end if;
        return new;
      end $$;
      create constraint trigger object_versions_chain after insert on object_versions
        deferrable initially deferred for each row execute function operant_validate_version_chain();
    `,
  },
  {
    id: "1017_pack_policy_projection",
    sql: `
      alter table role_definition_versions
        add column candidate_revision_id uuid references pack_candidate_revisions(id),
        add column definition_name text;
      alter table policy_definition_versions
        add column candidate_revision_id uuid references pack_candidate_revisions(id),
        add column definition_name text;
      do $$ declare constraint_name text; begin
        select conname into constraint_name from pg_constraint
         where conrelid='policy_rules'::regclass and contype='u'
           and array_length(conkey,1)=3 limit 1;
        if constraint_name is not null then
          execute format('alter table policy_rules drop constraint %I',constraint_name);
        end if;
      end $$;
      alter table policy_rules
        add column rule_name text,
        add column relation_relationship text,
        add column relation_object_side text check(relation_object_side in ('from','to')),
        add column relation_subject_side text check(relation_subject_side in ('from','to')),
        add column relation_subject text check(relation_subject in ('actor.id','actor.human_user_id'));
      create unique index role_definition_candidate_name_idx
        on role_definition_versions(candidate_revision_id,definition_name) where candidate_revision_id is not null;
      create unique index policy_definition_candidate_name_idx
        on policy_definition_versions(candidate_revision_id,definition_name) where candidate_revision_id is not null;
      create unique index policy_rule_stable_name_idx
        on policy_rules(policy_definition_version_id,rule_name,role_id,capability,resource)
        where rule_name is not null;
      create unique index policy_rule_legacy_identity_idx
        on policy_rules(policy_definition_version_id,role_id,capability,resource)
        where rule_name is null;
      create index policy_definition_candidate_active_idx
        on policy_definition_versions(candidate_revision_id) where active;
      create index role_definition_candidate_active_idx
        on role_definition_versions(candidate_revision_id) where active;
    `,
  },
  {
    id: "1018_immutable_staged_changesets",
    sql: `
      create table staged_changesets (
        id uuid primary key,
        schema_version integer not null check(schema_version=1),
        source_kind text not null check(source_kind in ('direct','action','seed')),
        source_identity_json jsonb not null check(jsonb_typeof(source_identity_json)='object'),
        created_auth_context_id uuid not null references auth_contexts(id),
        creating_context_json jsonb not null check(jsonb_typeof(creating_context_json)='object'),
        operation_graph_digest text not null check(operation_graph_digest ~ '^sha256:[0-9a-f]{64}$'),
        stage_digest text not null check(stage_digest ~ '^sha256:[0-9a-f]{64}$'),
        canonical_graph_json jsonb not null check(jsonb_typeof(canonical_graph_json)='object'),
        projects_json jsonb not null check(jsonb_typeof(projects_json)='array'),
        pack_revisions_json jsonb not null check(jsonb_typeof(pack_revisions_json)='array'),
        warnings_json jsonb not null check(jsonb_typeof(warnings_json)='array'),
        planned_events_json jsonb not null check(jsonb_typeof(planned_events_json)='array'),
        planned_deliveries_json jsonb not null check(jsonb_typeof(planned_deliveries_json)='array'),
        created_at timestamptz not null default now()
      );
      create table staged_changeset_operations (
        stage_id uuid not null references staged_changesets(id), ordinal integer not null check(ordinal>=0),
        operation_id uuid not null, project_id uuid not null references projects(id),
        pack_revision_id uuid not null references pack_candidate_revisions(id),
        resource_revision_id uuid not null references pack_candidate_revisions(id),
        operation_kind text not null check(operation_kind in ('create','update','transition','archive','link','unlink','comment')),
        object_id uuid, canonical_operation_json jsonb not null check(jsonb_typeof(canonical_operation_json)='object'),
        primary key(stage_id,ordinal), unique(stage_id,operation_id)
      );
      create table staged_changeset_dependencies (
        stage_id uuid not null references staged_changesets(id), ordinal integer not null check(ordinal>=0),
        dependency_kind text not null check(dependency_kind in ('project','pack_revision','resource','lifecycle','object_version','relationship','uniqueness','policy','assignment')),
        project_id uuid references projects(id), pack_revision_id uuid references pack_candidate_revisions(id),
        resource_revision_id uuid references pack_candidate_revisions(id), object_id uuid, expected_version_id uuid references object_versions(id),
        dependency_json jsonb not null check(jsonb_typeof(dependency_json)='object'), primary key(stage_id,ordinal)
      );
      create table staged_hook_executions (
        id uuid primary key, stage_id uuid not null references staged_changesets(id), ordinal integer not null check(ordinal>=0),
        phase text not null check(phase in ('changeset.before_stage','changeset.validate')),
        pack_revision_id uuid not null references pack_candidate_revisions(id), hook_revision_id uuid not null,
        input_digest text not null, output_digest text not null, output_json jsonb not null,
        stderr_text text not null, duration_ms bigint not null check(duration_ms>=0), grant_snapshot_json jsonb not null,
        created_at timestamptz not null default now(), unique(stage_id,ordinal)
      );
      create table staged_policy_decisions (
        id uuid primary key, stage_id uuid not null references staged_changesets(id), ordinal integer not null check(ordinal>=0),
        project_id uuid not null references projects(id), action text not null, resource_identity text not null,
        decision_json jsonb not null check(jsonb_typeof(decision_json)='object'), unique(stage_id,ordinal)
      );
      create table staged_approval_requirements (
        id uuid primary key, stage_id uuid not null references staged_changesets(id), ordinal integer not null check(ordinal>=0),
        requirement_json jsonb not null check(jsonb_typeof(requirement_json)='object'), unique(stage_id,ordinal)
      );
      create table staged_changeset_lifecycle (
        stage_id uuid primary key references staged_changesets(id),
        status text not null check(status in ('ready','awaiting_approval','rejected','cancelled','committed')),
        version bigint not null default 1 check(version>0), cancelled_auth_context_id uuid references auth_contexts(id),
        cancelled_at timestamptz, cancellation_reason text check(cancellation_reason is null or octet_length(cancellation_reason)<=4096),
        committed_at timestamptz,
        check((status='cancelled')=(cancelled_auth_context_id is not null and cancelled_at is not null)),
        check((status='committed')=(committed_at is not null))
      );
      create table staged_approval_decisions (
        id uuid primary key, stage_id uuid not null references staged_changesets(id),
        requirement_id uuid not null references staged_approval_requirements(id), principal_id uuid not null references principals(id),
        decision text not null check(decision in ('approve','reject')), reason text,
        decided_auth_context_id uuid not null references auth_contexts(id), decided_at timestamptz not null default now(),
        unique(requirement_id,principal_id)
      );
      alter table changeset_commits add column stage_id uuid references staged_changesets(id),
        add column authorization_cutoff_at timestamptz,
        add column operation_graph_digest text;
      create unique index changeset_commits_stage_idx on changeset_commits(stage_id);
      alter table changeset_commits add constraint changeset_commits_stage_complete check(
        (stage_id is null and authorization_cutoff_at is null and operation_graph_digest is null) or
        (stage_id is not null and authorization_cutoff_at is not null and operation_graph_digest ~ '^sha256:[0-9a-f]{64}$'));
      create function operant_reject_staged_evidence_mutation() returns trigger language plpgsql as $$
      begin raise exception 'staged changeset evidence is immutable'; end $$;
      create trigger staged_changesets_immutable before update or delete on staged_changesets for each row execute function operant_reject_staged_evidence_mutation();
      create trigger staged_operations_immutable before update or delete on staged_changeset_operations for each row execute function operant_reject_staged_evidence_mutation();
      create trigger staged_dependencies_immutable before update or delete on staged_changeset_dependencies for each row execute function operant_reject_staged_evidence_mutation();
      create trigger staged_hooks_immutable before update or delete on staged_hook_executions for each row execute function operant_reject_staged_evidence_mutation();
      create trigger staged_policy_immutable before update or delete on staged_policy_decisions for each row execute function operant_reject_staged_evidence_mutation();
      create trigger staged_approvals_immutable before update or delete on staged_approval_requirements for each row execute function operant_reject_staged_evidence_mutation();
      create trigger staged_decisions_immutable before update or delete on staged_approval_decisions for each row execute function operant_reject_staged_evidence_mutation();
      create index staged_operations_project_idx on staged_changeset_operations(stage_id,project_id,ordinal);
      create index staged_dependencies_stage_idx on staged_changeset_dependencies(stage_id,dependency_kind,ordinal);
      create index staged_policy_stage_idx on staged_policy_decisions(stage_id,project_id,ordinal);
    `,
  },
  {
    id: "1019_staged_component_and_creator_evidence",
    sql: `
      alter table staged_changesets
        add column created_principal_id uuid references principals(id);
      alter table staged_changesets disable trigger staged_changesets_immutable;
      update staged_changesets s set created_principal_id=a.principal_id
        from auth_contexts a where a.id=s.created_auth_context_id;
      alter table staged_changesets enable trigger staged_changesets_immutable;
      alter table staged_changesets alter column created_principal_id set not null;

      alter table staged_changeset_operations
        add column component_digest text not null default 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
          check(component_digest ~ '^sha256:[0-9a-f]{64}$'),
        alter column resource_revision_id drop not null;
      alter table staged_changeset_operations alter column component_digest drop default;
      alter table staged_changeset_dependencies add column component_digest text;
    `,
  },
  {
    id: "1020_immutable_pack_component_revisions",
    sql: `
      create table pack_component_revisions (
        id uuid primary key,
        candidate_revision_id uuid not null references pack_candidate_revisions(id),
        definition_kind text not null check(definition_kind in ('resource','relationship','lifecycle','action','hook','role','policy','seed')),
        definition_name text not null check(definition_name ~ '^[a-z][a-z0-9_]{0,62}$'),
        definition_digest text not null check(definition_digest ~ '^sha256:[0-9a-f]{64}$'),
        unique(candidate_revision_id,definition_kind,definition_name)
      );
      alter table staged_changeset_operations
        add column component_revision_id uuid references pack_component_revisions(id);
      alter table staged_changeset_dependencies
        add column component_revision_id uuid references pack_component_revisions(id);
      alter table staged_hook_executions add column attachment_id uuid;
    `,
    migrate: backfillComponentRevisions,
    applicationChecksum: "rfc8785-component-backfill-v1",
    finalSql: `
      create function operant_reject_pack_component_mutation() returns trigger language plpgsql as $$
      begin raise exception 'pack component revisions are immutable'; end $$;
      create trigger pack_component_revisions_immutable before update or delete on pack_component_revisions
        for each row execute function operant_reject_pack_component_mutation();
      alter table staged_changeset_operations alter column component_revision_id set not null;
    `,
  },
  {
    id: "1021_immutable_hook_attachment_revisions",
    sql: `
      create unique index pack_component_revision_candidate_id_unique
        on pack_component_revisions(candidate_revision_id,id);
      create table pack_hook_attachment_revisions (
        id uuid primary key check(uuid_extract_version(id)=7),
        candidate_revision_id uuid not null references pack_candidate_revisions(id),
        hook_revision_id uuid not null,
        hook_identity text not null check(hook_identity ~ '^[a-z][a-z0-9_]{0,62}/[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62}$'),
        component_revision_id uuid,
        phase text not null check(phase in ('changeset.before_stage','action.stage','changeset.validate','event.after_commit')),
        ordinal integer not null check(ordinal between 0 and 2147483647),
        declaration_digest text not null check(declaration_digest ~ '^sha256:[0-9a-f]{64}$'),
        declaration_spec jsonb not null check(jsonb_typeof(declaration_spec)='object'),
        foreign key(candidate_revision_id,hook_revision_id)
          references pack_component_revisions(candidate_revision_id,id),
        foreign key(candidate_revision_id,component_revision_id)
          references pack_component_revisions(candidate_revision_id,id),
        check(declaration_spec ?& array['hook','phase','resource','action','event','order','condition','input'] and
          declaration_spec - array['hook','phase','resource','action','event','order','condition','input'] = '{}'::jsonb),
        check(declaration_spec->>'hook'=hook_identity),
        check(declaration_spec->>'phase'=phase),
        check((declaration_spec->>'order')::integer=ordinal),
        check(((declaration_spec->'resource' = 'null'::jsonb) and
          (declaration_spec->'action' = 'null'::jsonb)) = (component_revision_id is null))
      );
      create unique index pack_hook_attachment_identity_unique
        on pack_hook_attachment_revisions(candidate_revision_id,hook_revision_id,declaration_digest);
    `,
    migrate: backfillHookAttachmentRevisions,
    applicationChecksum: "rfc8785-hook-attachment-backfill-v1",
    finalSql: `
      create function operant_reject_hook_attachment_mutation() returns trigger language plpgsql as $$
      begin raise exception 'pack hook attachment revisions are immutable'; end $$;
      create trigger pack_hook_attachment_revisions_immutable before update or delete on pack_hook_attachment_revisions
        for each row execute function operant_reject_hook_attachment_mutation();

      alter table staged_hook_executions alter column attachment_id set not null;
      alter table staged_hook_executions add constraint staged_hook_attachment_revision_fk
        foreign key(attachment_id) references pack_hook_attachment_revisions(id);
    `,
  },
  {
    id: "1022_hook_attachment_ordinal_identity",
    sql: `
      create unique index pack_hook_attachment_candidate_hook_phase_ordinal_unique
        on pack_hook_attachment_revisions(candidate_revision_id,hook_revision_id,phase,ordinal);
    `,
  },
  {
    id: "1023_hook_attachment_component_ordinal_identity",
    sql: `
      drop index pack_hook_attachment_candidate_hook_phase_ordinal_unique;
      create unique index pack_hook_attachment_component_ordinal_unique
        on pack_hook_attachment_revisions(
          candidate_revision_id,hook_revision_id,component_revision_id,phase,ordinal
        ) nulls not distinct;
    `,
  },
];

async function backfillComponentRevisions(sql: Queryable): Promise<void> {
  const candidates = (await query<{
    id: string;
    normalized: Record<string, unknown>;
  }>(sql, "select id,normalized from pack_candidate_revisions order by id"))
    .rows;
  const sections = [
    ["resource", "resources"],
    ["relationship", "relationships"],
    ["lifecycle", "lifecycles"],
    ["action", "actions"],
    ["hook", "hooks"],
    ["role", "roles"],
    ["policy", "policies"],
    ["seed", "seeds"],
  ] as const;
  for (const candidate of candidates) {
    for (const [kind, section] of sections) {
      const definitions = asRecord(candidate.normalized[section]);
      for (const name of Object.keys(definitions).sort()) {
        const definition = definitions[name];
        await query(
          sql,
          `insert into pack_component_revisions(
             id,candidate_revision_id,definition_kind,definition_name,definition_digest
           ) values($1,$2,$3,$4,$5)`,
          [
            uuidV7(),
            candidate.id,
            kind,
            name,
            `sha256:${await canonicalSha256(definition)}`,
          ],
        );
      }
    }
  }
  await query(
    sql,
    "alter table staged_changeset_operations disable trigger staged_operations_immutable",
  );
  try {
    await query(
      sql,
      `update staged_changeset_operations operation set
         component_revision_id=component.id,
         component_digest=component.definition_digest
       from pack_component_revisions component
       where component.candidate_revision_id=operation.pack_revision_id
         and component.definition_kind=case when operation.canonical_operation_json ? 'relationship' then 'relationship' else 'resource' end
         and component.definition_name=split_part(coalesce(operation.canonical_operation_json->>'resource',operation.canonical_operation_json->>'relationship'),':',2)`,
    );
  } finally {
    await query(
      sql,
      "alter table staged_changeset_operations enable trigger staged_operations_immutable",
    );
  }
}

async function backfillHookAttachmentRevisions(sql: Queryable): Promise<void> {
  const candidates = (await query<{
    id: string;
    publisher: string;
    pack_name: string;
    normalized: Record<string, unknown>;
  }>(
    sql,
    "select id,publisher,pack_name,normalized from pack_candidate_revisions order by id",
  )).rows;
  for (const candidate of candidates) {
    const hooks = asRecord(candidate.normalized.hooks);
    for (const hookName of Object.keys(hooks).sort()) {
      const hook = asRecord(hooks[hookName]);
      const hookComponent = (await query<{ id: string }>(
        sql,
        `select id from pack_component_revisions where candidate_revision_id=$1
         and definition_kind='hook' and definition_name=$2`,
        [candidate.id, hookName],
      )).rows[0];
      if (!hookComponent) {
        throw new Error("migrated hook component is unavailable");
      }
      const attachments = asRecord(hook.spec).attachments;
      if (!Array.isArray(attachments)) continue;
      for (const value of attachments) {
        const attachment = asRecord(value);
        const resource = typeof attachment.resource === "string"
          ? attachment.resource
          : null;
        const action = typeof attachment.action === "string"
          ? attachment.action
          : null;
        let componentRevisionId: string | null = null;
        if (resource !== null || action !== null) {
          const identity = resource ?? action!;
          const component = (await query<{ id: string }>(
            sql,
            `select id from pack_component_revisions where candidate_revision_id=$1
             and definition_kind=$2 and definition_name=$3`,
            [
              candidate.id,
              resource !== null ? "resource" : "action",
              identity.split(":")[1],
            ],
          )).rows[0];
          if (!component) {
            throw new Error("migrated attachment component is unavailable");
          }
          componentRevisionId = component.id;
        }
        const spec = {
          hook: `${candidate.publisher}/${candidate.pack_name}:${hookName}`,
          phase: String(attachment.phase),
          resource,
          action,
          event: typeof attachment.event === "string" ? attachment.event : null,
          order: typeof attachment.order === "number" ? attachment.order : 0,
          condition: typeof attachment.condition === "string"
            ? attachment.condition
            : null,
          input: attachment.input,
        };
        await query(
          sql,
          `insert into pack_hook_attachment_revisions(
             id,candidate_revision_id,hook_revision_id,hook_identity,component_revision_id,
             phase,ordinal,declaration_digest,declaration_spec
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb)`,
          [
            uuidV7(),
            candidate.id,
            hookComponent.id,
            spec.hook,
            componentRevisionId,
            spec.phase,
            spec.order,
            `sha256:${await canonicalSha256(spec)}`,
            JSON.stringify(spec),
          ],
        );
      }
    }
  }
  await query(
    sql,
    "alter table staged_hook_executions disable trigger staged_hooks_immutable",
  );
  try {
    await query(
      sql,
      `with ranked_executions as (
         select id,pack_revision_id,hook_revision_id,phase,
           row_number() over(partition by stage_id,hook_revision_id,phase order by ordinal) attachment_rank
         from staged_hook_executions
       ), ranked_attachments as (
         select id,candidate_revision_id,hook_revision_id,phase,
           row_number() over(partition by candidate_revision_id,hook_revision_id,phase order by ordinal,id) attachment_rank
         from pack_hook_attachment_revisions
       )
       update staged_hook_executions execution set attachment_id=attachment.id
       from ranked_executions ranked join ranked_attachments attachment
         on attachment.candidate_revision_id=ranked.pack_revision_id
        and attachment.hook_revision_id=ranked.hook_revision_id
        and attachment.phase=ranked.phase
        and attachment.attachment_rank=ranked.attachment_rank
       where execution.id=ranked.id`,
    );
  } finally {
    await query(
      sql,
      "alter table staged_hook_executions enable trigger staged_hooks_immutable",
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function applyPlatformMigrations(
  sql: Queryable,
  migrations: readonly PlatformMigration[] = platformMigrations,
): Promise<MigrationApplyResult> {
  await query(
    sql,
    `
    create table if not exists platform_schema_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `,
  );

  await query(
    sql,
    "select pg_advisory_xact_lock(hashtext('operant.platform_schema_migrations'))",
  );

  const knownIds = platformMigrations.map((migration) => migration.id);
  const incompatible = await query<{ id: string }>(
    sql,
    "select id from platform_schema_migrations where not (id = any($1::text[])) order by id",
    [knownIds],
  );
  if (incompatible.rows.length) {
    throw new Error(
      `incompatible development database schema: ${
        incompatible.rows.map((row) => row.id).join(", ")
      }; create a fresh OPERANT_DATA_DIR`,
    );
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    if (Boolean(migration.migrate) !== Boolean(migration.applicationChecksum)) {
      throw new Error(
        `platform migration callback checksum is missing or unused: ${migration.id}`,
      );
    }
    const checksum = await digest(
      `${migration.sql}\n-- application migration: ${
        migration.applicationChecksum ?? "none"
      }\n${migration.finalSql ?? ""}`,
    );
    const existing = await query<{ checksum: string }>(
      sql,
      "select checksum from platform_schema_migrations where id = $1",
      [migration.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`platform migration checksum changed: ${migration.id}`);
      }
      continue;
    }

    await query(sql, migration.sql);
    await migration.migrate?.(sql);
    if (migration.finalSql) await query(sql, migration.finalSql);
    await query(
      sql,
      "insert into platform_schema_migrations(id, checksum) values ($1, $2)",
      [migration.id, checksum],
    );
    applied.push(migration.id);
  }
  return { applied };
}

export async function inspectMigrationStatus(
  sql: Queryable,
): Promise<MigrationStatus> {
  const table = await query<{ exists: boolean }>(
    sql,
    "select to_regclass('public.platform_schema_migrations') is not null as exists",
  );
  if (!table.rows[0]?.exists) {
    return { ok: false, appliedCount: 0, latestId: null };
  }
  const expectedIds = platformMigrations.map((migration) => migration.id);
  const status = await query<
    { applied_count: string; known_count: string; latest_id: string | null }
  >(
    sql,
    `select count(*)::text as applied_count,
            count(*) filter (where id = any($1::text[]))::text as known_count,
            max(id) as latest_id
       from platform_schema_migrations`,
    [expectedIds],
  );
  const row = status.rows[0];
  const appliedCount = Number(row?.applied_count ?? 0);
  const knownCount = Number(row?.known_count ?? 0);
  return {
    ok: appliedCount === expectedIds.length &&
      knownCount === expectedIds.length,
    appliedCount,
    latestId: row?.latest_id ?? null,
  };
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
