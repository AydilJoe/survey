/* ---------- Cloud backup: iCloud and Google Drive ---------- */

/* Two transports, one encrypted record, one restore rule. iCloud exists only
   inside the iPhone app (app/icloud-sync.js + native/icloud-backup) and needs
   no sign-in: it is on by default whenever the phone is signed in to iCloud.
   Google Drive works everywhere, so it stays on iPhone as the way to restore
   on Android or the web. Either, both or neither may be active; every
   save goes to each active one. */
// A function, not a const: renderDriveCard runs during boot, before this
// part of the file has executed, and a const would still be in its TDZ.
function cloudProviders() {
  return {
    icloud: { name: "iCloud", api: () => window.ICloudSync },
    drive: { name: "Google Drive", api: () => window.DriveSync },
  };
}

function cloudApi(id) {
  const p = cloudProviders()[id];
  const api = p && p.api();
  return api && api.isConfigured() && api.isSignedIn() ? api : null;
}

// Connected AND switched on: the providers that saves go to and that a
// newer backup is looked for in.
function cloudActive(id) {
  if (!cloudApi(id)) return false;
  if (id === "icloud" && window.ICloudSync && ICloudSync.canBackUp && !ICloudSync.canBackUp()) return false;
  return id === "icloud" ? state.icloudBackup !== false : state.driveAutoSync !== false;
}
function activeClouds() {
  return Object.keys(cloudProviders()).filter(cloudActive);
}

/* Debounced upload of the current encrypted localStorage record. Runs
   5s after the most recent save() so rapid edits coalesce into one write. */
const DRIVE_UPLOAD_DEBOUNCE_MS = 5000;
let driveUploadTimer = null;

function driveAvailable() {
  return activeClouds().length > 0;
}

function scheduleDriveUpload() {
  if (!driveAvailable()) return;
  if (!isPro()) return;
  if (driveUploadTimer) clearTimeout(driveUploadTimer);
  driveUploadTimer = setTimeout(() => {
    driveUploadTimer = null;
    runDriveUpload().catch((err) => console.warn("cloud upload failed", err));
  }, DRIVE_UPLOAD_DEBOUNCE_MS);
}

/* Uploads to `only` (one provider id, for a "Back up now" button) or to every
   active provider. One provider failing never stops the other; the first
   error is rethrown after both have been tried. */
async function runDriveUpload(only) {
  // Manual is free: `only` is set by a "Back up now" button, and that works
  // for everyone. Automatic uploads (no `only`: after a save, on reconnect,
  // on unlock) are Pro. Restore is open to all.
  const manual = !!only;
  if (!manual && !isPro()) return;
  const ids = only ? (cloudApi(only) ? [only] : []) : activeClouds();
  if (!ids.length) return;
  // iCloud writes a local file that syncs later, so it doesn't need a
  // connection. Drive does; the next save() reschedules it.
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const rec = JSON.parse(raw);
  const props = {
    lastEditedAt: state.lastEditedAt || "",
    deviceId: state.deviceId || "",
    schema: "1",
  };
  let firstError = null;
  for (const id of ids) {
    if (id === "drive" && !navigator.onLine) continue;
    try {
      await cloudApi(id).uploadEncryptedRecord(rec, props);
      if (!manual && isTrialActive()) bumpTrialUsage("backups");
    }
    catch (err) { firstError = firstError || err; }
  }
  renderDriveCard();
  if (firstError) throw firstError;
}

window.addEventListener("online", () => {
  if (driveUploadTimer == null && cloudActive("drive") && isPro()) {
    scheduleDriveUpload();
  }
});

/* On unlock: compare each active provider's backup with this device. If the
   newest one is strictly newer, offer to restore it. If this device is newer
   (or a provider has no backup yet), schedule a push. v1 policy:
   last-write-wins with confirmation. */
async function checkDriveOnBoot() {
  if (window.ICloudSync) {
    try { await ICloudSync.ready(); } catch {}
  }
  // Drive is checked whenever it is connected (its auto-sync switch only
  // governs pushes, as before iCloud existed); iCloud only while its switch
  // is on, because switching it off is how someone opts out of it.
  const ids = Object.keys(cloudProviders())
    .filter((id) => cloudApi(id) && (id !== "icloud" || state.icloudBackup !== false));
  if (!ids.length) return;
  // Restore prompt is allowed for anyone connected — that's how Pro itself
  // flows from device A's backup to device B. A restore is never trimmed to
  // the free limits: the backup is the person's own data. Auto-upload is
  // still Pro-only (gated inside scheduleDriveUpload).
  const local = state.lastEditedAt || "";
  let newest = null;
  let needsPush = false;
  for (const id of ids) {
    let meta;
    try { meta = await cloudApi(id).getRemoteMeta(); }
    catch (err) { console.warn(`${id} meta failed`, err); continue; }
    const remote = (meta && meta.appProperties && meta.appProperties.lastEditedAt) || "";
    if (!remote || (local && local > remote)) needsPush = true;
    if (remote && (!newest || remote > newest.remote)) newest = { id, remote };
  }
  if (newest && newest.remote > local) {
    const ok = confirm(
      tr("A newer backup exists in {where} (last edited {when}).", { where: cloudProviders()[newest.id].name, when: formatRelative(newest.remote) }) + "\n\n" +
      tr("Restore it now? Your current data on this device will be replaced."),
    );
    if (ok) await restoreFromDrive(newest.id);
  } else if (needsPush) {
    scheduleDriveUpload();
  }
}

async function restoreFromDrive(id = "drive") {
  const api = cloudApi(id);
  if (!api) return;
  const where = cloudProviders()[id].name;
  let rec;
  try { rec = await api.downloadEncryptedRecord(); }
  catch (err) { notify(tr("Couldn't download backup:") + " " + (err.message || err)); return; }
  if (!rec) { notify(id === "icloud" ? tr("No backup found in iCloud.") : tr("No backup found in your Google Drive.")); return; }

  // The backup carries its own salt, so even with the same passcode the
  // local AES key won't match. Try the local key first (works only if the
  // backup was made on this same device), then fall back to a passcode
  // prompt and derive a key from the backup's salt. After decryption we
  // re-encrypt with the local key so subsequent saves stay consistent.
  let plain = null;
  try {
    plain = await decryptRecord(aesKey, rec);
  } catch {}
  // A backup made without a passcode opens with the fixed code.
  if (!plain) {
    try { plain = await decryptRecord(await deriveKey(OPEN_PASSCODE, b64decode(rec.salt)), rec); } catch {}
  }
  if (!plain) {
    const altPass = await askPasscode({ title: tr("Restore from {where}", { where }), label: "Passcode used for that backup", ok: "Restore", check: async (p) => {
      plain = await decryptRecord(await deriveKey(p, b64decode(rec.salt)), rec);
      return true;
    } });
    if (altPass == null) return;
  }
  state = coerceState(plain);
  // Force a re-encrypt under the local key on the next save tick.
  const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
  const reRec = await encryptWith(aesKey, state, prev.salt);
  localStorage.setItem(ENC_KEY, JSON.stringify(reRec));
  renderAll();
  showRestoreCelebration(id);
}

function formatRelative(iso) {
  if (!iso) return tr("unknown");
  const t = Date.parse(iso);
  if (!t) return tr("unknown");
  const diff = Date.now() - t;
  if (diff < 60000) return tr("moments ago");
  if (diff < 3600000) return tr("{n}m ago", { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return tr("{n}h ago", { n: Math.floor(diff / 3600000) });
  return tr("{n}d ago", { n: Math.floor(diff / 86400000) });
}

/* ----- Cloud backup UI ----- */

// Google Drive switched off for this build (iPhone, drive-config.js): hide
// every Drive control and say iCloud where the copy names both.
function driveHiddenHere() {
  return !!(window.DriveSync && DriveSync.isHidden && DriveSync.isHidden());
}
function applyDriveVisibility() {
  if (!driveHiddenHere()) return;
  document.querySelectorAll("[data-drive]").forEach((el) => { el.hidden = true; });
  document.querySelectorAll("[data-drive-text]").forEach((el) => { el.textContent = tr(el.dataset.driveText); });
  try { PAYWALL_COPY.cloudBackup = tr("Automatic backup to iCloud is a Pro feature. Back up now and Export CSV in Settings stay free."); } catch { /* not defined yet at boot */ }
}

function renderDriveCard() {
  const card = document.getElementById("drive-card");
  if (!card) return;
  applyDriveVisibility();
  card.hidden = false;
  const pro = isPro();

  // iCloud block: the iPhone app, and the web once a CloudKit web token is set.
  const ic = window.ICloudSync;
  const icConfigured = !!(ic && ic.isConfigured());
  const icBlock = document.getElementById("icloud-backup");
  if (icBlock) icBlock.hidden = !icConfigured;
  card.classList.toggle("has-icloud", icConfigured);
  if (icConfigured) {
    const icOn = ic.isSignedIn();
    const onEl = document.getElementById("icloud-on");
    const offEl = document.getElementById("icloud-off");
    if (onEl) onEl.hidden = !icOn;
    if (offEl) offEl.hidden = icOn;
    const onWeb = !!(ic.isWeb && ic.isWeb());
    const signInBox = document.getElementById("apple-sign-in-wrap");
    const signOutBox = document.getElementById("apple-sign-out-wrap");
    const recheck = document.getElementById("btn-icloud-recheck");
    if (signInBox) signInBox.hidden = !onWeb || icOn;
    if (signOutBox) signOutBox.hidden = !onWeb || !icOn;
    if (recheck) recheck.hidden = onWeb;
    // CloudKit JS draws its button into the box, so load it once the box is on screen.
    if (onWeb && !icOn && ic.prepareSignIn && !renderDriveCard._ckAsked) {
      renderDriveCard._ckAsked = true;
      ic.prepareSignIn().then(() => renderDriveCard()).catch(() => {});
    }
    const why = document.getElementById("icloud-off-why");
    if (why && !icOn && onWeb) {
      why.textContent = tr("Sign in with your Apple ID to restore the Duitful iPhone app's backup. To back up here, use Google Drive or CSV.");
    } else if (why && !icOn) {
      // Each reason names the one switch that fixes it. The code in
      // brackets is for a bug report, not for the reader.
      const reason = (ic.unavailableReason && ic.unavailableReason()) || "";
      why.textContent = reason === "no-account"
        ? tr("You're not signed in to iCloud on this iPhone. Sign in from the Settings app, then tap Check again.")
        : reason === "restricted"
          ? tr("iCloud is restricted on this iPhone (Screen Time or a work profile). Lift the restriction, then tap Check again.") + " (restricted)"
          : reason === "temporarily-unavailable"
            ? tr("iCloud needs your attention in the Settings app, often to re-enter your password. Then tap Check again.") + " (temporarily-unavailable)"
            : tr("Couldn't reach iCloud just now. Tap Check again.") + " (" + (reason || "unknown") + ")";
    }
    if (icOn) {
      const restoreOnly = onWeb;
      const autoRow = document.getElementById("icloud-auto")?.closest("label");
      if (autoRow) autoRow.style.display = restoreOnly ? "none" : "";
      const nowBtn = document.getElementById("btn-icloud-sync-now");
      if (nowBtn) nowBtn.style.display = restoreOnly ? "none" : "";
      const auto = document.getElementById("icloud-auto");
      if (auto) {
        auto.checked = pro && state.icloudBackup !== false;
        auto.disabled = !pro;
      }
      const last = ic.getStatus().lastSyncedAt;
      const lastLine = document.getElementById("icloud-last-synced");
      if (lastLine) {
        const lastText = last ? tr("Last backed up {when}.", { when: formatRelative(last) }) : tr("Not backed up yet.");
        lastLine.textContent = restoreOnly ? tr("Restore only on the web. Back up with Google Drive or CSV.")
          : !pro ? `${tr("Automatic backup is off (Pro). Back up now and restoring are free.")} ${lastText}`
          : last ? lastText
          : state.icloudBackup === false ? tr("Automatic backup is off.") : lastText;
      }
    }
  }

  const configured = !!(window.DriveSync && DriveSync.isConfigured());
  const unconfigured = document.getElementById("drive-unconfigured");
  const signinBtn = document.getElementById("btn-drive-signin");
  if (unconfigured) unconfigured.hidden = configured;
  if (signinBtn) {
    signinBtn.disabled = !configured;
    // With iCloud already backing up, Drive is the secondary choice.
    const icloudCovers = icConfigured && ic.isSignedIn();
    signinBtn.classList.toggle("primary", !icloudCovers);
    signinBtn.classList.toggle("ghost", icloudCovers);
  }

  const signedIn = configured && DriveSync.isSignedIn();
  const inEl = document.getElementById("drive-signed-in");
  const outEl = document.getElementById("drive-signed-out");
  if (inEl) inEl.hidden = !signedIn;
  if (outEl) outEl.hidden = signedIn;

  if (signedIn) {
    const email = DriveSync.getAccountEmail();
    const accountLine = document.getElementById("drive-account-line");
    if (accountLine) accountLine.textContent = email ? tr("Connected as {email}.", { email }) : tr("Connected to Google Drive.");

    const last = (DriveSync.getStatus().lastSyncedAt) || null;
    const lastLine = document.getElementById("drive-last-synced");
    if (lastLine) lastLine.textContent = last ? tr("Last synced {when}.", { when: formatRelative(last) }) : tr("Not synced yet.");

    const auto = document.getElementById("drive-auto-sync");
    if (auto) {
      auto.checked = pro && state.driveAutoSync !== false;
      auto.disabled = !pro;
    }
    const syncNow = document.getElementById("btn-drive-sync-now");
    if (syncNow) { syncNow.disabled = false; syncNow.title = ""; }
    const proHint = document.getElementById("drive-pro-hint");
    if (proHint) proHint.hidden = pro;
  }

  // One pill for the card: whichever provider is busy or failing says so.
  const pill = document.getElementById("drive-status-pill");
  if (pill) {
    const statuses = Object.keys(cloudProviders())
      .filter((id) => cloudApi(id))
      .map((id) => ({ id, s: cloudApi(id).getStatus() }));
    const busy = statuses.find((x) => x.s && x.s.state === "working");
    const failed = statuses.find((x) => x.s && x.s.state === "error");
    const prefix = (x) => (statuses.length > 1 ? cloudProviders()[x.id].name + ": " : "");
    if (busy) {
      pill.hidden = false;
      pill.textContent = prefix(busy) + (busy.s.message || tr("Syncing…"));
      pill.className = "drive-status-pill working";
    } else if (failed) {
      pill.hidden = false;
      pill.textContent = prefix(failed) + (failed.s.message || tr("Error"));
      pill.className = "drive-status-pill error";
    } else {
      pill.hidden = statuses.length === 0;
      pill.textContent = statuses.length ? tr("Synced") : "";
      pill.className = "drive-status-pill ok";
    }
  }
}

(function wireDriveButtons() {
  const onClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  onClick("btn-drive-signin", async () => {
    // Sign-in is open to all: restoring and "Back up now" are free.
    // Only automatic upload is Pro.
    try {
      await DriveSync.signIn();
      await checkDriveOnBoot();
      renderDriveCard();
    } catch (err) {
      notify(tr("Sign-in failed:") + " " + (err.message || err));
    }
  });
  onClick("btn-drive-signout", async () => {
    if (!confirm(tr("Disconnect Google Drive? Your local data is unchanged; the encrypted backup stays in your Drive."))) return;
    await DriveSync.signOut();
    renderDriveCard();
  });
  onClick("btn-drive-sync-now", async () => {
    try {
      await runDriveUpload("drive");
      renderDriveCard();
      toast(tr("Backed up to Google Drive."));
    } catch (err) {
      notify(tr("Sync failed:") + " " + (err.message || err));
    }
  });
  onClick("btn-drive-restore", async () => {
    if (!confirm(tr("Restore from Google Drive will replace the data on this device. Continue?"))) return;
    await restoreFromDrive("drive");
    renderDriveCard();
  });
  onClick("btn-icloud-sync-now", async () => {
    try {
      await runDriveUpload("icloud");
      renderDriveCard();
      toast(tr("Backed up to iCloud."));
    } catch (err) {
      notify(tr("iCloud backup failed:") + " " + (err.message || err));
    }
  });
  onClick("btn-icloud-recheck", async () => {
    const btn = document.getElementById("btn-icloud-recheck");
    const endWork = beginWork(btn);
    try { if (window.ICloudSync && ICloudSync.refresh) await ICloudSync.refresh(); }
    finally { endWork(); renderDriveCard(); }
  });
  onClick("btn-icloud-restore", async () => {
    if (!confirm(tr("Restore from iCloud will replace the data on this device. Continue?"))) return;
    await restoreFromDrive("icloud");
    renderDriveCard();
  });
  const bindToggle = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (!isPro()) {
        el.checked = false;
        gate("cloudBackup");
        return;
      }
      state[key] = !!el.checked;
      save(); // save() schedules the upload when the toggle went on
      renderDriveCard();
    });
  };
  bindToggle("drive-auto-sync", "driveAutoSync");
  bindToggle("icloud-auto", "icloudBackup");
})();
