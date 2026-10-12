# AyuOS — tester setup guide

This gets AyuOS running on your own Mac so you can connect your own Oura or
Whoop, your hospital's records, and lab report PDFs, and watch them collect
automatically. It's an early tester build: one setup command, then everything
happens in the AyuOS app.

## What you need first

- A Mac (Apple Silicon or Intel).
- The Oura and/or Whoop **client ID and secret** from the AyuOS team. Ask
  directly, not over a public channel — these are real secrets. Hospital
  records need no secrets.

## Setup

1. Open Terminal and run:
   ```
   git clone https://github.com/Aamrut-Inc/AyuOS.git
   cd AyuOS
   ./scripts/start.command
   ```
   It installs what's missing (Bun, and Apple's Command Line Tools — click
   **Install** if a system dialog appears), then asks for the Oura and Whoop
   credentials (press Enter to skip one). First run takes a few minutes.

2. The **AyuOS** app opens (it's also in Launchpad and Spotlight, and shows
   "Ayu ●" in your menu bar). Follow the **Getting started** checklist:
   - **Oura / Whoop:** click **Connect** and log into *your own* account. Your
     full history starts downloading in the background.
   - **Hospital:** click **+ Add a hospital** (details below).
   - **Lab reports:** drag PDFs onto the home page; you'll check the values it
     read before they're saved.

3. Click **View my health record** to see everything in one place.

From now on you don't need to run anything: AyuOS starts by itself when you log
in, syncs wearables every 30 minutes, and when you open the laptop after it's
been closed it catches up on what it missed. The **Background sync** box on the
home page (and the menu-bar item) shows when it last synced and any problems,
for example a wearable whose login expired and needs **Reconnect**.

To update after the team ships changes: `cd AyuOS && git pull && ./scripts/start.command`.

## Connecting your hospital (Epic)

AyuOS can download your full record from any US health system that uses Epic
(most large ones do), through the same login you use for its MyChart patient
portal.

1. On the home page, click **+ Add a hospital**, search for your health
   system, and click **Connect**.
2. AyuOS first checks that it's enabled at that hospital (Epic rolls it out to
   each one automatically, but not all at once). If it says "Not available at
   … yet", try again in a day or two.
3. Log in with your MyChart username and password and approve access. You'll
   briefly see a "Returning you to AyuOS…" page, then land back in AyuOS. The
   download takes a minute or two; then open **View my health record**.

Hospital records are a one-time download (the hospital's login only lasts an
hour, so AyuOS can't fetch them in the background): press **Sync** next to the
hospital after a new visit. You can connect more than one hospital.

## If something goes wrong

- **The app says "AyuOS is starting…" for more than a minute** — check
  `~/Library/Logs/AyuOS/app.log` and send it to the team.
- **Wearable connect says "Couldn't connect"** — the page explains why; send
  the team a screenshot.
- **"Disk space is running low"** — free some space; syncing stops if the
  disk fills up.
- **Hospital login shows "An error has occurred" or "The request is invalid"**
  — send the team a screenshot, plus the output of
  `./scripts/check-epic-client.sh <hospital address> 92928c9b-8eb2-4b11-b06a-c388150d45ce`
  (the address is on https://open.epic.com/MyApps/Endpoints).
- **Lab PDF upload says it can't read the PDF** — run `xcode-select --install`
  once, then try again.
- Anything else — message the team with what you see on screen.

## What this actually is, briefly

AyuOS pulls your health data (wearables now, hospital/EHR data too if you
connect it) into a database that runs entirely on your own laptop — nothing
gets sent to us or anyone else. It's the foundation for an AI layer that
reasons over your data, which is being built next.
