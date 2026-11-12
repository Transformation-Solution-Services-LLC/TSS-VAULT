# Vault in Cockpit

Cockpit (the TSS-Dashboard repository, assembled with every app in
TSS-FullStack) is the one sign-in for TSS apps. With `COCKPIT_URL` set,
Vault trusts it the same way Library, Sherlock and Watson do.
Code: `lib/cockpit.js` and `lib/auth.js`; tests: `test/server.test.mjs`.

## Signing in

1. A person signs in to Cockpit (the organization's Google, Microsoft or
   Okta sign-in).
2. They open Vault from Cockpit. Cockpit hands Vault a launch ticket
   in the address (`#tss_launch=...`): signed by Cockpit, good for two
   minutes, once, addressed to `vault`, naming the person, their
   organization and their Vault permissions.
3. The page sends the ticket to `POST /api/auth/cockpit`. Vault checks the
   signature against `<COCKPIT_URL>/.well-known/jwks.json`, the issuer, the
   audience, the time and that the ticket was never used, then starts a
   session for the tab.

Rules:

- Cockpit's `use` permission lets a person in: read the directory and case
  notes, write a case note, post on the message board. `manage` adds and
  changes client profiles, imports and exports, strikes any note, pins and
  removes any post, and reads the activity log. Without either the person is
  refused.
- Every record carries the organization from the ticket. Another
  organization's ids answer 404.
- Vault may be framed by Cockpit (and only Cockpit); it also opens in its
  own tab.

## What Cockpit reads

`GET /api/cockpit/rollup?from=YYYY-MM-DD&to=YYYY-MM-DD`, for Cockpit's server
only: `Authorization: Bearer <VAULT_SERVICE_TOKEN>` and `X-TSS-Org` naming
the organization.

It answers, for the period: case notes written, clients seen (with a note),
new clients (by intake date), message-board posts; and now: active clients
and active clients due for a check-in. By month: case notes, new clients,
posts. Never a name, a note, a post or anything about one person.

The service token opens no client record, and nothing it opens writes.

## Settings

| Variable | What |
|---|---|
| `COCKPIT_URL` | Cockpit's public address, e.g. `https://tss-cockpit.onrender.com`. Turns on Cockpit sign-in |
| `VAULT_SERVICE_TOKEN` | Shared with Cockpit (the counts). Blank turns them off |
| `TRUST_PROXY` | `1` on Render |

TSS-FullStack's `render.yaml` sets all of these for the hosted service.
