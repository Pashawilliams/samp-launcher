#!/usr/bin/env python3
"""Опрос SA-MP серверов (UDP query protocol) и генерация JSON для веб-лаунчера.

Запускается в GitHub Actions по расписанию. Результат:
  site/data/status.json  — текущее состояние серверов
  site/data/history.json — история онлайна (подтягивается с уже опубликованного сайта)
"""
import json
import os
import socket
import struct
import time
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DATA = os.path.join(SITE, "data")
HISTORY_KEEP_SEC = 3 * 24 * 3600   # храним 3 суток
HISTORY_MAX_POINTS = 3000


class Reader:
    def __init__(self, buf: bytes):
        self.b, self.i = buf, 0

    def _unpack(self, fmt):
        v = struct.unpack_from(fmt, self.b, self.i)[0]
        self.i += struct.calcsize(fmt)
        return v

    def u8(self):  return self._unpack("<B")
    def u16(self): return self._unpack("<H")
    def u32(self): return self._unpack("<I")
    def i32(self): return self._unpack("<i")

    def text(self, n):
        v = self.b[self.i:self.i + n].decode("cp1251", "replace")
        self.i += n
        return v


def request(ip, port, op: bytes, timeout=2.5, tries=3):
    """Отправляет запрос SA-MP query, возвращает (payload, rtt_ms) или (None, None)."""
    pkt = b"SAMP" + socket.inet_aton(ip) + struct.pack("<H", port) + op
    for _ in range(tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            t0 = time.perf_counter()
            s.sendto(pkt, (ip, port))
            while True:
                data, _ = s.recvfrom(65535)
                if data[:4] == b"SAMP" and data[10:11] == op:
                    return data[11:], (time.perf_counter() - t0) * 1000
        except OSError:
            continue
        finally:
            s.close()
    return None, None


def query_server(srv):
    out = {
        "id": srv["id"], "name": srv.get("name", ""), "ip": srv["ip"], "port": srv["port"],
        "online": False, "hostname": srv.get("name", ""), "gamemode": "", "language": "",
        "password": False, "players": 0, "maxPlayers": 0, "ping": None,
        "rules": {}, "playerList": None,
    }
    try:
        ip = socket.gethostbyname(srv["ip"])
    except OSError:
        return out

    data, rtt = request(ip, srv["port"], b"i")
    if data is None:
        return out
    try:
        r = Reader(data)
        out["password"] = bool(r.u8())
        out["players"] = r.u16()
        out["maxPlayers"] = r.u16()
        out["hostname"] = r.text(r.u32())
        out["gamemode"] = r.text(r.u32())
        out["language"] = r.text(r.u32())
        out["online"] = True
        out["ping"] = round(rtt)
    except Exception:
        return out

    data, _ = request(ip, srv["port"], b"r", tries=2)
    if data:
        try:
            r = Reader(data)
            for _ in range(r.u16()):
                k = r.text(r.u8())
                out["rules"][k] = r.text(r.u8())
        except Exception:
            pass

    # Список игроков SA-MP отдаёт только если онлайн < 100
    if out["players"] < 100:
        data, _ = request(ip, srv["port"], b"c", tries=2)
        if data:
            try:
                r = Reader(data)
                lst = []
                for _ in range(r.u16()):
                    name = r.text(r.u8())
                    lst.append({"name": name, "score": r.i32()})
                out["playerList"] = sorted(lst, key=lambda p: -p["score"])
            except Exception:
                pass
    return out


def load_history(base_url):
    if not base_url:
        return []
    url = base_url.rstrip("/") + "/data/history.json?t=" + str(int(time.time()))
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.load(resp)
            return data.get("points", []) if isinstance(data, dict) else []
    except Exception as e:
        print("history: не удалось загрузить предыдущую историю:", e)
        return []


def main():
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(SITE, "servers.json"), encoding="utf-8") as f:
        cfg = json.load(f)

    now = int(time.time())
    results = [query_server(s) for s in cfg.get("servers", [])]
    for s in results:
        state = f"{s['players']}/{s['maxPlayers']} ping {s['ping']}ms" if s["online"] else "OFFLINE"
        print(f"[{s['id']}] {s['ip']}:{s['port']} — {s['hostname']} — {state}")

    status = {"updated": datetime.now(timezone.utc).isoformat(), "updatedTs": now, "servers": results}
    with open(os.path.join(DATA, "status.json"), "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=1)

    points = load_history(os.environ.get("PAGES_URL", ""))
    points.append({"t": now, "p": {s["id"]: (s["players"] if s["online"] else -1) for s in results}})
    points = [p for p in points if now - p.get("t", 0) <= HISTORY_KEEP_SEC][-HISTORY_MAX_POINTS:]
    with open(os.path.join(DATA, "history.json"), "w", encoding="utf-8") as f:
        json.dump({"points": points}, f, separators=(",", ":"))
    print(f"history: {len(points)} точек")


if __name__ == "__main__":
    main()
