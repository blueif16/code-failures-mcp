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

### CLI (recommended)

```bash
# Global
claude mcp add code-failures -e BRAIN_PATH=/Users/tk/Desktop/brain/code_failures -- node /Users/tk/Desktop/code-failures-mcp/dist/index.js

# Project-scoped
claude mcp add -s project code-failures -e BRAIN_PATH=/Users/tk/Desktop/brain/code_failures -- node /Users/tk/Desktop/code-failures-mcp/dist/index.js
```

Verify with:

```bash
claude mcp list
```

### JSON config

Add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-project):

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
## Bug Knowledge Base (MCP: code-failures)

IMPORTANT: Before debugging ANY integration issue with CopilotKit, AG-UI,
LangGraph, Starlette, FastAPI streaming, or SSE — ALWAYS call
`search_past_bugs` first with the error message or symptom description.

Before writing integration code for these libraries, call `search_references`
to get the canonical working pattern and version compatibility info.
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
