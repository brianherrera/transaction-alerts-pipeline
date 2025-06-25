import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaPython from '@aws-cdk/aws-lambda-python-alpha';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

export interface EmailProcessorLambdaProps {
  readonly emailBucket: s3.IBucket;
  readonly outputBucket: s3.IBucket;
  readonly queue: sqs.IQueue;
  readonly functionName: string;
  readonly highValueAlertThreshold: number;
  readonly highValueAlertTopic: sns.ITopic;
  readonly amountMerchantPattern: string;
}
export class EmailProcessorLambda extends Construct {
  public readonly function: lambda.Function;
  
  constructor(scope: Construct, id: string, props: EmailProcessorLambdaProps) {
    super(scope, id);

    // Create the Lambda function with python dependencies
    this.function = new lambdaPython.PythonFunction(this, 'EmailProcessorFunction', {
      entry: path.join(__dirname, '../../lambda/email_processor_handler'),
      index: 'email_processor_handler.py',
      handler: 'handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      bundling: {
        assetExcludes: ['.venv'],
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      functionName: props.functionName,
      environment: {
        BUCKET_NAME: props.outputBucket.bucketName,
        HIGH_VALUE_THRESHOLD: props.highValueAlertThreshold.toString(),
        HIGH_VALUE_TOPIC_ARN: props.highValueAlertTopic.topicArn,
        AMOUNT_MERCHANT_PATTERN: props.amountMerchantPattern,
      },
    });
    
    this.function.addEventSource(
      new lambdaEventSources.SqsEventSource(props.queue, {
        batchSize: 10,
      })
    );
  
    props.emailBucket.grantRead(this.function);
    props.outputBucket.grantWrite(this.function);
  }
}