#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TransactionAlertsPipelineStack } from '../lib/transaction-alerts-pipeline-stack';

const app = new cdk.App();
new TransactionAlertsPipelineStack(app, 'TransactionAlertsPipelineStack', {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  emailBucketName: process.env.EMAIL_BUCKET_NAME || 'your-bucket-name',
  emailBucketPath: process.env.EMAIL_BUCKET_PATH || 'charges/',
  highValueAlertThreshold: parseInt(process.env.HIGH_VALUE_ALERT_THRESHOLD || '150'),
  amountMerchantPattern: process.env.AMOUNT_MERCHANT_PATTERN || 'Your card was charged \\$([0-9.]+) at ([^.]+)\\.'
});
