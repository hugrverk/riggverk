---
name: supabase-rls-review
description: Review Supabase RLS, auth boundaries, storage policies, service-role usage, and data access risk before or after schema/API changes.
category: security
risk: high
targets: codex, opencode, claude
related: security-review, database-migrations, nextjs-product-slice
---

# Supabase RLS Review

## Purpose

- Review Supabase access control before unsafe data exposure ships.
- Focus on RLS, policies, auth boundaries, storage, edge functions, and service-role usage.
- Keep findings practical and implementation-ready.

## Process

1. Inspect schema, migrations, policies, API routes, server actions, edge functions, and storage buckets relevant to the request.
2. Identify actors: anonymous, authenticated user, owner, admin, service role, webhook, cron, or public visitor.
3. Map intended access per table, view, RPC, bucket, and API surface.
4. Check that RLS is enabled where user-facing access exists.
5. Check policies for owner scoping, tenant scoping, public read exposure, write restrictions, and update/delete risk.
6. Check that service-role usage is server-only and not exposed to client code.
7. Recommend the smallest safe policy or code change.

## Output

- Data surfaces reviewed.
- Actor access matrix.
- RLS/policy findings.
- Service-role and client exposure findings.
- Recommended fixes.
- Verification SQL or manual checks.
- Remaining risk.

## Guardrails

- Do not print secrets or env values.
- Do not assume RLS is safe because auth exists.
- Do not expose service-role logic to clients.
- Do not broaden into general Supabase architecture unless access control requires it.
