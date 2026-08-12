# Security Policy

## Supported versions

Cockpit is pre-1.0; only the latest state of `main` receives security fixes.

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/tashtit/cockpit/security) and click
**Report a vulnerability**. You should receive a response within a few days.

Please include enough detail to reproduce the issue: affected component
(main process, preload bridge, renderer, or a provider parser), steps to
reproduce, and impact as you understand it.

## Scope notes

Cockpit's renderer is sandboxed and all renderer input crossing IPC is
treated as untrusted. Reports about paths that bypass `assertKnownRepoRoot`
or otherwise act on unvalidated renderer-supplied paths are particularly
relevant.
