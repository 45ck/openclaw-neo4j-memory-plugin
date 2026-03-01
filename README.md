# openclaw-neo4j-memory-plugin

A standalone OpenClaw plugin that stores long-term memory directly in **Neo4j** with vector recall, graph-style entity links, and auto recall/capture hooks.

This repo is a public OSS plugin that can be installed into any OpenClaw-based setup.

## What this plugin provides

- Plugin ID: `openclaw-neo4j-memory-plugin`
- Hooked into OpenClaw `memory` slot
- Vector recall (`memory_recall`), explicit write (`memory_store`), and forget (`memory_forget`) tools
- Auto recall hook on each turn via `before_agent_start`
- Auto capture hook from user content on `agent_end`
- Deterministic duplicate suppression with text fingerprinting
- Optional fallback to full-text matching if vector index is not ready

## Requirements

- Neo4j 5.x (for vector index support)
- Embedding provider credentials are optional:
  - keep embeddings enabled with a compatible OpenRouter-compatible endpoint (for example `openrouter`), or
  - run in text-first mode with `embedding.provider: "disabled"` (default)
- Node.js >= 20
- OpenClaw runtime version that supports plugin loading (`plugins` and `plugins.slots.memory`)

## Configure Neo4j locally

```bash
docker run --name neo4j-memory \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  neo4j:5
```

## Build

```bash
npm ci
npm run build
```

## Use in OpenClaw

From your OpenClaw host:

```bash
cd /path/to/openclaw
openclaw plugins install https://github.com/45ck/openclaw-neo4j-memory-plugin.git
```

You can also install locally for dev:

```bash
git clone https://github.com/45ck/openclaw-neo4j-memory-plugin.git
cd openclaw-neo4j-memory-plugin
npm ci
npm run build
openclaw plugins install .
```

Then in OpenClaw config:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-neo4j-memory-plugin"
    },
    "entries": {
      "openclaw-neo4j-memory-plugin": {
        "enabled": true,
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "username": "neo4j",
            "password": "${NEO4J_PASSWORD}",
            "database": "neo4j",
            "vectorDimension": 1536
          },
          "embedding": {
            "provider": "disabled",
            "enabled": false
          },
          "autoRecall": true,
          "autoCapture": true,
          "captureMaxChars": 500,
          "recallLimit": 5,
          "skipShortDuplicates": true
        }
      }
    }
  }
}
```

Example with OpenRouter embeddings (optional):

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-neo4j-memory-plugin"
    },
    "entries": {
      "openclaw-neo4j-memory-plugin": {
        "enabled": true,
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "username": "neo4j",
            "password": "${NEO4J_PASSWORD}",
            "database": "neo4j"
          },
          "embedding": {
            "provider": "openrouter",
            "apiKey": "${OPENROUTER_API_KEY}",
            "apiUrl": "https://openrouter.ai/api/v1/embeddings",
            "model": "text-embedding-3-small",
            "enabled": true
          },
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

## Duplicate prevention and write-load control

This plugin uses a fingerprint dedupe strategy:

- Every incoming memory is normalized, hashed, and compared with existing fingerprint
- If `skipShortDuplicates` is `true`, exact duplicates are skipped before writes
- The plugin caps automatic capture to 3 user messages per turn

For hard production protection, keep `captureMaxChars` conservative at first and monitor write TPS on Neo4j.

### Best-practice hardening

- Start with `skipShortDuplicates: true`
- Set `captureMaxChars` to 400-800 for noisy chat environments
- Add `autoCapture: false` during sensitive operations and run `memory_store` explicitly

## Benchmark suite (stub)

`benchmark/` contains a harness scaffold for comparing providers.

```bash
npm run build
npm run benchmark
```

Generated report file:

- `dist-benchmark/reports/memory-benchmark.json`

Current implementation ships deterministic stubs for external providers. Replace `runProviderRecall` in `benchmark/run-benchmark.ts` with concrete Graphiti/Cognee/Mem0 calls when backend services are available.

## Public repo setup (GitHub)

From this folder:

```bash
git init
git add .
git commit -m "Initial open-source Neo4j OpenClaw memory plugin"
gh repo create openclaw-neo4j-memory-plugin --public --source=. --remote=origin
git push -u origin main
```

## Notes

- If vector index is unavailable, plugin falls back to full-text index text search.
- For full graph-aware query use, extend `neo4j-client.ts` with richer Cypher traversals for your domain graph.
- For private environments, keep Neo4j bound to private networking and do not expose Bolt directly.

