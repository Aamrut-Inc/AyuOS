# AyuOS

A personal health record that lives on your own Mac: wearables (Oura, Whoop,
Apple Health export), hospital records (any Epic health system, via MyChart),
and lab report PDFs, collected automatically into a local database.

## Getting started

```
git clone https://github.com/Aamrut-Inc/AyuOS.git
cd AyuOS
./scripts/start.command
```

That's the whole setup (macOS; no Docker). `start.command`:

- installs [Bun](https://bun.sh) if needed and Apple's Command Line Tools
  (for lab PDF reading and the Mac app),
- asks once for the team's Oura/Whoop app credentials (Enter skips),
- creates AyuOS's own database (embedded Postgres, `load/db-server.ts`),
- installs the background app and `~/Applications/AyuOS.app`, then opens it.

Then connect wearables and hospitals from the home page. Older installs that
used Docker are migrated automatically on the next `start.command`
(`scripts/migrate-off-docker.ts`).

**Credentials:** the Oura/Whoop client secrets are real secrets and aren't in
this repo — ask a teammate. Their registered redirect URI is
`http://localhost:8000/api/v1/oauth/{provider}/callback`, which AyuOS serves
itself. Epic client IDs are public and already in `.env.example`.

### Where things live

| What | Where |
|---|---|
| Database | embedded Postgres, `~/Library/Application Support/AyuOS/data/postgres` (127.0.0.1:5435; password in the Keychain) |
| Uploaded lab PDFs, downloaded record attachments | `~/Library/Application Support/AyuOS/data/` |
| Secrets (DB password, token key) | macOS Keychain, service "AyuOS" |
| Logs | `~/Library/Logs/AyuOS/app.log` |

## The AyuOS app (macOS)

`start.command` also builds `~/Applications/AyuOS.app` (`mac/build-app.sh`): a
native window onto the local app, plus a menu-bar item ("Ayu ●") showing sync
status with **Sync wearables now**. It starts in the menu bar at login. Quitting
it only closes the window — syncing is done by the background app below.

## Background sync (macOS)

`start.command` runs `scripts/install-agent.sh`, which copies the app to
`~/Library/Application Support/AyuOS/app` and registers it with launchd
(`com.ayuos.app`). macOS blocks background processes from reading
Desktop/Documents/Downloads, which is why it runs from a copy.

- Starts at login and restarts within 30s if it crashes; starts the database.
- Pulls Oura and Whoop every 30 minutes, each from its own resume point (with a
  3-day overlap for late uploads); a newly connected device gets its full
  history. After the laptop wakes it waits for the network, then catches up
  everything missed while it was closed.
- OAuth tokens are encrypted with a Keychain key and refreshed under a row
  lock (providers revoke the login if a refresh token is reused).
- Failed runs retry with backoff (1, 2, 4 … 30 min). Every run is logged in
  `ops.sync_runs` and shown under "Background sync" on the home page, along
  with a warning when a provider's login has expired and needs a reconnect.

**After pulling new code, re-run `./scripts/install-agent.sh`** — the agent
runs the installed copy, not your checkout. Logs:
`~/Library/Logs/AyuOS/app.log`. Remove with `./scripts/uninstall-agent.sh`.
To run from the checkout instead (`bun run dev:app`), uninstall the agent
first, since both use port 3000.

## Lab report PDFs

Drop lab report PDFs on the home page (or `/labs`). Everything happens on this
laptop: the text layer is read with macOS PDFKit, and scanned pages are OCR'd
with Apple's Vision framework (`extract/lab-pdf/pdf-text.swift`, compiled on
first use — needs the Xcode Command Line Tools: `xcode-select --install`).

`transform/lab-results.ts` reads each row as test name / value / flag / units /
reference range, matches the name against common analytes
(`transform/lab-analytes.ts`, US and Indian naming, with a suggested LOINC code),
and detects the collection date. **Nothing counts until it's reviewed**: the
review page shows every candidate next to the line it was read from, pre-ticks
confident ones, and lets you fix values before saving. Originals are kept in
`~/Library/Application Support/AyuOS/data/lab-pdfs/`; results land in
`labs.documents` / `labs.results` (only `status = 'confirmed'` rows are real data).

## Tests

`bun test` runs against a separate `ayuos_test` database (`test/setup.ts`),
never your real data.
