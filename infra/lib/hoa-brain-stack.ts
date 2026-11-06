import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as glue from "aws-cdk-lib/aws-glue";
import * as athena from "aws-cdk-lib/aws-athena";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * HOA Brain, all serverless, nothing bills while idle:
 *  - Data bucket (private, encrypted):  finance/* CSVs for Athena, meta/* catalog + finance summary, athena-results/* (auto-expire)
 *  - S3 Vectors bucket + index "hoa-docs" (1024-d cosine; chunk text stored but not filterable)
 *  - Glue database + two external tables (transactions, budget) over the CSVs, queried by Athena
 *  - Athena workgroup with a per-query scan cap (hard cost guard) and enforced result location
 *  - A least-privilege managed policy for the identity that runs ingest/load/MCP
 * `cdk destroy` deletes everything, including your data copies in AWS. Your originals stay on your laptop.
 */
export class HoaBrainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const indexName = "hoa-docs";
    const dimension = 1024; // Titan Text Embeddings V2; must match src/config.ts
    const vectorBucketName = `hoa-brain-${this.account}`;
    const dbName = "hoa_brain";
    const workgroupName = "hoa-brain";

    // ---------- Data bucket ----------
    const dataBucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: "expire-athena-results", prefix: "athena-results/", expiration: cdk.Duration.days(7) }],
    });

    // ---------- Vector store ----------
    const vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", { vectorBucketName });
    vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const index = new s3vectors.CfnIndex(this, "DocsIndex", {
      vectorBucketName,
      indexName,
      dataType: "float32",
      dimension,
      distanceMetric: "cosine",
      metadataConfiguration: { nonFilterableMetadataKeys: ["source_text"] },
    });
    index.addResourceDependency(vectorBucket);
    index.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ---------- Athena over CSV in S3 ----------
    const db = new glue.CfnDatabase(this, "Database", {
      catalogId: this.account,
      databaseInput: { name: dbName, description: "HOA Brain budget data" },
    });

    const csvTable = (logicalId: string, name: string, prefix: string, columns: string[]) => {
      const t = new glue.CfnTable(this, logicalId, {
        catalogId: this.account,
        databaseName: dbName,
        tableInput: {
          name,
          tableType: "EXTERNAL_TABLE",
          parameters: { classification: "csv", "skip.header.line.count": "0" }, // loader writes files without a header row
          storageDescriptor: {
            // All columns are strings (OpenCSVSerde); queries CAST amounts, and years/dates compare as text.
            columns: columns.map((c) => ({ name: c, type: "string" })),
            location: `s3://${dataBucket.bucketName}/${prefix}`,
            inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
            outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
            serdeInfo: {
              serializationLibrary: "org.apache.hadoop.hive.serde2.OpenCSVSerde",
              parameters: { separatorChar: ",", quoteChar: '"', escapeChar: "\\" },
            },
          },
        },
      });
      t.addResourceDependency(db);
      return t;
    };
    // Column order MUST match TXN_COLUMNS / BUDGET_COLUMNS in src/financeData.ts
    csvTable("TransactionsTable", "transactions", "finance/transactions/", [
      "txn_id", "txn_date", "fiscal_year", "category", "vendor", "description", "amount", "kind", "fund",
    ]);
    csvTable("BudgetTable", "budget", "finance/budget/", ["fiscal_year", "category", "fund", "budgeted_amount"]);

    new athena.CfnWorkGroup(this, "Workgroup", {
      name: workgroupName,
      description: "HOA Brain queries (scan-capped)",
      state: "ENABLED",
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: false,
        bytesScannedCutoffPerQuery: 100 * 1024 * 1024, // 100 MB cap per query: a hard ceiling on cost
        engineVersion: { selectedEngineVersion: "Athena engine version 3" },
        resultConfiguration: {
          outputLocation: `s3://${dataBucket.bucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    // ---------- Least-privilege runtime policy (attach to your IAM user/role/permission set) ----------
    const vb = `arn:${this.partition}:s3vectors:${this.region}:${this.account}:bucket/${vectorBucketName}`;
    const glueArn = (suffix: string) => `arn:${this.partition}:glue:${this.region}:${this.account}:${suffix}`;
    const runtime = new iam.ManagedPolicy(this, "RuntimePolicy", {
      managedPolicyName: "hoa-brain-runtime",
      statements: [
        new iam.PolicyStatement({
          sid: "VectorIndex",
          actions: ["s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:ListVectors", "s3vectors:GetIndex", "s3vectors:GetVectorBucket"],
          resources: [vb, `${vb}/index/${indexName}`],
        }),
        new iam.PolicyStatement({
          sid: "EmbeddingModelOnly",
          actions: ["bedrock:InvokeModel"],
          resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
        }),
        new iam.PolicyStatement({
          sid: "DataBucket",
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:AbortMultipartUpload"],
          resources: [dataBucket.bucketArn, dataBucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "AthenaWorkgroup",
          actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution", "athena:GetWorkGroup"],
          resources: [`arn:${this.partition}:athena:${this.region}:${this.account}:workgroup/${workgroupName}`],
        }),
        new iam.PolicyStatement({
          sid: "GlueCatalogRead",
          actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartition", "glue:GetPartitions"],
          resources: [glueArn("catalog"), glueArn(`database/${dbName}`), glueArn(`table/${dbName}/*`)],
        }),
      ],
    });

    new cdk.CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, "VectorBucketName", { value: vectorBucketName });
    new cdk.CfnOutput(this, "RuntimePolicyArn", { value: runtime.managedPolicyArn });
    new cdk.CfnOutput(this, "EnvHint", {
      value: `export AWS_REGION=${this.region} DATA_BUCKET=${dataBucket.bucketName} VECTOR_BUCKET=${vectorBucketName} VECTOR_INDEX=${indexName} ATHENA_DATABASE=${dbName} ATHENA_WORKGROUP=${workgroupName}`,
    });
  }
}
