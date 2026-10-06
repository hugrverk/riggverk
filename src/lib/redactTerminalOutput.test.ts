import { describe, expect, it } from "vitest";
import { redactTerminalOutput } from "./redactTerminalOutput";

// Fake values only; they are shaped like real credentials but are not.
const FAKE_BASIC = "dXNlcjpwYXNzd29yZA==";
const FAKE_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzzzzzzz";
const FAKE_NPM = "npm_abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_OPENAI = "sk-abcdefghijklmnopqrstuvwxyz012345";
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";

describe("redactTerminalOutput", () => {
  const leaks: { name: string; input: string; secret: string }[] = [
    { name: "Bearer authorization", input: `Authorization: Bearer ${FAKE_GH}`, secret: FAKE_GH },
    { name: "Basic authorization", input: `Authorization: Basic ${FAKE_BASIC}`, secret: FAKE_BASIC },
    { name: "lowercase basic authorization", input: `authorization: basic ${FAKE_BASIC}`, secret: FAKE_BASIC },
    { name: "proxy authorization", input: `Proxy-Authorization: Basic ${FAKE_BASIC}`, secret: FAKE_BASIC },
    { name: "authorization with a custom scheme", input: `Authorization: AWS4-HMAC-SHA256 Credential=${FAKE_SECRET}`, secret: FAKE_SECRET },
    { name: "cookie header", input: "Cookie: session=abc123def456; theme=dark", secret: "abc123def456" },
    { name: "set-cookie header", input: "Set-Cookie: sid=abc123def456; HttpOnly", secret: "abc123def456" },
    { name: "AWS secret access key env assignment", input: `AWS_SECRET_ACCESS_KEY=${FAKE_SECRET}`, secret: FAKE_SECRET },
    { name: "npm_token with colon", input: `npm_token: ${FAKE_NPM}`, secret: FAKE_NPM },
    { name: "NPM_TOKEN env assignment", input: `NPM_TOKEN=${FAKE_NPM}`, secret: FAKE_NPM },
    { name: "plain password", input: "password=hunter2hunter2", secret: "hunter2hunter2" },
    { name: "api_key", input: "api_key = abcd1234efgh5678", secret: "abcd1234efgh5678" },
    { name: "hyphenated header-style name", input: "x-api-key: abcd1234efgh5678", secret: "abcd1234efgh5678" },
    { name: "camelCase accessToken", input: "accessToken: abcd1234efgh5678", secret: "abcd1234efgh5678" },
    { name: "client secret", input: "CLIENT_SECRET=abcd1234efgh5678", secret: "abcd1234efgh5678" },
    { name: "quoted JSON value", input: `{"npm_token": "${FAKE_NPM}"}`, secret: FAKE_NPM },
    { name: "GitHub token on its own", input: `leaked ${FAKE_GH} in a log`, secret: FAKE_GH },
    { name: "fine-grained GitHub token", input: "github_pat_abcdefghijklmnopqrstuvwxyz0123456789", secret: "abcdefghijklmnopqrstuvwxyz0123456789" },
    { name: "OpenAI-style key on its own", input: `key is ${FAKE_OPENAI}`, secret: FAKE_OPENAI },
    { name: "JWT on its own", input: `jwt ${FAKE_JWT}`, secret: FAKE_JWT },
    { name: "signed URL query", input: "https://bucket.example/obj?X-Amz-Signature=abcdef0123456789&x=1", secret: "abcdef0123456789" },
    {
      name: "private key block",
      input: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----",
      secret: "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
    },
  ];

  for (const { name, input, secret } of leaks) {
    it(`redacts ${name}`, () => {
      const output = redactTerminalOutput(input);
      expect(output).not.toContain(secret);
      expect(output).toContain("[REDACTED]");
    });
  }

  it("keeps the header name and known scheme visible while redacting the credential", () => {
    expect(redactTerminalOutput(`Authorization: Bearer ${FAKE_GH}`)).toBe("Authorization: Bearer [REDACTED]");
    expect(redactTerminalOutput(`Authorization: Basic ${FAKE_BASIC}`)).toBe("Authorization: Basic [REDACTED]");
    expect(redactTerminalOutput(`AWS_SECRET_ACCESS_KEY=${FAKE_SECRET}`)).toBe("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(redactTerminalOutput(`npm_token: ${FAKE_NPM}`)).toBe("npm_token: [REDACTED]");
  });

  it("only redacts the sensitive line of multi-line output", () => {
    const output = redactTerminalOutput(`building...\nAuthorization: Basic ${FAKE_BASIC}\ndone in 2s`);
    expect(output).toBe("building...\nAuthorization: Basic [REDACTED]\ndone in 2s");
  });

  const harmless = [
    "release-check completed: 12 files checked",
    "tokens: 12",
    "max_tokens: 4096",
    "secretary: Alex",
    "status=ok exit=0",
    "authorized users: 3",
    "",
  ];

  for (const input of harmless) {
    it(`leaves harmless text unchanged: ${JSON.stringify(input)}`, () => {
      expect(redactTerminalOutput(input)).toBe(input);
    });
  }
});
