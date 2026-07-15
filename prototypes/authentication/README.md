# Authentication Flow Prototype

This isolated Hono prototype validates the next-version authentication lifecycle
before integrating it into the main Postgres server.

## Run

```bash
deno test -A prototypes/authentication/auth-flow.test.ts
deno check prototypes/authentication/auth-flow.ts \
  prototypes/authentication/auth-flow.test.ts
```

Compiled compatibility:

```bash
deno compile -A -o /tmp/auth-flow \
  prototypes/authentication/auth-flow.ts
/tmp/auth-flow
```

## Covered behavior

The public-flow scenario exercises:

- bootstrap status, invalid bootstrap credential, successful one-time bootstrap,
  and duplicate-bootstrap rejection;
- Argon2id password hashing and login failure/success;
- human session plus retained/issued authorization-request credential;
- request credentials denied ordinary work;
- idempotent multi-role authorization requests;
- optional typed agent metadata;
- approval returning no bearer token to the approver;
- requester nonce redemption and invalid nonce rejection;
- one agent authorization with role assignments in multiple projects;
- replacement authorization superseding the old token without retaining the old
  self-authorization as a delegation ancestor;
- per-project role evaluation from one token;
- agent-to-subagent approval and delegation-chain invalidation;
- human denial reason with no suggested role/escalation;
- agent self-revocation;
- password-confirmed logout-all;
- targeted recovery revoking old authority and issuing new sessions;
- server auth contexts containing no PID/cwd/process evidence;
- stable structured error codes.

## Password result

`@node-rs/argon2` works in Deno and in a compiled Linux executable. The
prototype uses Argon2id with:

```text
memoryCost: 19456 KiB
timeCost: 2
parallelism: 1
outputLen: 32 bytes
```

Hashes are salted PHC strings. Repeating one password produces different hashes,
and verification succeeds/fails correctly.

## Observed evidence

```text
2 passed | 0 failed
AUTH_FLOW_COMPILED_PASS
```

## Important prototype finding

A replacement authorization must not retain the superseded authorization itself
as a delegation ancestor, because the old authorization is deactivated. It must
preserve the old authorization's parent/root chain while replacing the agent's
own role-assignment snapshot. The test caught this issue before integration.

## Deliberate limits

- State is in memory; production uses Postgres transactions and token hashes.
- The test work endpoint stands in for normal policy evaluation.
- Request waiting is represented by status/redeem calls rather than timing a
  long-poll loop.
- CLI filesystem/process binding, contexts, doctor, and isolate are covered by
  their own specs/process prototype rather than this server-flow prototype.
- Login throttling and the exact password policy remain to be finalized from the
  validated Argon2id base.
