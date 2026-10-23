#!/usr/bin/env bash
# Pack the library and import it from a clean project, the way a user would.
# Guards against the 1.0.0 bug where "main" pointed at a file that was not in the package.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
npm run build --silent
tarball="$(npm pack --silent --pack-destination "$work")"
echo "packed $tarball"
tar tzf "$work/$tarball" | sort > "$work/files.txt"
if grep -qE '\.ts$' <(grep -v '\.d\.ts$' "$work/files.txt"); then
  echo "package contains TypeScript sources:"; grep -v '\.d\.ts$' "$work/files.txt" | grep '\.ts$'; exit 1
fi
grep -q '^package/lib/index.js$' "$work/files.txt" || { echo "lib/index.js missing from package"; exit 1; }

cd "$work"
npm init -y >/dev/null
cdk_version="$(node -p "require('$root/node_modules/aws-cdk-lib/package.json').version")"
npm install --silent --no-audit --no-fund "./$tarball" "aws-cdk-lib@$cdk_version" constructs@10 >/dev/null
node -e "
const lib = require('@johnathan-horner/cdk-ai-constructs');
const expected = ['APIGatewayLambda','AuditableStorage','BedrockAgentConstruct','EventDrivenPipeline',
  'ModelCardConstruct','MultiTenantAuth','ServerlessMLEndpoint','StreamlitDashboard','StripeBilling'];
const missing = expected.filter((n) => typeof lib[n] !== 'function');
if (missing.length) { console.error('missing exports:', missing); process.exit(1); }
console.log('import OK:', expected.length, 'constructs exported');
"
