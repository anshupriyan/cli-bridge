# Security Policy

`cli-bridge` handles local filesystem access and shell command execution on behalf of MCP clients. We take security boundaries seriously.

---

## Supported Versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ Yes |
| < 1.0.0 | ❌ No |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability (such as a path traversal bypass, symlink sandbox escape, shell injection vulnerability outside Dev Mode, or unhandled permission escalation):

1. **Private Vulnerability Reporting**: Use the **Security tab** on GitHub and submit a private vulnerability report.
2. If GitHub Private Vulnerability Reporting is unavailable, contact the maintainer (`anshupriyan`) directly on GitHub.

### What to Include
- A description of the vulnerability and potential security impact.
- Steps to reproduce or a minimal proof-of-concept (PoC).
- Affected platform(s) (Windows, macOS, Linux).

---

## Response Expectations

- **Response Time**: Best effort basis. This is a solo-maintained project.
- **Triage & Patch**: Reported vulnerabilities will be triaged as quickly as possible, and a fix will be published in a patch release.

---

## Security Model & Scope Notes

- **Dev Mode & `execute_command`**: When Dev Mode is enabled (`toggle_dev_mode({ enable_dev_mode: true })`), `execute_command` intentionally runs shell commands with host user privileges. Arbitrary command execution while Dev Mode is explicitly ON is intended functionality, not a vulnerability.
- **In-Scope Boundaries**: Bugs that allow reading/writing files outside the workspace root without Dev Mode, escaping symlinks, or executing shell commands while Dev Mode is OFF are considered high-priority security issues.
