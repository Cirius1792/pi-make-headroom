# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/Cirius1792/pi-make-headroom/security/advisories/new

Do not open a public issue for a vulnerability.

Include:

- Affected version (`pi-make-headroom` and Headroom version).
- Operating system, Python version, Node version, and Pi version.
- A minimal reproduction, if possible.
- Impact and any suggested fix.
- Relevant logs with secrets, prompts, and message content removed.

## Scope

Security-relevant areas include:

- The managed Python venv and `pip install` invocation.
- Proxy startup, cancellation, and process-tree cleanup.
- Message conversion and compression alignment.
- Handling of API keys, proxy tokens, and local files.
- The extension's Pi event handling and command surface.

## What to expect

- Acknowledgment within 7 days.
- Triage and a remediation plan after the report is validated.
- A GitHub Security Advisory and patched release when appropriate.
- Credit in the advisory unless you ask to stay anonymous.

## Safe harbor

Good-faith security research that follows this policy will not be pursued or reported as abuse. Do not access, modify, or exfiltrate data that is not yours.
