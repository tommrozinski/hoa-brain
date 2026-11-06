// Central configuration. Everything is overridable via environment variables.
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}. See README (Configuration).`);
  return v;
};

export const cfg = {
  region: process.env.AWS_REGION ?? "us-east-2",
  // Read lazily so offline utilities (chunker, redaction, SQL builders) work without AWS config.
  get vectorBucket(): string {
    return need("VECTOR_BUCKET");
  },
  get dataBucket(): string {
    return need("DATA_BUCKET");
  },
  indexName: process.env.VECTOR_INDEX ?? "hoa-docs",

  embedModelId: process.env.EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
  dimension: 1024, // must match the index

  topK: Number(process.env.TOP_K ?? 6),
  // Hint threshold only: results farther than this get a "may not be covered" note. Calibrate with `npm run eval`.
  maxDistance: Number(process.env.MAX_DISTANCE ?? 0.6),

  chunkChars: Number(process.env.CHUNK_CHARS ?? 2000), // ~500 tokens
  chunkOverlapChars: Number(process.env.CHUNK_OVERLAP_CHARS ?? 200),

  athenaDatabase: process.env.ATHENA_DATABASE ?? "hoa_brain",
  athenaWorkgroup: process.env.ATHENA_WORKGROUP ?? "hoa-brain",
};

export const DOC_TYPES = ["bylaws", "ccrs", "rules", "contract", "minutes", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];

// S3 layout inside the single data bucket
export const S3 = {
  originals: "docs/", // optional copies of source files (off by default)
  transactions: "finance/transactions/",
  budget: "finance/budget/",
  catalog: "meta/catalog.json",
  financeMeta: "meta/finance.json",
  athenaResults: "athena-results/",
};
