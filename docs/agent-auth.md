# Agent CLI authentication

`optctl` resolves the owning session from verified process ancestry. For
supported harnesses, ordinary tool calls work through pipelines, nested
subshells, command substitution, and temporary command shells. **No `exec`
workaround is required.**

## Normal agent workflow

Run `optctl --json auth anchor` to inspect the selected process before granting
anything. It is read-only and does not require a full credential.

1. Run
   `optctl auth request --role <role> --boundary <boundary> --reason <reason>`.
2. Show the returned request ID and `process_binding` to the human for approval.
3. Run `optctl auth wait <request-id>` from the same agent session, in a later
   tool call if desired.
4. Verify `optctl auth status`, then perform the approved work.

Request creation records the chosen PID, process start time, real UID, and boot
identity. Redemption checks that the same live session still owns the request,
both before waiting and before redeeming. A sibling agent or restarted harness
cannot redeem it. Authorization output contains metadata, never the bearer
token. The shared request-only credential remains available to other unapproved
trees; it does not authorize application operations.

## Anchor selection

Walk from the CLI's parent toward the root, stopping at the nearest:

- existing matching process binding (never widen a narrower grant);
- recognized harness: Pi, Codex, Claude Code, OpenCode, Cursor Agent, Aider,
  Goose;
- interactive shell (Bash, Zsh, sh/dash, Fish, Nushell);
- explicit launcher anchor or `auth isolate` boundary.

Command/script shells and common wrappers (`env`, `timeout`, `setsid`, `nice`,
`nohup`, `stdbuf`) are traversed. Node/Bun/Python entrypoints for known
harnesses are also recognized. Arbitrary unknown launchers fail closed instead
of climbing past a possible separate session. Recognition selects a candidate;
only verified ancestry and full process identity establish the binding.
Different UID/boot boundaries and PID 1 are never used. The entire ancestry is
revalidated for PID reuse and reparenting.

Custom persistent launchers should set `OPTD_AUTH_ANCHOR_PID` to **their own
PID** before spawning tools. It is not an arbitrary target override: the PID
must be in the actual permitted ancestry, and cannot override a nearer
recognized harness, existing narrower binding, or isolation boundary.
`auth isolate` removes inherited explicit anchor hints before launching its
child.

A human should invoke `optctl auth login` normally from an interactive terminal.
`auth session-pid` still reports the immediate caller for low-level diagnostics;
the selected grant anchor is shown by `auth status`, not inferred from that
caller PID.

## Security and contract change

Nearest-credential selection is unchanged: no combining grants and no fallback
to a broader ancestor after a narrow grant is denied/revoked. Process-name
recognition does not grant server permissions. Same-OS-user malware remains
outside the filesystem credential provider's threat model; this is not a
hardened OS security boundary.

This intentionally supersedes the immediate-parent creation rule in the frozen
`spec/authentication.md` for the new CLI behavior. The frozen model/spec files
are not edited here. Requests made by older clients lack a recorded request
anchor and must be recreated; existing valid full bindings remain selectable.
Stale bindings are never reassigned to another PID or revived by copying a
credential.

Regression coverage includes compiled commands through six shell launch shapes,
sibling redemption rejection, nested recognized harnesses, explicit and isolate
bounds, unknown launchers, identity changes, independent human trees,
delegation, replacement, revocation, shared discovery, and token-free output.
