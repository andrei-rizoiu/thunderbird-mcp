"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// nsITimer stand-in backed by setTimeout.
function makeCc() {
  return {
    "@mozilla.org/timer;1": {
      createInstance() {
        let handle = null;
        return {
          // Unref only the 5-minute abandon cap, so a sync left running on
          // purpose does not keep node alive. The wait timer must stay ref'd:
          // on Node 18/22 an all-unref'd loop ends and cancels the test first.
          initWithCallback(cb, ms) {
            handle = setTimeout(() => cb.notify(), ms);
            if (ms >= 60000) handle.unref();
          },
          cancel() { clearTimeout(handle); },
        };
      },
    },
  };
}

// A calICalendar stand-in. `onRefresh(calendar)` decides what refresh() does.
function makeCalendar({ id, name = id, type = "caldav", disabled = false, canRefresh = true, onRefresh }) {
  const observers = new Set();
  const calendar = {
    id, name, type, canRefresh,
    refreshCalls: 0,
    observers,
    getProperty(key) { return key === "disabled" ? disabled : null; },
    addObserver(o) { observers.add(o); },
    removeObserver(o) { observers.delete(o); },
    notify(method, ...args) { for (const o of [...observers]) o[method](...args); },
    refresh() {
      calendar.refreshCalls++;
      return onRefresh ? onRefresh(calendar) : undefined;
    },
  };
  return calendar;
}

function loadRefresh(calendars) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const start = source.indexOf("const CAL_REFRESH_DEFAULT_TIMEOUT_MS");
  const end = source.indexOf("// END refreshCalendar", start);
  assert.ok(start >= 0, "refreshCalendar start marker missing");
  assert.ok(end > start, "refreshCalendar end marker missing");
  const sandbox = {
    Cc: makeCc(),
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 } },
    ChromeUtils: { generateQI: () => function () { return this; } },
    cal: { manager: { getCalendars: () => calendars } },
    Promise, Date, Map, Number, Math, String, setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + "\nthis.refreshCalendar = refreshCalendar;", sandbox);
  return sandbox.refreshCalendar;
}

describe("refreshCalendar", () => {
  it("calls the calendar's own refresh and waits for onLoad", async () => {
    const c = makeCalendar({ id: "a", type: "owl", onRefresh: (cal) => setTimeout(() => cal.notify("onLoad", cal), 20) });
    const refresh = loadRefresh([c]);
    const r = await refresh("a", 2000);
    assert.equal(r.success, true);
    assert.equal(r.status, "loaded");
    assert.equal(r.type, "owl");
    assert.equal(c.refreshCalls, 1);
    assert.equal(c.observers.size, 0, "observer must be removed");
  });

  it("catches an onLoad fired synchronously inside refresh()", async () => {
    const c = makeCalendar({ id: "a", onRefresh: (cal) => cal.notify("onLoad", cal) });
    const r = await loadRefresh([c])("a", 2000);
    assert.equal(r.status, "loaded");
  });

  it("ignores onLoad from another calendar", async () => {
    const other = makeCalendar({ id: "b" });
    const c = makeCalendar({ id: "a", onRefresh: (cal) => cal.notify("onLoad", other) });
    const r = await loadRefresh([c])("a", 1000);
    assert.equal(r.status, "timeout");
    assert.equal(r.success, false);
  });

  it("reports a mid-sync onError as a warning when the sync still loads", async () => {
    const c = makeCalendar({ id: "a", onRefresh: (cal) => {
      cal.notify("onError", cal, 0x80004005, "transient");
      setTimeout(() => cal.notify("onLoad", cal), 10);
    } });
    const r = await loadRefresh([c])("a", 2000);
    assert.equal(r.status, "loaded");
    assert.equal(r.warning, "transient");
  });

  it("reports a rejected refresh() as an error", async () => {
    const c = makeCalendar({ id: "a", onRefresh: () => Promise.reject(new Error("boom")) });
    const r = await loadRefresh([c])("a", 2000);
    assert.equal(r.status, "error");
    assert.equal(r.error, "boom");
  });

  it("times out but keeps the sync slot, and a repeat call joins it", async () => {
    let fire;
    const c = makeCalendar({ id: "a", onRefresh: (cal) => { fire = () => cal.notify("onLoad", cal); } });
    const refresh = loadRefresh([c]);
    const first = await refresh("a", 1000);
    assert.equal(first.status, "timeout");
    const second = refresh("a", 2000);
    setTimeout(fire, 20);
    const r = await second;
    assert.equal(r.status, "loaded");
    assert.equal(r.joinedInFlight, true);
    assert.equal(c.refreshCalls, 1, "a repeat call must not start a second sync");
  });

  it("skips a calendar that cannot refresh and rejects a disabled or unknown one", async () => {
    const local = makeCalendar({ id: "home", type: "storage", canRefresh: false });
    const off = makeCalendar({ id: "off", disabled: true });
    const refresh = loadRefresh([local, off]);
    const skipped = await refresh("home", 1000);
    assert.equal(skipped.success, true);
    assert.ok(skipped.skipped);
    assert.equal(local.refreshCalls, 0);
    assert.match((await refresh("off", 1000)).error, /disabled/);
    assert.match((await refresh("nope", 1000)).error, /not found/);
  });

  it("without calendarId refreshes every enabled refreshable calendar", async () => {
    const mk = (id, extra = {}) => makeCalendar({ id, ...extra, onRefresh: (cal) => setTimeout(() => cal.notify("onLoad", cal), 5) });
    const a = mk("owl", { type: "owl" });
    const b = mk("gdata", { type: "gdata" });
    const local = mk("home", { type: "storage", canRefresh: false });
    const off = mk("off", { disabled: true });
    const r = await loadRefresh([a, b, local, off])(undefined, 2000);
    assert.equal(r.success, true);
    assert.equal(r.scope, "all");
    assert.deepEqual(r.results.map(x => x.calendarId).sort(), ["gdata", "owl"]);
    assert.equal(local.refreshCalls, 0);
    assert.equal(off.refreshCalls, 0);
  });
});
