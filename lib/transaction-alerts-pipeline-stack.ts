import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EmailProcessingPipeline } from './constructs/email-processing-pipeline';
import { DailySpendingReportLambda } from './constructs/daily-spending-report-lambda';

export interface TransactionAlertsPipelineStackProps extends cdk.StackProps {
  readonly emailBucketName: string;
  readonly emailBucketPath: string;
  readonly highValueAlertThreshold: number;
  readonly amountMerchantPattern: string;
}

export class TransactionAlertsPipelineStack extends cdk.Stack {
  public readonly highValueTransactionTopic: sns.Topic;
  public readonly spendingReportTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: TransactionAlertsPipelineStackProps) {
    super(scope, id, props);

    const emailBucket = s3.Bucket.fromBucketName(
      this, 'EmailBucket', 
      props.emailBucketName
    );

    this.highValueTransactionTopic = new sns.Topic(this, 'HighValueTransactionTopic', {
      displayName: 'High Value Transaction Alert',
    });

    this.spendingReportTopic = new sns.Topic(this, 'SpendingReportTopic', {
      displayName: 'Daily Spending Report',
    });

    const pipeline = new EmailProcessingPipeline(this, 'EmailProcessingPipeline', {
      emailBucket: emailBucket,
      emailPathPrefix: props.emailBucketPath,
      highValueAlertThreshold: props.highValueAlertThreshold,
      highValueAlertTopic: this.highValueTransactionTopic,
      amountMerchantPattern: props.amountMerchantPattern
    });

    // Create Glue database for transaction data
    const transactionsDatabase = new glue.CfnDatabase(this, 'TransactionsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'transactions_db',
        description: 'Database for transaction data',
      },
    });

    const crawlerRole = new iam.Role(this, 'GlueCrawlerRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    crawlerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${pipeline.outputBucket.bucketName}`,
        `arn:aws:s3:::${pipeline.outputBucket.bucketName}/*`,
      ],
    }));

    const transactionsCrawler = new glue.CfnCrawler(this, 'TransactionsCrawler', {
      name: 'transactions-crawler',
      role: crawlerRole.roleArn,
      databaseName: transactionsDatabase.ref,
      schedule: {
        scheduleExpression: 'cron(0 12 * * ? *)', // Run daily at 12pm UTC
      },
      targets: {
        s3Targets: [
          {
            path: `s3://${pipeline.outputBucket.bucketName}/data/`,
          },
        ],
      },
      tablePrefix: '',
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
      configuration: JSON.stringify({
        Version: 1.0,
        CrawlerOutput: {
          Partitions: { AddOrUpdateBehavior: 'InheritFromTable' },
        },
        Grouping: {
          TableGroupingPolicy: 'CombineCompatibleSchemas'
        },
      }),
    });

    // Create the daily spending report lambda
    const dailySpendingReport = new DailySpendingReportLambda(this, 'DailySpendingReport', {
      outputBucket: pipeline.outputBucket,
      functionName: 'daily-spending-report',
      athenaDatabase: transactionsDatabase.ref,
      athenaOutputLocation: `s3://${pipeline.outputBucket.bucketName}/athena-results/`,
      spendingReportTopic: this.spendingReportTopic
    });
  }
}
