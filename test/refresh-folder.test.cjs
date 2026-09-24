"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FLAGS = {
  Inbox: 0x00001000,
  SentMail: 0x00000200,
  Virtual: 0x00000020,
  CheckNew: 0x20000000,
  ImapNoselect: 0x01000000,
};

// nsITimer stand-in backed by setTimeout.
function makeCc() {
  return {
    "@mozilla.org/timer;1": {
      createInstance() {
        let handle = null;
        return {
          initWithCallback(cb, ms) { handle = setTimeout(() => cb.notify(), ms); },
          cancel() { clearTimeout(handle); },
        };
      },
    },
  };
}

function makeMailSession() {
  const listeners = new Set();
  return {
    listeners,
    AddFolderListener(l) { listeners.add(l); },
    RemoveFolderListener(l) { listeners.delete(l); },
    fire(folder, event) { for (const l of [...listeners]) l.onFolderEvent(folder, event); },
  };
}

function loadRefresh({ folders, mailSession = makeMailSession() }) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const start = source.indexOf("const REFRESH_DEFAULT_TIMEOUT_MS");
  const end = source.indexOf("// BEGIN FILTER TOOL HANDLERS", start);
  assert.ok(start >= 0, "refreshFolder start marker missing");
  assert.ok(end > start, "refreshFolder end marker missing");
  const sandbox = {
    Cc: makeCc(),
    Ci: {
      nsITimer: { TYPE_ONE_SHOT: 0 },
      nsIFolderListener: { event: 0x80 },
      nsIMsgImapMailFolder: "nsIMsgImapMailFolder",
      nsMsgFolderFlags: FLAGS,
    },
    ChromeUtils: { generateQI: () => function () { return this; } },
    Components: { isSuccessCode: (code) => code === 0 },
    MailServices: { mailSession },
    getAccessibleFolder: (uri) => folders[uri] ? { folder: folders[uri] } : { error: `Folder not found: ${uri}` },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}
this.refreshFolder = refreshFolder;
this.clampRefreshTimeout = clampRefreshTimeout;`, sandbox);
  return sandbox;
}

// A fake folder whose counts grow by `arrivals` when complete() runs.
function makeFolder(uri, { type = "imap", flags = 0, arrivals = 0 } = {}) {
  return {
    URI: uri,
    flags,
    isServer: false,
    server: { type },
    total: 10,
    unread: 2,
    updateCalls: 0,
    imapUpdateCalls: 0,
    getTotalMessages() { return this.total; },
    getNumUnread() { return this.unread; },
    complete() { this.total += arrivals; this.unread += arrivals; },
    updateFolder() { this.updateCalls++; },
    QueryInterface() { return this; },
  };
}

// IMAP folder whose updateFolderWithListener finishes after `delayMs` with `exitCode`.
function imapFolder(uri, { arrivals = 0, delayMs = 10, exitCode = 0, never = false, flags = 0 } = {}) {
  const f = makeFolder(uri, { type: "imap", arrivals, flags });
  f.updateFolderWithListener = (win, listener) => {
    f.imapUpdateCalls++;
    f.pendingListener = listener;
    if (!never) setTimeout(() => { f.complete(); listener.OnStopRunningUrl(null, exitCode); }, delayMs);
  };
  return f;
}

describe("refreshFolder", () => {
  it("clamps timeoutMs into [1000, 25000] with a 15000 default", () => {
    const { clampRefreshTimeout } = loadRefresh({ folders: {} });
    assert.equal(clampRefreshTimeout(undefined), 15000);
    assert.equal(clampRefreshTimeout(-5), 15000);
    assert.equal(clampRefreshTimeout("abc"), 15000);
    assert.equal(clampRefreshTimeout(10), 1000);
    assert.equal(clampRefreshTimeout(99999), 25000);
    assert.equal(clampRefreshTimeout(5000.7), 5000);
  });

  it("IMAP: waits on updateFolderWithListener (not getNewMessages) and reports counts", async () => {
    const f = imapFolder("imap://acct/Archive", { arrivals: 2 });
    f.getNewMessages = () => assert.fail("account-level getNewMessages must not be used");
    const { refreshFolder } = loadRefresh({ folders: { [f.URI]: f } });
    const res = await refreshFolder(f.URI, 5000);
    assert.equal(res.success, true);
    assert.equal(res.status, "loaded");
    assert.equal(res.netMessageDelta, 2);
    assert.equal(res.totalBefore, 10);
    assert.equal(res.unreadAfter, 4);
    assert.equal(f.imapUpdateCalls, 1);
  });

  it("IMAP: maps a failing exit code to a structured error", async () => {
    const f = imapFolder("imap://acct/Broken", { exitCode: 0x80004005 });
    const { refreshFolder } = loadRefresh({ folders: { [f.URI]: f } });
    const res = await refreshFolder(f.URI, 5000);
    assert.equal(res.success, false);
    assert.equal(res.status, "error");
    assert.match(res.error, /0x80004005/);
  });

  it("times out without stacking syncs: a repeat call joins the running one", async () => {
    const f = imapFolder("imap://acct/Slow", { never: true, arrivals: 1 });
    const { refreshFolder } = loadRefresh({ folders: { [f.URI]: f } });

    const first = await refreshFolder(f.URI, 1000);
    assert.equal(first.success, false);
    assert.equal(first.status, "timeout");
    assert.match(first.error, /background/);

    const secondP = refreshFolder(f.URI, 5000);
    setTimeout(() => { f.complete(); f.pendingListener.OnStopRunningUrl(null, 0); }, 20);
    const second = await secondP;
    assert.equal(second.status, "loaded");
    assert.equal(second.joinedInFlight, true);
    assert.equal(f.imapUpdateCalls, 1, "no second sync was started");

    // Once finished, the slot is free again.
    const third = refreshFolder(f.URI, 5000);
    setTimeout(() => f.pendingListener.OnStopRunningUrl(null, 0), 10);
    assert.equal((await third).joinedInFlight, undefined);
    assert.equal(f.imapUpdateCalls, 2);
  });

  it("skips local-store folders (Local Folders, POP, RSS, news)", async () => {
    const folders = {};
    for (const type of ["none", "pop3", "rss", "nntp"]) {
      folders[`${type}://x/Inbox`] = makeFolder(`${type}://x/Inbox`, { type });
    }
    const { refreshFolder } = loadRefresh({ folders });
    for (const [uri, f] of Object.entries(folders)) {
      const res = await refreshFolder(uri, 5000);
      assert.equal(res.success, true);
      assert.match(res.skipped, /no server-side folder/);
      assert.equal(f.updateCalls, 0);
    }
  });

  it("rejects unknown paths, saved searches and no-select folders", async () => {
    const virt = makeFolder("owl://acct/Saved", { type: "owl", flags: FLAGS.Virtual });
    const noselect = imapFolder("imap://acct/[Gmail]", { flags: FLAGS.ImapNoselect });
    const { refreshFolder } = loadRefresh({ folders: { [virt.URI]: virt, [noselect.URI]: noselect } });
    assert.match((await refreshFolder("imap://nope", 5000)).error, /not found/);
    assert.match((await refreshFolder(virt.URI, 5000)).error, /virtual/);
    assert.match((await refreshFolder(noselect.URI, 5000)).error, /no-select/);
    assert.equal(virt.updateCalls + noselect.imapUpdateCalls, 0);
  });
});

describe("refreshFolder on add-on accounts (Owl)", () => {
  // Owl folder whose updateFolder fires FolderLoaded after `delayMs`.
  function owlFolder(uri, mailSession, { arrivals = 0, delayMs = 20, never = false, flags = 0 } = {}) {
    const f = makeFolder(uri, { type: "owl", arrivals, flags });
    f.updateFolder = () => {
      f.updateCalls++;
      if (!never) setTimeout(() => { f.complete(); mailSession.fire(f, "FolderLoaded"); }, delayMs);
    };
    return f;
  }

  it("waits for the folder's FolderLoaded event and removes its listener", async () => {
    const mailSession = makeMailSession();
    const sent = owlFolder("owl://acct/Sent", mailSession, { arrivals: 1 });
    const { refreshFolder } = loadRefresh({ folders: { [sent.URI]: sent }, mailSession });
    const res = await refreshFolder(sent.URI, 5000);
    assert.equal(res.success, true);
    assert.equal(res.status, "loaded");
    assert.equal(res.netMessageDelta, 1);
    assert.equal(sent.updateCalls, 1);
    assert.equal(mailSession.listeners.size, 0);
  });

  it("ignores other folders' FolderLoaded and other events", async () => {
    const mailSession = makeMailSession();
    const other = makeFolder("owl://acct/Other", { type: "owl" });
    const inbox = makeFolder("owl://acct/Inbox", { type: "owl" });
    inbox.updateFolder = () => {
      setTimeout(() => mailSession.fire(other, "FolderLoaded"), 5);
      setTimeout(() => mailSession.fire(inbox, "CompactCompleted"), 10);
      setTimeout(() => mailSession.fire(inbox, "FolderLoaded"), 40);
    };
    const { refreshFolder } = loadRefresh({ folders: { [inbox.URI]: inbox }, mailSession });
    const res = await refreshFolder(inbox.URI, 5000);
    assert.equal(res.status, "loaded");
    assert.ok(res.elapsedMs >= 35, `settled early after ${res.elapsedMs}ms`);
  });

  it("catches a FolderLoaded fired synchronously inside updateFolder", async () => {
    const mailSession = makeMailSession();
    const inbox = makeFolder("owl://acct/Inbox", { type: "owl" });
    inbox.updateFolder = () => mailSession.fire(inbox, "FolderLoaded");
    const { refreshFolder } = loadRefresh({ folders: { [inbox.URI]: inbox }, mailSession });
    assert.equal((await refreshFolder(inbox.URI, 5000)).status, "loaded");
  });

  it("keeps listening past a timeout; a repeat call joins and sees the end", async () => {
    const mailSession = makeMailSession();
    const slow = owlFolder("owl://acct/Slow", mailSession, { never: true });
    const { refreshFolder } = loadRefresh({ folders: { [slow.URI]: slow }, mailSession });

    const first = await refreshFolder(slow.URI, 1000);
    assert.equal(first.status, "timeout");
    assert.equal(mailSession.listeners.size, 1, "listener stays until the sync really ends");

    const secondP = refreshFolder(slow.URI, 5000);
    setTimeout(() => mailSession.fire(slow, "FolderLoaded"), 20);
    const second = await secondP;
    assert.equal(second.status, "loaded");
    assert.equal(second.joinedInFlight, true);
    assert.equal(slow.updateCalls, 1);
    assert.equal(mailSession.listeners.size, 0);
  });

  it("account root: refreshes the Inbox and check-new folders, as Get Messages does", async () => {
    const mailSession = makeMailSession();
    const inbox = owlFolder("owl://acct/Inbox", mailSession, { flags: FLAGS.Inbox, arrivals: 3 });
    const watched = owlFolder("owl://acct/Watched", mailSession, { flags: FLAGS.CheckNew });
    const sent = owlFolder("owl://acct/Sent", mailSession, { flags: FLAGS.SentMail });
    const root = { URI: "owl://acct", isServer: true, flags: 0, server: { type: "owl" }, descendants: [inbox, watched, sent] };
    const { refreshFolder } = loadRefresh({ folders: { [root.URI]: root }, mailSession });

    const res = await refreshFolder(root.URI, 5000);
    assert.equal(res.success, true);
    assert.equal(res.scope, "account");
    // Spread into this realm: arrays built inside the vm context fail deepEqual on prototype.
    assert.deepEqual([...res.results.map(r => r.folderPath)], [inbox.URI, watched.URI]);
    assert.equal(res.results[0].netMessageDelta, 3);
    assert.equal(sent.updateCalls, 0);
  });

  it("IMAP account root uses the IMAP path for its Inbox", async () => {
    const inbox = imapFolder("imap://acct/INBOX", { flags: FLAGS.Inbox });
    const root = { URI: "imap://acct", isServer: true, flags: 0, server: { type: "imap" }, descendants: [inbox] };
    const { refreshFolder } = loadRefresh({ folders: { [root.URI]: root } });
    const res = await refreshFolder(root.URI, 5000);
    assert.equal(res.success, true);
    assert.equal(inbox.imapUpdateCalls, 1);
    assert.equal(inbox.updateCalls, 0);
  });
});
