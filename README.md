# code-failures-mcp

MCP server that indexes your `code_failures/` knowledge base and makes it searchable from Claude Code (or any MCP client). Uses BM25 via [MiniSearch](https://github.com/lucaong/minisearch) for fast, relevant keyword search with fuzzy matching.

## Why

Every bug you debug for hours becomes institutional knowledge. This MCP server makes that knowledge automatically available to Claude Code so it searches your past fixes *before* attempting a new solution.

## Tools

| Tool | Purpose |
|---|---|
| `search_past_bugs` | Search bugs by symptom, error message, or library name |
| `search_references` | Search canonical working patterns and version guides |
| `search_all_knowledge` | Search everything with relevance scores |
| `get_document` | Retrieve full content of a specific document |
| `list_documents` | List all indexed documents |

## Setup

```bash
cd /Users/tk/Desktop/code-failures-mcp
npm install
npm run build
```

## Configure Claude Code

### CLI + Manual Config (recommended)

The `claude mcp add` CLI doesn't support environment variables via flags, so you need to add the server first, then manually edit the config:

```bash
# Step 1: Add the server (global)
claude mcp add code-failures -- node /Users/tk/Desktop/code-failures-mcp/dist/index.js

# Step 2: Edit ~/.claude.json and add the env object to the code-failures server config:
# "env": {
#   "BRAIN_PATH": "/Users/tk/Desktop/brain/code_failures"
# }

# For project-scoped:
claude mcp add -s project code-failures -- node /Users/tk/Desktop/code-failures-mcp/dist/index.js
# Then edit the project's section in ~/.claude.json
```

Verify with:

```bash
claude mcp list
```

### JSON config (alternative)

Manually add to `~/.claude.json` (find your project section):

```json
{
  "projects": {
    "/your/project/path": {
      "mcpServers": {
        "code-failures": {
          "type": "stdio",
          "command": "node",
          "args": ["/Users/tk/Desktop/code-failures-mcp/dist/index.js"],
          "env": {
            "BRAIN_PATH": "/Users/tk/Desktop/brain/code_failures"
          }
        }
      }
    }
  }
}
```

Or for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "code-failures": {
      "command": "node",
      "args": ["/Users/tk/Desktop/code-failures-mcp/dist/index.js"],
      "env": {
        "BRAIN_PATH": "/Users/tk/Desktop/brain/code_failures"
      }
    }
  }
}
```

## CLAUDE.md Integration

Add this to your project's `CLAUDE.md` to make Claude Code automatically use the knowledge base:

```markdown
# Global Preferences

- Implement only what's explicitly requested. Prefer minimal changes. No unnecessary features, files, or abstractions.
- Check all related functionality before modifying code — update or verify dependents.
- Before writing a script, check what tools are available via MCP or plugins. Prefer existing tools over bash scripts.
- Always use Context7 MCP (resolve-library-id → get-library-docs) before writing code involving external libraries or frameworks.
- ALWAYS call `search_past_bugs` before debugging any error. Call `search_references` before writing integration code. These check your verified fixes first — prioritize over Context7 and web search.
- After solving a bug that took >15 min: draft Symptom/Root Cause/Fix/Prevention, show me for review, then call `file_bug` to save it.

## Git Workflow

- Commit after each logical unit of work with conventional commit messages (feat:, fix:, refactor:, chore:).
- Do not push unless explicitly asked.
- Work on feature branches, never commit directly to main.

## Self-Improving Project CLAUDE.md

When I correct you on something that represents a recurring pattern or architectural decision (not a one-off typo), propose an update to the project's CLAUDE.md. Follow these rules:

**Before writing, check the existing file.** If a similar rule exists, replace or refine it — never duplicate. If the file exceeds 80 lines, identify a lower-value rule to remove before adding.

**How to write rules:**
1. Use absolute directives — start with NEVER or ALWAYS when appropriate
2. Lead with why (1 sentence max), then the concrete rule
3. Include actual commands or file:line references, not abstract descriptions
4. One code example max per rule. No example if the rule is obvious
5. Bullets over paragraphs. No "Warning Signs" sections for trivial rules

**When to update:** Only for corrections that would apply to future sessions — patterns, conventions, architectural decisions, recurring tool preferences. Not for one-off fixes, typos, or task-specific context.

**Two-tier structure:** If the project CLAUDE.md has a summary section at the top, add a one-line summary there and the detailed rule in the appropriate section below.

If the correction is about a library bug or integration pattern (not project-specific), use `file_bug` or `file_reference` instead of updating CLAUDE.md.

After proposing the update, wait for my approval before writing to the file.
```

## Test with MCP Inspector

```bash
npm run inspect
```

This opens the MCP Inspector UI where you can test each tool interactively.

## How Indexing Works

On startup, the server:

1. Recursively finds all `.md` files under `BRAIN_PATH`
2. Parses YAML frontmatter for metadata (type, library, tags, severity, status)
3. Extracts structured sections (Symptom, Root Cause, Fix, Prevention) from bug files
4. Builds a BM25 index with field boosting:
   - `symptom` × 3.0 (highest — you search by what you see)
   - `title` × 2.5
   - `library` × 2.0
   - `rootCause` × 1.5
   - `tags` × 1.5
   - `fix` × 1.0
   - `fullText` × 1.0 (fallback for anything else)
5. Enables fuzzy matching (0.2 edit distance) and prefix search
6. Watches the directory for changes and auto-rebuilds

## Adding New Bugs

Follow the format in your existing knowledge base:

```bash
# Create a new bug file
touch /Users/tk/Desktop/brain/code_failures/bugs/<library>-<short-description>.md
```

Template:

```markdown
---
type: bug
library: <library name>
versions_affected: "<version range>"
status: confirmed
severity: critical|high|medium|low
tags:
  - tag1
  - tag2
---

# BUG: Short Description

## Symptom
What you see (error messages, behavior)

## Root Cause
Why it happens

## Fix
Working code

## Prevention
How to avoid it
```

The index auto-rebuilds when files change.
