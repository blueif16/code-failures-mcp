import { readdir, readFile, stat, watch } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import MiniSearch from "minisearch";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DocEntry {
  id: string;           // relative filepath
  filename: string;
  title: string;
  type: string;         // bug | research | reference
  library: string;
  tags: string;         // space-separated for indexing
  severity: string;
  status: string;
  symptom: string;      // extracted from ## Symptom section
  rootCause: string;    // extracted from ## Root Cause section
  fix: string;          // extracted from ## Fix section
  prevention: string;   // extracted from ## Prevention section
  fullText: string;     // entire file content
}

// ── Frontmatter parser ─────────────────────────────────────────────────────

function parseFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const fmRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
  const match = content.match(fmRegex);
  if (!match) return { meta: {}, body: content };

  const rawYaml = match[1];
  const body = match[2];

  // Simple YAML-ish parser for flat + array fields (avoids heavy yaml dep at runtime)
  const meta: Record<string, unknown> = {};
  const lines = rawYaml.split("\n");
  let currentKey = "";
  let currentArray: string[] = [];
  let inArray = false;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kvMatch) {
      if (inArray) {
        meta[currentKey] = currentArray;
        inArray = false;
        currentArray = [];
      }
      const [, key, value] = kvMatch;
      if (value.trim() === "") {
        // Could be start of array or empty value
        currentKey = key;
      } else {
        meta[key] = value.replace(/^["']|["']$/g, "").trim();
      }
    } else if (line.match(/^\s+-\s+/)) {
      // Array item
      if (!inArray) {
        inArray = true;
        currentArray = [];
      }
      const val = line.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim();
      currentArray.push(val);
    }
  }
  if (inArray) {
    meta[currentKey] = currentArray;
  }

  return { meta, body };
}

// ── Section extractor ──────────────────────────────────────────────────────

function extractSection(body: string, heading: string): string {
  // Match ## Heading (case-insensitive) and grab content until next ## or EOF
  const pattern = new RegExp(
    `^##\\s+${heading}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$)`,
    "im"
  );
  const match = body.match(pattern);
  return match ? match[1].trim().slice(0, 2000) : ""; // cap per-section at 2k chars
}

function extractTitle(body: string, filename: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  // Fallback: humanize filename
  return filename
    .replace(/\.md$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── File → DocEntry ────────────────────────────────────────────────────────

function parseDocument(filepath: string, content: string, rootDir: string): DocEntry {
  const { meta, body } = parseFrontmatter(content);
  const relPath = relative(rootDir, filepath);
  const fname = basename(filepath);

  const tags = Array.isArray(meta.tags)
    ? (meta.tags as string[]).join(" ")
    : typeof meta.tags === "string"
      ? meta.tags
      : "";

  return {
    id: relPath,
    filename: fname,
    title: extractTitle(body, fname),
    type: (meta.type as string) || "unknown",
    library: (meta.library as string) || "",
    tags,
    severity: (meta.severity as string) || "",
    status: (meta.status as string) || "",
    symptom: extractSection(body, "Symptom"),
    rootCause: extractSection(body, "Root Cause"),
    fix: extractSection(body, "Fix"),
    prevention: extractSection(body, "Prevention"),
    fullText: body.slice(0, 8000), // cap total text to keep index lean
  };
}

// ── Recursive .md file discovery ───────────────────────────────────────────

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        results.push(...(await findMarkdownFiles(fullPath)));
      } else if (entry.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // dir might not exist yet
  }
  return results;
}

// ── Index builder ──────────────────────────────────────────────────────────

export class KnowledgeIndex {
  private index: MiniSearch<DocEntry>;
  private docs: Map<string, DocEntry> = new Map();
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.index = new MiniSearch<DocEntry>({
      fields: [
        "title",
        "library",
        "tags",
        "symptom",
        "rootCause",
        "fix",
        "prevention",
        "fullText",
      ],
      storeFields: [
        "id",
        "filename",
        "title",
        "type",
        "library",
        "tags",
        "severity",
        "status",
        "symptom",
        "rootCause",
        "fix",
        "prevention",
      ],
      // Boost symptom and title heavily — those are what you search by
      searchOptions: {
        boost: { symptom: 3, title: 2.5, library: 2, rootCause: 1.5, tags: 1.5, fix: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  async build(): Promise<number> {
    const files = await findMarkdownFiles(this.rootDir);
    const entries: DocEntry[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        const doc = parseDocument(file, content, this.rootDir);
        entries.push(doc);
        this.docs.set(doc.id, doc);
      } catch (err) {
        console.error(`[index] Failed to parse ${file}:`, err);
      }
    }

    this.index.addAll(entries);
    console.error(`[index] Indexed ${entries.length} documents from ${this.rootDir}`);
    return entries.length;
  }

  async rebuild(): Promise<number> {
    this.index.removeAll();
    this.docs.clear();
    return this.build();
  }

  searchBugs(query: string, maxResults = 5): DocEntry[] {
    const results = this.index.search(query, {
      filter: (result) => result.type === "bug",
    });
    return results.slice(0, maxResults).map((r) => this.docs.get(r.id)!).filter(Boolean);
  }

  searchReferences(query: string, maxResults = 5): DocEntry[] {
    const results = this.index.search(query, {
      filter: (result) => result.type !== "bug",
    });
    return results.slice(0, maxResults).map((r) => this.docs.get(r.id)!).filter(Boolean);
  }

  searchAll(query: string, maxResults = 10): Array<DocEntry & { score: number }> {
    const results = this.index.search(query);
    return results.slice(0, maxResults).map((r) => ({
      ...this.docs.get(r.id)!,
      score: r.score,
    })).filter((d) => d.id);
  }

  getDocument(id: string): DocEntry | undefined {
    return this.docs.get(id);
  }

  listAll(): DocEntry[] {
    return Array.from(this.docs.values());
  }

  get documentCount(): number {
    return this.docs.size;
  }

  /** Watch for file changes and rebuild (best-effort, non-blocking) */
  async startWatching(): Promise<void> {
    try {
      const watcher = watch(this.rootDir, { recursive: true });
      // Fire-and-forget rebuild on changes, debounced
      let debounce: ReturnType<typeof setTimeout> | null = null;
      (async () => {
        for await (const event of watcher) {
          if (!event.filename?.endsWith(".md")) continue;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            console.error(`[index] File changed: ${event.filename}, rebuilding...`);
            this.rebuild().catch((err) =>
              console.error("[index] Rebuild failed:", err)
            );
          }, 500);
        }
      })().catch(() => {
        // watcher closed, that's fine
      });
    } catch {
      console.error("[index] File watching not available, index is static");
    }
  }
}
