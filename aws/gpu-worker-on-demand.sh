#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE}"
: "${AWS_REGION:?Set AWS_REGION}"
if [[ "$AWS_REGION" != "ap-southeast-2" ]]; then
  echo "Expected AWS_REGION=ap-southeast-2 for this project." >&2
  exit 2
fi

export AWS_PAGER=""

WEB_INSTANCE_ID="${WEB_INSTANCE_ID:-i-01c90f2178c1e19f9}"
QUOTA_CODE="L-DB2E81BA"
LT_NAME="${GPU_LT_NAME:-folio-ai-worker-lt}"
SG_NAME="${GPU_SG_NAME:-folio-ai-worker-sg}"
WORKER_TAG_NAME="${GPU_WORKER_TAG_NAME:-folio-ai-worker}"
MODEL="${GPU_MODEL:-gemma3:4b}"
MAX_RUN_MINUTES="${MAX_RUN_MINUTES:-90}"
ROOT_DISK_GB="${ROOT_DISK_GB:-120}"
INSTANCE_TYPE="${GPU_INSTANCE_TYPE:-g4dn.xlarge}"
AMI_PARAM="${GPU_AMI_PARAM:-/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-amazon-linux-2/latest/ami-id}"
QUOTA_REQUEST_ID="${QUOTA_REQUEST_ID:-12861c9d1fbe4426a44c3add263ff2a42S6ObRTw}"

require_tools() {
  command -v aws >/dev/null
  command -v python3 >/dev/null
}

web_context() {
  aws ec2 describe-instances --instance-ids "$WEB_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].{VpcId:VpcId,SubnetId:SubnetId,WebSgId:SecurityGroups[0].GroupId,IamProfileArn:IamInstanceProfile.Arn}' \
    --output json
}

quota_status() {
  aws service-quotas get-service-quota --service-code ec2 --quota-code "$QUOTA_CODE" \
    --query '{QuotaName:Quota.QuotaName,Value:Quota.Value,Adjustable:Quota.Adjustable}' --output json
}

quota_request_status() {
  aws service-quotas get-requested-service-quota-change --request-id "$QUOTA_REQUEST_ID" \
    --query '{RequestId:RequestedQuota.Id,Status:RequestedQuota.Status,CaseId:RequestedQuota.CaseId,DesiredValue:RequestedQuota.DesiredValue,LastUpdated:RequestedQuota.LastUpdated}' \
    --output json
}

assert_quota_ready() {
  local current
  current=$(aws service-quotas get-service-quota --service-code ec2 --quota-code "$QUOTA_CODE" \
    --query 'Quota.Value' --output text)
  if [[ "$current" == "None" ]]; then
    echo "Could not read current quota value for $QUOTA_CODE." >&2
    return 1
  fi
  if (( $(printf '%.0f' "$current") < 4 )); then
    echo "Current G/VT quota is $current; requires at least 4 for $INSTANCE_TYPE." >&2
    echo "Request status:" >&2
    quota_request_status >&2 || true
    return 1
  fi
}

budget_allowance() {
  : "${NON_GPU_RESERVE_USD:?Set NON_GPU_RESERVE_USD to reserve budget for non-GPU costs}"
  local pricing_json
  pricing_json=$(mktemp)
  local rc
  aws pricing get-products --region us-east-1 --service-code AmazonEC2 \
    --filters \
      Type=TERM_MATCH,Field=productFamily,Value='Compute Instance' \
      Type=TERM_MATCH,Field=instanceType,Value="$INSTANCE_TYPE" \
      Type=TERM_MATCH,Field=location,Value='Asia Pacific (Sydney)' \
      Type=TERM_MATCH,Field=operatingSystem,Value=Linux \
      Type=TERM_MATCH,Field=tenancy,Value=Shared \
      Type=TERM_MATCH,Field=preInstalledSw,Value=NA \
      Type=TERM_MATCH,Field=capacitystatus,Value=Used \
    --output json > "$pricing_json"

  python3 - "$pricing_json" "$NON_GPU_RESERVE_USD" <<'PY'
import json
import sys
from decimal import Decimal, ROUND_FLOOR

with open(sys.argv[1], encoding="utf-8") as source:
    products = json.load(source)["PriceList"]
reserve = Decimal(sys.argv[2])
if not reserve.is_finite() or reserve <= 0 or reserve >= 100:
    raise SystemExit("NON_GPU_RESERVE_USD must be >0 and <100")

rates = set()
for raw in products:
    item = json.loads(raw)
    for term in item.get("terms", {}).get("OnDemand", {}).values():
        for dim in term.get("priceDimensions", {}).values():
            if dim.get("unit") == "Hrs" and dim.get("beginRange") == "0":
                price = Decimal(dim["pricePerUnit"]["USD"])
                if price > 0:
                    rates.add(price)
if len(rates) != 1:
    raise SystemExit("Could not determine a unique hourly price")
rate = rates.pop()
hours = ((Decimal("100") - reserve) / rate).to_integral_value(rounding=ROUND_FLOOR)
print(f"hourly_usd={rate}")
print(f"max_gpu_hours_month={hours}")
print("note=planning_only_not_a_hard_cap")
PY
  rc=$?
  rm -f "$pricing_json"
  return "$rc"
}

ensure_worker_sg() {
  local context vpc_id subnet_id web_sg_id worker_sg_id
  context=$(web_context)
  vpc_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["VpcId"])' <<<"$context")
  subnet_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["SubnetId"])' <<<"$context")
  web_sg_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["WebSgId"])' <<<"$context")

  worker_sg_id=$(aws ec2 describe-security-groups \
    --filters Name=vpc-id,Values="$vpc_id" Name=group-name,Values="$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text)

  if [[ "$worker_sg_id" == "None" ]]; then
    worker_sg_id=$(aws ec2 create-security-group --group-name "$SG_NAME" \
      --description "Folio AI worker: only accepts Ollama from web SG" --vpc-id "$vpc_id" \
      --query 'GroupId' --output text)
  fi

  set +e
  aws ec2 authorize-security-group-ingress --group-id "$worker_sg_id" \
    --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":11434,\"ToPort\":11434,\"UserIdGroupPairs\":[{\"GroupId\":\"$web_sg_id\"}]}]" \
    >/dev/null 2>&1
  set -e

  echo "$worker_sg_id|$subnet_id"
}

prepare_launch_template() {
  require_tools

  local profile_arn profile_name ami_id worker_sg_and_subnet worker_sg_id subnet_id user_data raw_user_data lt_json lt_exists
  profile_arn=$(aws ec2 describe-instances --instance-ids "$WEB_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)
  profile_name="${profile_arn##*/}"

  ami_id=$(aws ssm get-parameter --name "$AMI_PARAM" --query 'Parameter.Value' --output text)
  worker_sg_and_subnet=$(ensure_worker_sg)
  worker_sg_id="${worker_sg_and_subnet%%|*}"
  subnet_id="${worker_sg_and_subnet##*|}"

  read -r -d '' raw_user_data <<EOF || true
#!/usr/bin/env bash
set -euxo pipefail
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama
timeout 1800 ollama pull ${MODEL} || true
# Hard upper bound on runtime cost for this worker boot.
shutdown -h +${MAX_RUN_MINUTES}
EOF
  user_data=$(printf '%s' "$raw_user_data" | base64)

  lt_json=$(mktemp)
  local rc
  cat > "$lt_json" <<EOF
{
  "ImageId": "$ami_id",
  "InstanceType": "$INSTANCE_TYPE",
  "IamInstanceProfile": {"Name": "$profile_name"},
  "MetadataOptions": {
    "HttpTokens": "required",
    "HttpEndpoint": "enabled",
    "HttpPutResponseHopLimit": 2
  },
  "BlockDeviceMappings": [
    {
      "DeviceName": "/dev/xvda",
      "Ebs": {
        "VolumeType": "gp3",
        "VolumeSize": ${ROOT_DISK_GB},
        "DeleteOnTermination": true,
        "Encrypted": true
      }
    }
  ],
  "NetworkInterfaces": [
    {
      "DeviceIndex": 0,
      "AssociatePublicIpAddress": false,
      "DeleteOnTermination": true,
      "SubnetId": "$subnet_id",
      "Groups": ["$worker_sg_id"]
    }
  ],
  "UserData": "$user_data",
  "TagSpecifications": [
    {
      "ResourceType": "instance",
      "Tags": [
        {"Key": "Name", "Value": "$WORKER_TAG_NAME"},
        {"Key": "ManagedBy", "Value": "folio-gpu-worker-script"}
      ]
    }
  ]
}
EOF

  lt_exists=$(aws ec2 describe-launch-templates --launch-template-names "$LT_NAME" \
    --query 'LaunchTemplates[0].LaunchTemplateId' --output text 2>/dev/null || true)
  if [[ -z "$lt_exists" || "$lt_exists" == "None" ]]; then
    aws ec2 create-launch-template --launch-template-name "$LT_NAME" \
      --version-description "baseline" \
      --launch-template-data "file://$lt_json" \
      --query '{LaunchTemplateId:LaunchTemplate.LaunchTemplateId,LatestVersion:LaunchTemplate.LatestVersionNumber}' --output json
    rc=$?
  else
    local new_version
    new_version=$(aws ec2 create-launch-template-version --launch-template-name "$LT_NAME" \
      --version-description "refresh-$(date +%Y%m%d%H%M%S)" \
      --launch-template-data "file://$lt_json" \
      --query 'LaunchTemplateVersion.VersionNumber' --output text)
    aws ec2 modify-launch-template --launch-template-name "$LT_NAME" --default-version "$new_version" >/dev/null
    aws ec2 describe-launch-templates --launch-template-names "$LT_NAME" \
      --query '{LaunchTemplateId:LaunchTemplates[0].LaunchTemplateId,DefaultVersion:LaunchTemplates[0].DefaultVersionNumber,LatestVersion:LaunchTemplates[0].LatestVersionNumber}' --output json
    rc=$?
  fi
  rm -f "$lt_json"
  return "$rc"
}

start_worker() {
  require_tools
  assert_quota_ready
  prepare_launch_template >/dev/null

  local launched run_err exit_code
  run_err=$(mktemp)
  set +e
  launched=$(aws ec2 run-instances \
    --launch-template "LaunchTemplateName=$LT_NAME,Version=\$Default" \
    --instance-initiated-shutdown-behavior terminate \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$WORKER_TAG_NAME},{Key=ManagedBy,Value=folio-gpu-worker-script}]" \
    --query 'Instances[0].{InstanceId:InstanceId,PrivateIp:PrivateIpAddress,State:State.Name,AZ:Placement.AvailabilityZone}' \
    --output json 2>"$run_err")
  exit_code=$?
  set -e
  if [[ "$exit_code" -ne 0 ]]; then
    if grep -q "not eligible for Free Tier" "$run_err"; then
      echo "Launch blocked by account-level Free Tier eligibility enforcement." >&2
      echo "Use an AWS account with unrestricted paid EC2 launches, then retry start." >&2
      cat "$run_err" >&2
      rm -f "$run_err"
      return 1
    fi
    cat "$run_err" >&2
    rm -f "$run_err"
    return "$exit_code"
  fi
  rm -f "$run_err"
  echo "$launched"

  local instance_id
  instance_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["InstanceId"])' <<<"$launched")
  aws ec2 wait instance-running --instance-ids "$instance_id"
  aws ec2 describe-instances --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].{InstanceId:InstanceId,State:State.Name,PrivateIp:PrivateIpAddress,LaunchTime:LaunchTime}' --output json
}

stop_worker() {
  local id="${1:-}"
  if [[ -z "$id" ]]; then
    id=$(aws ec2 describe-instances \
      --filters Name=instance-state-name,Values=pending,running,stopping,stopped Name=tag:Name,Values="$WORKER_TAG_NAME" \
      --query 'Reservations[].Instances[].InstanceId' --output text)
  fi
  if [[ -z "$id" || "$id" == "None" ]]; then
    echo "No worker instances found." >&2
    return 1
  fi
  aws ec2 terminate-instances --instance-ids $id \
    --query '{Terminating:TerminatingInstances[].{InstanceId:InstanceId,CurrentState:CurrentState.Name,PreviousState:PreviousState.Name}}' --output json
}

status_worker() {
  aws ec2 describe-instances \
    --filters Name=tag:Name,Values="$WORKER_TAG_NAME" Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
    --query 'Reservations[].Instances[].{InstanceId:InstanceId,State:State.Name,PrivateIp:PrivateIpAddress,Type:InstanceType,AZ:Placement.AvailabilityZone,LaunchTime:LaunchTime}' \
    --output json
}

usage() {
  cat <<'EOF'
Usage:
  bash aws/gpu-worker-on-demand.sh quota
  bash aws/gpu-worker-on-demand.sh request-status
  NON_GPU_RESERVE_USD=35 bash aws/gpu-worker-on-demand.sh allowance
  bash aws/gpu-worker-on-demand.sh prepare
  MAX_RUN_MINUTES=90 GPU_MODEL=gemma3:4b bash aws/gpu-worker-on-demand.sh start
  bash aws/gpu-worker-on-demand.sh status
  bash aws/gpu-worker-on-demand.sh stop [instance-id]

Notes:
- start launches a private g4dn.xlarge worker with no public ingress and auto-shutdown timer.
- Worker accepts TCP 11434 only from the existing web SG.
- This script does not modify CloudFront, Nginx, or web ingress controls.
- Keep runtime bounded to remain within the 100 USD monthly budget.
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    quota)
      quota_status
      ;;
    request-status)
      quota_request_status
      ;;
    allowance)
      budget_allowance
      ;;
    prepare)
      prepare_launch_template
      ;;
    start)
      start_worker
      ;;
    status)
      status_worker
      ;;
    stop)
      stop_worker "${2:-}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"