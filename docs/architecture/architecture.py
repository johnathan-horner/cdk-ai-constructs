"""cdk-ai-constructs: what each of the 9 constructs deploys (from src/constructs/*.ts).

Each construct is drawn as its own small diagram, then tiled into a 3x3 grid so the page reads cleanly.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from diagrams import Diagram
from diagrams.aws.compute import Fargate, Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import Eventbridge, SimpleNotificationServiceSns as SNS, SimpleQueueServiceSqs as SQS
from diagrams.aws.management import Cloudtrail, Cloudwatch, SystemsManagerParameterStore as SSM
from diagrams.aws.ml import Bedrock, Sagemaker
from diagrams.aws.network import APIGateway, ElbApplicationLoadBalancer as ALB, Route53
from diagrams.aws.security import Cognito, KMS
from diagrams.aws.storage import SimpleStorageServiceS3Bucket as S3
from PIL import Image, ImageDraw, ImageFont

from style import EDGE, FONT, GRAPH, ICONS, INK, NODE, area, flow, primary, soft

TMP = HERE / "_parts"
TMP.mkdir(exist_ok=True)
G = {**GRAPH, "ranksep": "0.75", "nodesep": "0.9", "pad": "0.3"}


def part(name, build):
    with Diagram("", filename=str(TMP / name), outformat="png", direction="TB", show=False,
                 graph_attr=G, node_attr=NODE, edge_attr=EDGE):
        with area(name, "layer"):
            build()


def auth():
    c = Cognito("Cognito user pool\nMFA, tenant attributes")
    t = Lambda("Post-confirmation\ntrigger")
    d = Dynamodb("Tenants table")
    c >> flow("triggers") >> t >> flow("writes") >> d


def api():
    a = APIGateway("REST API\nCognito auth, API keys")
    f = Lambda("Handler")
    w = Cloudwatch("CloudWatch alarms")
    a >> flow("invokes") >> f
    a >> soft("4XX, 5XX, latency") >> w


def agent():
    f = Lambda("Agent Lambda\nleast-privilege role")
    b = Bedrock("Amazon Bedrock")
    f >> primary("InvokeModel") >> b


def pipeline():
    r = Eventbridge("EventBridge rule")
    f = Lambda("Processor")
    q = SQS("Dead-letter queue")
    n = SNS("Alarm topic")
    r >> flow("target") >> f
    r >> soft("failed events") >> q
    q >> soft("alarm") >> n


def storage():
    k = KMS("KMS key")
    t = Cloudtrail("CloudTrail\nmulti-Region,\nfile validation")
    b = S3("S3 bucket\nversioned, retention")
    k >> soft("encrypts") >> b
    b >> flow("object-level\ndata events") >> t


def card():
    c = Sagemaker("SageMaker\nmodel card")
    w = Lambda("Deploy-time writer\n(custom resource)")
    s = S3("Card JSON")
    d = Dynamodb("Model registry")
    w >> flow("writes") >> s
    w >> flow("writes entry") >> d


def endpoint():
    f = Lambda("Invoke function")
    e = Sagemaker("SageMaker\nserverless endpoint")
    f >> primary("InvokeEndpoint") >> e


def dashboard():
    r = Route53("Route 53 record")
    a = ALB("Application\nLoad Balancer")
    t = Fargate("Fargate service\nStreamlit container")
    r >> flow("alias") >> a >> flow("forwards") >> t


def billing():
    a = APIGateway("Billing API\ncheckout, portal, webhook")
    f = Lambda("3 Lambdas\nwebhook signature check")
    p = SSM("SSM SecureString\nStripe keys")
    a >> flow("invokes") >> f
    p >> soft("read at runtime") >> f


PARTS = [("MultiTenantAuth", auth), ("APIGatewayLambda", api), ("BedrockAgentConstruct", agent),
         ("EventDrivenPipeline", pipeline), ("AuditableStorage", storage), ("ModelCard", card),
         ("ServerlessMLEndpoint", endpoint), ("StreamlitDashboard", dashboard), ("StripeBilling", billing)]


def compose(out):
    imgs = []
    for name, build in PARTS:
        part(name, build)
        imgs.append(Image.open(TMP / f"{name}.png").convert("RGB"))
    cell_w = 1500
    s = min(1.0, min(cell_w / im.width for im in imgs))
    scaled = []
    for im in imgs:
        scaled.append(im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS))
    rows = [scaled[i:i + 3] for i in range(0, 9, 3)]
    row_h = [max(i.height for i in r) for r in rows]
    gap, margin, head = 90, 160, 520
    W = margin * 2 + cell_w * 3 + gap * 2
    H = head + sum(row_h) + gap * 2 + margin + 160
    page = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(page)
    fonts = "/usr/share/fonts"
    def font(weight, size):
        for pattern in (f"Inter-{weight}.*", f"Inter*{weight}*", "Arial*", "Helvetica*", "DejaVuSans.*"):
            for p in sorted(Path(fonts).rglob(pattern)):
                if p.suffix in (".ttf", ".otf") and "Italic" not in p.name:
                    return ImageFont.truetype(str(p), size)
        return ImageFont.load_default()
    title = "cdk-ai-constructs  |  9 AWS CDK constructs and what each deploys"
    sub = "npm: @johnathan-horner/cdk-ai-constructs   ·   TypeScript   ·   each box is one construct you add with one line of code"
    tf, sf = font("SemiBold", 96), font("Regular", 54)
    d.text(((W - d.textlength(title, font=tf)) / 2, 150), title, font=tf, fill=INK)
    d.text(((W - d.textlength(sub, font=sf)) / 2, 300), sub, font=sf, fill="#56636F")
    y = head
    for r, h in zip(rows, row_h):
        x = margin
        for im in r:
            page.paste(im, (int(x + (cell_w - im.width) / 2), int(y + (h - im.height) / 2)))
            x += cell_w + gap
        y += h + gap
    d.rectangle([margin - 50, head - 70, W - margin + 50, y - gap + 60], outline=INK, width=8)
    d.text((margin - 20, head - 60), "AWS Cloud  (your account)", font=font("SemiBold", 52), fill=INK)
    page.save(out, dpi=(300, 300))
    for p in TMP.iterdir():
        p.unlink()
    TMP.rmdir()


compose(HERE / "architecture.png")
