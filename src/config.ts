import { Type } from "@sinclair/typebox";

export const EMBEDDING_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

const DEFAULT_MODEL = "text-embedding-3-small";

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envName: string) => {
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(`Environment variable ${envName} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export type Neo4jMemoryConfig = {
  neo4j: {
    uri: string;
    username: string;
    password: string;
    database: string;
    vectorDimension?: number;
  };
  embedding: {
    model: string;
    apiKey: string;
  };
  autoRecall: boolean;
  autoCapture: boolean;
  captureMaxChars: number;
  recallLimit: number;
  skipShortDuplicates: boolean;
};

export const configSchema = {
  parse(value: unknown): Neo4jMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }

    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, [
      "neo4j",
      "embedding",
      "autoRecall",
      "autoCapture",
      "captureMaxChars",
      "recallLimit",
      "skipShortDuplicates",
    ], "memory config");

    const neo4j = cfg.neo4j as Record<string, unknown> | undefined;
    if (!neo4j || typeof neo4j !== "object" || Array.isArray(neo4j)) {
      throw new Error("memory.config.neo4j required");
    }
    assertAllowedKeys(neo4j, [
      "uri",
      "username",
      "password",
      "database",
      "vectorDimension",
    ], "neo4j config");

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) {
      throw new Error("memory.config.embedding required");
    }
    assertAllowedKeys(embedding, ["model", "apiKey"], "embedding config");

    const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
    if (!EMBEDDING_DIMS[model]) {
      throw new Error(`Unsupported embedding model: ${model}`);
    }

    if (typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }

    return {
      neo4j: {
        uri: typeof neo4j.uri === "string" ? neo4j.uri : "bolt://localhost:7687",
        username: typeof neo4j.username === "string" ? neo4j.username : "neo4j",
        password: resolveEnvVars(String(neo4j.password ?? "")),
        database: typeof neo4j.database === "string" ? neo4j.database : "memory",
        vectorDimension:
          typeof neo4j.vectorDimension === "number"
            ? neo4j.vectorDimension
            : EMBEDDING_DIMS[model],
      },
      embedding: {
        model,
        apiKey: resolveEnvVars(String(embedding.apiKey)),
      },
      autoRecall: cfg.autoRecall !== false,
      autoCapture: cfg.autoCapture !== false,
      captureMaxChars: typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : 500,
      recallLimit: typeof cfg.recallLimit === "number" ? Math.floor(cfg.recallLimit) : 5,
      skipShortDuplicates: cfg.skipShortDuplicates !== false,
    };
  },
  uiHints: {
    "neo4j.uri": {
      label: "Neo4j URI",
      help: "Bolt URI for Neo4j, for example bolt://localhost:7687",
      placeholder: "bolt://localhost:7687",
    },
    "neo4j.username": { label: "Neo4j User", help: "Neo4j auth username", placeholder: "neo4j" },
    "neo4j.password": {
      label: "Neo4j Password",
      sensitive: true,
      help: "Resolved from runtime environment if set as ${OPEN...}",
      placeholder: "${NEO4J_PASSWORD}",
    },
    "neo4j.database": { label: "Neo4j Database", placeholder: "memory", help: "Logical database name" },
    "embedding.apiKey": { label: "OpenAI Key", sensitive: true, placeholder: "${OPENAI_API_KEY}" },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model for query and capture vectors",
    },
    autoRecall: { label: "Auto Recall", help: "Inject relevant memories into context before each turn" },
    autoCapture: { label: "Auto Capture", help: "Capture important user-facing statements after turn" },
    captureMaxChars: { label: "Capture Max Chars", placeholder: "500" },
    recallLimit: { label: "Recall Limit", placeholder: "5" },
    skipShortDuplicates: { label: "Skip short exact duplicates", help: "Prevents duplicate writes for short texts" },
  },
  jsonSchema: Type.Object({
    neo4j: Type.Object({
      uri: Type.String({ minLength: 1 }),
      username: Type.String({ minLength: 1 }),
      password: Type.String({ minLength: 1 }),
      database: Type.Optional(Type.String()),
      vectorDimension: Type.Optional(Type.Integer({ minimum: 2 })),
    }),
    embedding: Type.Object({
      model: Type.Union([
        Type.Literal("text-embedding-3-small"),
        Type.Literal("text-embedding-3-large"),
      ]),
      apiKey: Type.String({ minLength: 1 }),
    }),
    autoRecall: Type.Optional(Type.Boolean()),
    autoCapture: Type.Optional(Type.Boolean()),
    captureMaxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 20000 })),
    recallLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    skipShortDuplicates: Type.Optional(Type.Boolean()),
  }),
};
