# Vault

The staff workspace in the TSS product suite (priority 5 of 13, "Internal
work communication and client records"). Its first screen has exactly three
buttons:

- **Message Board**: internal work messages, with replies and pins. A post
  can name a client, and then it shows on that client's page too.
- **Case Notes**: dated progress, contact, event and incident notes, each
  signed by its author and about one client. A note is never edited or
  deleted; one written in error is struck with a reason and stays on the
  record.
- **Directory**: client profiles (name and the name they go by, pronouns,
  date of birth, contact details, program, status, assigned worker, intake
  date, emergency contact, tags, summary), each with the route to that
  client's notes and the posts about them. Active clients with no note in 30
  days are flagged for a check-in.

Vault holds general staff and client records. Circles owns the specialized
restorative justice workflow.

Staff sign in through Cockpit only (`docs/cockpit.md`). Cockpit's `use`
permission lets a person read, write case notes and post; `manage` adds and
changes client profiles, imports and exports the directory, strikes any note,
pins and removes posts and reads the activity log. Every record belongs to one
Cockpit organization. Cockpit's dashboard reads counts only, never a name or
a note.

## Run it

```
npm ci
DEV_SIGNIN=on npm start            # http://localhost:8796, developer sign-in, in memory
npm test
TEST_DATABASE_URL=postgres://... npm test   # also runs the store contract on Postgres 16
```

Production needs `DATABASE_URL` (Postgres), `COCKPIT_URL`, `SESSION_SECRET`
and `VAULT_SERVICE_TOKEN`. In the TSS suite it is deployed from
TSS-FullStack's `render.yaml` as `tss-vault`.

Copyright Transformation Solution Services, LLC.

## Error tracking and organization export

| Variable | What it does |
|---|---|
| `ERROR_TRACKING_DSN` | A Sentry project's DSN (or GlitchTip or Bugsink). Server errors and crashes go there, scrubbed: ids, never people. Blank keeps tracking off. |
| `EXPORT_TOKEN` | Held by Cockpit only. Lets Cockpit's "Export everything" read `GET /api/export/org` for one organization (X-TSS-Org). Blank turns export off. |

The export is `tss.org-export/v1`: `{ schema, app, org_id, exported_at, tables: { name: [rows] }, files: [{ path, href, media_type }] }`. Every request is in the activity log as `export.org`.
