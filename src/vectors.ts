import { PutVectorsCommand, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";
import { s3v } from "./aws.js";
import { cfg, type DocType } from "./config.js";
import { embed } from "./embed.js";

export interface VectorRecord {
  key: string;
  embedding: number[];
  metadata: {
    doc_type: DocType;
    doc_id: string;
    doc_title: string;
    year?: number; // filterable (numeric): lets you ask "what did the board decide in 2024?"
    doc_date?: string; // YYYY-MM-DD when known (e.g. meeting date)
    page: number;
    section: string;
    verify?: boolean; // true = a human must check the original (e.g. handwritten notes)
    source_text: string; // declared NON-filterable on the index
  };
}

export async function putVectors(records: VectorRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 100) {
    await s3v.send(
      new PutVectorsCommand({
        vectorBucketName: cfg.vectorBucket,
        indexName: cfg.indexName,
        vectors: records.slice(i, i + 100).map((r) => ({
          key: r.key,
          data: { float32: r.embedding },
          metadata: r.metadata,
        })),
      })
    );
  }
}

export interface Filters {
  doc_type?: DocType;
  doc_id?: string;
  year?: number;
  from_year?: number;
  to_year?: number;
}

export interface Hit {
  distance: number;
  doc_type: string;
  doc_id: string;
  doc_title: string;
  doc_date: string;
  year?: number;
  page: number;
  section: string;
  verify: boolean;
  text: string;
}

export function buildFilter(f: Filters): Record<string, unknown> | undefined {
  const c: Record<string, unknown>[] = [];
  if (f.doc_type) c.push({ doc_type: { $eq: f.doc_type } });
  if (f.doc_id) c.push({ doc_id: { $eq: f.doc_id } });
  if (f.year !== undefined) c.push({ year: { $eq: f.year } });
  if (f.from_year !== undefined) c.push({ year: { $gte: f.from_year } });
  if (f.to_year !== undefined) c.push({ year: { $lte: f.to_year } });
  if (c.length === 0) return undefined;
  return c.length === 1 ? c[0] : { $and: c };
}

export async function search(query: string, filters: Filters = {}, topK = cfg.topK): Promise<Hit[]> {
  const res = await s3v.send(
    new QueryVectorsCommand({
      vectorBucketName: cfg.vectorBucket,
      indexName: cfg.indexName,
      queryVector: { float32: await embed(query) },
      topK,
      filter: buildFilter(filters) as any,
      returnMetadata: true,
      returnDistance: true,
    })
  );
  return (res.vectors ?? []).map((v) => {
    const m = (v.metadata ?? {}) as Record<string, any>;
    return {
      distance: v.distance ?? Number.NaN,
      doc_type: String(m.doc_type ?? ""),
      doc_id: String(m.doc_id ?? ""),
      doc_title: String(m.doc_title ?? ""),
      doc_date: String(m.doc_date ?? ""),
      year: m.year === undefined ? undefined : Number(m.year),
      page: Number(m.page ?? 0),
      section: String(m.section ?? ""),
      verify: m.verify === true,
      text: String(m.source_text ?? ""),
    };
  });
}
