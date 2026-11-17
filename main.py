"""The process of the "Jira tasks" plugin: reads the hub journal (read only), collects which Jira tasks the sessions and
tasks mentioned, and every few minutes asks Jira for the status, summary and assignee through the hub's connection to
Atlassian (the owner's login, rovo.py), by search only. The result is web/data.json for the view; with Jira unavailable
the view works on the hub's data.
"""
import json
import os
import re
import time
import urllib.request

from core import catalog

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.environ.get("HUB_STATE_DIR") or open(os.path.join(catalog.config_dir(), "state-dir")).read().strip()
JOURNAL = os.path.join(STATE_DIR, "journal.jsonl")
# the index lives outside the plugin folder: the hub computes the page version from all the extension's files and
# reloads the tab when it changes (the browser kept flickering while the plugin's files changed every 20 s)
INDEX = os.path.join(STATE_DIR, "jira-board", "index.json")
OUT = os.path.join(HERE, "web", "data.json")
EVERY, JIRA_EVERY = 20, 300
# not a mention of a task: the core's service events and command output (keys turn up there by chance: grep, reports, lists)
SKIP = ("catalog.loaded", "session.info", "account.limits", "owner.", "news.", "core.", "tools.", "turn.started",
        "host.", "session.recap", "watch.", "turn.tool_result", "task.noted")


# web/data.json is served to the page only from the plugin folder, and the page version is the size and time of the
# files there. So the file always has one size (padded with spaces, growing in steps) and one time: for the hub it does
# not change, while the view reads it fresh (?t= in the address). A new size step means one reload of the tabs.
FIXED_MTIME = 1_000_000_000
STEP = 256 << 10


def write(path, data, fixed=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = json.dumps(data, ensure_ascii=False).encode()
    if fixed:
        raw += b" " * (-(len(raw) + 1) % STEP + 1)
    with open(path + ".tmp", "wb") as f:
        f.write(raw)
    if fixed:
        os.utime(path + ".tmp", (FIXED_MTIME, FIXED_MTIME))
    os.replace(path + ".tmp", path)


def load_index():
    try:
        with open(INDEX) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"offset": 0, "first": None, "keys": {}, "sessions": []}


def key_re(projects):
    return re.compile(r"(?<![\w/-])((?:%s)-\d+)(?![\w-])" % "|".join(re.escape(p) for p in sorted(projects, key=len, reverse=True)))


def scan(idx, rx):
    """New journal lines → task mentions: who (the session), when, in which task. A new journal: start over."""
    try:
        with open(JOURNAL, "rb") as f:
            head = f.readline()
            size = f.seek(0, 2)
            if head != (idx.get("first") or "").encode() or size < idx["offset"]:
                idx.update(offset=0, first=head.decode(errors="replace"), keys={}, sessions=[])   # moved: keep
            f.seek(idx["offset"])
            chunk = f.read()
    except FileNotFoundError:
        return
    end = chunk.rfind(b"\n") + 1
    idx["offset"] += end
    sessions = set(idx["sessions"])
    for line in chunk[:end].splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t, ent, data = e.get("type", ""), e.get("entity"), e.get("data") or {}
        if t == "session.requested" and ent:
            sessions.add(ent)
        if t.startswith(SKIP):
            continue
        keys = set(rx.findall(json.dumps(data, ensure_ascii=False)))
        if not keys:
            continue
        who = data.get("session") if t == "delegation.created" else (ent if ent in sessions else data.get("to"))
        task = f"d{e['seq']}" if t == "delegation.created" else None
        for k in keys:
            rec = idx["keys"].setdefault(k, {"first": e["ts"], "last": e["ts"], "sessions": {}, "tasks": {}})
            rec["last"] = max(rec["last"], e["ts"])
            if who in sessions:
                s = rec["sessions"].setdefault(who, {"first": e["ts"], "last": e["ts"], "n": 0})
                s["last"], s["n"] = e["ts"], s["n"] + 1
            if task and who:
                rec["tasks"][task] = who
    idx["sessions"] = sorted(sessions)


def issue(it):
    f = it.get("fields") or {}
    st = f.get("status") or {}
    return {"summary": f.get("summary") or "", "status": st.get("name") or "",
            "category": (st.get("statusCategory") or {}).get("key") or "",
            "assignee": (f.get("assignee") or {}).get("displayName") or "", "type": (f.get("issuetype") or {}).get("name") or ""}


def jira(keys, cloud, moved, cfg):
    """Status, summary, assignee through the hub's connection to Atlassian (rovo.py), read only: a JQL search.
    A task moved to another project is not found by its old key in a search: it is read by key (getJiraIssue) and its
    new key is remembered in moved."""
    from rovo import Rovo
    fields = ["summary", "status", "assignee", "issuetype"]
    out, r = {}, None
    try:
        r = Rovo(cfg)
        want = sorted({moved.get(k) or k for k in keys})
        for i in range(0, len(want), 100):
            res = r.tool("searchJiraIssuesUsingJql", {"cloudId": cloud, "jql": "key in (%s)" % ",".join(want[i:i + 100]),
                                                      "fields": fields, "maxResults": 100})
            for it in res.get("issues") or []:
                out[it["key"]] = issue(it)
        for k in keys:
            if k in out or (moved.get(k) in out):
                continue
            try:
                it = r.tool("getJiraIssue", {"cloudId": cloud, "issueIdOrKey": k, "fields": fields})
            except RuntimeError:
                continue   # no such task: a chance match of a key
            moved[k] = it["key"]
            out[it["key"]] = issue(it)
        # whose: only the owner's tasks, by the same search with assignee = currentUser(): the Atlassian login is the
        # owner's
        found = sorted(out)
        for i in range(0, len(found), 100):
            res = r.tool("searchJiraIssuesUsingJql", {"cloudId": cloud, "jql": "key in (%s) AND assignee = currentUser()"
                                                      % ",".join(found[i:i + 100]), "fields": ["summary"], "maxResults": 100})
            for it in res.get("issues") or []:
                if it["key"] in out:
                    out[it["key"]]["mine"] = True
        for k, new in moved.items():
            if k in keys and new in out and k != new:
                out[k] = {**out[new], "moved_to": new}
        return out, None
    except Exception as e:  # noqa: BLE001 — Jira unavailable: the view stays on the hub's data
        return None, f"Jira unavailable: {str(e)[:120] or e.__class__.__name__}"
    finally:
        if r:
            r.close()


def only_mine(issues, keys):
    """The board shows only the owner's tasks (the Jira assignee is the owner). Before Jira answers: empty, not everything."""
    mine = {k: v for k, v in issues.items() if v.get("mine")}
    return {"issues": mine, "keys": {k: v for k, v in keys.items() if k in mine}}


def cloud_id(url):
    try:
        return json.load(urllib.request.urlopen(url + "/_edge/tenant_info", timeout=20))["cloudId"]
    except (OSError, ValueError, KeyError):
        return None


def main():
    idx, issues, jira_at, err = load_index(), {}, 0, None
    try:
        with open(OUT) as f:
            issues = json.load(f).get("issues") or {}
    except (OSError, ValueError):
        pass
    while True:
        full = catalog.load_config(STATE_DIR)
        cfg = full.get("jira") or {}
        url, projects = str(cfg.get("url") or "").rstrip("/"), list(cfg.get("projects") or [])
        if projects:
            scan(idx, key_re(projects))
            write(INDEX, idx)
        if url and idx["keys"] and time.time() - jira_at > JIRA_EVERY:
            cloud = cloud_id(url)
            got, err = jira(sorted(idx["keys"]), cloud, idx.setdefault("moved", {}), full) if cloud else \
                (None, "cannot get the cloudId of the Jira site")
            write(INDEX, idx)
            jira_at = time.time()
            if got is not None:
                issues = got
        write(OUT, {"generated": time.time(), "url": url, "jira_at": jira_at, "jira_error": err,
                    **only_mine(issues, idx["keys"])}, fixed=True)
        time.sleep(EVERY)


if __name__ == "__main__":
    main()
