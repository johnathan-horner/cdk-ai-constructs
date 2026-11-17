"""cdk-ai-constructs: what the 9 constructs create and how they wire together, from src/constructs/*.ts.

Nothing is deployed. The constructs are synthesized to CloudFormation in the Jest suite only.
Construct names are in [brackets] on each node. "Your Lambda functions" are passed in as props.
"""
from diagrams.aws.compute import Fargate, Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.general import Users
from diagrams.aws.integration import Eventbridge, SimpleQueueServiceSqs
from diagrams.aws.management import Cloudtrail, Cloudwatch, SystemsManagerParameterStore
from diagrams.aws.ml import Bedrock, Sagemaker, SagemakerModel
from diagrams.aws.network import APIGateway, ElbApplicationLoadBalancer
from diagrams.aws.security import Cognito
from diagrams.aws.storage import S3

from archstyle import arch, aws_cloud, box, e, layer, linkedin, outside

OUT = "architecture"
with arch("cdk-ai-constructs", "Library constructs (synthesized in tests, not deployed)", OUT):
    users = Users("App users")
    with outside("Stripe"):
        stripe = box("Stripe API\n(Checkout, Billing Portal,\nwebhooks)")
    with aws_cloud("AWS Cloud (one stack that uses the constructs)"):
        with layer("Entry points", margin=36):
            api = APIGateway("REST API\n[APIGatewayLambda]")
            billing_api = APIGateway("Billing API\n[StripeBilling]")
            cognito = Cognito("User pool + authorizer\n[MultiTenantAuth]")
            alb = ElbApplicationLoadBalancer("Load balancer\n[StreamlitDashboard]")
        with layer("Compute", margin=36):
            billing_fns = Lambda("checkout, webhook,\nportal functions\n[StripeBilling]")
            postconf = Lambda("post-confirmation\ntrigger\n[MultiTenantAuth]")
            fargate = Fargate("Streamlit on Fargate\n[StreamlitDashboard]")
        with layer("Your code", margin=60):
            fns = Lambda("Your Lambda functions\n(passed in as props)")
        with layer("AI and ML", margin=36):
            bedrock = Bedrock("Amazon Bedrock\none model or profile\n[BedrockAgentConstruct]")
            endpoint = Sagemaker("Serverless endpoint\n[ServerlessMLEndpoint]")
            card = SagemakerModel("SageMaker model card\n[ModelCardConstruct]")
        with layer("Events", margin=36):
            rule = Eventbridge("EventBridge rule\n[EventDrivenPipeline]")
            dlq = SimpleQueueServiceSqs("Dead letter queue\n[EventDrivenPipeline]")
        with layer("Data and audit", margin=36):
            tenants = Dynamodb("Tenants table\n[MultiTenantAuth]")
            ssm = SystemsManagerParameterStore("SSM SecureString\nStripe keys (yours)")
            bucket = S3("KMS-encrypted bucket\n[AuditableStorage]")
            card_store = S3("Model card JSON\n[ModelCardConstruct]")
            registry = Dynamodb("Model registry\n[ModelCardConstruct]")
            trail = Cloudtrail("CloudTrail trails\n[AuditableStorage,\nModelCardConstruct]")
        with layer("Monitoring", margin=64):
            cw = Cloudwatch("CloudWatch alarms\n(most constructs)")

    users >> e("HTTPS + Cognito token") >> api
    users >> e("sign up, sign in") >> cognito
    users >> e("POST /checkout, /portal") >> billing_api
    users >> e("HTTP or HTTPS") >> alb
    stripe >> e("POST /webhook (signed)") >> billing_api
    api >> e("authorizer") >> cognito
    api >> e("Lambda proxy") >> fns
    billing_api >> e("Lambda proxy") >> billing_fns
    cognito >> e("PostConfirmation") >> postconf
    alb >> e("port 8501") >> fargate
    billing_fns >> e("Checkout and\nPortal sessions") >> stripe
    billing_fns >> e("GetParameter") >> ssm
    billing_fns >> e("tier, customer ID") >> tenants
    billing_fns >> e("Invoke onPaymentSuccess") >> fns
    postconf >> e("PutItem tenant") >> tenants
    fargate >> e("optional read grant") >> tenants
    fns >> e("InvokeModel") >> bedrock
    fns >> e("InvokeEndpoint") >> endpoint
    fns >> e("UpdateModelCard\n(optional grant)") >> card
    rule >> e("invokes target\n(retries)") >> fns
    rule >> e("failed events") >> dlq
    fns >> e("read or write grant") >> bucket
    fns >> e("registry read grant") >> registry
    card_store >> e("object data events") >> trail
    bucket >> e("object data events") >> trail
    fns >> e("Errors metric") >> cw
linkedin(OUT)
