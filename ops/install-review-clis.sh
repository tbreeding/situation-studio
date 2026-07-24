#!/usr/bin/env bash
set -euo pipefail

required_user="${SITUATION_STUDIO_REVIEW_USER:-situation-studio-review}"
codex_version="0.145.0"
claude_version="2.1.218"
codex_integrity="sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ=="
claude_integrity="sha512-BHV951ruIa6QXaZFDF1wRhwxAOkAiafB2AOWG6wGRUJ4apaJ9mlzp1BFLAhGfG0SknwAyqBenqeT6nit6at4uQ=="

if [[ "$(id -un)" != "${required_user}" ]]; then
  echo "Review CLIs must be installed as ${required_user}." >&2
  exit 1
fi
if [[ -z "${HOME:-}" || "${HOME}" != /* || ! -d "${HOME}" ]]; then
  echo "Review service user requires an explicit home directory." >&2
  exit 1
fi
if [[ "$(stat -c '%U' "${HOME}")" != "${required_user}" ]]; then
  echo "Review service user must own its home directory." >&2
  exit 1
fi

test "$(
  npm view "@openai/codex@${codex_version}" dist.integrity
)" = "${codex_integrity}"
test "$(
  npm view "@anthropic-ai/claude-code@${claude_version}" dist.integrity
)" = "${claude_integrity}"

npm install \
  --global \
  --prefix "${HOME}/.local" \
  --no-audit \
  --no-fund \
  "@openai/codex@${codex_version}" \
  "@anthropic-ai/claude-code@${claude_version}"

export PATH="${HOME}/.local/bin:${PATH}"
test "$(codex --version)" = "codex-cli ${codex_version}"
test "$(claude --version)" = "${claude_version} (Claude Code)"

echo "Pinned review CLIs installed. Authenticate Codex and Claude as ${required_user}."
