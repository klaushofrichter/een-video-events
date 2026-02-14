#!/usr/bin/env bash
# Sync .env secrets with GitHub repository secrets
# Usage: ./sync-secrets.sh [repo]
# If no repo is specified, uses the current git remote origin.

set -euo pipefail

REPO="${1:-}"
ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found in current directory"
  exit 1
fi

if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI is not installed. Install from https://cli.github.com/"
  exit 1
fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  if [[ -z "$REPO" ]]; then
    echo "Error: Could not detect repository. Pass repo as argument: ./sync-secrets.sh owner/repo"
    exit 1
  fi
fi

echo "Syncing secrets from $ENV_FILE to $REPO"
echo "---"

count=0
while IFS='=' read -r key value; do
  # Skip empty lines and comments
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  # Strip surrounding quotes from value
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  echo "Setting: $key"
  gh secret set "$key" --repo "$REPO" --body "$value"
  ((count++))
done < "$ENV_FILE"

echo "---"
echo "Done. $count secrets synced to $REPO."
