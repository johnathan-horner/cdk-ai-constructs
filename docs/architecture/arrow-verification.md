# Arrow check

Every arrow that touches an AWS service, with the official AWS page that confirms it and its direction. Arrows between non-AWS parts (Streamlit, Gemini, SQLite, scikit-learn and so on) were checked against the code only. Links come from docs.aws.amazon.com only.

## architecture.png (9 constructs)

| From | To | Action | AWS doc |
|---|---|---|---|
| Cognito user pool | Post-confirmation trigger | Cognito invokes the trigger after a user is confirmed | https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-confirmation.html |
| Post-confirmation trigger | Tenants table | PutItem new tenant | https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html |
| REST API | Handler | Lambda proxy integration | https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html |
| REST API | CloudWatch alarms | 4XX, 5XX and latency metrics feed alarms | https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html |
| Agent Lambda | Amazon Bedrock | InvokeModel | https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html |
| EventBridge rule | Processor | Rule target | https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutTargets.html |
| EventBridge rule | Dead-letter queue | Events that fail delivery go to the SQS DLQ | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html |
| Dead-letter queue | Alarm topic | CloudWatch alarm on queue depth notifies SNS | https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html |
| KMS key | S3 bucket | SSE-KMS encryption | https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html |
| S3 bucket | CloudTrail | Trail logs the bucket's object-level data events | https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html |
| Deploy-time writer | Card JSON / Model registry | AwsCustomResource makes the PutObject and UpdateItem calls at deploy time | https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.AwsCustomResource.html |
| Invoke function | SageMaker serverless endpoint | InvokeEndpoint | https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_runtime_InvokeEndpoint.html |
| Route 53 record | Application Load Balancer | Alias record to the load balancer | UNVERIFIED (doc page not opened in this pass) |
| Application Load Balancer | Fargate service | Forwards to the container through a target group | UNVERIFIED (partial: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb.html does not name Fargate) |
| Billing API | 3 Lambdas | Lambda proxy integration | https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html |
| SSM SecureString | 3 Lambdas | GetParameter with decryption at runtime | UNVERIFIED (partial: https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html, WithDecryption detail) |

## UNVERIFIED

- Route 53 record > Application Load Balancer: UNVERIFIED (doc page not opened in this pass)
- Application Load Balancer > Fargate service: UNVERIFIED (partial: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb.html does not name Fargate)
- SSM SecureString > 3 Lambdas: UNVERIFIED (partial: https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html, WithDecryption detail)
