import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrock } from "./aws.js";
import { cfg } from "./config.js";

const MAX_RETRIES = 8;
const MAX_BACKOFF_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Embed one string with Titan Text Embeddings V2 (1024 dims, normalized). Retries on throttling. */
export async function embed(text: string): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await bedrock.send(
        new InvokeModelCommand({
          modelId: cfg.embedModelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: text, dimensions: cfg.dimension, normalize: true }),
        })
      );
      const json = JSON.parse(new TextDecoder().decode(res.body));
      return json.embedding as number[];
    } catch (e: any) {
      const throttled = e?.name === "ThrottlingException" || e?.$metadata?.httpStatusCode === 429;
      if (throttled && attempt < MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS));
        continue;
      }
      throw e;
    }
  }
}
