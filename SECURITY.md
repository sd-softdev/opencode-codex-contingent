# Security policy

Do not post tokens, credential files, account IDs, private terminal captures,
or raw provider responses in issues or pull requests.

Report vulnerabilities privately through this repository's GitHub security
advisories if enabled. Otherwise, open an issue requesting a private contact
without including exploit details or sensitive information.

## Trust boundary

The adapters run inside your local OpenCode TUI or desktop VS Code extension host.
Both use the same quota client and poller. They launch the Codex executable
from `PATH` or the configured `codexBinary` path without a shell. Only configure
executables you trust. The process inherits your environment, including
`CODEX_HOME`; authentication and network calls belong to Codex itself. VS Code
runs the extension locally even in remote workspaces. Its executable setting is
machine-scoped, not workspace-controlled, and the process starts in your home
directory rather than the opened project.

Neither adapter reads or copies credentials. The quota cache is held in memory, response
size and request duration are bounded, and background work is cancelled on
disposal. Display labels have terminal control characters stripped. Errors use
fixed messages rather than provider payloads or stderr. VS Code tooltips and
details are plain text, never trusted Markdown, HTML, or provider-supplied commands.
No telemetry or direct quota HTTP requests are made by either adapter. Each host
keeps its own in-memory cache; they do not share a running process or credentials.

The supported release line is 0.3.x for OpenCode 2.2.x and desktop VS Code 1.96+.
Check source changes before updating a clone. This project does not guarantee upstream quota accuracy or
availability.
