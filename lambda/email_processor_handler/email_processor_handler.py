import json
import os
import boto3
import email
import re
import uuid
import logging
from datetime import datetime
from email.header import decode_header
import pytz

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3')
sns_client = boto3.client('sns')
output_bucket = os.environ.get('BUCKET_NAME')
high_value_threshold = float(os.environ.get('HIGH_VALUE_THRESHOLD', '150'))
high_value_topic_arn = os.environ.get('HIGH_VALUE_TOPIC_ARN', '')
amount_merchant_pattern = os.environ.get('AMOUNT_MERCHANT_PATTERN', r'Your card was charged \$([0-9.]+) at ([^.]+)\.')

def handler(event, context):
    """
    Process transaction alert emails from SQS (which contains direct S3 events)
    and extract transaction details to upload to S3.
    """
    for record in event.get('Records', []):
        try:
            # Extract S3 object details from SQS message (direct S3 event notification)
            sqs_body = json.loads(record.get('body', '{}'))
            
            # Check if this is an S3 event
            if 'Records' not in sqs_body:
                continue
                
            for s3_record in sqs_body.get('Records', []):
                if s3_record.get('eventSource') != 'aws:s3' or s3_record.get('eventName', '').startswith('ObjectCreated:') is False:
                    continue
                    
                bucket = s3_record.get('s3', {}).get('bucket', {}).get('name')
                key = s3_record.get('s3', {}).get('object', {}).get('key')
                
                if not bucket or not key:
                    continue
                
                email_obj = s3_client.get_object(Bucket=bucket, Key=key)
                email_content = email_obj['Body'].read().decode('utf-8', errors='replace')
                
                msg = email.message_from_string(email_content)
                
                email_date = msg.get('Date')
                date_obj = parse_email_date(email_date)

                transaction_data = extract_transaction_data(msg)
                if not transaction_data:
                    print(f"Could not extract transaction data from email: {key}")
                    continue

                transaction_record = {
                    "date": date_obj.strftime("%Y-%m-%d"),
                    "time": date_obj.strftime("%H:%M:%S"),
                    "merchant": transaction_data.get('merchant', 'Unknown'),
                    "amount": transaction_data.get('amount', 0.0),
                    "email_source": f"s3://{bucket}/{key}"
                }
                
                # Upload transaction file to s3 path = year/month/day/unique-filename
                year = date_obj.strftime("%Y")
                month = date_obj.strftime("%m")
                day = date_obj.strftime("%d")
                unique_id = str(uuid.uuid4())
                
                output_key = f"data/year={year}/month={month}/day={day}/{unique_id}.json"
                s3_client.put_object(
                    Bucket=output_bucket,
                    Key=output_key,
                    Body=json.dumps(transaction_record),
                    ContentType='application/json'
                )
                
                logger.info(f"Successfully processed transaction: {transaction_record}")
                
                # Check if transaction amount exceeds threshold and send SNS notification
                amount = transaction_data.get('amount', 0.0)
                if amount > high_value_threshold and high_value_topic_arn:
                    try:
                        message = {
                            "transactionDate": transaction_record["date"],
                            "transactionTime": transaction_record["time"],
                            "merchant": transaction_record["merchant"],
                            "amount": amount,
                            "message": f"High value transaction detected: ${amount:.2f} at {transaction_record['merchant']}"
                        }
                        
                        sns_client.publish(
                            TopicArn=high_value_topic_arn,
                            Subject=f"High Value Transaction Alert: ${amount:.2f}",
                            Message=json.dumps(message)
                        )
                        logger.info(f"Sent high value transaction alert for ${amount:.2f}")
                    except Exception as sns_error:
                        logger.error(f"Failed to send SNS notification: {str(sns_error)}")
                
        except Exception as e:
            print(f"Error processing record: {str(e)}")
            # Continue processing other records even if one fails
            continue
    
    return {
        'statusCode': 200,
        'body': json.dumps('Email processing completed')
    }

def parse_email_date(date_str):
    """Parse email date string into datetime object"""
    if not date_str:
        return datetime.now(pytz.timezone('US/Pacific'))
    
    try:
        utc_dt = None
        
        # Try different date formats
        for fmt in [
            '%a, %d %b %Y %H:%M:%S %z',  # RFC 2822 format
            '%a, %d %b %Y %H:%M:%S %z (%Z)',
            '%d %b %Y %H:%M:%S %z',
        ]:
            try:
                utc_dt = datetime.strptime(date_str.strip(), fmt)
                break
            except ValueError:
                continue
        
        # If all formats fail, use a more permissive parser
        if not utc_dt:
            import email.utils
            utc_dt = datetime.fromtimestamp(email.utils.mktime_tz(email.utils.parsedate_tz(date_str)))
        
        # If the datetime doesn't have tzinfo, assume it's UTC
        if utc_dt.tzinfo is None:
            utc_dt = pytz.utc.localize(utc_dt)
        
        pacific_tz = pytz.timezone('US/Pacific')
        return utc_dt.astimezone(pacific_tz)
    except Exception as e:
        logger.error(f"Error parsing date: {str(e)}")
        return datetime.now(pytz.timezone('US/Pacific'))

def extract_transaction_data(email_message):
    """
    Extract transaction data (merchant and amount) from email content
    """
    result = {
        'merchant': None,
        'amount': None
    }
    
    # Get the plain text part of the email
    text_content = ""
    for part in email_message.walk():
        if part.get_content_type() == "text/plain":
            payload = part.get_payload(decode=True)
            if payload:
                text_content = payload.decode('utf-8', errors='replace')
                break
    
    if not text_content:
        return None
    
    # Look for transaction pattern using configurable regex
    match = re.search(amount_merchant_pattern, text_content)
    
    if match:
        result['amount'] = float(match.group(1))
        result['merchant'] = match.group(2).strip()
        return result
    
    # Alternative pattern
    alt_pattern = r"(\$[0-9.]+).*?(?:at|to) ([A-Za-z0-9\s*]+)"
    match = re.search(alt_pattern, text_content)
    if match:
        amount_str = match.group(1).replace('$', '')
        result['amount'] = float(amount_str)
        result['merchant'] = match.group(2).strip()
        return result
    
    return None
