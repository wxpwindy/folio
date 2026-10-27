#!/usr/bin/env bash
set -euo pipefail

# Read-only: no instance launches, resizes, quota requests, or network changes.
: "${AWS_PROFILE:?Set AWS_PROFILE}"
: "${AWS_REGION:?Set AWS_REGION}"
[[ "$AWS_REGION" == ap-southeast-2 ]] || {
  echo 'Expected the existing project Region ap-southeast-2.' >&2
  exit 2
}
export AWS_PAGER="" AWS_MAX_ATTEMPTS=3
command -v aws >/dev/null
command -v python3 >/dev/null
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
INSTANCE_ID="${EC2_INSTANCE_ID:-i-01c90f2178c1e19f9}"

echo 'Existing web instance (no changes):'
aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[].Instances[].{Type:InstanceType,Architecture:Architecture,State:State.Name,AZ:Placement.AvailabilityZone,RootDevice:RootDeviceType}' \
  --output json
echo 'GPU candidate specifications:'
aws ec2 describe-instance-types --instance-types g4dn.xlarge \
  --query 'InstanceTypes[].{Type:InstanceType,vCPUs:VCpuInfo.DefaultVCpus,RAMMiB:MemoryInfo.SizeInMiB,GPU:GpuInfo.Gpus,Architectures:ProcessorInfo.SupportedArchitectures}' \
  --output json
echo 'Offered Availability Zones (an offering is not a capacity reservation):'
aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters Name=instance-type,Values=g4dn.xlarge \
  --query 'InstanceTypeOfferings[].Location' --output json
echo 'Current On-Demand G/VT vCPU quota (existing usage must also be checked):'
aws service-quotas list-service-quotas --service-code ec2 \
  --query "Quotas[?contains(QuotaName, 'Running On-Demand G and VT instances')].{Name:QuotaName,Value:Value,Adjustable:Adjustable}" \
  --output json
echo 'Existing active GPU instances that may consume this quota:'
aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=pending,running,stopping,stopped Name=instance-type,Values=g*,vt* \
  --query 'Reservations[].Instances[].{Type:InstanceType,State:State.Name,Lifecycle:InstanceLifecycle}' \
  --output json

# Pricing is a global catalog endpoint, not a resource deployment in us-east-1.
aws pricing get-products --region us-east-1 --service-code AmazonEC2 \
  --filters \
    Type=TERM_MATCH,Field=productFamily,Value='Compute Instance' \
    Type=TERM_MATCH,Field=instanceType,Value=g4dn.xlarge \
    Type=TERM_MATCH,Field=location,Value='Asia Pacific (Sydney)' \
    Type=TERM_MATCH,Field=operatingSystem,Value=Linux \
    Type=TERM_MATCH,Field=tenancy,Value=Shared \
    Type=TERM_MATCH,Field=preInstalledSw,Value=NA \
    Type=TERM_MATCH,Field=capacitystatus,Value=Used \
  --output json > "$WORK/pricing.json"

python3 - "$WORK/pricing.json" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR

with open(sys.argv[1], encoding="utf-8") as source:
    products = json.load(source)["PriceList"]
rates = set()
for raw in products:
    product = json.loads(raw)
    for term in product.get("terms", {}).get("OnDemand", {}).values():
        for dimension in term.get("priceDimensions", {}).values():
            if dimension.get("unit") == "Hrs" and dimension.get("beginRange") == "0":
                rate = Decimal(dimension["pricePerUnit"]["USD"])
                if rate > 0:
                    rates.add(rate)
if len(rates) != 1:
    raise SystemExit("Could not identify a unique current hourly price; do not provision.")
rate = rates.pop()
print("Price lookup UTC:", datetime.now(timezone.utc).isoformat())
print(f"Sydney Linux On-Demand g4dn.xlarge: USD {rate}/running hour")
print(f"Continuous compute only, using 730 hours/month: USD {rate * Decimal(730):.2f}")
print("Approved total monthly budget: USD 100.00")
reserve = os.environ.get("NON_GPU_RESERVE_USD")
if reserve is None:
    print("Runtime allowance NOT set: first estimate existing web costs, GPU EBS, network, taxes and safety margin.")
else:
    reserve = Decimal(reserve)
    if not reserve.is_finite() or not Decimal(0) < reserve < Decimal(100):
        raise SystemExit("NON_GPU_RESERVE_USD must be greater than 0 and less than 100.")
    hours = ((Decimal(100) - reserve) / rate).to_integral_value(rounding=ROUND_FLOOR)
    print(f"Illustrative monthly running-hour allowance after USD {reserve} reserve: {hours}")
    print("This is planning arithmetic, not an enforced billing cap or a verified reserve.")
print("Stopped instances still incur EBS and potentially other charges; idle time while running is billed.")
print("No capacity has been provisioned. Availability, quota usage, and all non-compute costs need verification.")
PY