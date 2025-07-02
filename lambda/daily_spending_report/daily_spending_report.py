import json
import os
import boto3
import logging
import time
from datetime import datetime, timedelta

logger = logging.getLogger()
logger.setLevel(logging.INFO)

athena_client = boto3.client('athena')
s3_client = boto3.client('s3')
sns_client = boto3.client('sns')
output_bucket = os.environ.get('BUCKET_NAME')
athena_database = os.environ.get('ATHENA_DATABASE', 'default')
athena_output_location = os.environ.get('ATHENA_OUTPUT_LOCATION')
spending_report_topic_arn = os.environ.get('SPENDING_REPORT_TOPIC_ARN')

def handler(event, context):
    """
    Generate daily spending report from transaction data in S3 using Athena
    and send a notification via SNS.
    """
    # Get yesterday's date
    today = datetime.now()
    yesterday = today - timedelta(days=1)
    
    yesterday_str = yesterday.strftime("%Y-%m-%d")
    year_month = yesterday.strftime("%Y-%m")
    
    query = f"""
    SELECT date, time, merchant, amount
    FROM data
    WHERE date = '{yesterday_str}'
    ORDER BY time
    """
    
    query_execution_id = athena_client.start_query_execution(
        QueryString=query,
        QueryExecutionContext={
            'Database': athena_database
        },
        ResultConfiguration={
            'OutputLocation': athena_output_location
        }
    )['QueryExecutionId']
    
    status = 'RUNNING'
    while status in ['RUNNING', 'QUEUED']:
        time.sleep(1)
        response = athena_client.get_query_execution(QueryExecutionId=query_execution_id)
        status = response['QueryExecution']['Status']['State']
    
    if status != 'SUCCEEDED':
        error_message = response['QueryExecution']['Status'].get('StateChangeReason', 'Unknown error')
        logger.error(f"Athena query failed: {error_message}")
        return {
            'statusCode': 500,
            'body': json.dumps(f'Query failed: {error_message}')
        }
    
    results = athena_client.get_query_results(QueryExecutionId=query_execution_id)
    
    transactions = []
    total_spent = 0.0
    
    for row in results['ResultSet']['Rows'][1:]:  # Skip header row
        date = row['Data'][0]['VarCharValue']
        transaction_time = row['Data'][1]['VarCharValue']
        merchant = row['Data'][2]['VarCharValue']
        amount = float(row['Data'][3]['VarCharValue'])
        
        transactions.append({
            'date': date,
            'time': transaction_time,
            'merchant': merchant,
            'amount': amount
        })
        
        total_spent += amount
    
    # Store running monthly total value
    monthly_total = update_monthly_total(year_month, total_spent)

    # Generate the report
    if transactions:
        # Create the message with one transaction per line
        lines = [f"Daily Spending Report for {yesterday_str}"]
        lines.append("")
        lines.append("Transactions:")
        
        for t in transactions:
            time_obj = datetime.strptime(t['time'], "%H:%M:%S")
            formatted_time = time_obj.strftime("%I:%M%p").lower()
            lines.append(f"{formatted_time} - ${float(t['amount']):.2f} at {t['merchant']}")

        
        lines.append("")
        lines.append(f"Total Spent: ${total_spent:.2f}")
        lines.append(f"Total Spent This Month: ${monthly_total:.2f}")
        
        message = "\n".join(lines)
        
        sns_client.publish(
            TopicArn=spending_report_topic_arn,
            Subject=f"MTD ${int(monthly_total)} | D ${int(total_spent)} – Daily Spending Report",
            Message=message
        )
        
        logger.info(f"Sent daily spending report with {len(transactions)} transactions totaling ${total_spent:.2f}")
    else:
        message = "No transactions found in the past 24 hours."
        
        sns_client.publish(
            TopicArn=spending_report_topic_arn,
            Subject="Daily Spending Report: No Transactions",
            Message=message
        )
        
        logger.info("Sent daily spending report with no transactions")
    
    return {
        'statusCode': 200,
        'body': json.dumps('Daily spending report generated')
    }


def get_monthly_total(year_month):
    """
    Get the current monthly spending total from S3.
    If no total exists for the current month, return 0.
    """
    try:
        monthly_total_key = f"monthly_totals/{year_month}.json"
        response = s3_client.get_object(Bucket=output_bucket, Key=monthly_total_key)
        data = json.loads(response['Body'].read().decode('utf-8'))
        return float(data.get('total', 0.0))
    except s3_client.exceptions.NoSuchKey:
        # No monthly total exists yet, start with 0
        return 0.0
    except Exception as e:
        logger.error(f"Error retrieving monthly total: {str(e)}")
        return 0.0


def update_monthly_total(year_month, daily_total):
    """
    Update the monthly spending total in S3.
    """
    try:
        current_total = get_monthly_total(year_month)
        new_total = current_total + daily_total
        
        monthly_total_key = f"monthly_totals/{year_month}.json"
        s3_client.put_object(
            Bucket=output_bucket,
            Key=monthly_total_key,
            Body=json.dumps({'total': new_total}),
            ContentType='application/json'
        )
        return new_total
    except Exception as e:
        logger.error(f"Error updating monthly total: {str(e)}")
        return 0.0
