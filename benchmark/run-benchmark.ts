import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

type BenchRecord = {
  id: string;
  category: string;
  question: string;
  expected: string[];
};

type Candidate = {
  recallAtK: boolean;
  firstRank: number | null;
  latencyMs: number;
  tokenOverhead: number;
};

type Provider = "neo4j-memory" | "graphiti" | "cognee" | "mem0";

type Report = {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  p50Ms: number;
  p95Ms: number;
  avgTokenOverhead: number;
};

function parseNDJSON(filePath: string): BenchRecord[] {
  const text = readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchRecord);
}

function recallHitScore(expected: string[], returnedText: string[]): { found: boolean; rank: number | null } {
  const normalizedExpected = expected.map((v) => v.toLowerCase());
  for (let i = 0; i < returnedText.length; i += 1) {
    const value = returnedText[i].toLowerCase();
    if (normalizedExpected.some((needle) => value.includes(needle))) {
      return { found: true, rank: i + 1 };
    }
  }
  return { found: false, rank: null };
}

async function runProviderRecall(
  provider: Provider,
  question: string,
  limit: number,
  sampleResponses: string[] = [],
): Promise<{ results: string[]; latencyMs: number; tokenOverhead: number }> {
  const start = performance.now();

  // Optional local override for provider-specific canned responses. Useful for CI smoke tests.
  if (sampleResponses.length > 0) {
    return {
      results: sampleResponses.slice(0, limit),
      latencyMs: Math.max(1, performance.now() - start),
      tokenOverhead: Math.floor(Math.max(1, question.length) / 10),
    };
  }

  // Placeholder for real integration. Keeping this as a deterministic, fast stub for bootstrap.
  const fake: Record<Provider, string[]> = {
    "neo4j-memory": [
      "No direct answer found in stub. Replace with neo4j-memory tool call.",
    ],
    graphiti: [
      "No direct answer found in stub. Replace with Graphiti endpoint.",
    ],
    cognee: [
      "No direct answer found in stub. Replace with Cognee endpoint.",
    ],
    mem0: [
      "No direct answer found in stub. Replace with Mem0 endpoint.",
    ],
  };

  return {
    results: fake[provider],
    latencyMs: Math.max(1, performance.now() - start),
    tokenOverhead: 0,
  };
}

function summaryFromCandidates(entries: Candidate[]): Report {
  const recallAt1 = entries.filter((x) => x.firstRank === 1).length / entries.length;
  const recallAt3 = entries.filter((x) => (x.firstRank ?? 99) <= 3).length / entries.length;
  const recallAt5 = entries.filter((x) => (x.firstRank ?? 99) <= 5).length / entries.length;
  const reciprocalRanks = entries
    .map((x) => x.firstRank)
    .filter((x): x is number => x !== null)
    .map((rank) => 1 / rank);

  const mrr = reciprocalRanks.length === 0 ? 0 : reciprocalRanks.reduce((acc, value) => acc + value, 0) / reciprocalRanks.length;
  const sortedLatency = [...entries.map((x) => x.latencyMs)].sort((a, b) => a - b);
  const p50 = sortedLatency[Math.floor(0.5 * (sortedLatency.length - 1))] ?? 0;
  const p95 = sortedLatency[Math.floor(0.95 * (sortedLatency.length - 1))] ?? 0;
  const avgTokens = entries.reduce((acc, x) => acc + x.tokenOverhead, 0) / Math.max(1, entries.length);

  return {
    recallAt1,
    recallAt3,
    recallAt5,
    mrr,
    p50Ms: p50,
    p95Ms: p95,
    avgTokenOverhead: avgTokens,
  };
}

function parseProviders(): Provider[] {
  const raw = process.argv.find((v) => v.startsWith("--providers="));
  const source = raw ? raw.slice("--providers=".length) : "neo4j-memory,graphiti,cognee,mem0";
  const values = source.split(",").map((v) => v.trim().toLowerCase());
  return values.filter((value): value is Provider =>
    value === "neo4j-memory" || value === "graphiti" || value === "cognee" || value === "mem0"
  );
}

async function run() {
  const root = process.cwd();
  const datasetRoot = join(root, "benchmark", "dataset");
  const datasets = ["multi-hop.jsonl", "temporal.jsonl", "contradiction.jsonl", "continuity.jsonl"];
  const providers = parseProviders();
  const outputDir = join(root, "dist-benchmark", "reports");

  mkdirSync(outputDir, { recursive: true });
  const report: Record<string, Report> = {};

  for (const provider of providers) {
    const rows: Candidate[] = [];
    for (const datasetFile of datasets) {
      const datasetRows = parseNDJSON(join(datasetRoot, datasetFile));
      for (const row of datasetRows) {
        const recallLimit = 5;
        const { results, latencyMs, tokenOverhead } = await runProviderRecall(provider, row.question, recallLimit);
        const hit = recallHitScore(row.expected, results);

        rows.push({
          recallAtK: hit.found,
          firstRank: hit.rank,
          latencyMs,
          tokenOverhead,
        });
      }
    }

    report[provider] = summaryFromCandidates(rows);
  }

  const outputFile = join(outputDir, "memory-benchmark.json");
  writeFileSync(outputFile, JSON.stringify(report, null, 2));
  console.log(`Benchmark report written: ${outputFile}`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
