# Transaction Alerts Pipeline

This project came out of a simple goal: find a better way to track my spending without getting pinged for every single charge. I just wanted a low-effort way to see how I was doing against a monthly budget.

Yes I know, this is a hacky solution. Yes, there are probably better ways to do this. But no, I do not want to hand over my credentials to a third-party app (API tokens or otherwise).

Given that requirement, and the complete lack of options to integrate directly with my bank’s APIs, this project takes a different route: parsing email notifications to track and aggregate credit card transactions for reports.

That’s right, we’re scraping email like it’s 1999.

## Architecture

tl;dr: Credit card charge -> Email -> SES -> Lambda -> S3 -> Query later for reports

Details:

1. **S3 Bucket** (pre-existing): Assumes SES is configured to deliver alert emails to an S3 bucket. S3 notifications trigger the pipeline when new emails arrive. 
2. **SQS Queue**: Buffers events from S3 for processing and captures failed processing attempts for later inspection.
3. **Lambda Function**: Parses transaction emails and stores relevant data in S3. Another lambda sends a daily spending summary with the list of charges and the total, including a tracking total for the month. This avoids dealing with the notification spam for every transaction. A dollar amount threshold can be configured to allow alerts for charges above a specified value. 
4. **S3 Bucket**: Stores extracted transaction data for querying and reports using Athena.

## Setup

### 1. Prerequisites

- An AWS account with [CDK bootstrapped](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html).
- An existing S3 bucket where SES delivers transaction alert emails.

### 2. Configure Repo Variables
In your forked repository, go to: Settings > Secrets and variables > Actions > Variables and add:

- `EMAIL_BUCKET_NAME`: Your S3 bucket name where emails are delivered.
- `EMAIL_BUCKET_PATH`: Path prefix inside the bucket (e.g., `"charges/"`).
- `HIGH_VALUE_ALERT_THRESHOLD`: Dollar amount threshold for triggering alerts (e.g., `"150"`). All other charges are summarized each day to reduce noise.
- `AMOUNT_MERCHANT_PATTERN` *(optional but recommended)*: Regex pattern used to extract the transaction amount and merchant name from email content.
    - Default value: `Your card was charged \\$([0-9.]+) at ([^.]+)\\.`
    - There is a fallback pattern defined to capture a more generic format ($xx.xx at/to merchant).
    - Make sure to escape special characters properly (e.g., `\\$` for `$` in the GitHub UI).

### 3. Configure Repo Secrets
In Settings > Secrets and variables > Actions > Secrets, add:

- `AWS_ACCESS_KEY_ID`: Your AWS access key.
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret key.
- `AWS_REGION`: AWS region for deployment (e.g., `"us-east-1"`).
- `AWS_ACCOUNT_ID`: Your 12-digit AWS account ID.

## Deployment

Push to `main` to trigger automatic deployment via GitHub Actions.

See: `.github\workflows\deploy-cdk.yml`
