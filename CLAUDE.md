# CLAUDE.md: Vault (repository TSS-Vault)

The staff workspace in the TSS product suite (priority 5 of 13). Three
buttons: Message Board, Case Notes, Directory. See README.md.

## Layout

- `server.js` API, auth, validation and static frontend. One Render service.
- `lib/store.js` picks the store: `store-postgres.js` (production) or `store-memory.js` (dev, tests). One contract; `test/store.test.mjs` runs it against both.
- `lib/records.js` the check-in rule, client summaries, local days and Cockpit's rollup. Pure functions over the store's rows.
- `lib/csv.js` CSV in and out.
- `lib/cockpit.js` launch-ticket verification (same as Library, Rollodex, Sherlock and Watson). `lib/auth.js` sessions and the service token.
- `public/` vanilla ES modules, no build step. `public/util.js` holds the DOM-free helpers tests import.

## Dev / test

```
npm ci
npm test
TEST_DATABASE_URL=postgres://... npm test
DEV_SIGNIN=on npm start                     # http://localhost:8796
```

## Conventions

- **Sign-in comes from Cockpit only.** No password, no local accounts. `lib/cockpit.js` verifies launch tickets (audience `vault`); keep its refusals strict.
- **Everything belongs to one organization.** Every store call names `org_id`; every route answers 404 for another organization's ids, and the store refuses a reference (client, parent post) from another organization.
- **Nothing is deleted.** A client is archived. A case note is never edited; one written in error is struck (by its author or a manager, with a reason) and stays on the record. A post is removed (hidden, kept).
- **The first screen has exactly three buttons**: Message Board, Case Notes, Directory. `test/ui.test.mjs` enforces it.
- **Permissions:** `use` reads, writes case notes and posts; `manage` changes client profiles, imports, exports, strikes any note, pins and removes any post, reads the activity log. Cockpit grants them.
- **Cockpit sees counts, never a name or a note.** `GET /api/cockpit/rollup` answers only what `lib/records.js` `rollup()` builds.
- **Circles reads the directory at intake, nothing more.** `GET /api/service/clients` (service token) answers open clients, at most ten, with only the fields an intake form fills; each lookup is logged with the app and the person asking, never what was typed. No service route writes.
- **Dates are local calendar days** (`YYYY-MM-DD`), never converted through UTC. Timestamps become days with `localDay()` in `TZ_DISPLAY`.
- **Both stores keep the same contract.** Change one, change the other, and extend `test/store.test.mjs`.
- **Schema changes are additive** (`CREATE ... IF NOT EXISTS`, new nullable columns). No destructive migrations on start.
- **Never forward an upstream error body.** Use `PublicError`.
- **CI needs no secrets.** Postgres runs as a CI service; Cockpit is a stand-in.
- **The look is the shared TSS app shell** (Library, Sherlock, Watson, Circles, Rollodex): cream page, light side column with the brand mark upper left, system font, Cockpit's theme tokens between `/* tss-theme:start */` and `/* tss-theme:end */`.

## Writing conventions

- Never use an em dash. Use a comma, a colon, parentheses, or a second sentence.
- Drop the word "that" wherever the sentence stays grammatical without it.
- The app is "Vault", never "TSS-Vault" in the interface. TSS appears only as the wordmark.
- Always "Transformation Solution Services, LLC", never "Transformative".
