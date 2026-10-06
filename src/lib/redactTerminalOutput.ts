const REDACTED = "[REDACTED]";

const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// Any Authorization value (Bearer, Basic, Digest, custom schemes): keep a known scheme word, redact the credential.
const AUTH_HEADER_RE =
  /\b(authorization\s*:\s*(?:(?:bearer|basic|digest|token|negotiate|ntlm)\s+)?)[^\r\n]+/gi;

const COOKIE_HEADER_RE = /\b(cookie\s*:\s*)[^\r\n]+/gi;

// A name counts as sensitive when one of its `_`, `-` or `.` separated segments is a secret-ish word,
// so AWS_SECRET_ACCESS_KEY, npm_token and x-api-key match while "tokens" or "max_tokens" do not.
const SENSITIVE_WORD =
  "(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token|session|credentials?|private[_-]?key)";
const SENSITIVE_NAME_RE = new RegExp(`(?:^|[_.-])${SENSITIVE_WORD}(?=[_.-]|$)`, "i");
// Names are scanned as whole runs and the value is looked up only behind a sensitive one. One regex with a
// backtracking prefix restarted inside every long hyphen or dot token, which made it quadratic.
const NAME_RUN_RE = /[A-Za-z0-9_.-]+/g;
const ASSIGNED_VALUE_RE = /(["']?\s*[:=]\s*)(["']?)[^\s&;,`"']+/y;

/** `name=value` / `name: "value"` where the name has a secret-ish segment: the value becomes [REDACTED]. */
function redactAssignments(input: string): string {
  let output = "";
  let copiedUpTo = 0;
  NAME_RUN_RE.lastIndex = 0;
  for (let run = NAME_RUN_RE.exec(input); run; run = NAME_RUN_RE.exec(input)) {
    if (!SENSITIVE_NAME_RE.test(run[0])) continue;
    const nameEnd = run.index + run[0].length;
    ASSIGNED_VALUE_RE.lastIndex = nameEnd;
    const assigned = ASSIGNED_VALUE_RE.exec(input);
    if (!assigned) continue;
    output += `${input.slice(copiedUpTo, nameEnd)}${assigned[1]}${assigned[2]}${REDACTED}`;
    copiedUpTo = nameEnd + assigned[0].length;
    NAME_RUN_RE.lastIndex = copiedUpTo;
  }
  return output + input.slice(copiedUpTo);
}

const SIGNED_QUERY_PARAM_RE =
  /([?&](?:X-Amz-Signature|X-Amz-Credential|Signature|sig)=)[^&#\s]+/gi;

const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const OPENAI_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactTerminalOutput(input: string): string {
  if (!input) return input;

  return redactAssignments(
    input
      .replace(PRIVATE_KEY_BLOCK_RE, REDACTED)
      .replace(AUTH_HEADER_RE, `$1${REDACTED}`)
      .replace(COOKIE_HEADER_RE, `$1${REDACTED}`),
  )
    .replace(SIGNED_QUERY_PARAM_RE, `$1${REDACTED}`)
    .replace(GITHUB_PAT_RE, REDACTED)
    .replace(GITHUB_TOKEN_RE, REDACTED)
    .replace(OPENAI_TOKEN_RE, REDACTED)
    .replace(JWT_RE, REDACTED);
}
