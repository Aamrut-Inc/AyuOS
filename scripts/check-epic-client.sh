#!/usr/bin/env bash
# Checks whether a hospital's Epic server already knows an app's client ID —
# i.e. whether Epic's automatic distribution has reached that hospital —
# without logging in. Compares against a known-good client ID and a made-up
# one so the answer can be trusted.
#
# Usage:
#   scripts/check-epic-client.sh <fhir-base-url> <client-id> [known-good-client-id] [redirect-uri]
# Example (Stanford; needs a US network path / VPN):
#   scripts/check-epic-client.sh https://sfd.stanfordmed.org/FHIR/api/FHIR/R4 \
#     92928c9b-8eb2-4b11-b06a-c388150d45ce 3fdbd5b9-809b-4aa8-9c7f-992c485640d6

set -euo pipefail

BASE="${1:?FHIR base URL required}"
CLIENT="${2:?client ID required}"
KNOWN_GOOD="${3:-}"
REDIRECT="${4:-https://ishaan-netizen.github.io/ayuos-callback/}"
BASE="${BASE%/}"

config="$(curl -s -m 20 "$BASE/.well-known/smart-configuration" || true)"
if [[ -z "$config" ]]; then
  echo "Could not reach $BASE. If this is a US hospital and you're outside the US, turn on a US VPN and retry."
  exit 1
fi
AUTH_URL="$(printf '%s' "$config" | python3 -c 'import json,sys; print(json.load(sys.stdin)["authorization_endpoint"])')"

# Prints how the server responds to an authorize request for a client ID:
#   login  - redirected to the login page (client known, request accepted)
#   error  - redirected with an error (client known, but something is rejected)
#   unknown - no redirect (server doesn't recognize the client)
probe() {
  local location
  location="$(curl -s -m 20 -o /dev/null -w '%{redirect_url}' -G "$AUTH_URL" \
    --data-urlencode response_type=code \
    --data-urlencode "client_id=$1" \
    --data-urlencode "redirect_uri=$2" \
    --data-urlencode "scope=launch/patient openid fhirUser patient/Patient.rs" \
    --data-urlencode state=probe12345 \
    --data-urlencode "aud=$BASE" \
    --data-urlencode code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM \
    --data-urlencode code_challenge_method=S256)"
  if [[ -z "$location" ]]; then
    echo "unknown"
  elif [[ "$location" == *"error="* ]]; then
    echo "error ($(printf '%s' "$location" | grep -o 'error=[^&]*' | head -1))"
  else
    echo "login"
  fi
}

echo "Authorize endpoint: $AUTH_URL"
echo "Made-up client (should be 'unknown'):   $(probe 00000000-0000-0000-0000-000000000000 "$REDIRECT")"
if [[ -n "$KNOWN_GOOD" ]]; then
  echo "Known-good client (old app):            $(probe "$KNOWN_GOOD" http://127.0.0.1:8765)"
fi
result="$(probe "$CLIENT" "$REDIRECT")"
echo "Client $CLIENT: $result"
echo
case "$result" in
  login) echo "✓ This hospital knows the app. Switch AyuOS to it and run the import." ;;
  error*) echo "Recognized, but the request was rejected — check the redirect URI and APIs on the app." ;;
  *) echo "Not distributed to this hospital yet. Epic's automatic distribution can take a while; try again later." ;;
esac
