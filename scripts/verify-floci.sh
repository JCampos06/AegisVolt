#!/usr/bin/env bash
# Verifica (Día 1) que Floci soporta los servicios que exige AegisVolt.
# Crea recursos temporales "verify-*" y los elimina al final.
# Uso: bash scripts/verify-floci.sh
set -uo pipefail

CONTAINER="${FLOCI_CONTAINER:-aegisvolt-floci}"
aws_() { MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" aws --endpoint-url http://localhost:4566 --region us-east-1 --output text "$@"; }

pass=0; fail=0
check() {
  local name="$1"; shift
  if out=$("$@" 2>&1); then
    printf "  [OK]    %s\n" "$name"; pass=$((pass+1))
  else
    printf "  [FALLA] %s -> %s\n" "$name" "$(echo "$out" | tail -1)"; fail=$((fail+1))
  fi
}

echo "== Floci: verificación de servicios para AegisVolt =="

echo "-- STS / IAM"
check "sts get-caller-identity" aws_ sts get-caller-identity
check "iam list-roles"          aws_ iam list-roles

echo "-- S3 (estado de Terraform con versionamiento)"
check "s3 create-bucket"        aws_ s3api create-bucket --bucket verify-aegisvolt
check "s3 put-bucket-versioning" aws_ s3api put-bucket-versioning --bucket verify-aegisvolt --versioning-configuration Status=Enabled
docker exec "$CONTAINER" sh -c 'echo v1 > /tmp/v.txt'
aws_ s3api put-object --bucket verify-aegisvolt --key env:/dev/test.tfstate --body /tmp/v.txt >/dev/null 2>&1
docker exec "$CONTAINER" sh -c 'echo v2 > /tmp/v.txt'
aws_ s3api put-object --bucket verify-aegisvolt --key env:/dev/test.tfstate --body /tmp/v.txt >/dev/null 2>&1
versions=$(aws_ s3api list-object-versions --bucket verify-aegisvolt --prefix env:/dev/ --query 'length(Versions)' 2>/dev/null)
if [ "${versions:-0}" -ge 2 ] 2>/dev/null; then printf "  [OK]    s3 list-object-versions (%s versiones)\n" "$versions"; pass=$((pass+1)); else printf "  [FALLA] s3 versiones = %s\n" "$versions"; fail=$((fail+1)); fi

echo "-- DynamoDB"
check "dynamodb create-table"   aws_ dynamodb create-table --table-name verify-aegisvolt \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE --billing-mode PAY_PER_REQUEST
check "dynamodb put-item condicional" aws_ dynamodb put-item --table-name verify-aegisvolt \
  --item '{"PK":{"S":"A"},"SK":{"S":"B"}}' --condition-expression "attribute_not_exists(PK)"
# La segunda escritura condicional DEBE fallar (base de la idempotencia de la SAGA)
if aws_ dynamodb put-item --table-name verify-aegisvolt --item '{"PK":{"S":"A"},"SK":{"S":"B"}}' \
     --condition-expression "attribute_not_exists(PK)" >/dev/null 2>&1; then
  echo "  [FALLA] ConditionExpression no se respetó"; fail=$((fail+1))
else
  echo "  [OK]    ConditionalCheckFailed en escritura duplicada"; pass=$((pass+1))
fi

echo "-- EC2 / VPC / VPC Endpoints"
VPC=$(aws_ ec2 create-vpc --cidr-block 10.99.0.0/16 --query Vpc.VpcId 2>/dev/null)
if [ -n "$VPC" ]; then echo "  [OK]    ec2 create-vpc ($VPC)"; pass=$((pass+1)); else echo "  [FALLA] ec2 create-vpc"; fail=$((fail+1)); fi
SUBNET=$(aws_ ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.99.1.0/24 --query Subnet.SubnetId 2>/dev/null)
[ -n "$SUBNET" ] && { echo "  [OK]    ec2 create-subnet"; pass=$((pass+1)); } || { echo "  [FALLA] ec2 create-subnet"; fail=$((fail+1)); }
RT=$(aws_ ec2 create-route-table --vpc-id "$VPC" --query RouteTable.RouteTableId 2>/dev/null)
[ -n "$RT" ] && { echo "  [OK]    ec2 create-route-table"; pass=$((pass+1)); } || { echo "  [FALLA] ec2 create-route-table"; fail=$((fail+1)); }
SG=$(aws_ ec2 create-security-group --group-name verify-sg --description verify --vpc-id "$VPC" --query GroupId 2>/dev/null)
[ -n "$SG" ] && { echo "  [OK]    ec2 create-security-group"; pass=$((pass+1)); } || { echo "  [FALLA] ec2 create-security-group"; fail=$((fail+1)); }
check "vpce Gateway dynamodb"   aws_ ec2 create-vpc-endpoint --vpc-id "$VPC" --vpc-endpoint-type Gateway \
  --service-name com.amazonaws.us-east-1.dynamodb --route-table-ids "$RT"
check "vpce Gateway s3"         aws_ ec2 create-vpc-endpoint --vpc-id "$VPC" --vpc-endpoint-type Gateway \
  --service-name com.amazonaws.us-east-1.s3 --route-table-ids "$RT"
check "vpce Interface logs"     aws_ ec2 create-vpc-endpoint --vpc-id "$VPC" --vpc-endpoint-type Interface \
  --service-name com.amazonaws.us-east-1.logs --subnet-ids "$SUBNET" --security-group-ids "$SG"
check "vpce Interface execute-api" aws_ ec2 create-vpc-endpoint --vpc-id "$VPC" --vpc-endpoint-type Interface \
  --service-name com.amazonaws.us-east-1.execute-api --subnet-ids "$SUBNET" --security-group-ids "$SG"

echo "-- API Gateway v2 + VPC Link"
check "apigatewayv2 create-api" aws_ apigatewayv2 create-api --name verify-api --protocol-type HTTP
check "apigatewayv2 create-vpc-link" aws_ apigatewayv2 create-vpc-link --name verify-link \
  --subnet-ids "$SUBNET" --security-group-ids "$SG"

echo "-- CloudWatch Logs / Metrics"
check "logs create-log-group"   aws_ logs create-log-group --log-group-name /aegisvolt/verify/svc
check "logs create-log-stream"  aws_ logs create-log-stream --log-group-name /aegisvolt/verify/svc --log-stream-name s1
check "logs put-log-events"     aws_ logs put-log-events --log-group-name /aegisvolt/verify/svc --log-stream-name s1 \
  --log-events "[{\"timestamp\":$(date +%s)000,\"message\":\"{\\\"correlation_id\\\":\\\"abc-123\\\",\\\"env\\\":\\\"verify\\\"}\"}]"
check "logs filter-log-events (correlation_id)" aws_ logs filter-log-events --log-group-name /aegisvolt/verify/svc --filter-pattern '"abc-123"'
check "cloudwatch put-metric-data" aws_ cloudwatch put-metric-data --namespace AegisVolt/Verify --metric-name Errors --value 1

echo "-- Limpieza"
aws_ s3 rb s3://verify-aegisvolt --force >/dev/null 2>&1
aws_ dynamodb delete-table --table-name verify-aegisvolt >/dev/null 2>&1
aws_ logs delete-log-group --log-group-name /aegisvolt/verify/svc >/dev/null 2>&1
for id in $(aws_ apigatewayv2 get-apis --query "Items[?Name=='verify-api'].ApiId" 2>/dev/null); do aws_ apigatewayv2 delete-api --api-id "$id" >/dev/null 2>&1; done
for id in $(aws_ apigatewayv2 get-vpc-links --query "Items[?Name=='verify-link'].VpcLinkId" 2>/dev/null); do aws_ apigatewayv2 delete-vpc-link --vpc-link-id "$id" >/dev/null 2>&1; done
for id in $(aws_ ec2 describe-vpc-endpoints --filters Name=vpc-id,Values="$VPC" --query 'VpcEndpoints[].VpcEndpointId' 2>/dev/null); do aws_ ec2 delete-vpc-endpoints --vpc-endpoint-ids "$id" >/dev/null 2>&1; done
[ -n "${SG:-}" ] && aws_ ec2 delete-security-group --group-id "$SG" >/dev/null 2>&1
[ -n "${SUBNET:-}" ] && aws_ ec2 delete-subnet --subnet-id "$SUBNET" >/dev/null 2>&1
[ -n "${RT:-}" ] && aws_ ec2 delete-route-table --route-table-id "$RT" >/dev/null 2>&1
[ -n "${VPC:-}" ] && aws_ ec2 delete-vpc --vpc-id "$VPC" >/dev/null 2>&1

echo
echo "Resultado: $pass OK, $fail FALLAS"
[ "$fail" -eq 0 ]
