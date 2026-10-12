import { layout } from "./pages";

// In-app, step-by-step guide. Plain language: the reader may not be
// technical. Sections are linkable (e.g. /help#apple-health).

const SECTIONS = `
  <div class="card help-section" id="start">
    <h2 style="margin-top: 0;">Getting started</h2>
    <p>AyuOS gathers your health data from different places into one private record on this Mac. Setting it up takes about 10 minutes:</p>
    <ol>
      <li><a href="#wearables">Connect your Oura or Whoop</a></li>
      <li><a href="#hospital">Add your hospital</a> (any US health system that uses MyChart)</li>
      <li><a href="#labs">Add lab report PDFs</a> (optional)</li>
      <li><a href="#apple-health">Import Apple Health</a> (optional)</li>
      <li><a href="#record">Open your health record</a></li>
    </ol>
    <p class="meta">After that you don't need to do anything — AyuOS keeps your data up to date on its own.</p>
  </div>

  <div class="card help-section" id="wearables">
    <h2 style="margin-top: 0;">1. Connect your Oura or Whoop</h2>
    <ol>
      <li>On the <a href="/">Home</a> page, find the <strong>Oura</strong> or <strong>Whoop</strong> card and click <strong>Connect</strong>.</li>
      <li>Your web browser opens the Oura or Whoop sign-in page. Log in with the same account you use in their phone app.</li>
      <li>Click <strong>Allow</strong> (or <strong>Accept</strong>) to let AyuOS read your data.</li>
      <li>You're brought back to AyuOS and the card shows <span class="pill ok">Connected</span>.</li>
    </ol>
    <p>Your full history downloads in the background — a few minutes, longer if you've worn the device for years. After that, new data arrives every 30 minutes.</p>
    <p class="meta">If it says <em>"isn't set up on this computer yet"</em>, the Oura/Whoop app credentials weren't entered during setup — ask the AyuOS team for them and run <code>scripts/start.command</code> again.</p>
  </div>

  <div class="card help-section" id="hospital">
    <h2 style="margin-top: 0;">2. Add your hospital</h2>
    <ol>
      <li>Click <a href="/hospitals"><strong>Hospitals</strong></a> at the top (or <strong>+ Add a hospital</strong> on the Home page).</li>
      <li>Type the name of your health system — for example <em>Stanford</em>, <em>Kaiser</em> or <em>Mayo</em> — and click <strong>Connect</strong> next to it.</li>
      <li>Your hospital's <strong>MyChart</strong> page opens. Log in with your MyChart username and password (the same ones as the MyChart app or website).</li>
      <li>Review what AyuOS is asking to read and click <strong>Allow</strong>.</li>
      <li>You'll briefly see <em>"Returning you to AyuOS…"</em>, then land back in AyuOS. The download takes a minute or two.</li>
    </ol>
    <p><strong>After a doctor's visit</strong>, click <strong>Sync</strong> next to your hospital to pick up new results. (Hospitals only allow a one-hour login, so AyuOS can't fetch these in the background.) You can add more than one hospital.</p>
    <p class="meta">If it says <em>"Not available at … yet"</em>, the hospital hasn't enabled AyuOS yet — Epic rolls it out gradually; try again in a day or two.</p>
  </div>

  <div class="card help-section" id="labs">
    <h2 style="margin-top: 0;">3. Add lab report PDFs (optional)</h2>
    <ol>
      <li>Drag one or more lab report PDFs onto the <strong>Lab reports</strong> card on the Home page (or click it to choose files).</li>
      <li>AyuOS reads them on this Mac — even scanned reports — and opens a review page.</li>
      <li>Check each value against the PDF (there's a link to open the original). Fix anything that's wrong, untick rows you don't want, and check the collection date.</li>
      <li>Click <strong>Save reviewed results</strong>. Only values you've confirmed are added to your record.</li>
    </ol>
  </div>

  <div class="card help-section" id="apple-health">
    <h2 style="margin-top: 0;">4. Import Apple Health (optional)</h2>
    <ol>
      <li>On your iPhone, open the <strong>Health</strong> app.</li>
      <li>Tap your <strong>profile picture</strong> in the top-right corner.</li>
      <li>Scroll down and tap <strong>Export All Health Data</strong>, then <strong>Export</strong>. This can take a few minutes.</li>
      <li>Send the file to your Mac — <strong>AirDrop</strong> is easiest, or save it to iCloud Drive.</li>
      <li>Drag the <code>export.zip</code> file onto the <strong>Apple Health</strong> card on the Home page.</li>
    </ol>
    <p class="meta">Apple Health can't be synced automatically yet; repeat this whenever you want to bring it up to date.</p>
  </div>

  <div class="card help-section" id="record">
    <h2 style="margin-top: 0;">5. Your health record</h2>
    <p><a href="/record"><strong>My record</strong></a> shows everything together: health problems, medications, allergies, lab results (from your hospital and your PDFs), recent visits, wearable trends, and documents such as visit notes.</p>
  </div>

  <div class="card help-section" id="background">
    <h2 style="margin-top: 0;">What happens in the background</h2>
    <ul>
      <li>AyuOS starts by itself when you log in to your Mac. You don't need to keep this window open.</li>
      <li>Wearables sync every 30 minutes. If your Mac was asleep or off, AyuOS catches up on everything it missed as soon as you open it again.</li>
      <li>The <strong>Ayu ●</strong> item in your menu bar shows whether syncing is healthy; click it for <strong>Sync now</strong> or to open AyuOS.</li>
      <li>Problems show up on the Home page — for example a wearable whose login expired and needs <strong>Reconnect</strong>.</li>
    </ul>
  </div>

  <div class="card help-section" id="privacy">
    <h2 style="margin-top: 0;">Privacy</h2>
    <ul>
      <li>Your data is stored only on this Mac. AyuOS doesn't send it to its developers or anyone else.</li>
      <li>Logins to Oura, Whoop and your hospital are encrypted, with the key kept in your Mac's Keychain.</li>
      <li>Turn on <strong>FileVault</strong> (System Settings → Privacy &amp; Security) so everything on your disk is encrypted.</li>
      <li>You can stop AyuOS's access any time from your Oura/Whoop account settings or your hospital's MyChart.</li>
    </ul>
  </div>

  <div class="card help-section" id="troubleshooting">
    <h2 style="margin-top: 0;">If something goes wrong</h2>
    <ul>
      <li><strong>"Needs reconnecting"</strong> on a wearable — click <strong>Reconnect</strong> and log in again.</li>
      <li><strong>"Couldn't connect"</strong> — the page explains why; if it doesn't help, send the AyuOS team a screenshot.</li>
      <li><strong>Hospital login shows "An error has occurred"</strong> — send the team a screenshot and the name of your hospital.</li>
      <li><strong>"Disk space is running low"</strong> — free some space; syncing stops if your disk fills up.</li>
      <li><strong>The window says "AyuOS is starting…" for more than a minute</strong> — restart your Mac; if it continues, send the team the file <code>~/Library/Logs/AyuOS/app.log</code>.</li>
    </ul>
  </div>
`;

export function helpPage(): string {
  const body = `
    <h1>How to use AyuOS</h1>
    <p class="lede">A step-by-step guide to setting up AyuOS and keeping your health record up to date.</p>
    ${SECTIONS}
  `;
  return layout("AyuOS — Help", body, "", "/help");
}
