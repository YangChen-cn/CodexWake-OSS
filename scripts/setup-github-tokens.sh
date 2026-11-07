#!/usr/bin/env bash
# Paste two independently scoped fine-grained tokens into the hidden prompts.
# Never enable shell tracing or put token values in arguments or logs.
set +x
set -euo pipefail

repo="${CODEXWAKE_GITHUB_REPOSITORY:-}"
if [[ ! -t 0 || ! "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Run this command interactively for the configured private repository." >&2
  exit 1
fi
if [[ "$(gh repo view "$repo" --json isPrivate --jq .isPrivate)" != "true" ]]; then
  echo "The selected GitHub repository is not confirmed private." >&2
  exit 1
fi
echo 'Create two fine-grained tokens restricted to this repository:' >&2
echo '  1. Actions: Read and write (for the Cloudflare Worker)' >&2
echo '  2. Secrets: Read and write (for the GitHub Runner)' >&2
echo 'Paste tokens only here, never into chat or a shell command.' >&2
read -r -s -p 'Actions token: ' actions_token
echo >&2
read -r -s -p 'Secrets token: ' secrets_token
echo >&2
trap 'unset actions_token secrets_token' EXIT

if [[ ! "$actions_token" =~ ^github_pat_[a-zA-Z0-9_]{20,}$ || ! "$secrets_token" =~ ^github_pat_[a-zA-Z0-9_]{20,}$ || "$actions_token" == "$secrets_token" ]]; then
  echo 'Two distinct fine-grained tokens are required; nothing was written.' >&2
  exit 1
fi

# Both utilities read the value from stdin. The tokens are ordinary shell
# variables and are not exported or passed on the command line.
printf '%s' "$actions_token" | npx --no-install wrangler secret put GITHUB_ACTIONS_WRITE_TOKEN
unset actions_token
printf '%s' "$secrets_token" | gh secret set CODEXWAKE_SECRETS_WRITE_TOKEN --repo "$repo"
unset secrets_token
echo 'Token values were installed. Verify repository selection and permissions in GitHub settings.' >&2
