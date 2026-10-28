# Security policy

Do not post tokens, credential files, account IDs, private terminal captures,
or raw provider responses in issues or pull requests.

Report vulnerabilities privately through this repository's GitHub security
advisories if enabled. Otherwise, open an issue requesting a private contact
without including exploit details or sensitive information.

## Trust boundary

The plugin runs inside your local OpenCode TUI. It launches the Codex executable
from `PATH` or the configured `codexBinary` path without a shell. Only configure
executables you trust. The process inherits your environment, including
`CODEX_HOME`; authentication and network calls belong to Codex itself.

The plugin does not read or copy credentials. Quotas are held in memory, response
size and request duration are bounded, and background work is cancelled on
disposal. Display labels have terminal control characters stripped. Errors use
fixed messages rather than provider payloads or stderr.

The supported release line is 0.1.x for OpenCode 2.2.x. Check source changes before
updating a clone. This project does not guarantee upstream quota accuracy or
availability.
