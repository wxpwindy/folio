#!/usr/bin/env bash
set -euo pipefail

# Run while no document generation is active. Does not resize EC2 or alter ingress.
: "${AWS_PROFILE:?Set AWS_PROFILE}"
: "${AWS_REGION:?Set AWS_REGION}"
if [[ "$AWS_REGION" != ap-southeast-2 ]]; then
  echo 'This deployment uses ap-southeast-2; refusing another Region.' >&2
  exit 2
fi
export AWS_PAGER=""
command -v jq >/dev/null
INSTANCE_ID="${EC2_INSTANCE_ID:-i-01c90f2178c1e19f9}"

REMOTE_COMMAND=$(cat <<'REMOTE'
set -eu
export HOME=/root
command -v python3 >/dev/null
command -v timeout >/dev/null
systemctl is-active --quiet ollama
# Production must already support the configurable OpenAI-compatible endpoint.
grep -q 'process.env.LMSTUDIO_URL' /home/folio/folio/server/lmstudio.ts || {
  echo 'Production LMSTUDIO_URL support is missing. Deploy backend code first.' >&2
  exit 1
}
WORK=$(mktemp -d)
DROPIN=/etc/systemd/system/folio.service.d/zz-small-model.conf
CHANGED=0
COMMITTED=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$CHANGED" = 1 ] && [ "$COMMITTED" = 0 ]; then
    echo 'Restoring previous Folio defaults after failure.' >&2
    if [ -f "$WORK/previous.conf" ]; then
      cp -p "$WORK/previous.conf" "$DROPIN"
    else
      rm -f "$DROPIN"
    fi
    systemctl daemon-reload
    systemctl restart folio || true
  fi
  rm -rf "$WORK"
  exit "$result"
}
trap cleanup EXIT
echo 'Downloading qwen2.5:0.5b; instance size is unchanged.'
timeout 600 ollama pull qwen2.5:0.5b > "$WORK/pull.log" 2>&1 || {
  echo 'Model download failed or exceeded 10 minutes; defaults unchanged.' >&2
  exit 1
}
# Release the previous oversized model if it is loaded, without deleting it.
ollama stop gemma3:4b >/dev/null 2>&1 || true
echo 'Testing real structured inference, not just model discovery:'
curl --fail --silent --show-error --connect-timeout 5 --max-time 120 \
  --output "$WORK/inference.json" --write-out 'Inference HTTP %{http_code}; duration %{time_total}s\n' \
  http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"Return a JSON object with status equal to ok."}],"temperature":0,"stream":false,"max_tokens":64,"response_format":{"type":"json_schema","json_schema":{"name":"health","strict":true,"schema":{"type":"object","properties":{"status":{"type":"string","enum":["ok"]}},"required":["status"],"additionalProperties":false}}}}'
python3 - "$WORK/inference.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    envelope = json.load(source)
content = json.loads(envelope["choices"][0]["message"]["content"])
if content != {"status": "ok"}:
    raise SystemExit("Structured inference failed; defaults unchanged.")
print("Structured inference passed.")
PY
mkdir -p /etc/systemd/system/folio.service.d
if [ -f "$DROPIN" ]; then
  cp -p "$DROPIN" "$WORK/previous.conf"
  cp -p "$DROPIN" "$DROPIN.previous"
fi
cat > "$WORK/new.conf" <<'CONFIG'
[Service]
Environment=FOLIO_AI_PROVIDER=lmstudio
Environment=LMSTUDIO_URL=http://127.0.0.1:11434/v1
Environment=LMSTUDIO_MODEL=qwen2.5:0.5b
Environment=OLLAMA_MODEL=qwen2.5:0.5b
CONFIG
CHANGED=1
install -m 600 "$WORK/new.conf" "$DROPIN"
systemctl daemon-reload
systemctl restart folio
healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl is-active --quiet folio && curl --fail --silent --show-error --max-time 2 \
    http://127.0.0.1:3001/api/auth/session --output /dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
[ "$healthy" = 1 ] || { echo 'Folio health check failed.' >&2; exit 1; }
COMMITTED=1
echo 'Folio default is now qwen2.5:0.5b. Instance and network settings unchanged.'
echo 'Reload Folio; in AI settings explicitly select qwen2.5:0.5b if an older preference remains.'
echo 'This probe does not verify full resume quality or completion within CloudFront’s 30-second timeout.'
echo 'Rollback: restore zz-small-model.conf.previous if this run created it, otherwise remove zz-small-model.conf; then systemctl daemon-reload and systemctl restart folio.'
REMOTE
)

PARAMS=$(mktemp)
trap 'rm -f "$PARAMS"' EXIT
jq -n --arg command "$REMOTE_COMMAND" '{commands:[$command],executionTimeout:["900"]}' > "$PARAMS"
CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment 'Switch Folio to smaller Qwen model; no EC2 resize' \
  --parameters "file://$PARAMS" --query 'Command.CommandId' --output text)
echo "Model switch command: $CMD_ID"
# Poll within a bounded window; the CLI's short default waiter is insufficient for a download.
for ((attempt=0; attempt<200; attempt++)); do
  STATUS=$(aws ssm list-command-invocations --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query 'CommandInvocations[0].Status' --output text)
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut|Cancelling)
      aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,Output:StandardOutputContent,Errors:StandardErrorContent}' --output json
      [[ "$STATUS" == Success ]]
      exit $?
      ;;
  esac
  sleep 5
done
echo "Polling limit reached; inspect SSM command $CMD_ID before retrying." >&2
exit 1