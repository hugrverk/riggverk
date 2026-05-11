#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dw="$repo_root/resources/default-workspace"
failed=0

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failed=1; }

# --- JSON validation ---
if python3 -m json.tool "$dw/templates/opencode.json" >/dev/null 2>&1; then
  pass "default-workspace/templates/opencode.json strict JSON"
else
  fail "default-workspace/templates/opencode.json strict JSON"
fi

if python3 -m json.tool "$dw/templates/tui.json" >/dev/null 2>&1; then
  pass "default-workspace/templates/tui.json strict JSON"
else
  fail "default-workspace/templates/tui.json strict JSON"
fi

# --- tui.json expected keys ---
tui_keys=('"theme"' '"leader_timeout"' '"scroll_acceleration"' '"diff_style"' '"mouse"')
for key in "${tui_keys[@]}"; do
  if grep -qF "$key" "$dw/templates/tui.json"; then
    pass "default-workspace/templates/tui.json has $key"
  else
    fail "default-workspace/templates/tui.json missing $key"
  fi
done

# --- opencode.json model keys ---
for key in '"model"' '"small_model"'; do
  if grep -qF "$key" "$dw/templates/opencode.json"; then
    pass "default-workspace/templates/opencode.json has $key"
  else
    fail "default-workspace/templates/opencode.json missing $key"
  fi
done

# --- No model frontmatter in agents ---
no_model_agents=0
for f in "$dw"/agents/*.md; do
  if grep -q '^model:' "$f"; then
    fail "default-workspace/$(basename "$f") has model frontmatter (should be model-agnostic)"
    no_model_agents=1
  fi
done
if [ "$no_model_agents" -eq 0 ]; then
  pass "no default-workspace agent files contain model frontmatter"
fi

# --- Agent files exist ---
expected_agents=(architect.md scout.md inspector.md sentinel.md scribe.md verifier.md)
for agent in "${expected_agents[@]}"; do
  if [ -f "$dw/agents/$agent" ]; then
    pass "default-workspace/agents/$agent exists"
  else
    fail "default-workspace/agents/$agent missing"
  fi
done

# --- architect mode: primary ---
if grep -q '^mode: primary' "$dw/agents/architect.md"; then
  pass "default-workspace/architect.md mode: primary"
else
  fail "default-workspace/architect.md missing mode: primary"
fi

# --- subagents mode: subagent ---
for subagent in scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if grep -q '^mode: subagent' "$dw/agents/$subagent"; then
    pass "default-workspace/$subagent mode: subagent"
  else
    fail "default-workspace/$subagent missing mode: subagent"
  fi
done

# --- Global opencode.json denies dangerous bash patterns ---
dangerous_bash_patterns=(
  'git push --force*'
  'git push -f*'
  'git reset --hard*'
  'git clean -fd*'
  'git clean -fdx*'
  'rm -rf*'
  'rm -fr*'
  'sudo*'
)
for pat in "${dangerous_bash_patterns[@]}"; do
  if grep -qF "\"$pat\": \"deny\"" "$dw/templates/opencode.json"; then
    pass "default-workspace/opencode.json denies $pat"
  else
    fail "default-workspace/opencode.json missing deny for $pat"
  fi
done

# --- Pipe-to-shell patterns ---
pipe_patterns=('*|bash' '*| bash' '* | bash' '*|sh' '*| sh' '* | sh')
for pat in "${pipe_patterns[@]}"; do
  if grep -qF "\"$pat\": \"deny\"" "$dw/templates/opencode.json"; then
    pass "default-workspace/opencode.json denies $pat"
  else
    fail "default-workspace/opencode.json missing deny for $pat"
  fi
done

# --- Credential-bearing read deny patterns ---
cred_read_patterns=(
  '.env*' '**/.env*' '**/*.key' '**/*.pem' '**/*token*.json' '**/*secret*.json' '**/wp-config.php'
)
for pat in "${cred_read_patterns[@]}"; do
  if grep -qF "\"$pat\": \"deny\"" "$dw/templates/opencode.json"; then
    pass "default-workspace/opencode.json read deny covers $pat"
  else
    fail "default-workspace/opencode.json read deny missing $pat"
  fi
done

# --- Read-only agents do not allow broad edit ---
ro_agents=(scout.md inspector.md sentinel.md verifier.md)
for agent in "${ro_agents[@]}"; do
  if grep -q 'edit: deny' "$dw/agents/$agent"; then
    pass "default-workspace/$agent edit is denied (read-only)"
  else
    fail "default-workspace/$agent missing edit: deny"
  fi
done

# --- No agent allows dangerous operations ---
for agent in "${expected_agents[@]}"; do
  file="$dw/agents/$agent"
  for deny in 'rm -rf' 'sudo' 'git reset --hard' 'git clean -fdx'; do
    if grep -q "\"$deny" "$file"; then
      pass "default-workspace/$agent denies $deny"
    else
      fail "default-workspace/$agent missing explicit deny for $deny"
    fi
  done
  # Agents use YAML frontmatter (unquoted deny values)
  for pat in "${pipe_patterns[@]}"; do
    if grep -qF "\"$pat\": deny" "$file"; then
      pass "default-workspace/$agent denies $pat"
    else
      fail "default-workspace/$agent missing explicit deny for $pat"
    fi
  done
done

# --- opencode.json has share disabled ---
if grep -q '"share": "disabled"' "$dw/templates/opencode.json"; then
  pass "default-workspace/opencode.json share disabled"
else
  fail "default-workspace/opencode.json share not disabled"
fi

if [ "$failed" -eq 0 ]; then
  printf '\nPASS default opencode policy valid\n'
else
  printf 'FAIL default opencode policy invalid\n'
fi
exit "$failed"
