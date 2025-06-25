import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { EmailProcessorLambda } from './email-processor-lambda';

export interface EmailProcessingPipelineProps {
  readonly emailBucket: s3.IBucket;
  readonly emailPathPrefix: string;
  readonly highValueAlertThreshold: number;
  readonly highValueAlertTopic: sns.ITopic;
  readonly amountMerchantPattern: string;
}

export class EmailProcessingPipeline extends Construct {
  public readonly processingQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly processorFunction: lambda.Function;
  public readonly outputBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EmailProcessingPipelineProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'DLQ', {
      retentionPeriod: cdk.Duration.days(14), // Keep failed messages for 14 days
    });

    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 3,
      alarmDescription: 'Messages in DLQ detected',
    });

    this.processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(300), // 5 minutes
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3, // Move to DLQ after 3 failed processing attempts
      },
    });

    props.emailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED, 
      new s3n.SqsDestination(this.processingQueue),
      {
        prefix: props.emailPathPrefix,
      }
    );

    this.outputBucket = new s3.Bucket(this, 'OutputBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          enabled: true,
          expiration: cdk.Duration.days(365)
        }
      ]
    });

    const emailProcessor = new EmailProcessorLambda(this, 'EmailProcessor', {
      emailBucket: props.emailBucket,
      outputBucket: this.outputBucket,
      queue: this.processingQueue,
      functionName: 'transaction-alerts-processor',
      highValueAlertThreshold: props.highValueAlertThreshold,
      highValueAlertTopic: props.highValueAlertTopic,
      amountMerchantPattern: props.amountMerchantPattern
    });
    
    this.processorFunction = emailProcessor.function;
    
    if (props.highValueAlertTopic) {
      props.highValueAlertTopic.grantPublish(this.processorFunction);
    }
  }
}
