#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
水晶手串 DIY —— 订单服务（零依赖，Python 标准库）

职责只有三件事：
  1. 收客户订单（POST /api/orders，公开）
  2. 管理员登录发令牌（POST /api/login）
  3. 管理员查/归档/删除（需 Bearer 令牌）

刻意不做的事：不做用户体系、不做支付、不做图片上传。
数据落 SQLite，文件 /var/lib/bracelet/orders.db，权限 600。
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
from contextlib import contextmanager
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("BRACELET_DB", "/var/lib/bracelet/orders.db")
HOST = "127.0.0.1"
PORT = int(os.environ.get("BRACELET_PORT", "41890"))
SECRET_PATH = os.environ.get("BRACELET_SECRET", "/var/lib/bracelet/.secret")

# 仓库是公开的，默认值必须是占位符；真实账号密码走环境变量注入。
ADMIN_USER = os.environ.get("BRACELET_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("BRACELET_ADMIN_PASS", "change-me")
if ADMIN_USER == "admin" and ADMIN_PASS == "change-me":
    print("[warn] 正在使用默认账号密码，请用 BRACELET_ADMIN_USER / "
          "BRACELET_ADMIN_PASS 环境变量覆盖", flush=True)
TOKEN_TTL = 12 * 3600           # 令牌 12 小时
MAX_BODY = 96 * 1024            # 单请求上限 96KB
MAX_ORDERS = 5000               # 防无限增长，超出时拒绝写入并提示清理

# 本地联调时可指向静态目录，让同一个进程同时服务页面与接口；
# 生产环境走 Caddy file_server，此处留空。
STATIC_DIR = os.environ.get("BRACELET_STATIC", "")
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
}

# 与前端 bracelet-core.js 的 BEADS 白名单保持一致
BEAD_IDS = {"w", "pk", "ro", "am", "te", "ye", "ls", "nv", "gr", "rd", "bk", "pe",
            "s7", "mo", "aq", "lb", "pr", "ga"}
ACC_IDS = {"ag", "as", "ad", "ap", "af", "ab"}
ALL_IDS = BEAD_IDS | ACC_IDS
BEAD_SIZES = (8, 10, 12, 14)
# 配件不是按珠径卖的，各自固定厚度
ACC_SIZE = {"ag": 6, "as": 6, "ad": 4, "ap": 4, "af": 8, "ab": 8}
# 搜索时要能把中文珠材名也匹配上，否则店主搜「黑曜石」一条都搜不到
BEAD_NAMES = {
    "w": "白水晶", "pk": "草莓晶", "ro": "粉晶", "am": "紫水晶", "te": "茶晶",
    "ye": "黄水晶", "ls": "青金石", "nv": "藏青", "gr": "绿幽灵",
    "rd": "红玛瑙", "bk": "黑曜石", "pe": "珍珠",
    # 2026 热度第一批（之前漏加映射，店主搜不到，一并补上）
    "s7": "超七", "mo": "月光石", "aq": "海蓝宝", "lb": "拉长石",
    "pr": "葡萄石", "ga": "石榴石",
    # 2026-10-19 热度第二批
    "ru": "金发晶", "sn": "雪花幽灵", "ht": "黄塔晶",
    "su": "舒俱来", "tt": "兔毛水晶", "bx": "碧玺",
    # 配件
    "ag": "金隔珠", "as": "银隔珠", "ad": "银隔片",
    "ap": "珍珠隔片", "af": "花托", "ab": "中空桶珠",
}
SIZES = {8, 10, 12, 14}

# 简易速率限制：同一 IP 每分钟最多 N 次写操作
RATE_MAX = 20
RATE_WINDOW = 60
_rate = {}


def now_ms():
    return int(time.time() * 1000)


def _eq(a, b):
    """定时安全比较，兼容非 ASCII（中文账号）。"""
    return hmac.compare_digest(str(a).encode("utf-8"), str(b).encode("utf-8"))


def load_secret():
    os.makedirs(os.path.dirname(SECRET_PATH), exist_ok=True)
    if os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, "rb") as f:
            return f.read()
    s = secrets.token_bytes(32)
    fd = os.open(SECRET_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(s)
    return s


SECRET = load_secret()


@contextmanager
def db():
    """每次请求用完即关，避免守护进程长期持有 fd。"""
    conn = sqlite3.connect(DB_PATH, timeout=8)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS orders (
                id         TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                payload    TEXT NOT NULL,
                status     TEXT NOT NULL DEFAULT 'pending',
                archived_at INTEGER
            )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_created ON orders(created_at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_status ON orders(status)")
        # phone 单独成列：顾客「我的订单」按手机号查，靠 LIKE 匹配 JSON 太脆
        cols = [r[1] for r in c.execute("PRAGMA table_info(orders)").fetchall()]
        if "phone" not in cols:
            c.execute("ALTER TABLE orders ADD COLUMN phone TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS idx_phone ON orders(phone)")
        # 珠材上下架（SKU 级）：key 是「材质:尺寸」，缺省即上架
        c.execute("""CREATE TABLE IF NOT EXISTS catalog_sku (
                        sku TEXT PRIMARY KEY,
                        enabled INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    )""")


def make_token(user):
    exp = int(time.time()) + TOKEN_TTL
    body = "%s|%d" % (user, exp)
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
    raw = "%s|%s" % (body, sig)
    return base64.urlsafe_b64encode(raw.encode()).decode()


def check_token(tok):
    try:
        raw = base64.urlsafe_b64decode(tok.encode()).decode()
        user, exp, sig = raw.rsplit("|", 2)
        if int(exp) < time.time():
            return None
        body = "%s|%s" % (user, exp)
        want = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, want):
            return None
        return user
    except Exception:
        return None


def new_order_id():
    # BR + 日期 + 时分 + 4 位随机，店主口头报单也能对得上
    t = time.localtime()
    return "BR%s%02d%02d-%s" % (
        time.strftime("%Y%m%d", t), t.tm_hour, t.tm_min,
        secrets.token_hex(2).upper(),
    )


def validate_order(d):
    """只接受结构合法的订单，任何一个字段不对就整单拒绝。"""
    if not isinstance(d, dict):
        return None, "订单格式不对"

    seq = d.get("seq")
    if not isinstance(seq, list) or not (1 <= len(seq) <= 60):
        return None, "珠子数量需在 1–60 颗之间"

    clean_seq = []
    for b in seq:
        if not isinstance(b, dict):
            return None, "珠子数据格式不对"
        bid, bd = b.get("id"), b.get("d")
        if bid not in BEAD_IDS:
            return None, "未知珠材：%s" % bid
        if bd not in SIZES:
            return None, "珠径不在可选档位：%s" % bd
        clean_seq.append({"id": bid, "d": bd})

    def num(k, lo, hi, default=None):
        v = d.get(k, default)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return None
        v = int(round(v))
        return v if lo <= v <= hi else None

    wrist = num("wrist", 120, 240)
    total = num("total", 0, 20000)
    if wrist is None or total is None:
        return None, "尺寸或金额超出范围"

    cord = d.get("cord") if d.get("cord") in ("elastic", "wax") else "elastic"
    ease = num("ease", 0, 30, 12) or 12

    def text(k, maxlen):
        v = d.get(k, "")
        if not isinstance(v, str):
            return ""
        v = v.strip().replace("\n", " ")[:maxlen]
        return v

    phone = text("phone", 20)
    if not re.fullmatch(r"1\d{10}", phone):
        return None, "请填写 11 位手机号，店主才能联系到你"

    return {
        "seq": clean_seq,
        "wrist": wrist,
        "ease": ease,
        "cord": cord,
        "total": total,
        "beads": num("beads", 0, 20000, 0) or 0,
        "fee": num("fee", 0, 200, 0) or 0,
        "stretch": num("stretch", 0, 200, 0) or 0,
        "name": text("name", 24),
        "phone": phone,
        "note": text("note", 120),
    }, None


def row_to_order(r):
    try:
        payload = json.loads(r["payload"])
    except Exception:
        payload = {}
    out = {"id": r["id"], "createdAt": r["created_at"], "status": r["status"]}
    out.update(payload)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "BraceletOrder/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, obj=None, raw=None, ctype="application/json; charset=utf-8"):
        body = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, {"ok": False, "error": msg})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return None

    def _token(self):
        h = self.headers.get("Authorization") or ""
        if h.startswith("Bearer "):
            return check_token(h[7:].strip())
        return None

    def _rate_ok(self, key):
        t = time.time()
        bucket = [x for x in _rate.get(key, []) if t - x < RATE_WINDOW]
        if len(bucket) >= RATE_MAX:
            _rate[key] = bucket
            return False
        bucket.append(t)
        _rate[key] = bucket
        return True

    # ---------- 路由 ----------
    def _serve_static(self, path):
        """仅本地联调使用；生产由 Caddy file_server 承担。"""
        if not STATIC_DIR:
            return self._err(404, "not found")
        rel = path.lstrip("/") or "index.html"
        if ".." in rel:
            return self._err(403, "forbidden")
        full = os.path.join(STATIC_DIR, rel)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
            if not os.path.isfile(full):
                return self._err(404, "not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/") or "/"

        if not path.startswith("/api/"):
            return self._serve_static(path)

        if path == "/api/health":
            return self._send(200, {"ok": True, "service": "bracelet-order"})

        if path == "/api/catalog":
            # 公开：客人端要据此过滤菜单，外泄的只是「哪些没货」，无所谓
            try:
                with db() as c:
                    off = [r[0] for r in c.execute(
                        "SELECT sku FROM catalog_sku WHERE enabled=0").fetchall()]
                return self._send(200, {"ok": True, "off": off})
            except Exception as e:
                import traceback
                traceback.print_exc()
                return self._err(500, "读取失败，请稍后再试")

        if path == "/api/orders":
            if not self._token():
                return self._err(401, "未登录或登录已过期")
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = {}
            for kv in qs.split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    params[k] = v
            import urllib.parse
            q = urllib.parse.unquote_plus(params.get("q", "")).strip()
            status = params.get("status", "all")
            rng = params.get("range", "all")

            sql = "SELECT * FROM orders"
            where, args = [], []
            if status in ("pending", "archived"):
                where.append("status = ?")
                args.append(status)
            if rng in ("today", "7d", "30d"):
                span = {"today": 86400, "7d": 7 * 86400, "30d": 30 * 86400}[rng]
                if rng == "today":
                    lt = time.localtime()
                    start = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)
                else:
                    start = now_ms() - span * 1000
                where.append("created_at >= ?")
                args.append(start)
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY created_at DESC LIMIT 500"

            with db() as c:
                rows = [row_to_order(r) for r in c.execute(sql, args).fetchall()]
            if q:
                ql = q.lower()
                rows = [o for o in rows if ql in o["id"].lower()
                        or ql in str(o.get("name", "")).lower()
                        or ql in str(o.get("phone", "")).lower()
                        or ql in str(o.get("note", "")).lower()
                        or any(ql in str(b.get("id", ""))
                               or ql in BEAD_NAMES.get(b.get("id"), "")
                               for b in o.get("seq", []))]
            stats = {"total": len(rows),
                     "pending": sum(1 for o in rows if o["status"] == "pending"),
                     "archived": sum(1 for o in rows if o["status"] == "archived")}
            return self._send(200, {"ok": True, "orders": rows, "stats": stats})

        return self._err(404, "not found")

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")

        if path == "/api/login":
            if not self._rate_ok("login:" + self.client_address[0]):
                return self._err(429, "尝试过于频繁，请稍后再试")
            d = self._body() or {}
            u = str(d.get("user", "")).strip()
            p = str(d.get("pass", ""))
            # compare_digest 只吃纯 ASCII str，中文账号必须先编成 bytes
            if _eq(u, ADMIN_USER) and _eq(p, ADMIN_PASS):
                return self._send(200, {"ok": True, "token": make_token(u), "user": u})
            return self._err(401, "账号或密码不正确")

        if path == "/api/catalog":
            if not self._token():
                return self._err(401, "未登录或登录已过期")
            d = self._body() or {}
            bid = str(d.get("id", ""))
            if bid not in ALL_IDS:
                return self._err(400, "未知珠材")
            try:
                size = int(d.get("d", 0))
            except (TypeError, ValueError):
                return self._err(400, "尺寸不对")

            # 珠子只卖 8/10/12/14；配件固定厚度，不接受别的尺寸
            if bid in ACC_IDS:
                if size != ACC_SIZE.get(bid):
                    return self._err(400, "配件尺寸固定")
            elif size not in BEAD_SIZES:
                return self._err(400, "珠径只能是 8/10/12/14")

            key = "%s:%d" % (bid, size)
            enabled = 1 if d.get("enabled") else 0
            with db() as c:
                c.execute("INSERT INTO catalog_sku(sku, enabled, updated_at) VALUES(?,?,?) "
                          "ON CONFLICT(sku) DO UPDATE SET enabled=excluded.enabled, "
                          "updated_at=excluded.updated_at",
                          (key, enabled, int(time.time() * 1000)))
            return self._send(200, {"ok": True, "sku": key, "enabled": bool(enabled)})

        if path == "/api/my-orders":
            # 顾客按手机号查自己的订单。手机号即凭证——小店场景够用，
            # 但必须限流，否则等于开放订单库给枚举。
            if not self._rate_ok("my:" + self.client_address[0]):
                return self._err(429, "查询过于频繁，请稍后再试")
            d = self._body() or {}
            phone = str(d.get("phone", "")).strip()
            if not re.fullmatch(r"1\d{10}", phone):
                return self._err(400, "请填写 11 位手机号")
            with db() as c:
                rows = [row_to_order(r) for r in
                        c.execute("SELECT * FROM orders WHERE phone=? ORDER BY created_at DESC LIMIT 100",
                                  (phone,)).fetchall()]
            return self._send(200, {"ok": True, "orders": rows})

        if path == "/api/orders":
            if not self._rate_ok("order:" + self.client_address[0]):
                return self._err(429, "提交过于频繁，请稍后再试")
            clean, err = validate_order(self._body())
            if err:
                return self._err(400, err)
            with db() as c:
                n = c.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
                if n >= MAX_ORDERS:
                    return self._err(507, "订单库已满，请先在后台归档或清理")
                oid = new_order_id()
                ts = now_ms()
                c.execute("INSERT INTO orders(id, created_at, payload, status, phone) VALUES(?,?,?,?,?)",
                          (oid, ts, json.dumps(clean, ensure_ascii=False), "pending", clean["phone"]))
            return self._send(200, {"ok": True, "id": oid, "createdAt": ts})

        m = re.match(r"^/api/orders/([A-Za-z0-9\-]+)/(archive|restore)$", path)
        if m:
            if not self._token():
                return self._err(401, "未登录或登录已过期")
            oid, act = m.group(1), m.group(2)
            with db() as c:
                if act == "archive":
                    cur = c.execute("UPDATE orders SET status='archived', archived_at=? WHERE id=?",
                                    (now_ms(), oid))
                else:
                    cur = c.execute("UPDATE orders SET status='pending', archived_at=NULL WHERE id=?",
                                    (oid,))
            if cur.rowcount == 0:
                return self._err(404, "订单不存在")
            return self._send(200, {"ok": True})

        return self._err(404, "not found")

    def do_DELETE(self):
        m = re.match(r"^/api/orders/([A-Za-z0-9\-]+)$", self.path.split("?")[0].rstrip("/"))
        if not m:
            return self._err(404, "not found")
        if not self._token():
            return self._err(401, "未登录或登录已过期")
        with db() as c:
            cur = c.execute("DELETE FROM orders WHERE id=?", (m.group(1),))
        if cur.rowcount == 0:
            return self._err(404, "订单不存在")
        return self._send(200, {"ok": True})


def main():
    init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    sys.stderr.write("bracelet-order listening on %s:%d\n" % (HOST, PORT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
