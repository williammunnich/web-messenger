#!/bin/bash
# Deploys the messenger to your AWS account. Reads deploy.env. Works from a Mac with the AWS CLI, or from AWS CloudShell.
#   bash aws/deploy.sh check      what's configured, what's missing. Changes nothing.
#   bash aws/deploy.sh secrets    stores the session key, Google client secret and Apple key in SSM (encrypted).
#   bash aws/deploy.sh deploy     runs the tests, then creates or updates the stack. Safe to re-run.
#   bash aws/deploy.sh urls       prints the addresses and the embed tag.
#   bash aws/deploy.sh logs       follows the function's logs.
#
# @file deploy.sh
# @project web-messenger
# @usage bash aws/deploy.sh check|secrets|deploy|urls|logs
# @param $1 The command (above). Anything else prints the usage lines and exits 1.
# @env deploy.env Read from the repo root; it must exist. It sets ALLOWED_EMAIL and, optionally, PREFIX (stack name,
#      default messenger), REGION (default us-east-1), OWNER_NAME (default Support), GOOGLE_CLIENT_ID, ALLOWED_ORIGINS,
#      SITE_URL, CHAT_DOMAIN, INBOX_DOMAIN, CERT_ARN, HOSTED_ZONE_ID, APNS_TEAM_ID, APNS_TOPIC, MAIL_ADDRESS, FROM_ADDRESS.
# @env REPLACE Set to 1 with `secrets` to replace a stored Google client secret or Apple key.
# @exit 0 on success; 1 when deploy.env, the AWS CLI, the AWS sign-in or a needed setting is missing; otherwise
#       the status of the command that failed (set -e).
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-14
#
# Lines 2-7 of this file are the usage text printed for an unknown command (the `sed -n 2,7p` at the bottom),
# so they must stay where they are.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ -f deploy.env ] || { echo "No deploy.env. Run: cp deploy.env.example deploy.env, then fill it in (docs/deploy.md)."; exit 1; }
set -a; . ./deploy.env; set +a
PREFIX=${PREFIX:-messenger} REGION=${REGION:-us-east-1} OWNER_NAME=${OWNER_NAME:-Support}
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
STACK=$PREFIX

# Checks that the AWS CLI is installed and signed in; prints the account id. Exits 1 otherwise.
need_aws() {
  command -v aws >/dev/null || { echo "The AWS CLI isn't installed: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"; exit 1; }
  aws sts get-caller-identity --query Account --output text 2>/dev/null || { echo "Not signed in to AWS: run 'aws configure' or 'aws sso login'."; exit 1; }
}
# Tells whether an SSM parameter exists.
# @param $1 The parameter name.
has_param() { aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }
# Prints one output value of the stack.
# @param $1 The output key.
output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
# Prints one line of the `check` report.
# @param $1 The label.
# @param $2 The value; "ok" is printed when it is not empty.
# @param $3 The word to print when it is empty (default: missing).
mark() { if [ -n "$2" ]; then printf '  ok       %s\n' "$1"; else printf '  %-8s %s\n' "${3:-missing}" "$1"; fi; }

# check: shows what is configured in deploy.env and SSM and what is missing. Changes nothing.
check() {
  local acct; acct=$(need_aws)
  echo "Account $acct, region $REGION, stack $STACK"
  case "$ALLOWED_EMAIL" in ""|you@example.com) mark ALLOWED_EMAIL "" ;; *) mark ALLOWED_EMAIL x ;; esac
  mark GOOGLE_CLIENT_ID "${GOOGLE_CLIENT_ID:-}"
  mark ALLOWED_ORIGINS "${ALLOWED_ORIGINS:-}"
  mark "push notifications (APNS_TEAM_ID, APNS_TOPIC)" "${APNS_TEAM_ID:-}" off
  mark "custom hostnames" "${CHAT_DOMAIN:-}${INBOX_DOMAIN:-}" off
  mark "email" "${MAIL_ADDRESS:-}" off
  for p in session-key google-client-secret apns-key apns-key-id; do
    if has_param "/$PREFIX/$p"; then mark "SSM /$PREFIX/$p" x; else mark "SSM /$PREFIX/$p" "" missing; fi
  done
}

# secrets: stores the session key (generated once), the Google client secret and the Apple push key and key id
# in SSM, asking for the last two on the terminal. Exits 1 on a bad .p8 file or key id.
secrets() {
  need_aws >/dev/null
  if has_param "/$PREFIX/session-key"; then echo "session key: already stored"; else
    aws ssm put-parameter --name "/$PREFIX/session-key" --type SecureString --value "$(openssl rand -hex 32)" >/dev/null
    echo "session key: created"
  fi
  if has_param "/$PREFIX/google-client-secret" && [ "${REPLACE:-}" != 1 ]; then echo "Google client secret: already stored (REPLACE=1 to change it)"; else
    local s; read -r -s -p "Google client secret (hidden, Enter to skip): " s < /dev/tty; echo
    if [ -n "$s" ]; then aws ssm put-parameter --name "/$PREFIX/google-client-secret" --type SecureString --value "$s" --overwrite >/dev/null; echo "   stored"; fi
  fi
  if has_param "/$PREFIX/apns-key" && [ "${REPLACE:-}" != 1 ]; then echo "Apple push key: already stored (REPLACE=1 to change it)"; else
    local f kid; read -r -p "Path of your AuthKey_XXXXXXXXXX.p8 (Enter to skip push notifications): " f < /dev/tty; f="${f/#\~/$HOME}"
    if [ -n "$f" ]; then
      grep -q 'BEGIN PRIVATE KEY' "$f" 2>/dev/null || { echo "   That isn't a .p8 key file. Nothing changed."; exit 1; }
      kid=$(basename "$f" | sed -nE 's/^AuthKey_([A-Z0-9]{10})\.p8$/\1/p')
      [ -n "$kid" ] || read -r -p "   Key ID (10 characters): " kid < /dev/tty
      [[ "$kid" =~ ^[A-Z0-9]{10}$ ]] || { echo "   A Key ID is 10 letters or digits. Nothing changed."; exit 1; }
      aws ssm put-parameter --name "/$PREFIX/apns-key" --type SecureString --value "$(cat "$f")" --overwrite >/dev/null
      aws ssm put-parameter --name "/$PREFIX/apns-key-id" --type String --value "$kid" --overwrite >/dev/null
      echo "   stored, encrypted. Keep the .p8 somewhere safe and out of this folder."
    fi
  fi
}

# Points a hostname at a target with a Route 53 alias record in HOSTED_ZONE_ID.
# @param $1 The hostname.
# @param $2 The target DNS name.
# @param $3 The target's hosted zone id.
dns() {   # $1 hostname, $2 target, $3 target zone
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":
    {\"Name\":\"$1\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"$3\",\"DNSName\":\"$2\",\"EvaluateTargetHealth\":false}}}]}" >/dev/null
  echo "DNS: $1 -> $2"
}

# deploy: runs the tests when node is installed, packages the template into the deploy bucket (created when missing),
# creates or updates the stack, sets DNS records when HOSTED_ZONE_ID is set, then prints the addresses.
# Exits 1 without ALLOWED_EMAIL or the session key, when the stack name belongs to something else, or when a test fails.
deploy() {
  local acct; acct=$(need_aws)
  case "$ALLOWED_EMAIL" in ""|you@example.com) echo "Set ALLOWED_EMAIL in deploy.env first."; exit 1 ;; esac
  has_param "/$PREFIX/session-key" || { echo "Run 'bash aws/deploy.sh secrets' first."; exit 1; }

  # Never touch a stack this repo didn't create: PREFIX names the stack, so a typo could otherwise update something else.
  if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
    [ -n "$(output InboxUrl)" ] && [ "$(output InboxUrl)" != None ] || { echo "Stack '$STACK' exists and wasn't made by this repo. Pick another PREFIX. Nothing changed."; exit 1; }
  fi

  # A failing test must stop the deploy. (An `a && b && c` list would not: `set -e` ignores a failure inside it.)
  if command -v node >/dev/null; then
    node --test aws/chat/test/*.test.mjs >/dev/null || { echo "Tests failed (see: npm test). Nothing was deployed."; exit 1; }
    echo "tests passed"
  else
    echo "node isn't installed: skipping the tests"
  fi
  local art="$PREFIX-deploy-$acct-$REGION" out; out=$(mktemp)
  aws s3api head-bucket --bucket "$art" 2>/dev/null || {
    if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$art" >/dev/null
    else aws s3api create-bucket --bucket "$art" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
    aws s3api put-public-access-block --bucket "$art" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true; }
  aws cloudformation package --template-file aws/chat/template.yaml --s3-bucket "$art" --output-template-file "$out" >/dev/null
  aws cloudformation deploy --template-file "$out" --stack-name "$STACK" --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset \
    --parameter-overrides "Prefix=$PREFIX" "AllowedEmail=$ALLOWED_EMAIL" "GoogleClientId=${GOOGLE_CLIENT_ID:-}" "AllowedOrigins=${ALLOWED_ORIGINS:-}" \
      "OwnerName=$OWNER_NAME" "SiteUrl=${SITE_URL:-}" "ChatDomain=${CHAT_DOMAIN:-}" "InboxDomain=${INBOX_DOMAIN:-}" "CertificateArn=${CERT_ARN:-}" \
      "ApnsTeamId=${APNS_TEAM_ID:-}" "ApnsTopic=${APNS_TOPIC:-}" "MailAddress=${MAIL_ADDRESS:-}" "FromAddress=${FROM_ADDRESS:-}"
  rm -f "$out"
  if [ -n "${HOSTED_ZONE_ID:-}" ]; then
    [ -z "${CHAT_DOMAIN:-}" ] || dns "$CHAT_DOMAIN" "$(output ChatDomainTarget)" "$(output ChatDomainZone)"
    [ -z "${INBOX_DOMAIN:-}" ] || dns "$INBOX_DOMAIN" "$(output InboxDomainTarget)" "$(output InboxDomainZone)"
  fi
  urls
}

# urls: prints the inbox, Google redirect, WebSocket and demo addresses and the embed tag.
urls() {
  need_aws >/dev/null
  local inbox; inbox=$(output InboxUrl)
  echo; echo "Inbox and iPhone app host:  $inbox"
  echo "Google redirect URI:        ${inbox}oauth2/callback"
  echo "WebSocket:                  $(output ChatWs)"
  echo "Demo page:                  ${inbox}demo"
  [ -z "${CHAT_DOMAIN:-}" ] || echo "Point $CHAT_DOMAIN at:  $(output ChatDomainTarget)"
  [ -z "${INBOX_DOMAIN:-}" ] || echo "Point $INBOX_DOMAIN at:  $(output InboxDomainTarget)"
  echo; echo "Put this on your site:"; echo "  <script src=\"${inbox}widget/chat.js\" defer></script>"
}

case "${1:-}" in
  check) check ;; secrets) secrets ;; deploy) deploy ;; urls) urls ;;
  logs) need_aws >/dev/null; aws logs tail "/aws/lambda/$PREFIX" --follow ;;
  *) sed -n 2,7p "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
