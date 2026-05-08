const REDACTED = "[REDACTED]";

const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const AUTH_BEARER_RE = /\b(authorization\s*:\s*Bearer\s+)[^\s]+/gi;

const COOKIE_HEADER_RE = /\b(cookie\s*:\s*)[^\r\n]+/gi;

const KEY_VALUE_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|token|session)\b(\s*[:=]\s*)(["']?)[^\s&;,`"']+/gi;

const SIGNED_QUERY_PARAM_RE =
  /([?&](?:X-Amz-Signature|X-Amz-Credential|Signature|sig)=)[^&#\s]+/gi;

const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const OPENAI_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactTerminalOutput(input: string): string {
  if (!input) return input;

  return input
    .replace(PRIVATE_KEY_BLOCK_RE, REDACTED)
    .replace(AUTH_BEARER_RE, `$1${REDACTED}`)
    .replace(COOKIE_HEADER_RE, `$1${REDACTED}`)
    .replace(KEY_VALUE_RE, (_match, key: string, separator: string, quote: string) => {
      return `${key}${separator}${quote}${REDACTED}`;
    })
    .replace(SIGNED_QUERY_PARAM_RE, `$1${REDACTED}`)
    .replace(GITHUB_PAT_RE, REDACTED)
    .replace(GITHUB_TOKEN_RE, REDACTED)
    .replace(OPENAI_TOKEN_RE, REDACTED)
    .replace(JWT_RE, REDACTED);
}
