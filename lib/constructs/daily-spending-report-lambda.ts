import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';

export interface DailySpendingReportLambdaProps {
  readonly outputBucket: s3.IBucket;
  readonly functionName: string;
  readonly athenaDatabase: string;
  readonly athenaOutputLocation: string;
  readonly spendingReportTopic: sns.ITopic;
}

export class DailySpendingReportLambda extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: DailySpendingReportLambdaProps) {
    super(scope, id);

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'daily_spending_report.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/daily_spending_report')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      functionName: props.functionName,
      environment: {
        BUCKET_NAME: props.outputBucket.bucketName,
        ATHENA_DATABASE: props.athenaDatabase,
        ATHENA_OUTPUT_LOCATION: props.athenaOutputLocation,
        SPENDING_REPORT_TOPIC_ARN: props.spendingReportTopic.topicArn
      }
    });

    // Grant permissions to read from S3
    props.outputBucket.grantReadWrite(this.function);
    
    // Grant permissions to use Athena
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults'
      ],
      resources: ['*']
    }));
    
    // Grant permissions to access Glue Data Catalog
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'glue:GetDatabase',
        'glue:GetTable',
        'glue:GetPartition',
        'glue:GetPartitions',
        'glue:BatchGetPartition'
      ],
      resources: ['*']
    }));
    
    // Grant permission to publish to SNS topic
    props.spendingReportTopic.grantPublish(this.function);
    
    // Create EventBridge rule to trigger Lambda at 6am PT daily
    const rule = new events.Rule(this, 'DailyTrigger', {
      schedule: events.Schedule.cron({ minute: '0', hour: '13' })
    });
    
    rule.addTarget(new targets.LambdaFunction(this.function));
  }
}