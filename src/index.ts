import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import type { Neo4jMemoryConfig } from "./config.js";
import { EMBEDDING_DIMS, configSchema as pluginConfigSchema } from "./config.js";
import { Neo4jMemoryStore } from "./neo4j-client.js";

// Keep compatibility with runtime plugin API differences.
type OpenClawPluginApi = {
  pluginConfig: unknown;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  registerTool: (...args: unknown[]) => void;
  registerCli: (handler: (api: unknown) => void, options?: unknown) => void;
  registerService: (svc: { id: string; start?: () => void; stop?: () => void }) => void;
  on: (hook: string, handler: (...args: unknown[]) => Promise<unknown> | unknown) => void;
  registerConfig?: (schema: unknown) => void;
};

type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other";

type MemoryRow = {
  id: string;
  text: string;
  category: MemoryCategory;
  score: number;
  source: string;
  eventAt: string;
};

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function formatRelevantMemoriesContext(memories: { category: MemoryCategory; text: string; score: number }[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((memory, index) => {
    const escaped = escapeHtml(memory.text);
    return `${index + 1}. [${memory.category}] ${escaped} (${(memory.score * 100).toFixed(0)}%)`;
  });

  return `\n<relevant-memories>\nSource: historical memory in Neo4j\n${lines.join("\n")}\n</relevant-memories>\n`;
}

function looksLikeInjection(text: string): boolean {
  const lowered = text.toLowerCase();
  if (lowered.includes("<system>") || lowered.includes("</system>")) return true;
  if (lowered.includes("ignore previous instructions")) return true;
  if (lowered.includes("assistant you must") && lowered.includes("forget")) return true;
  if (lowered.includes("system prompt")) return true;
  return false;
}

function detectCategory(text: string): MemoryCategory {
  const normalized = text.toLowerCase();
  if (normalized.includes("prefer") || normalized.includes("hate") || normalized.includes("like")) return "preference";
  if (normalized.includes("decide") || normalized.includes("decision") || normalized.includes("plan")) return "decision";
  if (/\b\d{1,4}(\.\d+)?\b/.test(normalized) || normalized.includes("server") || normalized.includes("url")) return "fact";
  if (/@[a-z0-9._-]+|https?:\/\/\S+/i.test(text)) return "entity";
  return "other";
}

function shouldCapture(text: string, maxChars = 500): boolean {
  if (!text || typeof text !== "string") return false;
  if (text.length < 20 || text.length > maxChars) return false;
  if (looksLikeInjection(text)) return false;
  if (text.includes("<relevant-memories>") || text.includes("<system>")) return false;
  if (text.trim().startsWith("* ") || text.includes("\n-")) return false;
  return true;
}

function extractUserTextFromEventMessages(messages: unknown[]): string[] {
  const values: string[] = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const msg = item as Record<string, unknown>;
    if (msg.role !== "user") continue;

    const content = msg.content;
    if (typeof content === "string") {
      values.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          values.push(b.text);
        }
      }
    }
  }
  return values;
}

class Embeddings {
  private readonly model: string;
  private readonly provider: Neo4jMemoryConfig["embedding"]["provider"];
  private readonly apiKey?: string;
  private readonly apiUrl?: string;
  private readonly enabled: boolean;
  private readonly vectorDimension: number;
  private readonly logger?: Pick<OpenClawPluginApi["logger"], "warn">;

  constructor(
    provider: Neo4jMemoryConfig["embedding"]["provider"],
    model: string,
    apiKey: string | undefined,
    apiUrl: string | undefined,
    vectorDimension: number,
    enabled: boolean,
    logger?: Pick<OpenClawPluginApi["logger"], "warn">,
  ) {
    this.provider = provider;
    this.model = model;
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.enabled = enabled;
    this.vectorDimension = vectorDimension;
    this.logger = logger;
  }

  async embed(text: string): Promise<number[]> {
    const prompt = String(text || "").trim();
    if (!prompt || this.provider === "disabled" || !this.enabled || !this.apiKey || !this.apiUrl) {
      return createDeterministicEmbedding(prompt, this.vectorDimension);
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.provider === "openrouter"
            ? {
                "HTTP-Referer": "https://github.com/45ck/openclaw-neo4j-memory-plugin",
                "X-Title": "OpenClaw Neo4j Memory Plugin",
              }
            : {}),
        },
        body: JSON.stringify({ model: this.model, input: [prompt] }),
      });

      if (!response.ok) {
        throw new Error(`embedding request failed: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = payload.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("embedding response missing vector");
      }

      return embedding;
    } catch (error) {
      this.logger?.warn(`neo4j-memory: embedding failed, using deterministic fallback: ${String(error)}`);
      return createDeterministicEmbedding(prompt, this.vectorDimension);
    }
  }
}

function createDeterministicEmbedding(text: string, dimensions: number): number[] {
  const normalized = text.trim().toLowerCase();
  const vector = new Array<number>(Math.max(0, dimensions));

  if (dimensions <= 0) return vector;
  if (normalized.length === 0) {
    return vector;
  }

  let normSq = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const digest = createHash("sha256").update(`${normalized}\u0000${i}`).digest();
    const value = (digest.readUInt32BE(0) / 0xffffffff) * 2 - 1;
    vector[i] = value;
    normSq += value * value;
  }

  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = vector[i] / norm;
  }

  return vector;
}

function clampVectorDimensions(vector: number[], maxDims: number): number[] {
  if (vector.length === maxDims) return vector;
  if (vector.length > maxDims) return vector.slice(0, maxDims);
  const padded = [...vector];
  while (padded.length < maxDims) {
    padded.push(0);
  }
  return padded;
}

function toToolRows(rows: MemoryRow[]) {
  return rows.map((entry, index) => `${index + 1}. [${entry.category}] ${entry.text}`).join("\n");
}

const memoryPlugin = {
  id: "claw-neo4j-memory-plugin",
  name: "Neo4j Memory",
  description: "Neo4j-backed long-term memory with graph-aware capture and recall",
  kind: "memory" as const,
  configSchema: {
    parse(value: unknown): Neo4jMemoryConfig {
      return pluginConfigSchema.parse(value);
    },
    uiHints: pluginConfigSchema.uiHints,
    jsonSchema: pluginConfigSchema.jsonSchema,
  },

  register(api: OpenClawPluginApi) {
    const cfg = pluginConfigSchema.parse(api.pluginConfig);
    const vectorDim = cfg.neo4j.vectorDimension ?? EMBEDDING_DIMS[cfg.embedding.model] ?? 1536;
    const embeddings = new Embeddings(
      cfg.embedding.provider,
      cfg.embedding.model,
      cfg.embedding.apiKey,
      cfg.embedding.apiUrl,
      vectorDim,
      cfg.embedding.enabled,
      api.logger,
    );
    const db = new Neo4jMemoryStore(cfg);

    void db.bootstrapSchema().catch((err: unknown) => api.logger.warn(`neo4j-memory: schema bootstrap failed: ${String(err)}`));

    api.logger.info(
      `neo4j-memory: registering plugin (db: ${cfg.neo4j.uri}, dim: ${vectorDim}, embedding: ${cfg.embedding.provider}, enabled: ${cfg.embedding.enabled})`,
    );

    const defaultRecallLimit = Math.max(1, Math.min(cfg.recallLimit, 20));
    const captureMaxChars = cfg.captureMaxChars ?? 500;

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description: "Search long-term memories by semantic similarity and return ranked matches.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        }),
        async execute(_toolCallId: string, params: { query: string; limit?: number }) {
          const query = (params.query || "").trim();
          const limit = params.limit ?? defaultRecallLimit;

          if (query.length < 3) {
            return {
              content: [{ type: "text", text: "No query provided." }],
              details: { count: 0, memories: [] },
            };
          }

          const vector = await embeddings.embed(query);
          const vectorResults =
            cfg.embedding.enabled && cfg.embedding.provider !== "disabled"
              ? await db.searchByVector(clampVectorDimensions(vector, vectorDim), limit)
              : [];
          const results = vectorResults.length > 0 ? vectorResults : await db.searchByText(query, limit);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, memories: [] },
            };
          }

          return {
            content: [{ type: "text", text: `Found ${results.length} memories:\n\n${toToolRows(results)}` }],
            details: {
              count: results.length,
              memories: results.map((entry: MemoryRow) => ({
                id: entry.id,
                category: entry.category,
                score: entry.score,
                text: entry.text,
              })),
            },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description: "Store explicit memory entries.",
        parameters: Type.Object({
          text: Type.String({ minLength: 5 }),
          importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          category: Type.Optional(
            Type.Union([
              Type.Literal("preference"),
              Type.Literal("fact"),
              Type.Literal("decision"),
              Type.Literal("entity"),
              Type.Literal("other"),
            ]),
          ),
          source: Type.Optional(Type.String()),
        }),
        async execute(
          _toolCallId: string,
          params: { text: string; importance?: number; category?: MemoryCategory; source?: string },
        ) {
          const text = (params.text || "").trim();
          if (!text) {
            return {
              content: [{ type: "text", text: "No text provided." }],
              details: { error: "empty-text" },
            };
          }

          const vector = await embeddings.embed(text);
          const upsert = await db.upsertMemory({
            text,
            vector: clampVectorDimensions(vector, vectorDim),
            category: params.category ?? detectCategory(text),
            source: params.source ?? "tool",
            importance: params.importance ?? 0.5,
            skipDuplicate: cfg.skipShortDuplicates,
          });

          if (upsert.action === "created") {
            await db.ensureEntityLinks(text, upsert.id);
            return {
              content: [{ type: "text", text: `Stored memory (${upsert.id}).` }],
              details: { action: "created", id: upsert.id },
            };
          }

          return {
            content: [{ type: "text", text: `Duplicate memory skipped (id ${upsert.id}).` }],
            details: { action: "duplicate", id: upsert.id },
          };
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Forget one memory by ID, or get candidate IDs from query text.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String()),
          query: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: { memoryId?: string; query?: string }) {
          if (params.memoryId) {
            const deleted = await db.deleteMemoryById(params.memoryId);
            if (!deleted) {
              return {
                content: [{ type: "text", text: `No memory found: ${params.memoryId}` }],
                details: { action: "missing", id: params.memoryId },
              };
            }

            return {
              content: [{ type: "text", text: `Deleted memory ${params.memoryId}.` }],
              details: { action: "deleted", id: params.memoryId },
            };
          }

          if (!params.query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_input" },
            };
          }

          const result = await db.searchByText(params.query, 5);
          if (result.length === 0) {
            return {
              content: [{ type: "text", text: "No matching memory found." }],
              details: { action: "missing", count: 0 },
            };
          }

          const candidates = result.slice(0, 3).map((r: MemoryRow) => ({ id: r.id, text: r.text }));
          return {
            content: [
              {
                type: "text",
                text: "Pass memoryId to delete one of:\n" + candidates.map((c) => `- ${c.id} ${c.text}`).join("\n"),
              },
            ],
            details: { action: "candidates", candidates },
          };
        },
      },
      { name: "memory_forget" },
    );

    api.registerCli(
      ((cliApi: unknown) => {
        const root: any =
          cliApi && typeof cliApi === "object" && "command" in cliApi ? cliApi : (cliApi as { program?: { command?: (...args: any[]) => any } }).program;
        if (!root || typeof root.command !== "function") return;

        const memories = root.command("ltm").description("Neo4j memory plugin commands");

        memories
          .command("stats")
          .description("Show memory totals")
          .action(async () => {
            const stats = await db.getStats();
            console.log(`Total memories: ${stats.total}`);
            for (const [category, count] of Object.entries(stats.byCategory)) {
              console.log(`- ${category}: ${count}`);
            }
          });

        memories
          .command("list")
          .description("List latest memories")
          .option("--limit <n>", "max rows", "10")
          .action(async (opts: { limit?: string }) => {
            const limit = Number(opts.limit || 10);
            const rows = await db.listRecent(limit);
            console.log(
              rows
                .map((row) => `${row.id} | ${row.eventAt} | ${row.category} | ${row.text.slice(0, 120)}`)
                .join("\n"),
            );
          });

        memories
          .command("search")
          .description("Search memories")
          .argument("<query>", "search text")
          .option("--limit <n>", "max rows", "10")
          .action(async (query: string, opts: { limit?: string }) => {
            const limit = Number(opts.limit || 10);
            const rows = await db.searchByText(query, limit);
            console.log(
              JSON.stringify(rows.map((r: MemoryRow) => ({ id: r.id, category: r.category, score: r.score, text: r.text })), null, 2),
            );
          });
      }) as unknown as (...args: any[]) => void,
      { commands: ["ltm"] },
    );

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (...args: unknown[]) => {
        const event = (args[0] as { prompt?: string }) ?? {};
        const prompt = event.prompt?.trim();
        if (!prompt || prompt.length < 6) return;

        try {
          const vector = await embeddings.embed(prompt);
          let rows =
            cfg.embedding.enabled && cfg.embedding.provider !== "disabled"
              ? await db.searchByVector(clampVectorDimensions(vector, vectorDim), defaultRecallLimit)
              : [];
          if (rows.length === 0) {
            rows = await db.searchByText(prompt, defaultRecallLimit);
          }
          if (rows.length === 0) return;

          return {
            prependContext: formatRelevantMemoriesContext(
              rows.map((row) => ({ category: row.category, text: row.text, score: row.score })),
            ),
          };
        } catch (error) {
          api.logger.warn(`neo4j-memory: recall failed: ${String(error)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (...args: unknown[]) => {
        const event = (args[0] as { messages?: unknown[]; success?: boolean }) ?? {};
        if (!event.success || !Array.isArray(event.messages) || event.messages.length === 0) return;

        const rawTexts = extractUserTextFromEventMessages(event.messages);
        const candidates = rawTexts.filter((item) => shouldCapture(item, captureMaxChars));
        if (candidates.length === 0) return;

        let stored = 0;
        for (const text of candidates.slice(0, 3)) {
          const category = detectCategory(text);
          const vector = await embeddings.embed(text);
          const upsert = await db.upsertMemory({
            text,
            vector: clampVectorDimensions(vector, vectorDim),
            category,
            source: "agent_turn",
            skipDuplicate: cfg.skipShortDuplicates,
          });
          if (upsert.action === "created") {
            await db.ensureEntityLinks(text, upsert.id);
            stored += 1;
          }
        }

        if (stored > 0) {
          api.logger.info(`neo4j-memory: auto-captured ${stored} memories`);
        }
      });
    }

    api.registerService({
      id: "neo4j-memory-service",
      start: () => api.logger.info("neo4j-memory: service started"),
      stop: () => {
        void db.close().catch(() => {});
        api.logger.info("neo4j-memory: service stopped");
      },
    });
  },
};

export default memoryPlugin;
