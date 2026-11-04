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

## On a phone

Vault installs as an app from the browser (Share, then Add to Home Screen on
an iPhone; Install app on Android). On a phone the menu is a bar along the
bottom. A case note saved with no signal waits on the phone, with a count on
Case Notes, and is sent when the signal is back; the server takes the phone's
id for it, so a resend is never a second note. The phone keeps only the app's
own files and the notes waiting to go out, never client records; notes wait
at most 7 days and leave when someone else signs in on the same browser.
`test/mobile-e2e.test.mjs` runs the whole flow in a phone-sized browser.

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
