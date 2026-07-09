# Hook Attachment Prototype

Validates metadata-driven hook attachment points:

- resource `before_preview` normalization hooks
- resource `validate` hooks
- action hooks returning `changeset.operations.v1`
- after-commit hooks enqueued through outbox and recorded in `hook_executions`

This composes the hook stdin/stdout contract with changeset phases without
hardcoding hook behavior in the changeset engine.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/hook-attachments/hook-attachment-prototype.test.ts
```
