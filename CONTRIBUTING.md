# Contributing to cli-bridge

Thank you for considering contributing to `cli-bridge`! We welcome bug fixes, documentation improvements, and feature additions.

---

## Development Setup

### Prerequisites
- **Node.js**: v18.17.0+ (v20 or v24 LTS recommended)
- **npm**: Included with Node.js
- **Git**

### Local Setup
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/anshupriyan/cli-bridge.git
   cd cli-bridge
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the TypeScript source:
   ```bash
   npm run build
   ```
   To watch for changes during development:
   ```bash
   npm run watch
   ```

### Testing with MCP Inspector
You can test tool calls locally using the official MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node build/index.js <PATH_TO_TEST_WORKSPACE>
```

---

## Branch Naming

Use descriptive branch names with appropriate prefixes:
- `feature/<short-description>` — New feature or tool capability
- `fix/<short-description>` — Bug fix or path handling fix
- `docs/<short-description>` — Documentation or comment updates
- `refactor/<short-description>` — Code cleanup without behavior changes
- `test/<short-description>` — Adding or updating test scripts

---

## Commit Message Guidelines

Keep commit messages simple, concise, and conventional:

Format: `<type>: <short summary>`

Examples:
- `feat: add filter parameter to grep_content`
- `fix: handle backslash normalization on Windows paths`
- `docs: update setup steps for macOS`
- `refactor: extract path security checks into utility module`

---

## Code Style & Expectations

- **TypeScript**: Written in strict TS targeting ESM (`"type": "module"`).
- **Compilation**: Code must compile cleanly without errors when running `npm run build`.
- **Security First**: Maintain strict path confinement (`resolveSafePath`), symlink verification, and Dev Mode gating. Never bypass these security boundaries.
- **Dependencies**: Keep dependencies minimal.

---

## Submitting a Pull Request

1. **Check existing issues and PRs** to avoid duplicate work.
2. **Push your branch** to your fork.
3. **Open a PR** against the `main` branch.
4. **Fill out the PR Template**:
   - Provide a clear summary of what changed and why.
   - Reference related issues (`Closes #123`).
   - Include testing steps performed (e.g., tested with MCP Inspector or Claude Desktop).
5. **Maintainer Sign-Off**:
   - **No PR will be merged without explicit sign-off from the maintainer (`anshupriyan`)**.
