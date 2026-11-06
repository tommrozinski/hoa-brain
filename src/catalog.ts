import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./aws.js";
import { cfg } from "./config.js";

export async function readJson<T>(key: string): Promise<T | undefined> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg.dataBucket, Key: key }));
    return JSON.parse((await res.Body?.transformToString()) ?? "null") as T;
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return undefined;
    throw e;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: cfg.dataBucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    })
  );
}

export interface CatalogEntry {
  doc_id: string;
  doc_title: string;
  doc_type: string;
  doc_date?: string;
  year?: number;
  pages: number;
  chunks: number;
  ingested_at: string;
  verify?: string; // reason a human must verify the original
  verify_mode?: "warn" | "pointer-only";
}
