"""Jira через подключение хаба к Atlassian (Rovo MCP): сервер берётся из каталога хаба (hub.json → mcp: тот, что
ходит на mcp.atlassian.com), вход — тот же, что у сессий (mcp-remote хранит его в ~/.mcp-auth), свой токен не нужен.
Только чтение: поиск задач по JQL и чтение задачи."""
import json
import os
import signal
import subprocess
import threading
import queue

MCP = ["npx", "-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"]   # нет в каталоге — как в README Atlassian


def server(cfg):
    """Команда и окружение сервера Atlassian из каталога хаба: stdio-сервер, в args которого mcp.atlassian.com."""
    for m in (cfg.get("mcp") or {}).values():
        srv = m.get("server") or {}
        if srv.get("command") and any("mcp.atlassian.com" in str(a) for a in srv.get("args") or []):
            return [srv["command"], *(srv.get("args") or [])], srv.get("env") or {}
    return MCP, {}


class Rovo:
    def __init__(self, cfg, timeout=60):
        cmd, env = server(cfg)
        # свой process group: npx поднимает mcp-remote отдельным процессом (node) — закрыть надо всю группу, иначе он
        # переживает закрытие npx и остаётся сиротой
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, env={**os.environ, **env}, start_new_session=True)
        self.q, self.n, self.timeout = queue.Queue(), 0, timeout
        threading.Thread(target=self._read, daemon=True).start()
        self.call_raw("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "hub-jira-board", "version": "0.1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _read(self):
        for line in self.p.stdout:
            try:
                self.q.put(json.loads(line))
            except ValueError:
                pass

    def _send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def call_raw(self, method, params):
        self.n += 1
        self._send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        while True:
            msg = self.q.get(timeout=self.timeout)
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", "ошибка MCP")[:200])
                return msg["result"]

    def tool(self, name, args):
        res = self.call_raw("tools/call", {"name": name, "arguments": args})
        text = "".join(c.get("text", "") for c in res.get("content") or [] if c.get("type") == "text")
        if res.get("isError"):
            raise RuntimeError(text[:200])
        return json.loads(text)

    def close(self):
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
