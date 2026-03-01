# openclaw-neo4j-memory-plugin

A standalone OpenClaw plugin that stores long-term memory directly in **Neo4j** with vector recall, graph-style entity links, and auto recall/capture hooks.

This repo is intended to be used as a public OSS plugin, installed into CLAW separately from the main platform repository.

## What this plugin provides

- Plugin ID: `neo4j-memory`
- Hooked into OpenClaw `memory` slot
- Vector recall (`memory_recall`), explicit write (`memory_store`), and forget (`memory_forget`) tools
- Auto recall hook on each turn via `before_agent_start`
- Auto capture hook from user content on `agent_end`
- Deterministic duplicate suppression with text fingerprinting
- Optional fallback to full-text matching if vector index is not ready

## Requirements

- Neo4j 5.x (for vector index support)
- OpenAI API key (or replace embedder implementation with local embedding model)
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

## Use in CLAW

From your CLAW host:

```bash
cd /opt/claw
git clone https://github.com/45ck/openclaw-neo4j-memory-plugin.git
cd openclaw-neo4j-memory-plugin
npm ci
npm run build
openclaw plugins install .
```

Then in CLAW config:

```json
{
  "plugins": {
    "slots": {
      "memory": "neo4j-memory"
    },
    "entries": {
      "neo4j-memory": {
        "enabled": true,
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "username": "neo4j",
            "password": "${NEO4J_PASSWORD}",
            "database": "memory",
            "vectorDimension": 1536
          },
          "embedding": {
            "model": "text-embedding-3-small",
            "apiKey": "${OPENAI_API_KEY}"
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

