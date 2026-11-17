// "Jira tasks": which Jira tasks the hub's sessions and tasks mentioned, their status in Jira and in the hub, who works on them.
// Data: web/data.json from the plugin process (main.py); the state of sessions and tasks comes from the hub snapshot.
const ACTIVE = new Set(["busy", "starting", "dialog"]);
const DAY = 86400;
let data = null, timer = null, filter = "work", query = "", draw = () => {};

// UI strings: English by default, Russian when the page language is Russian (hub.lang, Plugin API 1.25)
const STR = {
  en: {
    now: "just now", min: (n) => `${n} min ago`, hours: (n) => `${n} h ago`, days: (n) => `${n} d ago`,
    handed: "agents handed in", today: "today", quiet: "quiet", waits: "waits for you", working: "in progress",
    sent: (id) => `sent to the hub${id ? ` (${id})` : ""}`, sending: "sending…",
    failed: (err) => `not sent: ${err}. Click again`, ask: (key) => `Ask the hub: what is the status of ${key}?`,
    noHub: "hub session not found", noAnswer: "no answer", refused: (key, err) => `The hub did not accept the question about ${key}: ${err}`,
    notInJira: "not in Jira", movedTo: (key) => `now ${key}`, openSession: (name) => `open session ${name}`,
    mentions: (n) => `mentions: ${n}`, inJira: (who) => `in Jira: ${who}`,
    filters: [["work", "In progress"], ["wait", "Waiting for you"], ["done", "Closed"], ["all", "All"]],
    search: "Key or word", collecting: "Collecting tasks from the hub journal…",
    statusesFrom: (err, when) => `${err}: Jira statuses as of ${when}`,
    count: (n) => `${n} ${n === 1 ? "task" : "tasks"}`, empty: "Nothing here.",
    title: "Jira tasks", subtitle: "what the agents are working on",
  },
  ru: {
    now: "только что", min: (n) => `${n} мин назад`, hours: (n) => `${n} ч назад`, days: (n) => `${n} дн назад`,
    handed: "агенты сдали", today: "сегодня", quiet: "тихо", waits: "ждёт вас", working: "в работе",
    sent: (id) => `отправлено хабу${id ? ` (${id})` : ""}`, sending: "отправляю…",
    failed: (err) => `не отправлено: ${err}. Нажмите ещё раз`, ask: (key) => `Спросить хаб: что с задачей ${key}?`,
    noHub: "сессия хаба не найдена", noAnswer: "нет ответа", refused: (key, err) => `Хаб не принял вопрос по ${key}: ${err}`,
    notInJira: "не в Jira", movedTo: (key) => `теперь ${key}`, openSession: (name) => `открыть сессию ${name}`,
    mentions: (n) => `упоминаний ${n}`, inJira: (who) => `в Jira: ${who}`,
    filters: [["work", "В работе"], ["wait", "Ждут вас"], ["done", "Закрытые"], ["all", "Все"]],
    search: "Номер или слово", collecting: "Собираю задачи из журнала хаба…",
    statusesFrom: (err, when) => `${err} — статусы Jira от ${when}`,
    count: (n) => `${n} задач`, empty: "Здесь пусто.",
    title: "Задачи Jira", subtitle: "что в работе у агентов",
  },
};
let L = STR.en;

async function load(hub) {
  try {
    const r = await fetch(hub.url("web/data.json") + "?t=" + Date.now());
    if (r.ok) { data = await r.json(); draw(); }
  } catch { /* the process has not written the file yet: shown once it does */ }
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return L.now;
  if (s < 3600) return L.min(Math.round(s / 60));
  if (s < DAY) return L.hours(Math.round(s / 3600));
  return L.days(Math.round(s / DAY));
}

// the task's state in the hub: waits for you > in progress > handed in / quiet. Only what concerns this task, not the
// agent as a whole (a busy agent used to mark everything it had mentioned in the last half hour):
// "waits for you": the agent's question to you names the task; "in progress": the agent is busy and mentioned it in
// this turn (since the turn began) or a hub task about it is open; closed in Jira is never "in progress", whatever the hub says.
function hubState(key, rec, snap, cat) {
  // the third item is the session the mark leads to (a click on "handed in" or "waits for you" opens it)
  const byName = new Map(snap.sessions.map((s) => [s.name, s]));
  const tasks = new Map((snap.delegations || []).map((d) => [d.id, d]));
  const people = Object.entries(rec.sessions).map(([n, m]) => [byName.get(n), m]).filter(([s]) => s && s.kind !== "hub")
    .sort((a, b) => b[1].last - a[1].last);
  const latest = people[0]?.[0]?.name;
  const owned = Object.entries(rec.tasks).filter(([id, n]) => byName.has(n)).sort((a, b) => b[0].slice(1) - a[0].slice(1));
  const done = owned.length ? ["done", L.handed, owned[0][1]]
    : ["quiet", Date.now() / 1000 - rec.last < DAY ? L.today : L.quiet, latest];
  if (cat === "done") return owned.length || people.length ? ["done", L.handed, owned[0]?.[1] || latest] : done;
  const asks = people.find(([s]) => JSON.stringify([s.pending || [], s.waiting || ""]).includes(key));
  if (asks) return ["wait", L.waits, asks[0].name];
  const busy = people.find(([s, m]) => working(s, m));
  if (busy) return ["work", L.working, busy[0].name];
  const open = owned.find(([id]) => tasks.get(id)?.state === "working");
  if (open) return ["work", L.working, open[1]];
  return done;
}

const working = (s, m) => ACTIVE.has(s.state) && m.last >= (s.since || 0);

// "?": ask the hub about the task. The state lives outside the DOM: draw() rebuilds the rows every 30 s and on every snapshot.
const ASK_HOLD = 60000;
const asks = new Map();   // key → { st: "sending" | "sent" | "fail", at, id, err, cid }
const askOf = (key) => {
  const a = asks.get(key);
  if (a && a.st === "sent" && Date.now() - a.at >= ASK_HOLD) { asks.delete(key); return null; }
  return a || null;
};

function askButton(hub, key, snap) {
  const b = hub.el("button", "jb-chip jb-ask", "?");
  b.type = "button";
  const paint = () => {
    const a = askOf(key);
    b.classList.toggle("sending", a?.st === "sending");
    b.classList.toggle("sent", a?.st === "sent");
    b.classList.toggle("fail", a?.st === "fail");
    b.disabled = a?.st === "sending" || a?.st === "sent";
    b.textContent = a?.st === "sending" ? "…" : a?.st === "sent" ? "✓" : "?";
    b.title = a?.st === "sent" ? L.sent(a.id)
      : a?.st === "sending" ? L.sending
      : a?.st === "fail" ? L.failed(a.err)
      : L.ask(key);
    b.setAttribute("aria-label", b.title);
    if (a?.st === "sent") setTimeout(() => { if (b.isConnected) paint(); }, Math.max(0, ASK_HOLD - (Date.now() - a.at)) + 50);
  };
  b.addEventListener("click", async () => {
    const cur = askOf(key);
    if (cur && cur.st !== "fail") return;
    const hubS = snap.sessions.find((s) => s.kind === "hub");
    if (!hubS || typeof hub.send !== "function") { asks.set(key, { st: "fail", err: L.noHub }); paint(); return; }
    // the same client_id on a retry after "not sure it arrived": no duplicate
    const prev = cur;
    const cid = prev?.cid || `jira-ask-${key}-${Date.now()}`;
    asks.set(key, { st: "sending", at: Date.now(), cid });
    paint();
    const r = await hub.send({ session: hubS.name, text: `what is the status of ${key}?`, action: true, client_id: cid });
    if (r.ok) asks.set(key, { st: "sent", at: Date.now(), id: r.data?.id || "" });
    else {
      const err = r.error || L.noAnswer;
      asks.set(key, { st: "fail", at: Date.now(), err, cid: r.receipt === "unknown" ? cid : "" });
      if (hub.capabilities?.banner === 1) hub.banner(L.refused(key, err));
    }
    paint();
  });
  paint();
  return b;
}

function row(hub, key, rec, snap) {
  const is = data.issues[key] || {};
  const [hs, hl, to] = hubState(key, rec, snap, is.category);
  const tr = hub.el("div", "jb-row");
  const a = hub.el("a", "jb-key", key);
  a.href = `${data.url}/browse/${key}`; a.target = "_blank"; a.rel = "noopener";
  const head = hub.el("div", "jb-head");
  head.append(a, hub.el("span", "jb-sum", is.summary || "—"));
  const st = hub.el("span", `jb-chip jira-${is.category || "none"}`, is.status || L.notInJira);
  if (is.moved_to) { a.href = `${data.url}/browse/${is.moved_to}`; a.title = L.movedTo(is.moved_to); }
  const hc = hub.el(to ? "button" : "span", `jb-chip hub-${hs}${to ? " go" : ""}`, hl);
  if (to) {
    hc.title = L.openSession(to);
    hc.addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(to)}`; });
  }
  const who = hub.el("div", "jb-who");
  const byName = new Map(snap.sessions.map((s) => [s.name, s]));
  for (const [name, s] of Object.entries(rec.sessions).sort((x, y) => y[1].last - x[1].last)) {
    const sess = byName.get(name);
    if (!sess || sess.kind === "hub") continue;
    const on = is.category !== "done" && working(sess, s);
    const b = hub.el("button", `jb-agent ${on ? "on" : ""}`, `${sess.icon ? sess.icon + " " : ""}${name}`);
    b.title = `${sess.state} · ${L.mentions(s.n)} · ${ago(s.last)}`;
    b.addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(name)}`; });
    who.append(b);
  }
  const meta = hub.el("div", "jb-meta", [is.assignee && L.inJira(is.assignee), ago(rec.last)].filter(Boolean).join(" · "));
  tr.append(head, hub.el("div", "jb-chips"), who, meta);
  tr.querySelector(".jb-chips").append(st, hc, askButton(hub, is.moved_to || key, snap));
  return { node: tr, hs, cat: is.category || "", inJira: !!data.issues[key], last: rec.last };
}

export default function register(hub) {
  L = hub.lang === "ru" ? STR.ru : STR.en;
  hub.addStyle("web/style.css");
  let root = null, snap = null, list = null, note = null, count = null, chips = [];
  // the frame is built once: the filter row and the search live across snapshots (the cursor and the typed text stay)
  const frame = () => {
    const box = hub.el("div", "jb"), bar = hub.el("div", "jb-bar");
    chips = L.filters.map(([id, label]) => {
      const b = hub.el("button", "chip", label);
      b.dataset.id = id;
      b.addEventListener("click", () => { filter = id; draw(); });
      bar.append(b);
      return b;
    });
    const q = hub.el("input", "jb-q");
    q.placeholder = L.search;
    q.addEventListener("input", () => { query = q.value; draw(); });
    bar.append(q);
    note = hub.el("p", "hint warn"); count = hub.el("div", "jb-count"); list = hub.el("div", "jb-list");
    box.append(bar, note, count, list);
    root.replaceChildren(box);
  };
  draw = () => {
    if (!root || !snap) return;
    if (!root.querySelector(".jb")) frame();
    for (const c of chips) c.classList.toggle("on", c.dataset.id === filter);
    if (!data) { count.textContent = L.collecting; note.hidden = true; return; }
    note.hidden = !data.jira_error;
    note.textContent = data.jira_error ? L.statusesFrom(data.jira_error, ago(data.jira_at)) : "";
    const known = Object.keys(data.issues).length > 0;
    const rows = Object.entries(data.keys).map(([k, r]) => [k, row(hub, k, r, snap)])
      .filter(([, r]) => r.inJira || !known)   // a key that is not in Jira is a chance match (UTF-8 and the like)
      .filter(([k, r]) => {
        const t = (k + " " + (data.issues[k]?.summary || "")).toLowerCase();
        if (query && !t.includes(query.toLowerCase())) return false;
        if (filter === "work") return r.hs === "work" || r.hs === "wait" || r.cat === "indeterminate";
        if (filter === "wait") return r.hs === "wait";
        if (filter === "done") return r.cat === "done";
        return true;
      })
      .sort((a, b) => ({ wait: 0, work: 1 }[a[1].hs] ?? 2) - ({ wait: 0, work: 1 }[b[1].hs] ?? 2) || b[1].last - a[1].last);
    count.textContent = L.count(rows.length);
    list.replaceChildren(...rows.map(([, r]) => r.node));
    if (!rows.length) list.append(hub.el("p", "hint", L.empty));
  };
  hub.addView({
    id: "jira", title: L.title, subtitle: L.subtitle, icon: "board",
    render(r, s) { root = r; snap = s; draw(); },
    show() { load(hub); timer = setInterval(() => load(hub), 30000); },
    hide() { clearInterval(timer); },
  });
  load(hub);
}
