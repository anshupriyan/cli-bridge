# Security Policy

`cli-bridge` handles local filesystem access and shell command execution on behalf of MCP clients. We take security boundaries seriously.

---

## Supported Versions

| Version | Supported |
|---|---|
| 0.0.x / 0.0.1+ | ✅ Yes |

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

## Security Model, User Responsibility & Scope Notes

- **Dev Mode & User Responsibility**: When Dev Mode is enabled (`toggle_dev_mode({ enable_dev_mode: true })`), `execute_command` runs real shell commands with host user privileges. As stated in the README, **any data loss, system damage, security incident, or unhandled command side effect resulting from enabling Dev Mode is entirely the user's responsibility.**
- **In-Scope Vulnerabilities**: Bugs that allow reading or writing files outside the workspace root without Dev Mode, escaping symlinks, or executing shell commands while Dev Mode is OFF are considered critical security vulnerabilities.
- **Feedback & Future Safety Improvements**: Reporting feedback, edge cases, or ideas regarding Dev Mode safety enhancements and execution guardrails is always open. Suggestions for improving shell safety are welcomed and will be considered for future versions.
