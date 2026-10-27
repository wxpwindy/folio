#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   AWS_PROFILE=wxpwindy AWS_REGION=ap-southeast-2 ./aws/lmstudio-next-steps.sh smoke
#   AWS_PROFILE=wxpwindy AWS_REGION=ap-southeast-2 ./aws/lmstudio-next-steps.sh cleanup-bedrock-proxy
#   AWS_PROFILE=wxpwindy AWS_REGION=ap-southeast-2 ./aws/lmstudio-next-steps.sh fix-504
#   AWS_PROFILE=wxpwindy AWS_REGION=ap-southeast-2 ./aws/lmstudio-next-steps.sh enable-ai-debug
#   AWS_PROFILE=wxpwindy AWS_REGION=ap-southeast-2 ./aws/lmstudio-next-steps.sh show-ai-debug-logs
#   AWS_PROFILE=wxpwindy AWS_REGION=ap-southeast-2 bash aws/lmstudio-next-steps.sh diagnose-504

MODE="${1:-}"
CF_URL="https://d2t5y3ri1ve041.cloudfront.net"

if [[ -z "$MODE" ]]; then
  echo "Provide mode: smoke | cleanup-bedrock-proxy | fix-504 | enable-ai-debug | show-ai-debug-logs | diagnose-504" >&2
  exit 2
fi

case "$MODE" in
  diagnose-504)
    : "${AWS_PROFILE:?Set AWS_PROFILE}"
    : "${AWS_REGION:?Set AWS_REGION}"
    if [[ "$AWS_REGION" != "ap-southeast-2" ]]; then
      echo "This deployment uses ap-southeast-2; refusing to target another Region." >&2
      exit 2
    fi
    export AWS_PAGER=""
    command -v jq >/dev/null
    INSTANCE_ID="${EC2_INSTANCE_ID:-i-01c90f2178c1e19f9}"
    DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-ETF4ASW8WSAAJ}"
    echo "CloudFront timeout settings (origin secrets excluded):"
    aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" \
      --query 'DistributionConfig.{Origins:Origins.Items[].{Id:Id,ReadTimeout:CustomOriginConfig.OriginReadTimeout,CompletionTimeout:ResponseCompletionTimeout},DefaultOrigin:DefaultCacheBehavior.TargetOriginId,Behaviors:CacheBehaviors.Items[].{Path:PathPattern,Origin:TargetOriginId}}' \
      --output json

    REMOTE_COMMAND=$(cat <<'REMOTE'
set -eu
echo 'Service health:'
for service in folio nginx ollama; do systemctl is-active "$service" || true; done
echo 'Memory:'
free -m
echo 'Installed/running models (no inference request):'
if command -v ollama >/dev/null 2>&1; then HOME=/root ollama ps; fi
echo 'Model endpoint health:'
curl --silent --show-error --max-time 10 --output /dev/null --write-out 'HTTP %{http_code}; duration %{time_total}s\n' http://127.0.0.1:11434/v1/models
echo 'Deployed backend timeout support:'
if grep -q 'function providerTimeoutMs' /home/folio/folio/server/ai.ts; then
  echo 'Configurable provider timeout code is present.'
else
  echo 'Configurable provider timeout code is MISSING; timeout environment overrides may have no effect.'
fi
echo 'Nginx effective timeout directives (no origin secrets):'
nginx -T 2>/dev/null | grep -E '^[[:space:]]*(proxy_read_timeout|proxy_send_timeout|send_timeout)[[:space:]]' || true
echo 'Upstream timeout entries among last 200 Nginx error lines (count only):'
if [ -r /var/log/nginx/error.log ]; then
  tail -n 200 /var/log/nginx/error.log | grep -c 'upstream timed out' || true
else
  echo 'Default Nginx error log is unavailable.'
fi
REMOTE
)
    PARAMS=$(mktemp)
    trap 'rm -f "$PARAMS"' EXIT
    jq -n --arg command "$REMOTE_COMMAND" '{commands:[$command],executionTimeout:["120"]}' > "$PARAMS"
    CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" \
      --document-name AWS-RunShellScript --comment 'Read-only Folio 504 diagnostics; no resume content' \
      --parameters "file://$PARAMS" --query 'Command.CommandId' --output text)
    echo "Diagnostic command: $CMD_ID"
    WAIT_STATUS=0
    aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" || WAIT_STATUS=$?
    aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
      --query '{Status:Status,Output:StandardOutputContent,Errors:StandardErrorContent}' --output json
    exit "$WAIT_STATUS"
    ;;

  smoke)
    EMAIL="folio-smoke-$(date +%s)@example.test"
    PASS='FolioSmokePassword42!'
    ORIGIN="$CF_URL"
    COOKIE_JAR="$(mktemp)"

    echo "Signing up test user: $EMAIL"
    SIGNUP_STATUS=$(curl -sS -o /tmp/folio-signup.json -w "%{http_code}" \
      -c "$COOKIE_JAR" \
      -H "Content-Type: application/json" \
      -H "Origin: $ORIGIN" \
      -H "X-Folio-Request: 1" \
      -X POST "$CF_URL/api/auth/signup" \
      -d "{\"method\":\"email\",\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}")

    if [[ "$SIGNUP_STATUS" != "201" ]]; then
      echo "Signup failed with HTTP $SIGNUP_STATUS" >&2
      cat /tmp/folio-signup.json >&2 || true
      exit 1
    fi

    OWNER_ID=$(jq -r '.user.id' /tmp/folio-signup.json)
    if [[ -z "$OWNER_ID" || "$OWNER_ID" == "null" ]]; then
      echo "Missing owner id in signup response" >&2
      cat /tmp/folio-signup.json >&2 || true
      exit 1
    fi

    echo "Fetching model list"
    curl -sS \
      -b "$COOKIE_JAR" \
      -H "Origin: $ORIGIN" \
      -H "X-Folio-User: $OWNER_ID" \
      "$CF_URL/api/lmstudio/models" | jq .

    echo "Running chat completion"
    CHAT_STATUS=$(curl -sS -o /tmp/folio-chat.json -w "%{http_code}" \
      -b "$COOKIE_JAR" \
      -H "Content-Type: application/json" \
      -H "Origin: $ORIGIN" \
      -H "X-Folio-Request: 1" \
      -H "X-Folio-User: $OWNER_ID" \
      -X POST "$CF_URL/api/chat" \
      -d '{"model":"google/gemma-4-e4b","messages":[{"role":"user","content":"Reply with exactly: ok"}],"webSearch":false}')

    echo "Chat HTTP status: $CHAT_STATUS"
    cat /tmp/folio-chat.json | jq .

    if [[ "$CHAT_STATUS" != "200" ]]; then
      echo "Chat smoke test failed" >&2
      exit 1
    fi

    ;;

  cleanup-bedrock-proxy)
    : "${AWS_PROFILE:?Set AWS_PROFILE}"
    : "${AWS_REGION:?Set AWS_REGION}"

    FUNC_NAME="folio-lmstudio-bedrock-proxy"
    ROLE_NAME="folio-lmstudio-bedrock-proxy-role"
    POLICY_NAME="folio-lmstudio-bedrock-invoke"

    echo "Deleting Lambda function URL config if present"
    aws lambda delete-function-url-config --function-name "$FUNC_NAME" >/dev/null 2>&1 || true

    echo "Deleting Lambda function if present"
    aws lambda delete-function --function-name "$FUNC_NAME" >/dev/null 2>&1 || true

    echo "Deleting inline IAM role policy if present"
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" >/dev/null 2>&1 || true

    echo "Deleting IAM role if present"
    aws iam delete-role --role-name "$ROLE_NAME" >/dev/null 2>&1 || true

    echo "Cleanup complete"
    ;;

  fix-504)
    : "${AWS_PROFILE:?Set AWS_PROFILE}"
    : "${AWS_REGION:?Set AWS_REGION}"

    # Override if needed, for example: EC2_INSTANCE_ID=i-abc123
    INSTANCE_ID="${EC2_INSTANCE_ID:-i-01c90f2178c1e19f9}"
    LM_TIMEOUT_MS="${LM_TIMEOUT_MS:-900000}"

    echo "Applying longer model/proxy timeouts on instance: $INSTANCE_ID"
    CMD_ID=$(aws ssm send-command \
      --instance-ids "$INSTANCE_ID" \
      --document-name AWS-RunShellScript \
      --comment "Increase Folio model and Nginx proxy timeouts to prevent 504" \
      --parameters commands='[
"set -euo pipefail",
"sudo mkdir -p /etc/systemd/system/folio.service.d",
"cat <<\"EOF\" | sudo tee /etc/systemd/system/folio.service.d/timeouts.conf >/dev/null",
"[Service]",
"Environment=LMSTUDIO_TIMEOUT_MS='"$LM_TIMEOUT_MS"'",
"Environment=OLLAMA_TIMEOUT_MS='"$LM_TIMEOUT_MS"'",
"EOF",
"sudo systemctl daemon-reload",
"sudo systemctl restart folio",
"if ! grep -q \"proxy_read_timeout\" /etc/nginx/conf.d/folio.conf; then",
"  sudo sed -i.bak -E \"s#(proxy_pass\\s+http://127\\.0\\.0\\.1:3001;[[:space:]]*)#proxy_read_timeout 900s;\\n    proxy_send_timeout 900s;\\n    send_timeout 900s;\\n    \\1#\" /etc/nginx/conf.d/folio.conf",
"fi",
"sudo nginx -t",
"sudo systemctl reload nginx",
"systemctl is-active folio",
"systemctl is-active nginx",
"systemctl show folio --property=Environment --no-pager",
"grep -n \"proxy_read_timeout\\|proxy_send_timeout\\|send_timeout\" /etc/nginx/conf.d/folio.conf"
]' \
      --query 'Command.CommandId' --output text)

    aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID"
    aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query '[Status,StandardOutputContent,StandardErrorContent]' --output json

    echo "Timeout fix applied. Re-run smoke check next."
    ;;

  enable-ai-debug)
    : "${AWS_PROFILE:?Set AWS_PROFILE}"
    : "${AWS_REGION:?Set AWS_REGION}"

    INSTANCE_ID="${EC2_INSTANCE_ID:-i-01c90f2178c1e19f9}"

    echo "Enabling AI debug output on instance: $INSTANCE_ID"
    CMD_ID=$(aws ssm send-command \
      --instance-ids "$INSTANCE_ID" \
      --document-name AWS-RunShellScript \
      --comment "Enable Folio AI debug output" \
      --parameters commands='[
"set -euo pipefail",
"sudo mkdir -p /etc/systemd/system/folio.service.d",
"if [ -f /etc/systemd/system/folio.service.d/timeouts.conf ]; then",
"  sudo awk '\''BEGIN{seen=0} /^Environment=FOLIO_AI_DEBUG_OUTPUT=/{seen=1} {print} END{if(!seen) print \"Environment=FOLIO_AI_DEBUG_OUTPUT=1\"}'\'' /etc/systemd/system/folio.service.d/timeouts.conf | sudo tee /etc/systemd/system/folio.service.d/timeouts.conf >/dev/null",
"else",
"  cat <<\"EOF\" | sudo tee /etc/systemd/system/folio.service.d/timeouts.conf >/dev/null",
"[Service]",
"Environment=FOLIO_AI_DEBUG_OUTPUT=1",
"EOF",
"fi",
"sudo systemctl daemon-reload",
"sudo systemctl restart folio",
"systemctl is-active folio",
"systemctl show folio --property=Environment --no-pager"
]' \
      --query 'Command.CommandId' --output text)

    aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID"
    aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query '[Status,StandardOutputContent,StandardErrorContent]' --output json

    echo "AI debug logging enabled. Trigger resume generation, then run show-ai-debug-logs."
    ;;

  show-ai-debug-logs)
    : "${AWS_PROFILE:?Set AWS_PROFILE}"
    : "${AWS_REGION:?Set AWS_REGION}"

    INSTANCE_ID="${EC2_INSTANCE_ID:-i-01c90f2178c1e19f9}"

    echo "Fetching recent ai-debug lines from folio service logs on: $INSTANCE_ID"
    CMD_ID=$(aws ssm send-command \
      --instance-ids "$INSTANCE_ID" \
      --document-name AWS-RunShellScript \
      --comment "Show recent Folio AI debug output" \
      --parameters commands='[
"set -euo pipefail",
"journalctl -u folio -n 400 --no-pager | grep \"\\[ai-debug\\]\" | tail -n 120 || true"
]' \
      --query 'Command.CommandId' --output text)

    aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID"
    aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query '[Status,StandardOutputContent,StandardErrorContent]' --output json
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    exit 2
    ;;
esac
