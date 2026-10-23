"""Behavior tests for the inline Lambda handlers, run against the exact code CDK emits.

Run `DUMP_INLINE_DIR=<dir> npx jest test/synth-smoke.test.ts` first, then
`INLINE_DIR=<dir> pytest test/python`. boto3, botocore and stripe are replaced with fakes.
"""

import json
import os
import sys
import types
from pathlib import Path

import pytest

INLINE_DIR = Path(os.environ.get("INLINE_DIR", ""))


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeTable:
    def __init__(self):
        self.items = {}
        self.updates = []

    def put_item(self, Item, ConditionExpression=None):
        if ConditionExpression and Item["tenant_id"] in self.items:
            raise ClientError("ConditionalCheckFailedException")
        self.items[Item["tenant_id"]] = Item

    def get_item(self, Key):
        item = self.items.get(Key["tenant_id"])
        return {"Item": item} if item else {}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)

    def query(self, **kwargs):
        cid = kwargs["ExpressionAttributeValues"][":c"]
        return {"Items": [i for i in self.items.values() if i.get("stripe_customer_id") == cid]}


class FakeClient:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def call(**kwargs):
            self.calls.append((name, kwargs))
            if name == "get_parameter":
                return {"Parameter": {"Value": "secret-for-" + kwargs["Name"]}}
            return {}
        return call


def load(fragment, env, stripe_module=None):
    """Exec the dumped handler whose file name contains `fragment` with fake AWS and Stripe."""
    matches = sorted(INLINE_DIR.glob(f"*{fragment}*.py"))
    if not matches:
        pytest.skip(f"no dumped handler matching {fragment}; set INLINE_DIR")
    table, clients = FakeTable(), {}

    boto3 = types.ModuleType("boto3")
    boto3.resource = lambda name: types.SimpleNamespace(Table=lambda _n: table)
    boto3.client = lambda name: clients.setdefault(name, FakeClient())
    botocore = types.ModuleType("botocore")
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = ClientError
    modules = {"boto3": boto3, "botocore": botocore, "botocore.exceptions": exceptions}
    if stripe_module:
        modules["stripe"] = stripe_module

    old_env = dict(os.environ)
    os.environ.update(env)
    saved = {k: sys.modules.get(k) for k in modules}
    sys.modules.update(modules)
    ns = {}
    exec(compile(matches[0].read_text(), str(matches[0]), "exec"), ns)

    def restore():
        os.environ.clear()
        os.environ.update(old_env)
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    ns["_table"], ns["_clients"], ns["_env"], ns["_restore"] = table, clients, env, restore
    return ns


# --- MultiTenantAuth post-confirmation trigger ---------------------------------------------

def confirm_event(user, attrs):
    return {"userName": user, "userPoolId": "us-east-1_pool", "request": {"userAttributes": attrs}}


def test_new_user_gets_a_new_tenant_and_it_is_written_back():
    h = load("MultiTenantAuth-CPostConfirmation", {"TENANTS_TABLE_NAME": "tenants"})
    h["handler"](confirm_event("u1", {"email": "a@example.com", "custom:company_size": "10"}), None)
    (tenant_id, record), = h["_table"].items.items()
    assert record["owner_user_id"] == "u1"
    assert record["company_size"] == "10"
    assert "stripe_customer_id" not in record  # GSI key must not be written as null
    name, kwargs = h["_clients"]["cognito-idp"].calls[0]
    assert name == "admin_update_user_attributes"
    assert kwargs["UserAttributes"] == [{"Name": "custom:tenant_id", "Value": tenant_id}]
    h["_restore"]()


def test_joining_an_existing_tenant_does_not_overwrite_it():
    h = load("MultiTenantAuth-CPostConfirmation", {"TENANTS_TABLE_NAME": "tenants"})
    h["_table"].items["t-1"] = {"tenant_id": "t-1", "owner_user_id": "owner", "tier": "pro"}
    h["handler"](confirm_event("u2", {"email": "b@example.com", "custom:tenant_id": "t-1"}), None)
    assert h["_table"].items["t-1"] == {"tenant_id": "t-1", "owner_user_id": "owner", "tier": "pro"}
    assert h["_clients"]["cognito-idp"].calls == []  # tenant_id already set by an admin
    h["_restore"]()


# --- StripeBilling -------------------------------------------------------------------------

class SignatureVerificationError(Exception):
    pass


def fake_stripe():
    stripe = types.ModuleType("stripe")
    stripe.error = types.SimpleNamespace(SignatureVerificationError=SignatureVerificationError)
    stripe.created = []

    def construct_event(payload, sig, secret):
        if sig != "t=1,v1=good" or secret != "secret-for-/app/webhook":
            raise SignatureVerificationError()
        return json.loads(payload)

    stripe.Webhook = types.SimpleNamespace(construct_event=construct_event)
    stripe.Customer = types.SimpleNamespace(create=lambda **kw: types.SimpleNamespace(id="cus_new"))

    def create_session(**kw):
        stripe.created.append(kw)
        return types.SimpleNamespace(url="https://checkout", id="cs_1")

    stripe.checkout = types.SimpleNamespace(Session=types.SimpleNamespace(create=create_session))
    stripe.billing_portal = types.SimpleNamespace(Session=types.SimpleNamespace(
        create=lambda **kw: stripe.created.append(kw) or types.SimpleNamespace(url="https://portal")))
    stripe.Subscription = types.SimpleNamespace(retrieve=lambda sid: {
        "id": sid, "items": {"data": [{"price": {"id": "price_pro"}}]}})
    return stripe


STRIPE_ENV = {
    "TENANTS_TABLE_NAME": "tenants", "STRIPE_KEY_PARAM": "/app/key", "TENANT_CLAIM": "custom:tenant_id",
    "SUCCESS_URL": "https://ok", "CANCEL_URL": "https://cancel", "RETURN_URL": "https://account",
    "ALLOWED_PRICES": json.dumps(["price_123"]), "WEBHOOK_SECRET_PARAM": "/app/webhook",
    "PAYMENT_SUCCESS_FUNCTION": "on-paid", "TIERS_CONFIG": json.dumps([{"name": "Pro", "priceId": "price_pro"}]),
}


def api_event(tenant=None, body=None):
    claims = {"custom:tenant_id": tenant} if tenant else {}
    return {"requestContext": {"authorizer": {"claims": claims}}, "body": json.dumps(body or {})}


def test_checkout_uses_the_token_tenant_and_ignores_the_body():
    stripe = fake_stripe()
    h = load("StripeBilling-CCheckout", STRIPE_ENV, stripe)
    h["_table"].items["mine"] = {"tenant_id": "mine", "email": "me@example.com"}
    h["_table"].items["victim"] = {"tenant_id": "victim", "stripe_customer_id": "cus_victim"}
    resp = h["handler"](api_event("mine", {"tenant_id": "victim", "price_id": "price_123"}), None)
    assert resp["statusCode"] == 200
    assert stripe.created[0]["customer"] == "cus_new"
    assert stripe.created[0]["metadata"]["tenant_id"] == "mine"
    h["_restore"]()


def test_checkout_rejects_missing_tenant_and_unknown_price():
    h = load("StripeBilling-CCheckout", STRIPE_ENV, fake_stripe())
    assert h["handler"](api_event(None, {"price_id": "price_123"}), None)["statusCode"] == 403
    assert h["handler"](api_event("mine", {"price_id": "price_free_lunch"}), None)["statusCode"] == 400
    h["_restore"]()


def test_portal_uses_fixed_return_url():
    stripe = fake_stripe()
    h = load("StripeBilling-CPortal", STRIPE_ENV, stripe)
    h["_table"].items["mine"] = {"tenant_id": "mine", "stripe_customer_id": "cus_mine"}
    resp = h["handler"](api_event("mine", {"return_url": "https://evil.example"}), None)
    assert resp["statusCode"] == 200
    assert stripe.created[0] == {"customer": "cus_mine", "return_url": "https://account"}
    h["_restore"]()


def webhook_event(sig_header_name, sig):
    body = {"type": "checkout.session.completed", "data": {"object": {
        "metadata": {"tenant_id": "mine"}, "customer": "cus_mine", "subscription": "sub_1"}}}
    return {"headers": {sig_header_name: sig}, "body": json.dumps(body)}


@pytest.mark.parametrize("header", ["Stripe-Signature", "stripe-signature"])
def test_webhook_accepts_signature_header_in_any_case(header):
    h = load("StripeBilling-CWebhook", STRIPE_ENV, fake_stripe())
    assert h["handler"](webhook_event(header, "t=1,v1=good"), None) == {"statusCode": 200}
    update = h["_table"].updates[0]
    assert update["Key"] == {"tenant_id": "mine"}
    assert update["ExpressionAttributeValues"][":t"] == "pro"
    h["_restore"]()


def test_webhook_rejects_bad_signature():
    h = load("StripeBilling-CWebhook", STRIPE_ENV, fake_stripe())
    assert h["handler"](webhook_event("Stripe-Signature", "t=1,v1=forged"), None) == {"statusCode": 400}
    assert h["_table"].updates == []
    h["_restore"]()
