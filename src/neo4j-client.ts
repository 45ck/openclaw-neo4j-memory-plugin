import neo4j from "neo4j-driver";
import { createHash } from "node:crypto";
import type { Neo4jMemoryConfig } from "./config.js";

type MemoryEntryCategory = "preference" | "fact" | "decision" | "entity" | "other";

type MemoryRecord = {
  id: string;
  text: string;
  category: MemoryEntryCategory;
  score: number;
  source: string;
  eventAt: string;
  fingerprint: string;
  importance?: number;
};

type UpsertResult = { action: "created"; id: string } | { action: "duplicate"; id: string };

type NodeProperties = Record<string, unknown>;
type NodeLike = { properties: NodeProperties };
type ScoreValue = number | { toNumber?: () => number };

type Neo4jScoreRecord = { node: NodeLike; score: ScoreValue };

const MEMORY_INDEX_TEXT = "memory_text_ft";
const MEMORY_INDEX_VECTOR = "memory_vector";
const MEMORY_NODE_LABEL = "Memory";

function nowIso(): string {
  return new Date().toISOString();
}

export class Neo4jMemoryStore {
  private readonly driver: neo4j.Driver;
  private readonly db: string;
  private readonly vectorDimensions: number;

  constructor(cfg: Neo4jMemoryConfig) {
    this.driver = neo4j.driver(cfg.neo4j.uri, neo4j.auth.basic(cfg.neo4j.username, cfg.neo4j.password), {
      encrypted: "ENCRYPTION_OFF",
    });
    this.db = cfg.neo4j.database;
    this.vectorDimensions = cfg.neo4j.vectorDimension ?? 1536;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private session(): neo4j.Session {
    return this.driver.session({ database: this.db });
  }

  async bootstrapSchema(): Promise<void> {
    const s = this.session();
    const queries = [
      `CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:${MEMORY_NODE_LABEL}) REQUIRE m.id IS UNIQUE`,
      `CREATE CONSTRAINT memory_fingerprint IF NOT EXISTS FOR (m:${MEMORY_NODE_LABEL}) REQUIRE m.fingerprint IS UNIQUE`,
      `CREATE FULLTEXT INDEX ${MEMORY_INDEX_TEXT} IF NOT EXISTS FOR (m:${MEMORY_NODE_LABEL}) ON EACH [m.text]`,
      `CREATE INDEX memory_eventAt IF NOT EXISTS FOR (m:${MEMORY_NODE_LABEL}) ON (m.eventAt)`,
      `CREATE INDEX memory_category IF NOT EXISTS FOR (m:${MEMORY_NODE_LABEL}) ON (m.category)`,
    ];

    const vectorIndex =
      `CREATE VECTOR INDEX ${MEMORY_INDEX_VECTOR} IF NOT EXISTS FOR (m:${MEMORY_NODE_LABEL}) ON (m.vector) OPTIONS {indexConfig: {` +
      ` 'vector.dimensions': ${this.vectorDimensions},` +
      ` 'vector.similarity_function': 'cosine'` +
      " } }";

    try {
      for (const query of [...queries, vectorIndex]) {
        try {
          await s.run(query);
        } catch (_err) {
          // Best-effort schema bootstrapping to tolerate Neo4j edition/version differences.
        }
      }
    } finally {
      await s.close();
    }
  }

  async count(): Promise<number> {
    const s = this.session();
    try {
      const result = await s.run(`MATCH (m:${MEMORY_NODE_LABEL}) RETURN count(m) AS count`);
      return Number(result.records[0]?.get("count")?.toNumber?.() ?? 0);
    } finally {
      await s.close();
    }
  }

  async searchByText(queryText: string, limit: number): Promise<MemoryRecord[]> {
    const s = this.session();
    try {
      try {
        const result = await s.run(
          `CALL db.index.fulltext.queryNodes('${MEMORY_INDEX_TEXT}', $query) YIELD node, score RETURN node, score LIMIT $limit`,
          {
            query: queryText,
            limit: Number(limit),
          },
        );
        return result.records
          .map((record) => this.hydrateRecord({ node: record.get("node"), score: record.get("score") }));
      } catch (_err) {
        const fallback = await s.run(
          `MATCH (m:${MEMORY_NODE_LABEL}) WHERE toLower(m.text) CONTAINS toLower($queryText) RETURN m AS node LIMIT $limit`,
          { queryText, limit: Number(limit) },
        );
        return fallback.records.map((record) => this.hydrateRecord({ node: record.get("node"), score: 1 }));
      }
    } finally {
      await s.close();
    }
  }

  async searchByVector(queryVector: number[], limit: number): Promise<MemoryRecord[]> {
    const s = this.session();
    try {
      const result = await s.run(
        `CALL db.index.vector.queryNodes('${MEMORY_INDEX_VECTOR}', $limit, $vector) YIELD node, score RETURN node, score`,
        {
          limit: Number(limit),
          vector: queryVector,
        },
      );
      return result.records
        .map((record) => this.hydrateRecord({ node: record.get("node"), score: record.get("score") }));
    } catch (_err) {
      return [];
    } finally {
      await s.close();
    }
  }

  private hydrateRecord(input: Neo4jScoreRecord): MemoryRecord {
    const properties = input.node?.properties ?? {};
    const rawScore = input.score;
    const score =
      typeof rawScore === "number"
        ? rawScore
        : typeof rawScore === "object" && rawScore && "toNumber" in rawScore && typeof rawScore.toNumber === "function"
          ? rawScore.toNumber()
          : 0;

    return {
      id: String(properties.id ?? ""),
      text: String(properties.text ?? ""),
      category: String(properties.category ?? "other") as MemoryEntryCategory,
      score,
      source: String(properties.source ?? "agent"),
      eventAt: String(properties.eventAt ?? nowIso()),
      fingerprint: String(properties.fingerprint ?? ""),
      importance: properties.importance ? Number(properties.importance) : undefined,
    };
  }

  private fingerprint(text: string): string {
    return createHash("sha256").update(text.trim().toLowerCase()).digest("hex");
  }

  async upsertMemory(params: {
    text: string;
    vector: number[];
    category: MemoryEntryCategory;
    source: string;
    importance?: number;
    skipDuplicate: boolean;
  }): Promise<UpsertResult> {
    const fingerprint = this.fingerprint(params.text);
    const id = createHash("sha1").update(`${fingerprint}|${params.source}`).digest("hex");
    const eventAt = nowIso();
    const vector = params.vector.slice(0, this.vectorDimensions);
    const s = this.session();

    try {
      if (params.skipDuplicate) {
        const existing = await s.run(`MATCH (m:${MEMORY_NODE_LABEL} {fingerprint:$fingerprint}) RETURN m.id AS id LIMIT 1`, {
          fingerprint,
        });
        if (existing.records.length > 0) {
          return { action: "duplicate", id: String(existing.records[0].get("id")) };
        }
      }

      await s.run(
        `MERGE (m:${MEMORY_NODE_LABEL} {id:$id})
         SET m.text=$text,
             m.category=$category,
             m.source=$source,
             m.importance=$importance,
             m.fingerprint=$fingerprint,
             m.eventAt=$eventAt,
             m.createdAt=$eventAt,
             m.vector=$vector,
             m.updatedAt=$eventAt`,
        {
          id,
          text: params.text,
          category: params.category,
          source: params.source,
          importance: params.importance ?? 0.5,
          fingerprint,
          eventAt,
          vector,
        },
      );

      return { action: "created", id };
    } finally {
      await s.close();
    }
  }

  async deleteMemoryById(id: string): Promise<boolean> {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (m:${MEMORY_NODE_LABEL} {id:$id}) DETACH DELETE m RETURN count(m) AS removed`,
        { id },
      );
      const removed = Number(result.records[0]?.get("removed")?.toNumber?.() ?? 0);
      return removed > 0;
    } finally {
      await s.close();
    }
  }

  async listRecent(limit = 20): Promise<MemoryRecord[]> {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (m:${MEMORY_NODE_LABEL}) RETURN m AS node ORDER BY m.eventAt DESC LIMIT $limit`,
        { limit: Number(limit) },
      );
      return result.records.map((record) => this.hydrateRecord({ node: record.get("node"), score: 1 }));
    } finally {
      await s.close();
    }
  }

  async getStats(): Promise<{ total: number; byCategory: Record<string, number> }> {
    const s = this.session();
    try {
      const total = await this.count();
      const byCategoryResult = await s.run(
        `MATCH (m:${MEMORY_NODE_LABEL}) RETURN m.category AS category, count(m) AS count`,
      );
      const byCategory: Record<string, number> = {};

      for (const record of byCategoryResult.records) {
        const category = String(record.get("category") ?? "other");
        byCategory[category] = Number(record.get("count")?.toNumber?.() ?? 0);
      }

      return { total, byCategory };
    } finally {
      await s.close();
    }
  }

  async ensureEntityLinks(text: string, memoryId: string): Promise<void> {
    const entities = extractEntities(text);
    if (entities.length === 0) {
      return;
    }

    const s = this.session();
    try {
      for (const entity of entities.slice(0, 12)) {
        await s.run(
          `MATCH (m:${MEMORY_NODE_LABEL} {id:$memoryId})
           MERGE (e:Entity {name:$entity})
           ON CREATE SET e.type = "nlp_entity", e.createdAt = $eventAt
           MERGE (m)-[:MENTIONS]->(e)`,
          { memoryId, entity, eventAt: nowIso() },
        );
      }
    } finally {
      await s.close();
    }
  }
}

function extractEntities(text: string): string[] {
  const unique = new Set<string>();
  const raw = text.match(/[A-Z][a-zA-Z0-9._-]+/g) ?? [];
  for (const token of raw) {
    if (token.length >= 3 && token.length <= 80) {
      unique.add(token);
    }
  }
  return [...unique];
}
