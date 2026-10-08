# AyuOS — tester setup guide

This gets AyuOS running on your own laptop so you can connect your own Oura
and/or Whoop account and see your own data flow in. This is a developer-style
setup for now (Docker + a terminal command), not a polished installer yet —
you're an early tester, not a end user of the finished thing.

## What you need first

- A Mac.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — install
  it, then open it once so it's running.
- [Bun](https://bun.sh) — install with:
  ```
  curl -fsSL https://bun.sh/install | bash
  ```
- Real credential values from the team (ask directly, not over a public
  channel — these are real secrets): `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`,
  `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`. (FHIR/EHR is optional for
  wearables testing — skip it unless you specifically want to try that part.)

## Setup

1. Open Terminal and clone the repo:
   ```
   git clone https://github.com/Aamrut-Inc/AyuOS.git
   cd AyuOS
   ```

2. Create your local config files from the templates:
   ```
   cp .env.example .env
   cp services/wearables/backend/config/.env.example services/wearables/backend/config/.env
   ```

3. Open `services/wearables/backend/config/.env` in any text editor and
   replace the placeholder values for `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`,
   `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` with the real ones the team gave
   you. Leave everything else as-is.

4. Run:
   ```
   ./scripts/start.command
   ```
   This brings up the database and backend, sets everything up, installs
   AyuOS to run in the background (it starts by itself when you log in and
   keeps syncing), and opens your browser to `http://127.0.0.1:3000`. First
   run takes a few minutes.

5. On the page that opens, click **Connect** next to Oura or Whoop, and log
   into *your own* account when it redirects you — same as connecting Oura
   or Whoop to any app. Once you approve access, it automatically starts
   pulling your real history in the background (give it a few minutes for a
   full sync, especially if you have a lot of history).

6. Click **View my health record** for everything in one place, or go to
   `http://127.0.0.1:3000/data/wearables` for the raw readings. You can also
   drag lab report PDFs onto the home page; you'll be asked to check the
   values it read before they're saved.

From now on you don't need to run anything: close the laptop whenever you
like, and when you open it again AyuOS catches up on what it missed. The
**Background sync** box on the home page shows when it last synced and any
problems (for example a wearable whose login expired and needs **Reconnect**).
After pulling new code, run `./scripts/install-agent.sh` to update the
background copy.

## If something goes wrong

- **Nothing happens / times out waiting for Docker** — make sure Docker
  Desktop is actually open (not just installed), then run
  `./scripts/start.command` again.
- **The page doesn't load after a restart** — give it a minute (it waits for
  Docker to start). If it still doesn't, check
  `~/Library/Logs/AyuOS/app.log` and send it to the team.
- **Lab PDF upload says it can't compile the PDF reader** — run
  `xcode-select --install` once, then try again.
- **Connect fails immediately with an error page** — double-check the
  credential values in `services/wearables/backend/config/.env` were pasted
  in cleanly, no extra quotes or spaces.
- Anything else — message the team with what you see on screen.

## What this actually is, briefly

AyuOS pulls your health data (wearables now, hospital/EHR data too if you
connect it) into a database that runs entirely on your own laptop — nothing
gets sent to us or anyone else. It's the foundation for an AI layer that
reasons over your data, which is being built next.
