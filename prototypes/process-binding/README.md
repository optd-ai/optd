# Linux Process Binding Prototype

This prototype validates the local process identity and closest-ancestor binding
model proposed by `spec/authentication.md`.

## Run

```bash
deno test -A prototypes/process-binding/linux_process_binding.test.ts
deno run -A prototypes/process-binding/linux_process_binding.ts
```

A compiled executable was also validated with:

```bash
deno compile -A -o /tmp/process-binding \
  prototypes/process-binding/linux_process_binding.ts
/tmp/process-binding
```

## Observed evidence

On Linux, an unprivileged process can read:

- parent PID and process start ticks from `/proc/<pid>/stat`;
- real UID from `/proc/<pid>/status`;
- boot UUID from `/proc/sys/kernel/random/boot_id`.

The executable walk returned the real ancestry chain with stable start ticks,
UID `1000`, and one boot UUID. Tests observed `6 passed | 0 failed` and the
compiled smoke printed `COMPILED_LINUX_PROCESS_BINDING_PASS`.

The tests cover:

- robust `/proc/<pid>/stat` parsing when the command name contains spaces or
  closing parentheses;
- real UID parsing;
- rejection of reused PIDs, changed UIDs, and changed boot IDs;
- closest matching ancestor selection;
- valid explicit tree stopping;
- rejection when the requested stop PID is not in the real ancestry.

Immediate-parent anchoring naturally gives the desired shell/multiplexer shape:
a login command's parent is its invoking shell, while sibling shells/panes are
not descendants and therefore cannot match. Scripts and ordinary child processes
remain descendants. No tmux/Zellij-specific rule is required.

## Caveat

In the tested Deno environment, direct reads of dynamic `/proc/<pid>` paths
required `-A`; `--allow-read` and `--allow-read=/proc` were rejected as
requiring all access. The existing compiled `optctl` packaging already uses
broad runtime permissions, but production implementation should explicitly
account for this Deno permission behavior.

This mechanism is ergonomic same-user credential selection, not a hardened
security boundary against a malicious process running as the same OS user.
