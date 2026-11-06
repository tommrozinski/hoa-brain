import * as cdk from "aws-cdk-lib";
import { HoaBrainStack } from "../lib/hoa-brain-stack.js";

const app = new cdk.App();
new HoaBrainStack(app, "HoaBrain", {
  // S3 Vectors is only available in some regions; this account's project is assigned to us-east-2.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
  description: "HOA Brain: S3 Vectors index + Athena over budget CSVs (personal project)",
});
