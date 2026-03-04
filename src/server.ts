import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { KnowledgeIndex, type DocEntry } from "./indexer.js";

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatBugResult(doc: DocEntry): string {
  const parts = [
    `# ${doc.title}`,
    "",
    `**Library:** ${doc.library || "unknown"}`,
    `**Severity:** ${doc.severity || "unknown"}`,
    `**Status:** ${doc.status || "unknown"}`,
    `**File:** ${doc.id}`,
  ];

  if (doc.symptom) {
    parts.push("", "## Symptom", doc.symptom);
  }
  if (doc.rootCause) {
    parts.push("", "## Root Cause", doc.rootCause);
  }
  if (doc.fix) {
    parts.push("", "## Fix", doc.fix);
  }
  if (doc.prevention) {
    parts.push("", "## Prevention", doc.prevention);
  }

  return parts.join("\n");
}

function formatReferenceResult(doc: DocEntry): string {
  const parts = [
    `# ${doc.title}`,
    "",
    `**Type:** ${doc.type}`,
    `**File:** ${doc.id}`,
  ];

  if (doc.tags) {
    parts.push(`**Tags:** ${doc.tags}`);
  }

  // For references, return the full text since they're canonical patterns
  if (doc.fullText) {
    parts.push("", "---", "", doc.fullText);
  }

  return parts.join("\n");
}

function formatSearchResult(doc: DocEntry & { score: number }): string {
  return [
    `- **${doc.title}** (${doc.type}, score: ${doc.score.toFixed(2)})`,
    `  File: ${doc.id}`,
    doc.library ? `  Library: ${doc.library}` : "",
    doc.severity ? `  Severity: ${doc.severity}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Server ─────────────────────────────────────────────────────────────────

export async function createServer(brainPath: string) {
  const index = new KnowledgeIndex(brainPath);
  const docCount = await index.build();
  await index.startWatching();

  const server = new McpServer(
    {
      name: "code-failures",
      version: "1.0.0",
    },
    {
      capabilities: { logging: {} },
    }
  );

  // ── Tool: search_past_bugs ─────────────────────────────────────────────

  server.tool(
    "search_past_bugs",
    [
      "Search your code_failures knowledge base for bugs you've already solved.",
      "Query with error messages, symptoms, library names, or keywords.",
      `Currently indexing ${docCount} documents.`,
      "",
      "USE THIS TOOL BEFORE debugging any integration issue — your past self",
      "may have already spent hours finding the fix.",
    ].join("\n"),
    {
      query: z
        .string()
        .describe(
          "Error message, symptom description, or keywords (e.g. 'useCopilotChat undefined', 'SSE streaming broken FastAPI', 'BaseHTTPMiddleware')"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("Max results to return (default: 3)"),
    },
    async ({ query, maxResults }): Promise<CallToolResult> => {
      const results = index.searchBugs(query, maxResults ?? 3);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No matching bugs found for: "${query}"\n\nThis may be a new bug. After fixing it, consider adding it to code_failures/bugs/ following the Symptom → Root Cause → Fix → Prevention format.`,
            },
          ],
        };
      }

      const formatted = results.map(formatBugResult).join("\n\n---\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} matching bug(s):\n\n${formatted}`,
          },
        ],
      };
    }
  );

  // ── Tool: search_references ────────────────────────────────────────────

  server.tool(
    "search_references",
    [
      "Search your code_failures knowledge base for canonical working patterns,",
      "version guides, and integration references.",
      "",
      "USE THIS for questions like 'what's the correct CopilotKit + AG-UI setup?'",
      "or 'which versions are compatible?'",
    ].join("\n"),
    {
      query: z
        .string()
        .describe(
          "Library name, concept, or integration pattern (e.g. 'copilotkit langgraph agui setup', 'version compatibility')"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("Max results to return (default: 3)"),
    },
    async ({ query, maxResults }): Promise<CallToolResult> => {
      const results = index.searchReferences(query, maxResults ?? 3);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No matching references found for: "${query}"`,
            },
          ],
        };
      }

      const formatted = results.map(formatReferenceResult).join("\n\n---\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} reference(s):\n\n${formatted}`,
          },
        ],
      };
    }
  );

  // ── Tool: search_all ───────────────────────────────────────────────────

  server.tool(
    "search_all_knowledge",
    "Search across ALL documents (bugs + references) with relevance scoring. Use when you're not sure if something is a bug or a reference pattern.",
    {
      query: z
        .string()
        .describe("Any search terms"),
      maxResults: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results (default: 5)"),
    },
    async ({ query, maxResults }): Promise<CallToolResult> => {
      const results = index.searchAll(query, maxResults ?? 5);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results for: "${query}"`,
            },
          ],
        };
      }

      const summary = results.map(formatSearchResult).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} result(s):\n\n${summary}`,
          },
        ],
      };
    }
  );

  // ── Tool: get_document ─────────────────────────────────────────────────

  server.tool(
    "get_document",
    "Retrieve the full content of a specific document by its file path (as returned from search results).",
    {
      id: z
        .string()
        .describe(
          "Document ID / relative file path (e.g. 'bugs/starlette-BaseHTTPMiddleware-breaks-sse.md')"
        ),
    },
    async ({ id }): Promise<CallToolResult> => {
      const doc = index.getDocument(id);
      if (!doc) {
        return {
          content: [
            {
              type: "text",
              text: `Document not found: "${id}"\n\nAvailable documents:\n${index
                .listAll()
                .map((d) => `  - ${d.id}`)
                .join("\n")}`,
            },
          ],
        };
      }

      if (doc.type === "bug") {
        return { content: [{ type: "text", text: formatBugResult(doc) }] };
      }
      return { content: [{ type: "text", text: formatReferenceResult(doc) }] };
    }
  );

  // ── Tool: list_documents ───────────────────────────────────────────────

  server.tool(
    "list_documents",
    "List all indexed documents in the knowledge base.",
    {},
    async (): Promise<CallToolResult> => {
      const docs = index.listAll();
      if (docs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Knowledge base is empty. Add .md files to the code_failures directory.",
            },
          ],
        };
      }

      const grouped: Record<string, DocEntry[]> = {};
      for (const doc of docs) {
        const group = doc.type || "other";
        if (!grouped[group]) grouped[group] = [];
        grouped[group].push(doc);
      }

      const lines: string[] = [`# Knowledge Base (${docs.length} documents)`, ""];
      for (const [type, entries] of Object.entries(grouped)) {
        lines.push(`## ${type} (${entries.length})`);
        for (const entry of entries) {
          lines.push(
            `- **${entry.title}**${entry.library ? ` [${entry.library}]` : ""} — ${entry.id}`
          );
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── Tool: file_bug ──────────────────────────────────────────────────────

  server.tool(
    "file_bug",
    [
      "Save a newly discovered bug to the knowledge base.",
      "Call this AFTER solving a hard bug to capture the knowledge for future sessions.",
      "The file is written to code_failures/bugs/ and auto-indexed.",
      "",
      "IMPORTANT: Show the user the generated content and get confirmation before calling.",
    ].join("\n"),
    {
      library: z.string().describe("Library/package name (e.g. 'copilotkit', 'starlette')"),
      shortName: z
        .string()
        .describe(
          "Kebab-case short description for filename (e.g. 'useCopilotChat-undefined-messages')"
        ),
      versionsAffected: z.string().optional().describe("Version range (e.g. '1.50.0 – 1.52.1')"),
      severity: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Bug severity"),
      tags: z.array(z.string()).optional().describe("Tags for searchability"),
      title: z.string().describe("Bug title (e.g. 'useCopilotChat returns undefined visibleMessages')"),
      symptom: z.string().describe("What you observe — error messages, broken behavior"),
      rootCause: z.string().describe("Why it happens — the underlying mechanism"),
      fix: z.string().describe("Working solution with code examples"),
      prevention: z.string().optional().describe("How to avoid this in the future"),
    },
    async (args): Promise<CallToolResult> => {
      const filename = `${args.library.toLowerCase()}-${args.shortName}.md`;
      const filepath = join(brainPath, "bugs", filename);

      const today = new Date().toISOString().split("T")[0];
      const tagsYaml = args.tags?.length
        ? `\ntags:\n${args.tags.map((t) => `  - ${t}`).join("\n")}`
        : "";

      const content = `---
type: bug
library: ${args.library}
versions_affected: "${args.versionsAffected || "unknown"}"
status: confirmed
severity: ${args.severity || "medium"}
created: ${today}
updated: ${today}${tagsYaml}
---

# BUG: ${args.title}

## Symptom

${args.symptom}

## Root Cause

${args.rootCause}

## Fix

${args.fix}
${args.prevention ? `\n## Prevention\n\n${args.prevention}\n` : ""}
## Discovered

${today} — auto-filed by code-failures-mcp.
`;

      try {
        await mkdir(dirname(filepath), { recursive: true });
        await writeFile(filepath, content, "utf-8");
        // Index will auto-rebuild via file watcher, but force it for immediate availability
        await index.rebuild();

        return {
          content: [
            {
              type: "text",
              text: `Bug filed: ${filepath}\n\nThe knowledge base has been rebuilt (${index.documentCount} docs). This bug is now searchable in future sessions.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to write bug file: ${err}`,
            },
          ],
        };
      }
    }
  );

  // ── Tool: file_reference ────────────────────────────────────────────────

  server.tool(
    "file_reference",
    [
      "Save a reference document (canonical pattern, version guide, architecture notes) to the knowledge base.",
      "Use this for working integration patterns, version compatibility matrices, and architectural decisions.",
    ].join("\n"),
    {
      filename: z
        .string()
        .describe("Filename without extension (e.g. 'copilotkit-agui-langgraph-reference')"),
      title: z.string().describe("Document title"),
      tags: z.array(z.string()).optional().describe("Tags for searchability"),
      content: z
        .string()
        .describe(
          "Full markdown content (without frontmatter — it will be generated)"
        ),
    },
    async (args): Promise<CallToolResult> => {
      const filepath = join(brainPath, `${args.filename}.md`);
      const today = new Date().toISOString().split("T")[0];
      const tagsYaml = args.tags?.length
        ? `\ntags:\n${args.tags.map((t) => `  - ${t}`).join("\n")}`
        : "";

      const fileContent = `---\ntype: research\ntopic: ${args.title}\nstatus: evergreen\ncreated: ${today}\nupdated: ${today}${tagsYaml}\n---\n\n${args.content}\n`;

      try {
        await writeFile(filepath, fileContent, "utf-8");
        await index.rebuild();

        return {
          content: [
            {
              type: "text",
              text: `Reference filed: ${filepath}\n\nKnowledge base rebuilt (${index.documentCount} docs).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to write reference file: ${err}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

// ── Exports for direct usage ───────────────────────────────────────────────

export { StdioServerTransport };
