import { query, type Queryable } from "./client.ts";

export type PlatformMigration = {
  id: string;
  sql: string;
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
];

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

  const knownIds = migrations.map((migration) => migration.id);
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
    const checksum = await digest(migration.sql);
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
