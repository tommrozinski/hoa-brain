import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { S3Client } from "@aws-sdk/client-s3";
import { AthenaClient } from "@aws-sdk/client-athena";
import { cfg } from "./config.js";

export const bedrock = new BedrockRuntimeClient({ region: cfg.region });
export const s3v = new S3VectorsClient({ region: cfg.region });
export const s3 = new S3Client({ region: cfg.region });
export const athena = new AthenaClient({ region: cfg.region });
