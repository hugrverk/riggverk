### Claude Security Review

- If using a subagent, keep it read-only unless the user explicitly asked for fixes.
- Do not inspect or print secrets, credential stores, raw environment values, cookies, private keys, or unrelated personal files.
