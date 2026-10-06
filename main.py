"""Процесс плагина «Задачи Jira»: читает журнал хаба (только чтение), собирает, какие задачи Jira упоминали сессии и
поручения, и раз в несколько минут спрашивает у Jira статус, заголовок и исполнителя — через подключение хаба к
Atlassian (вход владельца, rovo.py), только поиском. Итог — web/data.json для вида; Jira недоступна — вид на данных хаба.
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
# индекс — вне папки плагина: хаб считает версию страницы по всем файлам расширения и перезагружает вкладку, когда она
# меняется (владелец 06.10: «браузер постоянно моргает» — файлы плагина менялись каждые 20 с)
INDEX = os.path.join(STATE_DIR, "jira-board", "index.json")
OUT = os.path.join(HERE, "web", "data.json")
EVERY, JIRA_EVERY = 20, 300
# не упоминание задачи: служебное ядра и вывод команд (там номера бывают случайно — grep, отчёты, списки)
SKIP = ("catalog.loaded", "session.info", "account.limits", "owner.", "news.", "core.", "tools.", "turn.started",
        "host.", "session.recap", "watch.", "turn.tool_result", "task.noted")


# web/data.json отдаётся странице только из папки плагина, а версия страницы — размер и время файлов там. Поэтому файл
# всегда одного размера (добивается пробелами, растёт ступенями) и с одним временем: для хаба он не меняется, а вид
# читает его свежим (?t= в адресе). Новая ступень размера — одна перезагрузка вкладок.
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
    """Новые строки журнала → упоминания задач: кто (сессия), когда, в каком поручении. Журнал сменился — заново."""
    try:
        with open(JOURNAL, "rb") as f:
            head = f.readline()
            size = f.seek(0, 2)
            if head != (idx.get("first") or "").encode() or size < idx["offset"]:
                idx.update(offset=0, first=head.decode(errors="replace"), keys={}, sessions=[])   # moved — оставить
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
    """Статус, заголовок, исполнитель — через подключение хаба к Atlassian (rovo.py), только чтение: поиск по JQL.
    Задача, переехавшая в другой проект, по старому номеру в поиске не находится — её читаем по номеру (getJiraIssue)
    и запоминаем новый номер в moved."""
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
                continue   # нет такой задачи — случайное совпадение номера
            moved[k] = it["key"]
            out[it["key"]] = issue(it)
        for k, new in moved.items():
            if k in keys and new in out and k != new:
                out[k] = {**out[new], "moved_to": new}
        return out, None
    except Exception as e:  # noqa: BLE001 — Jira недоступна: вид остаётся на данных хаба
        return None, f"Jira недоступна: {str(e)[:120] or e.__class__.__name__}"
    finally:
        if r:
            r.close()


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
                (None, "не узнать cloudId сайта Jira")
            write(INDEX, idx)
            jira_at = time.time()
            if got is not None:
                issues = got
        write(OUT, {"generated": time.time(), "url": url, "jira_at": jira_at, "jira_error": err,
                    "issues": issues, "keys": idx["keys"]}, fixed=True)
        time.sleep(EVERY)


if __name__ == "__main__":
    main()
