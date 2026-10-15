# Frozen Projects upgrade fixture

`projects-v0.2.0.tar.gz` contains the unmodified Projects pack from release
`v0.3.0` (commit `a0aebacf2d1b89bc629321436b629a9640f853a1`). It was generated
using `git archive --format=tar v0.3.0 prototypes/project-management-pack` piped
to `gzip -n`.

SHA256: `64d0c8cbbd364047df12012d426f40f5504c5950d6f89e663a1c4cedea92f4bb`.

The integration upgrade test extracts this trusted fixture into an owned
temporary directory and applies it before testing the current candidate. It must
not be regenerated from the current pack: its purpose is to preserve the
released baseline independently of future source changes.
