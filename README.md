# optd

optd is a single-tenant, open-source runtime for versioned business objects,
project-scoped authorization, and Pack-defined workflows. The server is `optd`;
the standalone client is `optctl`. The HTTP API remains `/api/v1`.

## Development

Use Deno 2.8.3 and PostgreSQL 17 or newer. Set `OPTD_PG_BIN_DIR` to an existing
PostgreSQL installation for local managed-mode tests; no host installer is run.
The pinned release image supplies PostgreSQL 18.4. Runtime configuration uses
`OPTD_*` only. Start with fresh optd state: legacy development databases and
credentials are not migrated or imported.

```sh
deno task check
deno task compile:optctl
./dist/optctl --help
```

See [runtime and deployment](docs/runtime.md) for required secrets, persistence,
and the two supported production modes: app-managed PostgreSQL in one container,
or an external PostgreSQL server. Official proof Packs are `optd/crm` and
`optd/projects`, using the `optd.dev/v1` namespace. There is no Pack registry.

## Validation and release

[Local distribution checks](docs/release.md) bind artifacts to exact clean
source and an immutable image ID. Prefix checks are not host acceptance,
exact-image acceptance, or evidence of a published release. No publication is
performed by local release automation.

`optd-ai/optd` is the canonical **new public repository** identity. Creating it
from complete validated local Git history is separate, explicitly authorized
external work, not a transfer or a side effect of building this checkout.

The authoritative contract is
[project-model/model.json](project-model/model.json). The `spec/` projection is
frozen; historical planning evidence is not current release status.
CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, CODEOWNERS, and hosted CI
policies are not supplied by this local distribution candidate; public
maintainership and security-reporting channels must be settled separately before
announcing a public release.

## License

optd is licensed under [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
Third-party components retain their own licenses and notices.
