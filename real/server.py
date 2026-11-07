#!/usr/bin/env python3
"""
Zabbix 只读数据代理 + 静态页面服务（多实例 / 多版本）

设计原则（针对"禁止修改源 Zabbix 数据"的要求）：
  1. 只读白名单：只允许 .get / apiinfo.version 这类读取方法，其余方法在本地直接拒绝，
     请求不会发往 Zabbix（连尝试都不会发生）。
  2. 凭据只存在于服务端进程内，不下发给浏览器。
  3. 每一次真正转发给 Zabbix 的调用都写进 audit.jsonl，可审计。
  4. 只绑定 127.0.0.1，不对外暴露。

版本差异：
  - 5.0+：API Token，Authorization: Bearer
  - 4.0：无 API Token，必须 user.login 换 sessionid，请求体带 auth
         （这是唯一的"认证动作"，不改监控数据；会话过期自动重登一次）

启动：python3 server.py
访问：http://127.0.0.1:8770/
"""

import base64
import hmac
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
AUDIT = os.path.join(BASE, "audit.jsonl")

with open(os.path.join(BASE, "config.json"), encoding="utf-8") as f:
    CFG = json.load(f)

TIMEOUT = int(CFG.get("timeout", 60))
BIND = os.environ.get("ZBX_BIND", CFG.get("bind", "127.0.0.1"))
PORT = int(os.environ.get("ZBX_PORT", CFG.get("port", 8770)))

# ---- 访问控制（P0-1）----
# 端口绑 0.0.0.0 后，同网段任何人都能读到监控数据，因此提供一层轻量 HTTP Basic Auth。
# mode: "off"（默认，本地开发）/ "basic"。凭据只在服务端，不下发浏览器。
# /api/ping 免认证：容器 HEALTHCHECK 与外部探活需要它（不返回任何监控数据）。
ACCESS = CFG.get("access") or {}
ACCESS_MODE = str(ACCESS.get("mode", "off")).lower()
ACCESS_USER = str(ACCESS.get("user", ""))
ACCESS_PASS = str(ACCESS.get("password", ""))
ACCESS_PUBLIC = set(ACCESS.get("public_paths") or ["/api/ping"])

# ---- 审计日志轮转（P0-2）----
# audit.jsonl 原本只追加不轮转，长期运行会无限增长。
ROTATE = CFG.get("audit_rotate") or {}
ROTATE_MAX_BYTES = int(ROTATE.get("max_bytes", 5 * 1024 * 1024))
ROTATE_MAX_FILES = int(ROTATE.get("max_files", 5))

# ---- 实例配置：兼容旧的单实例写法 ----
def _load_profiles(cfg):
    if isinstance(cfg.get("profiles"), list) and cfg["profiles"]:
        out = {}
        for p in cfg["profiles"]:
            # enabled=false 的实例不加载（用于实例临时下线：保留配置，改回 true 重启即可）
            if p.get("enabled") is False:
                continue
            pid = str(p.get("id") or len(out) + 1)
            q = dict(p)
            q["id"] = pid
            q.setdefault("label", pid)
            q.setdefault("auth", "token")
            out[pid] = q
        if not out:
            sys.exit("config.json 中没有任何启用的实例（全部 enabled=false）")
        return out
    return {
        "default": {
            "id": "default",
            "label": "默认实例",
            "upstream": cfg["upstream"],
            "auth": CFG.get("auth", "token"),
            "token": cfg.get("token", ""),
            "user": cfg.get("user", ""),
            "password": cfg.get("password", ""),
        }
    }


PROFILES = _load_profiles(CFG)
ACTIVE = CFG.get("active") or next(iter(PROFILES))
if ACTIVE not in PROFILES:
    ACTIVE = next(iter(PROFILES))

# ---- 只读白名单：这是唯一的放行清单，不在表里的一律拒绝 ----
READ_ONLY = {
    "apiinfo.version",
    "host.get", "hostgroup.get", "hostinterface.get",
    "item.get", "itemprototype.get",
    "trigger.get", "triggerprototype.get",
    "problem.get", "event.get",
    "history.get", "trend.get",
    "map.get", "iconmap.get", "graph.get", "graphitem.get",
    "application.get",
    "alert.get", "mediatype.get", "action.get",
    "template.get", "proxy.get", "maintenance.get",
    "user.get", "role.get", "usermacro.get", "usergroup.get",
    "discoveryrule.get", "drule.get", "service.get", "sla.get",
    "settings.get", "housekeeping.get", "auditlog.get",
}

LOG = []          # 内存环形日志，供页面展示
BLOCKED = []      # 被拦截的写操作尝试
STATS = {"forwarded": 0, "blocked": 0, "errors": 0, "auth": 0}
SESSIONS = {}     # profile_id -> {"sid": str, "ts": float}
LOCK = threading.Lock()


def _rotate_audit_locked():
    """调用时必须已持有 LOCK。超过阈值时把 audit.jsonl 滚成 .1/.2/... 并淘汰最老。"""
    try:
        if not os.path.exists(AUDIT) or os.path.getsize(AUDIT) < ROTATE_MAX_BYTES:
            return
        oldest = "%s.%d" % (AUDIT, ROTATE_MAX_FILES)
        if os.path.exists(oldest):
            os.remove(oldest)
        for i in range(ROTATE_MAX_FILES - 1, 0, -1):
            src = "%s.%d" % (AUDIT, i)
            if os.path.exists(src):
                os.replace(src, "%s.%d" % (AUDIT, i + 1))
        os.replace(AUDIT, AUDIT + ".1")
    except OSError:
        # 只读文件系统/权限问题：轮转失败不影响主流程，审计仍会尝试追加
        pass


def audit(entry):
    LOG.append(entry)
    del LOG[:-400]
    try:
        with LOCK:
            _rotate_audit_locked()
            with open(AUDIT, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _post(profile, method, params, sid=None):
    """真正发往 Zabbix 的 HTTP 请求，返回 (body_str, ms)。

    注意 JSON-RPC 信封：`auth` 是**请求对象的根级字段**，不是 params 的成员。
    放进 params 里 Zabbix 看不到它，会直接回 Not authorised（4.0 实测）。
    """
    headers = {"Content-Type": "application/json-rpc"}
    req_body = {
        "jsonrpc": "2.0",
        "method": method,
        "params": dict(params or {}),
        "id": int(time.time() * 1000) % 10 ** 9,
    }

    if profile.get("auth") == "login" and method != "apiinfo.version":
        if sid:
            req_body["auth"] = sid
    elif method != "apiinfo.version" and profile.get("token"):
        headers["Authorization"] = "Bearer " + profile["token"]

    raw = json.dumps(req_body).encode("utf-8")

    req = urllib.request.Request(profile["upstream"], data=raw, headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=int(profile.get("timeout", TIMEOUT))) as r:
            body = r.read().decode("utf-8", "replace")
        return body, round((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        STATS["errors"] += 1
        return json.dumps({"jsonrpc": "2.0", "error": {
            "code": -32000, "message": "Upstream HTTP error",
            "data": f"{e.code} {e.reason}"}, "id": 1}), round((time.time() - t0) * 1000)
    except Exception as e:  # noqa: BLE001
        STATS["errors"] += 1
        return json.dumps({"jsonrpc": "2.0", "error": {
            "code": -32000, "message": "Upstream unreachable", "data": str(e)}, "id": 1}), 0


VERSIONS = {}     # profile_id -> (version_str, major_int)


def _version(profile):
    """取上游版本号并缓存。用于决定 login 参数名等版本差异。"""
    pid = profile["id"]
    with LOCK:
        v = VERSIONS.get(pid)
    if v:
        return v
    body, _ = _post(profile, "apiinfo.version", {})
    try:
        ver = str(json.loads(body).get("result") or "")
    except Exception:
        ver = ""
    try:
        major = int((ver.split(".") or ["0"])[0])
    except Exception:
        major = 0
    with LOCK:
        VERSIONS[pid] = (ver, major)
    return ver, major


def _login(profile):
    """4.0–6.x 专用：用只读账号换 sessionid。仅认证，不修改监控数据。

    参数名随版本变化：<=5.2 用 user，5.4+ 用 username。
    这里按 apiinfo.version 精确选择，**失败一次就返回**——
    盲目回退会多消耗一次失败计数，反而加速账号锁定。
    """
    user = profile.get("user", "")
    pwd = profile.get("password", "")
    ver, major = _version(profile)
    # 5.4 起把 login 参数从 user 改成 username（5.4 / 5.5 / 6.x 都属于后者）
    try:
        minor = int(ver.split(".")[1])
    except Exception:
        minor = 0
    need_username = major > 5 or (major == 5 and minor >= 4)
    field = "username" if need_username else "user"

    body, ms = _post(profile, "user.login", {field: user, "password": pwd})
    try:
        d = json.loads(body)
    except Exception:
        d = {}
    sid = d.get("result")
    if not sid:
        err = d.get("error") or {}
        detail = str(err.get("data") or err.get("message") or d)
        hint = ""
        low = detail.lower()
        if "blocked" in low or "incorrect" in low or "incorrectly" in low:
            hint = ("；请确认该实例上 %s 的密码，或解除临时锁定"
                    "（连续失败会锁 30 秒，可先用 Web 登录一次确认账号可用）" % user)
        raise RuntimeError(
            "%s 登录失败（%s，参数名 %s）：%s%s" % (ver or "未知版本", profile["id"], field, detail, hint))
    with LOCK:
        SESSIONS[profile["id"]] = {"sid": sid, "ts": time.time()}
    STATS["auth"] += 1
    audit({"ts": int(time.time()), "profile": profile["id"], "method": "user.login",
           "ms": ms, "count": 1, "ctype": "auth",
           "note": "%s 会话认证，非数据写入" % (ver or "legacy")})
    return sid


def _session(profile, force=False):
    with LOCK:
        s = SESSIONS.get(profile["id"])
    if force or not s or time.time() - s["ts"] > 600:
        return _login(profile)
    return s["sid"]


def _needs_reauth(body):
    try:
        e = json.loads(body).get("error") or {}
    except Exception:
        return False
    msg = (str(e.get("message", "")) + " " + str(e.get("data", ""))).lower()
    return ("session terminated" in msg or "re-login" in msg
            or "not authorised" in msg or "not authorized" in msg)


def forward(profile, method, params):
    """转发只读请求；4.0 会话失效时自动重登并重试一次。"""
    if profile.get("auth") != "login" or method == "apiinfo.version":
        return _post(profile, method, params)

    sid = _session(profile)
    body, ms = _post(profile, method, params, sid=sid)
    if _needs_reauth(body):
        sid = _session(profile, force=True)
        body, ms = _post(profile, method, params, sid=sid)
    return body, ms


def public_profile(p):
    return {
        "id": p["id"],
        "label": p.get("label", p["id"]),
        "upstream": p["upstream"],
        "auth": p.get("auth", "token"),
        "has_credentials": bool(p.get("token") or (p.get("user") and p.get("password"))),
    }


class Handler(SimpleHTTPRequestHandler):
    server_version = "zbx-ro-proxy/2.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PUBLIC, **kw)

    # ---- 统一响应 ----
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Zbx-Profile")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _profile(self):
        pid = (self.headers.get("X-Zbx-Profile") or "").strip()
        return PROFILES.get(pid) or PROFILES[ACTIVE]

    # ---- 访问控制（P0-1）：所有 HTTP 入口统一过闸 ----
    def _guard(self):
        if ACCESS_MODE == "off":
            return True
        if self.path.split("?")[0] in ACCESS_PUBLIC:
            return True
        raw = self.headers.get("Authorization") or ""
        if raw.startswith("Basic "):
            try:
                decoded = base64.b64decode(raw[6:].strip()).decode("utf-8")
                user, _, pwd = decoded.partition(":")
                if (hmac.compare_digest(user, ACCESS_USER)
                        and hmac.compare_digest(pwd, ACCESS_PASS)):
                    return True
            except Exception:
                pass
        body = ("<!doctype html><meta charset=utf-8><title>401</title>"
                "<p style='font:14px system-ui;padding:24px'>需要认证才能访问该控制台。"
                "请在浏览器弹出的登录框中输入账号密码。</p>")
        raw = body.encode("utf-8")
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Zabbix Console", charset="UTF-8"')
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)
        return False

    def do_OPTIONS(self):  # noqa: N802
        if not self._guard():
            return
        self._send(204, b"")

    def do_HEAD(self):  # noqa: N802
        if not self._guard():
            return
        return super().do_HEAD()

    def do_GET(self):  # noqa: N802
        if not self._guard():
            return
        path = self.path.split("?")[0]

        if path == "/api/meta":
            p = self._profile()
            return self._send(200, {
                "upstream": p["upstream"],
                "profile": p["id"],
                "profiles": [public_profile(x) for x in PROFILES.values()],
                "mode": "read-only",
                "allowed_methods": sorted(READ_ONLY),
                "blocked_count": STATS["blocked"],
                "forwarded_count": STATS["forwarded"],
                "auth_count": STATS["auth"],
                "access_mode": ACCESS_MODE,
                "audit_rotate": {"max_bytes": ROTATE_MAX_BYTES, "max_files": ROTATE_MAX_FILES},
                "blocked": BLOCKED[-20:],
                "server_time": int(time.time()),
            })

        if path == "/api/log":
            return self._send(200, {"log": LOG[-200:]})

        if path == "/api/ping":
            return self._send(200, {"ok": True})

        # 静态文件，禁止目录穿越
        if path == "/":
            self.path = "/index.html"
        if ".." in self.path:
            return self._send(403, {"error": "forbidden"})
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        if not self._guard():
            return
        path = self.path.split("?")[0]
        if path != "/api_jsonrpc.php":
            return self._send(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw.decode("utf-8"))
            method = req.get("method", "")
            params = req.get("params", {})
        except Exception:
            return self._send(400, {"jsonrpc": "2.0", "error": {
                "code": -32700, "message": "Parse error"}, "id": None})

        # ---- 只读闸门 ----
        if method not in READ_ONLY:
            STATS["blocked"] += 1
            entry = {"ts": int(time.time()), "method": method, "blocked": True,
                     "reason": "not in read-only allowlist"}
            BLOCKED.append(entry)
            audit(entry)
            return self._send(200, {"jsonrpc": "2.0", "error": {
                "code": -32601,
                "message": "Blocked by read-only proxy",
                "data": f"方法 {method} 不在只读白名单内，请求未发送到 Zabbix"},
                "id": req.get("id")})

        profile = self._profile()
        try:
            body, ms = forward(profile, method, params)
        except Exception as e:  # noqa: BLE001
            # 认证/网络类失败也按 JSON-RPC 错误返回，前端能显示原因而不是白屏
            STATS["errors"] += 1
            audit({"ts": int(time.time()), "profile": profile["id"], "method": method,
                   "ms": 0, "ok": False, "err": str(e)[:300]})
            return self._send(200, {"jsonrpc": "2.0", "error": {
                "code": -32000, "message": "Proxy error", "data": str(e)},
                "id": req.get("id")})
        STATS["forwarded"] += 1

        # 统计返回条数，供调用链展示
        count = None
        ctype = None
        try:
            d = json.loads(body)
            res = d.get("result")
            if isinstance(res, list):
                count = len(res)
                ctype = "rows"
            elif isinstance(res, bool):
                count = int(res)
                ctype = "value"
            elif isinstance(res, (int, float)) or (isinstance(res, str) and res.isdigit()):
                count = res
                ctype = "value"
            elif res is not None:
                count = 1
                ctype = "rows"
        except Exception:
            pass

        audit({"ts": int(time.time()), "profile": profile["id"], "method": method,
               "ms": ms, "count": count, "ctype": ctype,
               "params_keys": sorted(params.keys()) if isinstance(params, dict) else []})

        return self._send(200, body)

    def log_message(self, fmt, *args):  # 静默访问日志
        return


if __name__ == "__main__":
    if not os.path.isdir(PUBLIC):
        sys.exit(f"缺少目录：{PUBLIC}")
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"只读代理已启动  http://{BIND}:{PORT}/")
    for p in PROFILES.values():
        print(f"  实例 {p['id']:<10} {p.get('label', ''):<12} {p['upstream']}  认证={p.get('auth')}")
    print(f"只读白名单      {len(READ_ONLY)} 个方法，写操作在本地拒绝")
    print(f"访问控制        {ACCESS_MODE}" +
          (f"（免认证路径 {sorted(ACCESS_PUBLIC)}）" if ACCESS_MODE != "off" else "（未启用）"))
    print(f"审计轮转        {ROTATE_MAX_BYTES // 1024 // 1024} MB × {ROTATE_MAX_FILES} 份")
    print(f"审计日志        {AUDIT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
