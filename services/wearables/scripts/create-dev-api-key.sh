#!/usr/bin/env bash
# One-time local bootstrap: the wearables service's X-Open-Wearables-API-Key
# header is validated against a database-backed key, not a static secret, so
# it can't be baked into .env.example. This logs in as the admin account
# seeded automatically on first startup (ADMIN_EMAIL/ADMIN_PASSWORD from
# backend/config/.env) and creates a fresh API key via the authenticated
# POST /api/v1/developer/api-keys endpoint.
#
# Usage: ./services/wearables/scripts/create-dev-api-key.sh
# Then paste the printed key into the repo root .env as OPEN_WEARABLES_API_KEY.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../backend/config/.env"
API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy backend/config/.env.example to backend/config/.env first." >&2
  exit 1
fi

ADMIN_EMAIL="$(grep -E '^ADMIN_EMAIL=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2-)"
ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2-)"

if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "ADMIN_EMAIL / ADMIN_PASSWORD not set in $ENV_FILE" >&2
  exit 1
fi

echo "Logging in as $ADMIN_EMAIL at $API_BASE_URL ..." >&2

TOKEN_RESPONSE="$(curl -sf -X POST "$API_BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=$ADMIN_EMAIL" \
  --data-urlencode "password=$ADMIN_PASSWORD")"

ACCESS_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

KEY_RESPONSE="$(curl -sf -X POST "$API_BASE_URL/api/v1/developer/api-keys" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"ayuos-dev"}')"

API_KEY="$(printf '%s' "$KEY_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

echo "" >&2
echo "Created API key. Paste this into the repo root .env:" >&2
echo "" >&2
echo "OPEN_WEARABLES_API_KEY=$API_KEY"
