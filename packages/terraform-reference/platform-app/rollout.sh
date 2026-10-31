#!/bin/bash
# CodeBuild (F2): run deploy.sh on the instance through SSM Run Command and
# wait for it. On failure, prints what the instance printed -- including the
# app's own logs when it crashed at startup.
set -euo pipefail

# A new instance needs a minute or two to register with SSM.
for i in $(seq 1 60); do
  registered=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query "length(InstanceInformationList)" --output text)
  [ "$registered" = "1" ] && break
  if [ "$i" = "60" ]; then
    echo "The instance $INSTANCE_ID never registered with SSM (waited 10 minutes)."
    exit 1
  fi
  sleep 10
done

script="set -e; mkdir -p /opt/autoinfra; aws s3 cp s3://$ARTIFACTS_BUCKET/deploy/deploy.sh /opt/autoinfra/deploy.sh --region $AWS_REGION --only-show-errors; bash /opt/autoinfra/deploy.sh $ARTIFACTS_BUCKET $AWS_REGION $SSM_PREFIX"
params=$(python3 -c 'import json, sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["1800"]}))' "$script")
command_id=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)
echo "Rolling out on $INSTANCE_ID (SSM command $command_id)"

status=Pending
for _ in $(seq 1 180); do # up to 30 minutes
  sleep 10
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$status" in Success | Failed | Cancelled | TimedOut) break ;; esac
done

aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text || true
if [ "$status" != "Success" ]; then
  echo "--- errors from the instance ---"
  aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query StandardErrorContent --output text || true
  echo "The rollout on the instance ended with status: $status"
  exit 1
fi
