// «Задачи Jira»: какие задачи упоминали сессии и поручения хаба, их статус в Jira и в хабе, кто над ними работает.
// Данные — web/data.json от процесса плагина (main.py); состояние сессий и поручений — из снимка хаба.
const ACTIVE = new Set(["busy", "starting", "dialog"]);
const DAY = 86400;
let data = null, timer = null, filter = "work", query = "", draw = () => {};

async function load(hub) {
  try {
    const r = await fetch(hub.url("web/data.json") + "?t=" + Date.now());
    if (r.ok) { data = await r.json(); draw(); }
  } catch { /* процесс ещё не написал файл — покажем, когда напишет */ }
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "только что";
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < DAY) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / DAY)} дн назад`;
}

// статус задачи в хабе: ждёт вас > в работе > сдано / тихо. Только то, что относится к этой задаче, а не к агенту
// целиком (владелец 06.10: «как это в done и в работе?» — занятый агент метил всё, что упоминал за полчаса):
// «ждёт вас» — вопрос агента вам называет задачу; «в работе» — агент занят и упоминал её в этом ходе (с начала хода)
// или по ней открыто поручение хаба; закрытая в Jira — не «в работе», что бы ни было в хабе.
function hubState(key, rec, snap, cat) {
  // третьим — сессия, куда ведёт отметка (владелец 06.10: «при нажатии сдали или ждёт вас переходить в нужную сессию»)
  const byName = new Map(snap.sessions.map((s) => [s.name, s]));
  const tasks = new Map((snap.delegations || []).map((d) => [d.id, d]));
  const people = Object.entries(rec.sessions).map(([n, m]) => [byName.get(n), m]).filter(([s]) => s && s.kind !== "hub")
    .sort((a, b) => b[1].last - a[1].last);
  const latest = people[0]?.[0]?.name;
  const owned = Object.entries(rec.tasks).filter(([id, n]) => byName.has(n)).sort((a, b) => b[0].slice(1) - a[0].slice(1));
  const done = owned.length ? ["done", "агенты сдали", owned[0][1]]
    : ["quiet", Date.now() / 1000 - rec.last < DAY ? "сегодня" : "тихо", latest];
  if (cat === "done") return owned.length || people.length ? ["done", "агенты сдали", owned[0]?.[1] || latest] : done;
  const asks = people.find(([s]) => JSON.stringify([s.pending || [], s.waiting || ""]).includes(key));
  if (asks) return ["wait", "ждёт вас", asks[0].name];
  const busy = people.find(([s, m]) => working(s, m));
  if (busy) return ["work", "в работе", busy[0].name];
  const open = owned.find(([id]) => tasks.get(id)?.state === "working");
  if (open) return ["work", "в работе", open[1]];
  return done;
}

const working = (s, m) => ACTIVE.has(s.state) && m.last >= (s.since || 0);

function row(hub, key, rec, snap) {
  const is = data.issues[key] || {};
  const [hs, hl, to] = hubState(key, rec, snap, is.category);
  const tr = hub.el("div", "jb-row");
  const a = hub.el("a", "jb-key", key);
  a.href = `${data.url}/browse/${key}`; a.target = "_blank"; a.rel = "noopener";
  const head = hub.el("div", "jb-head");
  head.append(a, hub.el("span", "jb-sum", is.summary || "—"));
  const st = hub.el("span", `jb-chip jira-${is.category || "none"}`, is.status || "не в Jira");
  if (is.moved_to) { a.href = `${data.url}/browse/${is.moved_to}`; a.title = `теперь ${is.moved_to}`; }
  const hc = hub.el(to ? "button" : "span", `jb-chip hub-${hs}${to ? " go" : ""}`, hl);
  if (to) {
    hc.title = `открыть сессию ${to}`;
    hc.addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(to)}`; });
  }
  const who = hub.el("div", "jb-who");
  const byName = new Map(snap.sessions.map((s) => [s.name, s]));
  for (const [name, s] of Object.entries(rec.sessions).sort((x, y) => y[1].last - x[1].last)) {
    const sess = byName.get(name);
    if (!sess || sess.kind === "hub") continue;
    const on = is.category !== "done" && working(sess, s);
    const b = hub.el("button", `jb-agent ${on ? "on" : ""}`, `${sess.icon ? sess.icon + " " : ""}${name}`);
    b.title = `${sess.state} · упоминаний ${s.n} · ${ago(s.last)}`;
    b.addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(name)}`; });
    who.append(b);
  }
  const meta = hub.el("div", "jb-meta", [is.assignee && `в Jira: ${is.assignee}`, ago(rec.last)].filter(Boolean).join(" · "));
  tr.append(head, hub.el("div", "jb-chips"), who, meta);
  tr.querySelector(".jb-chips").append(st, hc);
  return { node: tr, hs, cat: is.category || "", inJira: !!data.issues[key], last: rec.last };
}

export default function register(hub) {
  hub.addStyle("web/style.css");
  let root = null, snap = null, list = null, note = null, count = null, chips = [];
  // каркас — один раз: строка фильтров и поиск живут между снимками (курсор и набранное не теряются)
  const frame = () => {
    const box = hub.el("div", "jb"), bar = hub.el("div", "jb-bar");
    chips = [["work", "В работе"], ["wait", "Ждут вас"], ["done", "Закрытые"], ["all", "Все"]].map(([id, label]) => {
      const b = hub.el("button", "chip", label);
      b.dataset.id = id;
      b.addEventListener("click", () => { filter = id; draw(); });
      bar.append(b);
      return b;
    });
    const q = hub.el("input", "jb-q");
    q.placeholder = "Номер или слово";
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
    if (!data) { count.textContent = "Собираю задачи из журнала хаба…"; note.hidden = true; return; }
    note.hidden = !data.jira_error;
    note.textContent = data.jira_error ? `${data.jira_error} — статусы Jira от ${ago(data.jira_at)}` : "";
    const known = Object.keys(data.issues).length > 0;
    const rows = Object.entries(data.keys).map(([k, r]) => [k, row(hub, k, r, snap)])
      .filter(([, r]) => r.inJira || !known)   // номер, которого нет в Jira, — случайное совпадение (UTF-8 и т. п.)
      .filter(([k, r]) => {
        const t = (k + " " + (data.issues[k]?.summary || "")).toLowerCase();
        if (query && !t.includes(query.toLowerCase())) return false;
        if (filter === "work") return r.hs === "work" || r.hs === "wait" || r.cat === "indeterminate";
        if (filter === "wait") return r.hs === "wait";
        if (filter === "done") return r.cat === "done";
        return true;
      })
      .sort((a, b) => ({ wait: 0, work: 1 }[a[1].hs] ?? 2) - ({ wait: 0, work: 1 }[b[1].hs] ?? 2) || b[1].last - a[1].last);
    count.textContent = `${rows.length} задач`;
    list.replaceChildren(...rows.map(([, r]) => r.node));
    if (!rows.length) list.append(hub.el("p", "hint", "Здесь пусто."));
  };
  hub.addView({
    id: "jira", title: "Задачи Jira", subtitle: "что в работе у агентов", icon: "board",
    render(r, s) { root = r; snap = s; draw(); },
    show() { load(hub); timer = setInterval(() => load(hub), 30000); },
    hide() { clearInterval(timer); },
  });
  load(hub);
}
