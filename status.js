/* status.olict.com. Every number on this page is measured; nothing is generated here.

   Two sources, both read with a plain fetch:
   - the summary: one Firestore document, rewritten every 5 minutes by the statusProbe function
     (functions/status-probe.js in the olict.com repository), which checks the six services;
   - the witness: witness.json on this repository's `witness` branch, rewritten every 5 minutes by
     a GitHub Actions job that asks olict.com for its homepage from outside our hosting.
   This page is served by GitHub Pages, so it still loads when the hosting it reports on is down;
   then the summary is missing or old, and the witness is what it has left to say.

   ?mock=ok|degraded|down|stale|nofirebase|empty shows a built-in sample of each state.
   On localhost, ?emu=1 reads the summary from the Firestore emulator. */
(() => {
  const MIN = 60000, DAY = 86400000;
  const HOME = "https://olict.com";
  const DOC = "/v1/projects/olictcom/databases/(default)/documents/olict_status/public";
  const WITNESS_URL = "https://raw.githubusercontent.com/olictcom/status/witness/witness.json";
  const COMPONENTS = ["web", "portals", "hub", "api", "db", "mail"];
  const STALE = 15 * MIN;        // three missed runs: the summary no longer describes now
  const WIT_STALE = 30 * MIN;    // GitHub starts scheduled jobs late, so the witness gets longer
  const WINDOW = 90;

  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const MOCK = params.get("mock");
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const SUMMARY_URL = (LOCAL && params.get("emu") ? "http://127.0.0.1:8080" : "https://firestore.googleapis.com") + DOC;

  // ── language: ?lang=xx wins, then the browser's languages in order, then English (as on olict.com)

  function pickLanguage() {
    const asked = params.get("lang");
    if (STRINGS[asked]) return [asked, LANGUAGES[asked][1]];
    for (const tag of navigator.languages || [navigator.language || "en"]) {
      const [code, ...rest] = String(tag).split("-");
      const lang = code.toLowerCase();
      if (!STRINGS[lang]) continue;
      const region = rest.map(s => s.toUpperCase()).find(s => /^[A-Z]{2}$/.test(s));
      return [lang, region || LANGUAGES[lang][1]];
    }
    return ["en", "GB"];
  }
  const [lang, region] = pickLanguage();
  const locale = `${lang}-${region}`;
  const S = STRINGS[lang];
  const t = (key, vars = {}) => (S[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  const cap = s => s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);

  const pct = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 3 });
  // floored, so a few minutes of trouble never rounds up to a perfect 100%
  const fmtPct = f => pct.format(Math.floor(f * 1e5) / 1e5);
  // English's short units read "2 mins 14 secs"; its narrow ones are the familiar "2m 14s"
  const unit = u => new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: lang === "en" && u !== "millisecond" ? "narrow" : "short" });
  const [msF, hourF, minF, secF] = [unit("millisecond"), unit("hour"), unit("minute"), unit("second")];
  const fmtDur = s => {
    if (s >= 3600) {
      const hrs = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
      return [hourF.format(hrs), m && minF.format(m)].filter(Boolean).join(" ");
    }
    const m = Math.floor(s / 60), r = s % 60;
    return [m && minF.format(m), (r || !m) && secF.format(r)].filter(Boolean).join(" ");
  };
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const clockShort = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" });
  const dayNameYear = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  // the bars are the prober's days, which are UTC days
  const dayUTC = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const sameYear = (a, b) => new Date(a).getFullYear() === new Date(b).getFullYear();
  const fmtDay = ms => cap((sameYear(ms, Date.now()) ? dayName : dayNameYear).format(ms));
  // a run of quiet days: "23–25 October", "30 September – 2 October"
  const fmtRange = (a, b) => {
    const f = new Intl.DateTimeFormat(locale, sameYear(a, Date.now())
      ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
    return cap(f.formatRange ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`);
  };
  const dayStart = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const daysBack = (now, k) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k).getTime(); };
  function ago(ms, now) {
    const min = Math.round((now - ms) / MIN);
    if (min < 60) return rtf.format(-Math.max(1, min), "minute");
    if (min < 24 * 60) return rtf.format(-Math.round(min / 60), "hour");
    // calendar days, rounded so a daylight-saving change doesn't make it 1.96
    return rtf.format(-Math.round((dayStart(now) - dayStart(ms)) / DAY), "day");
  }

  // ── the two sources

  async function getJSON(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
      return res.ok ? await res.json() : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  const isCol = a => Array.isArray(a) && a.length === WINDOW;
  const okSummary = s => s && Number.isFinite(s.at) && s.components && s.days && typeof s.days.from === "string"
    && COMPONENTS.every(c => s.components[c] && s.days[c] && ["ok", "deg", "total", "ms"].every(k => isCol(s.days[c][k])))
    && Array.isArray(s.incidents);
  const okWitness = w => w && Number.isFinite(w.at) && typeof w.from === "string" && isCol(w.ok90) && isCol(w.total90);

  async function load() {
    if (MOCK) return mock(MOCK);
    // the witness changes every 5 minutes; the query only keeps a proxy from serving an older one
    const [doc, wit] = await Promise.all([getJSON(SUMMARY_URL), getJSON(`${WITNESS_URL}?t=${Math.floor(Date.now() / (5 * MIN))}`)]);
    let sum = null;
    try { sum = JSON.parse(doc.fields.json.stringValue); } catch { /* unreachable, or not written yet */ }
    return { sum: okSummary(sum) ? sum : null, wit: okWitness(wit) ? wit : null };
  }

  // The headline, first match wins. A summary that is missing or old must never read as "operational".
  function headline(sum, wit, now) {
    const fresh = !!sum && now - sum.at <= STALE;
    const witFresh = !!wit && now - wit.at <= WIT_STALE;
    if (!fresh) return witFresh && wit.ok ? "nodata" : "unknown";
    const states = COMPONENTS.map(c => sum.components[c].state);
    if (states.includes("down")) return "down";
    if (states.includes("degraded") || (witFresh && !wit.ok)) return "degraded";
    return "ok";
  }

  // ── DOM

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
    el.append(...kids.flat().filter(k => k != null && k !== false && k !== ""));
    return el;
  };

  function translate() {
    root.lang = lang;
    document.title = t("doc.title");
    document.querySelectorAll("[data-t]").forEach(el => { el.textContent = t(el.dataset.t); });
    // the privacy and terms pages exist in English, Italian and Turkish
    document.querySelectorAll("[data-legal]").forEach(el => {
      el.href = `${HOME}/${el.dataset.legal}/olict?lang=${["en", "it", "tr"].includes(lang) ? lang : "en"}`;
    });
    document.querySelectorAll("[data-home]").forEach(el => { el.href = `${HOME}/?lang=${lang}`; });
    const nav = document.getElementById("langs");
    nav.setAttribute("aria-label", t("lang.label"));
    nav.replaceChildren(...Object.entries(LANGUAGES).map(([code, [name]]) => {
      const q = new URLSearchParams(location.search);
      q.set("lang", code);
      const a = h("a", { href: `${location.pathname}?${q}`, lang: code }, name);
      if (code === lang) a.setAttribute("aria-current", "true");
      return a;
    }));
  }

  const sum90 = a => a.reduce((x, y) => x + y, 0);
  const STATE_KEY = { up: "state.ok", degraded: "state.degraded", down: "state.down", nodata: "state.nodata" };

  function renderHero(kind, { sum, wit }, now) {
    document.getElementById("headline").textContent = t(`hero.${kind}`);
    document.getElementById("stop").className = `stop ${kind}`;
    root.dataset.state = kind;
    let parts = [];
    if (kind === "nodata") parts = [t("hero.nodata.sub", { ago: ago(wit.at, now) })];
    else if (kind === "unknown") parts = [t("hero.unknown.sub")];
    else {
      const ok = sum90(COMPONENTS.map(c => sum90(sum.days[c].ok))), total = sum90(COMPONENTS.map(c => sum90(sum.days[c].total)));
      const open = sum.incidents.filter(i => !i.to).length;
      const last = sum.incidents.find(i => i.to);
      parts = [
        total && t("hero.uptime", { uptime: fmtPct(ok / total) }),
        open ? t("hero.open", { n: open }) + "." : last && t("hero.last", { ago: ago(last.to, now), d: fmtDur(Math.round((last.to - last.from) / 1000)) }),
        t("hero.checked", { ago: ago(sum.at, now) })
      ];
    }
    document.getElementById("sum").textContent = parts.filter(Boolean).join(" ");
  }

  // one row: a dot, the name, 90 day bars, the uptime and the last response time
  const series = new Map();   // row id → { from, ok, deg, total } for the bar tooltips
  function row(id, { name, small, state, ms, from, ok, deg, total }) {
    series.set(id, { from, ok, deg, total });
    const checks = sum90(total);
    const up = checks ? fmtPct(sum90(ok) / checks) : "—";
    const bars = h("span", { class: "bars", role: "img", "aria-label": checks ? t("bars.label", { host: name, uptime: up }) : `${name}: ${t("state.nodata")}` },
      total.map((n, k) => h("i", { class: !n ? "s" : ok[k] === n ? null : (ok[k] + deg[k]) * 2 < n ? "d" : "m", "data-k": k })));
    return h("li", { class: "srv", "data-row": id },
      h("span", { class: "srv-name" },
        h("i", { class: `dot ${state === "up" ? "" : state}`, "aria-hidden": "true" }),
        h("span", null, h("b", null, name), h("small", null, small)),
        h("span", { class: "sr-only" }, t(STATE_KEY[state]))),
      bars,
      h("span", { class: "srv-up" }, up),
      h("span", { class: "srv-ms" }, ms ? msF.format(ms) : "—"));
  }
  const axis = () => h("li", { class: "srv axis", "aria-hidden": "true" }, h("span"),
    h("span", { class: "ax" },
      h("span", { class: "a90" }, cap(rtf.format(-90, "day"))),
      h("span", { class: "a45" }, cap(rtf.format(-45, "day"))),
      h("span", null, cap(rtf.format(0, "day")))));
  const block = (id, title, meta, sketch, rows) => h("section", { class: "site", "aria-labelledby": id },
    h("header", { class: "site-head" }, h("h2", { id }, title), h("p", { class: "meta" }, h("span", null, meta)), sketch),
    h("ul", { class: "srvs" }, rows, axis()));
  const zeros = () => Array(WINDOW).fill(0);
  const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

  const sitesEl = document.getElementById("sites");
  function renderRows({ sum, wit }, now) {
    const fresh = !!sum && now - sum.at <= STALE;
    const witFresh = !!wit && now - wit.at <= WIT_STALE;
    const emptyFrom = utcDay(now - (WINDOW - 1) * DAY);
    series.clear();
    const services = COMPONENTS.map(c => {
      const d = sum ? sum.days[c] : { ok: zeros(), deg: zeros(), total: zeros() };
      const state = fresh ? sum.components[c].state : "nodata";
      return row(c, {
        name: t(`c.${c}`), small: t(`d.${c}`), state, ms: fresh && state !== "down" ? sum.components[c].ms : 0,
        from: sum ? sum.days.from : emptyFrom, ok: d.ok, deg: d.deg, total: d.total
      });
    });
    const witness = row("witness", {
      name: t("wit.name"), small: witFresh ? t("hero.checked", { ago: ago(wit.at, now) }) : t("wit.stale"),
      state: !witFresh ? "nodata" : wit.ok ? "up" : "down", ms: witFresh && wit.ok ? wit.ms : 0,
      from: wit ? wit.from : emptyFrom, ok: wit ? wit.ok90 : zeros(), deg: zeros(), total: wit ? wit.total90 : zeros()
    });
    sitesEl.replaceChildren(
      block("svc", t("svc.title"), t("svc.meta"), document.getElementById("sketch-ext").content.cloneNode(true), services),
      block("wit", t("wit.title"), t("wit.meta"), null, [witness]));
  }

  // ── incidents: the last 30 days, newest first; quiet days in a row share one line

  const step = (ms, label, text) => h("li", null,
    h("time", { datetime: new Date(ms).toISOString() }, clock.format(ms)),
    h("span", null, h("b", null, t(label)), " ", text));
  const article = e => h("article", { class: e.to ? "inc" : "inc open" },
    h("h4", null, t(e.worst === "down" ? "inc.down" : "inc.degraded", { name: t(`c.${e.component}`) })),
    h("p", { class: e.to ? "took" : "took open" }, h("i", { "aria-hidden": "true" }),
      e.to ? t("resolvedIn", { d: fmtDur(Math.round((e.to - e.from) / 1000)) }) : t("inc.ongoing")),
    h("ol", { class: "steps" },
      step(e.from, "step.detected", [t("detected.auto"), e.cause && t("inc.cause", { cause: e.cause })].filter(Boolean).join(" ")),
      e.to && step(e.to, "step.resolved", t("resolved.auto"))),
    e.note && h("p", { class: "note" }, e.note));

  const daysEl = document.getElementById("days");
  function renderIncidents({ sum }, now) {
    const tz = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(now)
      .find(p => p.type === "timeZoneName")?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzEl = document.getElementById("tz");
    tzEl.textContent = t("inc.tz", { tz });
    if (!sum) return daysEl.replaceChildren();
    // the first day anything was checked: the list does not claim quiet days from before that
    const first = Math.min(...COMPONENTS.map(c => { const k = sum.days[c].total.findIndex(n => n > 0); return k < 0 ? WINDOW : k; }));
    const began = first < WINDOW ? Date.parse(`${sum.days.from}T00:00:00Z`) + first * DAY : now;
    const list = [];
    let quiet = [];   // newest first
    const flush = () => {
      if (!quiet.length) return;
      list.push(h("li", { class: "day quiet" },
        h("h3", null, quiet.length === 1 ? fmtDay(quiet[0]) : fmtRange(quiet.at(-1), quiet[0])),
        h("div", null, h("p", null, t("inc.none")))));
      quiet = [];
    };
    for (let k = 0; k < 30; k++) {
      const day = daysBack(now, k);
      if (day + DAY <= began) break;
      const ev = sum.incidents.filter(e => dayStart(e.from) === day).sort((a, b) => b.from - a.from);
      if (!ev.length) { quiet.push(day); continue; }
      flush();
      list.push(h("li", { class: "day" }, h("h3", null, fmtDay(day)), h("div", null, ev.map(article))));
    }
    flush();
    if (first < WINDOW && began > daysBack(now, 30)) tzEl.textContent += " " + t("inc.since", { date: dayUTC.format(began) });
    daysEl.replaceChildren(...list);
  }

  // ── one bar's day, on hover or tap

  const tip = document.getElementById("tip");
  function showTip(bar) {
    const s = series.get(bar.closest(".srv").dataset.row);
    if (!s) return hideTip();
    const k = +bar.dataset.k, n = s.total[k], ok = s.ok[k];
    const date = h("b", null, dayUTC.format(Date.parse(`${s.from}T00:00:00Z`) + k * DAY));
    const line = !n ? h("span", null, t("tip.nodata"))
      : h("span", { class: ok === n ? null : (ok + s.deg[k]) * 2 < n ? "d" : "m" },
          ok === n ? t("tip.none") : t("tip.day", { uptime: fmtPct(ok / n), n }),
          ok === n && h("small", null, t("tip.day", { uptime: fmtPct(1), n })));
    tip.replaceChildren(date, line);
    tip.hidden = false;
    const r = bar.getBoundingClientRect();
    const w = tip.offsetWidth, ht = tip.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const top = r.top - ht - 10 < 8 ? r.bottom + 10 : r.top - ht - 10;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function hideTip() { tip.hidden = true; }
  sitesEl.addEventListener("pointerover", e => { const bar = e.target.closest(".bars i"); if (bar) showTip(bar); });
  sitesEl.addEventListener("pointerleave", hideTip);
  document.addEventListener("pointerdown", e => { if (!e.target.closest(".bars")) hideTip(); });
  addEventListener("scroll", hideTip, { passive: true });

  // ── the log: the prober's latest run, typed out one service at a time; each line pings its row.
  // The times are the ones the prober measured at the minute shown, not anything timed in this browser.

  const term = document.getElementById("term");
  const lines = ["> olict status --watch"];
  const draw = () => term.replaceChildren(...lines.slice(-5).map((s, i, a) =>
    h("span", { style: `opacity:${(1 - (a.length - 1 - i) * 0.17).toFixed(2)}` }, s + "\n")));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let turn = 0, data = { sum: null, wit: null };

  async function logLine() {
    const { sum } = data;
    const fresh = !!sum && Date.now() - sum.at <= STALE;
    let line = "> waiting for monitoring data";
    if (fresh) {
      const c = COMPONENTS[turn++ % COMPONENTS.length], comp = sum.components[c];
      const word = comp.state === "up" ? "ok" : comp.state;
      line = `${clockShort.format(sum.at)} probe ${c} `.padEnd(26, ".") + ` ${String(comp.state === "down" ? "—" : comp.ms).padStart(4)} ms  ${word}`;
      const dot = sitesEl.querySelector(`.srv[data-row="${c}"] .dot`);
      if (dot) {
        dot.classList.remove("ping");
        void dot.offsetWidth;   // restart the animation
        dot.classList.add("ping");
      }
    } else if (lines.at(-1) === line) return;
    if (lines.length > 40) lines.splice(0, lines.length - 5);
    // a hidden tab clamps timers to a second, so it gets whole lines instead of typing
    if (reduced || document.hidden) { lines.push(line); draw(); return; }
    lines.push("");
    for (let i = 3; i < line.length + 3; i += 3) {
      lines[lines.length - 1] = line.slice(0, i);
      draw();
      await wait(14);
    }
  }
  async function watch() {
    await logLine();
    setTimeout(watch, 1700);
  }

  // ── samples of every state, for ?mock=

  function mock(name) {
    const now = Date.now();
    const runsToday = Math.max(1, Math.floor((now % DAY) / (5 * MIN)));
    const from = utcDay(now - (WINDOW - 1) * DAY);
    const col = () => Array.from({ length: WINDOW }, (_, k) => (k < 30 ? 0 : k === WINDOW - 1 ? runsToday : 288));   // monitoring began 60 days ago
    const base = { web: 190, portals: 230, hub: 215, api: 420, db: 120, mail: 140 };
    const days = { from };
    for (const c of COMPONENTS) {
      const total = col(), ok = col(), deg = zeros();
      days[c] = { ok, deg, total, ms: total.map(n => (n ? base[c] : 0)) };
    }
    days.api.ok[86] -= 5; days.api.deg[86] += 5;          // the closed incident below, three days ago
    days.web.ok[70] -= 160;                                // one bad day, mostly down
    const components = Object.fromEntries(COMPONENTS.map(c => [c, { state: "up", ms: base[c], since: now - 20 * DAY }]));
    const closedFrom = now - 3 * DAY - 2 * 3600000;
    const incidents = [{ id: "api-1", component: "api", from: closedFrom, to: closedFrom + 25 * MIN, worst: "degraded", cause: "HTTP 503", note: "A deploy restarted the functions; they answered again on their own." }];
    const sum = { at: now - 2 * MIN, components, days, incidents };
    const wit = { at: now - 4 * MIN, ok: true, ms: 205, status: 200, from, ok90: col(), total90: col() };
    const open = (c, state, mins, cause) => {
      components[c] = { state, ms: state === "down" ? 0 : base[c], since: now - mins * MIN };
      incidents.unshift({ id: `${c}-2`, component: c, from: now - mins * MIN, to: null, worst: state, cause });
      days[c].ok[WINDOW - 1] = Math.max(0, days[c].ok[WINDOW - 1] - Math.round(mins / 5));
      if (state === "degraded") days[c].deg[WINDOW - 1] += Math.min(runsToday, Math.round(mins / 5));
    };
    if (name === "degraded") open("portals", "degraded", 20, "HTTP 500");
    if (name === "down") {
      open("web", "down", 35, "timeout"); open("portals", "down", 35, "timeout"); open("hub", "down", 35, "timeout");
      Object.assign(wit, { ok: false, status: 0, ms: 8000 });
    }
    if (name === "stale") sum.at = now - 40 * MIN;
    if (name === "nofirebase") return { sum: null, wit };
    if (name === "empty") return { sum: null, wit: null };
    return { sum, wit };
  }

  // ── Back returns to the olict.com page this one was opened from, which the browser keeps as it was.
  // Opened any other way (from outside, in a new tab, or after a language switch here), it is a link home.

  document.getElementById("back")?.addEventListener("click", e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || history.length < 2) return;
    let from;
    try { from = new URL(document.referrer); } catch { return; }
    if (!/^(www\.)?olict\.com$/.test(from.hostname)) return;
    e.preventDefault();
    history.back();
  });

  function render(d) {
    data = d;
    const now = Date.now();
    const kind = headline(d.sum, d.wit, now);
    renderHero(kind, d, now);
    renderRows(d, now);
    renderIncidents(d, now);
    return kind;
  }
  async function refresh() { render(await load()); }

  translate();
  draw();
  refresh().then(() => setTimeout(watch, 600));
  setInterval(refresh, MIN);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // a debugging handle: what the page read, and how it judged it
  window.OLICT_STATUS = { load, headline, render, get data() { return data; }, locale };
})();
