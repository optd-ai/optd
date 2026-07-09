# Secret Bootstrap Spike

This spike validates the permission bootstrap model for built-in secret
resources.

It proves:

- A `super_admin` role bypasses permission checks.
- Bootstrap creates an `admin` role with all initial secret-management
  permissions.
- Super admin can grant `admin` to another user.
- Admin can create/read secrets through normal permission checks.
- Non-admin users are denied until granted.
- Secret actions are audited.

The encryption in this spike is deliberately fake (`btoa`) and only validates
permission/bootstrap flow. MVP encryption should use a master key from an
environment variable mounted into the server runtime.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/secrets/secret-bootstrap-spike.test.ts
```
