/* Zabbix 控制台前端逻辑 · v4
   零构建、单 IIFE、共享闭包状态 S。
   模块顺序：基础设施 → 格式化 → 启动取数 → 问题页 → 主机页 → 主机详情 → 图形页 → 拓扑页 → 接口页 → 抽屉 → 路由 → 事件绑定。
*/
(function () {
"use strict";

/* ================= 基础设施 ================= */
var API = "/api_jsonrpc.php";
var RID = 1;
var CHAIN = [];
var PROFILE = "";
try { PROFILE = localStorage.getItem("zbx.profile") || ""; } catch (e) {}

/* 版本能力矩阵：页面只读 CAPS，不直接判断版本号 */
var CAPS = {
  version: "", major: 0,
  groupField: "groups", groupSelect: "selectGroups",
  availabilityFrom: "interfaces", mapNode: "elementid",
  problemHostids: true, inventory: true, tags: true,
  trendWindow: true
};
function buildCaps(v) {
  var major = parseInt(String(v || "0").split(".")[0], 10) || 0;
  CAPS.version = String(v || "");
  CAPS.major = major;
  if (major >= 7) {
    CAPS.groupField = "hostgroups";
    CAPS.groupSelect = "selectHostGroups";
    CAPS.mapNode = "elements";
  } else {
    CAPS.groupField = "groups";
    CAPS.groupSelect = "selectGroups";
    CAPS.mapNode = "elementid";
  }
  /* 4.x 的 problem.get 对 hostids 支持不稳定：不冒险，直接走 trigger → problem */
  CAPS.problemHostids = major >= 6;
  CAPS.inventory = major >= 4;
  CAPS.tags = major >= 4;
  return CAPS;
}

var S = {
  meta: null, version: "", profiles: [], hosts: [], hostById: {}, groups: [],
  problems: [], rows: [], triggers: {}, netErr: null,
  alerts: { total: 0, failed: 0, sent: 0, samples: [] },
  media: {}, events14: [], bars: [],
  graph: {
    hostsLoaded: false, hostid: null, graphs: [], items: [], mode: "graphs",
    range: "24h", customFrom: null, customTo: null, curGraph: null, curItems: [],
    chart: null, hostQ: "", listQ: "", loading: false, pendingGraphid: null, pendingItem: null,
    selItems: [], peerMap: {}, onlyData: false, lastFallback: null, pendingItems: null
  },
  topo: {
    loaded: false, map: null, maps: [], linkStatus: {}, lldp: null,
    mode: "auto", model: null, plan: null, sel: null, pending: null,
    linking: false, deleting: false, group: "net", onlyProb: false,
    zoom: null, drag: null
  },
  filt: { sev: "all", group: "all", q: "", long: false, unreach: false, sort: "sev", dir: -1 },
  hostFilt: { kind: "all", q: "", groups: [], sort: "prob", dir: -1 },
  hd: { hostid: null, data: null, page: 0, q: "", filter: "all", items: [], lastData: {}, health: {}, probed: false }
};

function $(id) { return document.getElementById(id); }
function h(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

window.onerror = function (msg, src, line) {
  var el = $("jsErr");
  el.style.display = "block";
  el.textContent = "JS 错误: " + msg + "  @" + line;
};

function toast(msg) {
  var t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.classList.remove("on"); }, 2600);
}

/* ================= 统一错误态（P0-3） =================
   上游不可达 / 凭据失效 / 代理要求认证时，给出明确的错误卡片而不是空白页。
   只有两处会显示：启动链失败（boot 的 catch）与运行时 401。
   成功加载后由 clearGlobalError() 收起，切到另一个实例会重新 boot。 */
function showGlobalError(title, detail, method) {
  var el = $("globalErr");
  if (!el) return;
  var meta = "实例 " + (PROFILE || "—") +
    (S.version ? " · Zabbix " + S.version : "") +
    (method ? " · 失败方法 " + method : "");
  el.innerHTML =
    '<div class="ge-ic">⚠</div>' +
    '<div class="ge-body"><b>' + h(title) + '</b>' +
      '<div class="ge-meta">' + h(meta) + '</div>' +
      '<div class="ge-detail">' + h(detail) + '</div></div>' +
    '<div class="ge-act">' +
      '<button class="btn2" id="geRetry">重新加载</button>' +
      '<button class="btn2" id="geClose">关闭</button></div>';
  el.hidden = false;
  $("geRetry").onclick = function () { location.reload(); };
  $("geClose").onclick = function () { el.hidden = true; };
}
function clearGlobalError() {
  var el = $("globalErr");
  if (el) el.hidden = true;
}
function noteRpcFailure(method, e) {
  S.netErr = { method: method, message: e.message, at: Date.now(), auth: !!e.auth };
  if (e.auth) {
    showGlobalError("认证失效，无法加载数据",
      "代理要求认证或登录状态已失效。刷新页面后在浏览器登录框输入账号密码即可恢复；" +
      "若不想每次认证，可由管理员把 access.mode 设为 off。", method);
  }
}

function rpc(method, params) {
  var id = RID++;
  var t0 = performance.now();
  var hdrs = { "Content-Type": "application/json-rpc" };
  if (PROFILE) hdrs["X-Zbx-Profile"] = PROFILE;
  return fetch(API, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ jsonrpc: "2.0", method: method, params: params || {}, id: id })
  }).then(function (r) {
    if (r.status === 401) {
      var e = new Error("需要认证（HTTP 401），请刷新页面重新登录");
      e.auth = true;
      throw e;
    }
    if (!r.ok) throw new Error("代理返回 HTTP " + r.status);
    return r.json();
  }).then(function (d) {
    var ms = Math.round(performance.now() - t0);
    if (d.error) throw new Error(method + ": " + (d.error.data || d.error.message));
    var n = Array.isArray(d.result) ? d.result.length : (typeof d.result === "string" ? "=" + d.result : "");
    CHAIN.push({ method: method, ms: ms, ok: true, count: n });
    return d.result;
  }).catch(function (e) {
    var ms = Math.round(performance.now() - t0);
    CHAIN.push({ method: method, ms: ms, ok: false, err: e.message });
    noteRpcFailure(method, e);
    throw e;
  });
}

/* ================= 格式化 ================= */
var SEV = [
  { n: "未分类", c: "#97AAB3" }, { n: "信息", c: "#7499FF" }, { n: "警告", c: "#FFC859" },
  { n: "一般", c: "#FFA059" }, { n: "严重", c: "#E97659" }, { n: "灾难", c: "#E45959" }
];
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function fmtTime(sec) {
  if (!sec || sec === "0") return "—";
  var d = new Date(num(sec) * 1000);
  return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function fmtClock(sec) {
  var d = new Date(num(sec) * 1000);
  return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) {
    var hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60);
    return mm ? hh + "h " + mm + "m" : hh + "h";
  }
  var dd = Math.floor(sec / 86400), rh = Math.floor(sec % 86400 / 3600);
  return dd + "d " + rh + "h";
}
function fmtBps(v) {
  var n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " Gbps";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " Mbps";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " Kbps";
  return n.toFixed(0) + " bps";
}
function splitBps(v) {
  var s = fmtBps(v).split(" ");
  return [s[0], s[1]];
}
function statBps(v) {
  var p = splitBps(v);
  return p[0] + (p[1] ? "<small>" + p[1] + "</small>" : "");
}

/* ================= 顶栏 ================= */
var LAST_REFRESH = null;
function setConn(ok, msg) {
  var p = $("connPill");
  p.innerHTML = '<i class="dot ' + (ok ? "ok" : "err") + '"></i><span>' + h(msg) + "</span>";
}

/* ================= 启动取数 ================= */
function profileById(id) {
  var list = S.profiles || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return list[0] || {};
}
function profileLabel(id) { return profileById(id).label || id || "—"; }
function hostOf(id) {
  var u = String(profileById(id).upstream || (S.meta && S.meta.upstream) || "");
  return u.replace(/^https?:\/\//, "").split("/")[0];
}
function renderProfiles() {
  var sel = $("profileSel");
  sel.innerHTML = (S.profiles || []).map(function (p) {
    return '<option value="' + h(p.id) + '">' + h(p.label) + (p.auth === "login" ? " · 账号" : "") + "</option>";
  }).join("");
  sel.value = PROFILE;
  sel.onchange = function () {
    PROFILE = this.value;
    try { localStorage.setItem("zbx.profile", PROFILE); } catch (e) {}
    S.topo.loaded = false;
    S.graph.hostsLoaded = false;
    S.graph.hostid = null;
    boot();
  };
}

function boot() {
  var btn = $("refreshBtn");
  btn.classList.add("spin");
  CHAIN = [];

  var qsp = new URLSearchParams(location.search);
  if (qsp.get("profile")) {
    PROFILE = qsp.get("profile");
    try { localStorage.setItem("zbx.profile", PROFILE); } catch (e) {}
  }
  if (qsp.get("range") && GRAPH_RANGES[qsp.get("range")]) S.graph.range = qsp.get("range");
  if (qsp.get("from")) {
    var qf = toEpoch(qsp.get("from"));
    if (qf) {
      S.graph.customFrom = qf;
      S.graph.customTo = toEpoch(qsp.get("to")) || Math.floor(Date.now() / 1000);
      S.graph.range = "custom";
    }
  }

  return fetch("/api/meta", { headers: PROFILE ? { "X-Zbx-Profile": PROFILE } : {} })
    .then(function (r) {
      if (r.status === 401) {
        var e = new Error("需要认证（HTTP 401），请刷新页面重新登录");
        e.auth = true;
        throw e;
      }
      return r.json();
    }).then(function (meta) {
    S.meta = meta;
    S.profiles = meta.profiles || [];
    if (!PROFILE || !S.profiles.some(function (p) { return p.id === PROFILE; })) {
      PROFILE = meta.profile || (S.profiles[0] || {}).id || "";
      try { localStorage.setItem("zbx.profile", PROFILE); } catch (e) {}
    }
    renderProfiles();
    $("envApi").textContent = profileById(PROFILE).upstream || meta.upstream;
    $("roMode").textContent = meta.mode;
    $("roCount").textContent = meta.allowed_methods.length;
    $("roBlocked").textContent = meta.blocked_count;
    $("roForward").textContent = meta.forwarded_count;
    $("wlCount").textContent = meta.allowed_methods.length + " 个";
    $("wlBody").innerHTML = meta.allowed_methods.map(function (m) {
      return '<span style="font-family:var(--mono);font-size:10px;padding:1.5px 6px;border-radius:4px;background:#fff;border:1px solid #E3E9EF;color:#5E7488">' +
        h(m) + "</span>";
    }).join("");
    renderLog();

    return rpc("apiinfo.version", {});
  }).then(function (ver) {
    buildCaps(ver);
    S.version = String(ver);
    $("envVer").textContent = S.version + " · " + profileLabel(PROFILE);
    $("envLine").textContent = "Zabbix " + S.version + " · " + profileLabel(PROFILE) + " · 只读实时数据";
    var vp = $("verPill");
    vp.textContent = "v" + S.version;
    vp.className = "pill ver" + (CAPS.major >= 7 ? "" : " warn");
    setConn(true, "已连接 " + hostOf(PROFILE));
    return loadCore();
  }).then(function () {
    clearGlobalError();
    renderAll();
    LAST_REFRESH = new Date();
    $("lastRefresh").textContent = "刷新于 " + pad2(LAST_REFRESH.getHours()) + ":" + pad2(LAST_REFRESH.getMinutes()) + ":" + pad2(LAST_REFRESH.getSeconds());
    $("envRefresh").textContent = LAST_REFRESH.toLocaleTimeString("zh-CN");
    btn.classList.remove("spin");
    applyRoute();
    var qs = new URLSearchParams(location.search);
    if (qs.get("event")) setTimeout(function () { showProblemDrawer(qs.get("event")); }, 200);
    /* 本次加载已经发了一批请求，回读一次计数，避免显示启动时的旧值 */
    setTimeout(refreshMeta, 400);
  }).catch(function (e) {
    btn.classList.remove("spin");
    setConn(false, e.auth ? "认证失效" : "连接失败");
    $("envLine").textContent = "取数失败：" + e.message;
    var detail = e.auth
      ? "代理要求认证，或登录状态已失效。刷新页面并在浏览器登录框输入账号密码后即可恢复；" +
        "若不想每次认证，可由管理员关闭访问控制。"
      : "无法从当前实例取得数据。可能是上游 Zabbix 不可达、凭据失效或账号权限不足。" +
        "可切换顶栏的其他实例，或稍后重试。";
    showGlobalError(e.auth ? "认证失效，无法加载数据" : "无法加载监控数据",
      detail, (S.netErr && S.netErr.method) || "");
    toast("取数失败：" + e.message);
    console.error(e);
  });
}

function hostGetParams(extra) {
  var p = {
    output: ["hostid", "host", "name", "status", "maintenance_status"],
    selectInterfaces: ["interfaceid", "type", "available", "ip", "dns", "port", "error", "main"],
    selectParentTemplates: ["templateid", "name"],
    limit: 500
  };
  p[CAPS.groupSelect] = ["groupid", "name"];
  if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
  return p;
}

function loadCore() {
  return Promise.all([
    rpc("host.get", hostGetParams()),
    rpc("problem.get", {
      output: "extend", selectTags: "extend", selectAcknowledges: "extend",
      sortfield: ["eventid"], sortorder: "DESC", limit: 500
    }),
    rpc("alert.get", { output: ["alertid"], countOutput: true }),
    rpc("alert.get", { output: ["alertid"], countOutput: true, filter: { status: 2 } }),
    rpc("alert.get", { output: ["alertid"], countOutput: true, filter: { status: 1 } }),
    rpc("alert.get", {
      output: ["alertid", "clock", "status", "error", "mediatypeid", "sendto", "eventid"],
      sortfield: ["clock"], sortorder: "DESC", limit: 40
    }),
    rpc("mediatype.get", { output: ["mediatypeid", "name", "type", "status"], limit: 200 }),
    rpc("event.get", {
      output: ["eventid", "clock", "severity"], time_from: Math.floor(Date.now() / 1000) - 14 * 86400,
      source: 0, limit: 5000
    })
  ]).then(function (r) {
    S.hosts = r[0] || [];
    S.hostById = {};
    S.hosts.forEach(function (x) {
      /* 4.0 返回 groups，7.0+ 返回 hostgroups：统一成 hostgroups，页面只读这一份 */
      x.hostgroups = x.hostgroups || x.groups || [];
      x.groups = x.hostgroups;
      S.hostById[x.hostid] = x;
    });

    var gset = {};
    S.hosts.forEach(function (x) {
      (x.hostgroups || []).forEach(function (g) { gset[g.name] = (gset[g.name] || 0) + 1; });
    });
    S.groups = Object.keys(gset).sort(function (a, b) { return gset[b] - gset[a]; }).map(function (n) {
      return { name: n, count: gset[n] };
    });

    S.problems = r[1] || [];
    S.alerts.total = num(r[2]); S.alerts.failed = num(r[3]); S.alerts.sent = num(r[4]);
    S.alerts.samples = r[5] || [];
    (r[6] || []).forEach(function (m) { S.media[m.mediatypeid] = m; });
    S.events14 = r[7] || [];

    var tids = [];
    S.problems.forEach(function (p) { if (tids.indexOf(p.objectid) < 0) tids.push(p.objectid); });
    if (!tids.length) return [];
    return rpc("trigger.get", {
      triggerids: tids,
      output: ["triggerid", "description", "priority", "value", "status", "lastchange", "comments", "manual_close"],
      selectHosts: ["hostid", "host", "name"]
    });
  }).then(function (trs) {
    S.triggers = {};
    (trs || []).forEach(function (t) { S.triggers[t.triggerid] = t; });
    buildRows();
    buildBars();
  });
}

/* ================= 组装行 ================= */
/* 真实环境里问题名称有 5 种形态，且部分触发器没打 tags，
   这里按形态解析成「类别 / 对象 / 现象」，而不是简单切字符串。 */
var CAT_RULES = [
  [/^\[端口Down\]/, "端口"],
  [/^(接口|端口)\s*/i, "端口"],
  [/Unavailable by (ICMP|SNMP|agent)/i, "不可达"],
  [/采集中断|nodata|no data/i, "采集中断"],
  [/PSU|Power supply|电源/i, "电源"],
  [/温度|temperature/i, "温度"],
  [/memory|内存/i, "内存"],
  [/duplex|半双工/i, "双工"],
  [/speed|速率/i, "速率"],
  [/Interface\s+\S+/i, "端口"],
  [/Utilization of|over \d+%/i, "服务性能"],
  [/level is|墨粉|硒鼓|toner|cartridge/i, "耗材"]
];

/* 打印机模板把中文当字节串输出了：E5 BA 9F = 「灰」的 UTF-8。
   这里还原成人能读的文本，并标记为已修正。 */
function fixEncoding(s) {
  var m = /^((?:[0-9A-Fa-f]{2}\s+){2,})(.*)$/.exec(s);
  if (!m) return { text: s, fixed: false };
  var hexes = m[1].trim().split(/\s+/);
  var bytes = new Uint8Array(hexes.length);
  for (var i = 0; i < hexes.length; i++) bytes[i] = parseInt(hexes[i], 16);
  try {
    var dec = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/[\u4e00-\u9fa5]/.test(dec)) return { text: s, fixed: false };
    return { text: (dec + (m[2].trim() ? " " + m[2].trim() : "")).replace(/\s+/g, " ").trim(), fixed: true };
  } catch (e) {
    return { text: s, fixed: false };
  }
}

function buildRows() {
  var now = Math.floor(Date.now() / 1000);
  S.rows = S.problems.map(function (p) {
    var t = S.triggers[p.objectid] || {};
    var host = (t.hosts && t.hosts[0]) || {};
    var tags = {};
    (p.tags || []).forEach(function (x) { tags[x.tag] = x.value; });

    var name = p.name;
    var iface = tags.interface || "";
    var target = tags.description || "";
    var symptom = t.description || name;
    var cat = "";

    /* 形态 B：接口 X（用途）：现象 */
    var mB = /^接口\s*([^（(]+)[（(]([^）)]*)[）)]\s*[：:]\s*(.+)$/.exec(name);
    if (mB) {
      iface = iface || mB[1].trim();
      target = target || mB[2].trim();
      symptom = mB[3].trim();
    }

    /* 形态 A：[类型] 主机 | 接口 | 用途 —— 优先用 tags，缺了再从名称切 */
    var mA = /^\[([^\]]+)\]/.exec(name);
    if (mA) {
      cat = mA[1];
      if (!iface || !target) {
        var parts = name.split("|").map(function (s) { return s.trim(); });
        if (parts.length >= 3) {
          iface = iface || parts[1];
          target = target || parts.slice(2).join(" | ");
        }
      }
    }

    /* 编码修正 */
    var enc = fixEncoding(symptom);
    symptom = enc.text;

    if (!cat) {
      for (var i = 0; i < CAT_RULES.length; i++) {
        if (CAT_RULES[i][0].test(name)) { cat = CAT_RULES[i][1]; break; }
      }
    }
    if (!cat) cat = "其他";
    if (cat === "端口" && /duplex|半双工/i.test(name)) cat = "双工";
    if (cat === "端口" && /speed|速率/i.test(name) && /interface/i.test(name)) cat = "速率";

    /* 电源类：把 "PSU 2" 提到对象列 */
    if (cat === "电源" && !iface) {
      var mP = /PSU\s*\d+/i.exec(name);
      if (mP) iface = mP[0].toUpperCase();
    }
    if (!symptom) symptom = name;

    var hinfo = S.hostById[host.hostid] || {};
    var grps = (hinfo.hostgroups || []).map(function (g) { return g.name; });
    var age = now - num(p.clock);

    return {
      raw: p, trig: t, hostid: host.hostid || "", host: host.host || host.name || "—",
      cat: cat, iface: iface, target: target, symptom: symptom,
      title: t.description || name,
      encFixed: enc.fixed,
      sev: num(p.severity), clock: num(p.clock), age: age,
      ack: num(p.acknowledged), supp: num(p.suppressed),
      groups: grps, opdata: p.opdata || "",
      long: age > 7 * 86400
    };
  });
}

function hostUnreach(h) {
  return (h.interfaces || []).some(function (i) { return String(i.available) === "2"; });
}
function hostUnknown(h) {
  var ifs = h.interfaces || [];
  return ifs.length > 0 && ifs.every(function (i) { return String(i.available) === "0"; });
}

/* ================= 渲染总览 ================= */
function refreshMeta() {
  fetch("/api/meta").then(function (r) { return r.json(); }).then(function (m) {
    $("roBlocked").textContent = m.blocked_count;
    $("roForward").textContent = m.forwarded_count;
  }).catch(function () {});
}

function renderAll() {  renderKPI();
  renderBanner();
  renderFilters();
  renderProblems();
  renderSevList();
  renderBars();
  renderTopHosts();
  renderHosts();
  $("tabCntProblems").textContent = S.problems.length;
  $("tabCntHosts").textContent = S.hosts.length;
}

function renderKPI() {
  var sev = [0, 0, 0, 0, 0, 0];
  S.rows.forEach(function (r) { sev[r.sev]++; });

  $("kProblems").innerHTML = S.problems.length + '<small>条</small>';
  $("kProblemsSub").innerHTML = "严重 <b>" + sev[4] + "</b> · 灾难 <b>" + sev[5] + "</b> · 已确认 <b>" +
    S.rows.filter(function (r) { return r.ack; }).length + "</b>";

  var un = S.hosts.filter(hostUnreach).length;
  $("kUnreach").innerHTML = un + '<small>台</small>';
  var unNames = S.hosts.filter(hostUnreach).map(function (x) { return x.host; });
  $("kUnreachSub").innerHTML = "共 <b>" + S.hosts.length + "</b> 台主机，其中 <b>" +
    S.hosts.filter(hostUnknown).length + "</b> 台可用性未知";

  $("kAlertFail").innerHTML = S.alerts.failed.toLocaleString() + '<small>条</small>';
  $("kAlertFailSub").innerHTML = "总计 <b>" + S.alerts.total.toLocaleString() + "</b> · 成功 <b>" +
    S.alerts.sent.toLocaleString() + "</b>";

  var longs = S.rows.filter(function (r) { return r.long; });
  var maxAge = S.rows.reduce(function (a, r) { return Math.max(a, r.age); }, 0);
  $("kLong").innerHTML = longs.length + '<small>条</small>';
  $("kLongSub").innerHTML = "最久未恢复 <b>" + fmtDur(maxAge) + "</b>";
}

function renderBanner() {
  var box = $("alertBanner");
  if (!S.alerts.samples.length) { box.innerHTML = ""; return; }

  var failedRecent = S.alerts.samples.filter(function (a) { return String(a.status) === "2"; }).length;
  var disabled = [];
  var seen = {};
  S.alerts.samples.forEach(function (a) {
    if (String(a.status) !== "2") return;
    var m = S.media[a.mediatypeid];
    if (m && String(m.status) === "1" && !seen[m.mediatypeid]) {
      seen[m.mediatypeid] = 1; disabled.push(m.name);
    }
  });

  if (!failedRecent) { box.innerHTML = ""; return; }

  box.innerHTML =
    '<div class="banner">' +
      '<svg class="bi" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.4" stroke="#C04545" stroke-width="1.5"/>' +
      '<path d="M10 5.8v5" stroke="#C04545" stroke-width="1.7" stroke-linecap="round"/>' +
      '<circle cx="10" cy="14" r="1.05" fill="#C04545"/></svg>' +
      "<div>" +
        "<h4>告警通知全部送达失败 —— 企业微信媒介处于禁用状态</h4>" +
        "<p>最近 " + S.alerts.samples.length + " 条发送记录中 <b>" + failedRecent + "</b> 条失败，" +
        "错误均为 <span class=\"mono\">Media type disabled.</span>。被禁用的媒介：" +
        disabled.map(function (n) { return "<b>" + h(n) + "</b>"; }).join("、") +
        "。问题是真实发生的，但通知没有发出去。</p>" +
      "</div>" +
      '<button class="lnk" id="bannerDetail">查看发送记录</button>' +
    "</div>";

  $("bannerDetail").onclick = showAlertDrawer;
}

function renderFilters() {
  var sel = $("groupSel");
  var html = '<option value="all">全部主机组</option>';
  S.groups.forEach(function (g) {
    html += '<option value="' + h(g.name) + '">' + h(g.name) + " (" + g.count + ")</option>";
  });
  sel.innerHTML = html;
  sel.value = S.filt.group;

  var c = [0, 0, 0, 0, 0, 0];
  S.rows.forEach(function (r) { c[r.sev]++; });
  $("cAll").textContent = S.rows.length;
  for (var i = 1; i <= 5; i++) $("c" + i).textContent = c[i];
}

function filteredRows() {
  var f = S.filt;
  var q = f.q.trim().toLowerCase();
  return S.rows.filter(function (r) {
    if (f.sev !== "all" && r.sev !== num(f.sev)) return false;
    if (f.group !== "all" && r.groups.indexOf(f.group) < 0) return false;
    if (f.long && !r.long) return false;
    if (f.unreach && !hostUnreach(S.hostById[r.hostid] || {})) return false;
    if (q) {
      var blob = (r.host + " " + r.iface + " " + r.target + " " + r.symptom + " " + r.title + " " + r.cat + " " + r.groups.join(" ")).toLowerCase();
      if (blob.indexOf(q) < 0) return false;
    }
    return true;
  }).sort(function (a, b) {
    var k = S.filt.sort, d = S.filt.dir;
    if (k === "sev") return (a.sev - b.sev) * d || (a.clock - b.clock) * -1;
    if (k === "clock") return (a.clock - b.clock) * d;
    if (k === "dur") return (a.age - b.age) * d;
    if (k === "host") return a.host.localeCompare(b.host) * d;
    return 0;
  });
}

function renderProblems() {
  var rows = filteredRows();
  var body = $("probBody");

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty">当前筛选条件下没有问题</div></td></tr>';
  } else {
    body.innerHTML = rows.map(function (r) {
      var dupTarget = !r.target || r.target === r.iface || (r.iface && r.target.indexOf(r.iface) === 0);
      var objCell = '<div class="if">' + (r.iface ? h(r.iface) : '<span class="muted">—</span>') + "</div>" +
        (!dupTarget ? '<div class="ds" title="' + h(r.target) + '">' + h(r.target) + "</div>" : "");
      var symCell = '<div class="desc" title="' + h(r.symptom + (r.opdata ? "  [" + r.opdata + "]" : "")) + '">' + h(r.symptom) +
        (r.encFixed ? '<span class="tag-mini" title="原始值是该中文的 UTF-8 字节（E5 BA 9F…），已还原">编码已修正</span>' : "") + "</div>" +
        (r.opdata && r.opdata !== r.symptom ? '<div class="opd" title="' + h(r.opdata) + '">' + h(r.opdata) + "</div>" : "");

      return '<tr class="prow" data-eid="' + r.raw.eventid + '">' +
        '<td><span class="sev"><i style="background:' + SEV[r.sev].c + '"></i>' + SEV[r.sev].n + "</span></td>" +
        '<td><span class="host">' + h(r.host) + "</span></td>" +
        '<td><span class="typ">' + h(r.cat) + "</span></td>" +
        '<td class="obj">' + objCell + "</td>" +
        "<td>" + symCell + "</td>" +
        '<td><span class="tm">' + fmtTime(r.clock) + "</span></td>" +
        '<td><span class="dur' + (r.long ? " long" : "") + '">' + fmtDur(r.age) +
          (r.long ? '<span class="tag-mini">长期</span>' : "") + "</span></td>" +
      "</tr>";
    }).join("");
  }

  Array.prototype.forEach.call(body.querySelectorAll(".prow"), function (tr) {
    tr.onclick = function () { showProblemDrawer(tr.getAttribute("data-eid")); };
  });

  $("probFoot").textContent = "显示 " + rows.length + " / " + S.rows.length + " 条";
  var totalAge = rows.reduce(function (a, r) { return a + r.age; }, 0);
  $("probStat").textContent = rows.length ? "平均持续 " + fmtDur(totalAge / rows.length) : "—";
}

function renderSevList() {
  var c = [0, 0, 0, 0, 0, 0];
  S.rows.forEach(function (r) { c[r.sev]++; });
  var max = Math.max.apply(null, c) || 1;
  var html = "";
  for (var i = 5; i >= 0; i--) {
    var pct = c[i] / max * 100;
    html += '<div class="sev-row' + (c[i] ? "" : " zero") + '">' +
      '<span class="nm">' + SEV[i].n + "</span>" +
      '<span class="bar"><span class="fill" style="width:' + Math.max(pct, c[i] ? 3 : 0) + "%;background:" + SEV[i].c + '"></span></span>' +
      '<span class="n">' + c[i] + "</span></div>";
  }
  $("sevList").innerHTML = html;
}

function buildBars() {
  var days = {};
  var now = new Date();
  for (var i = 13; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    var key = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    days[key] = [0, 0, 0, 0, 0, 0];
  }
  S.events14.forEach(function (e) {
    var d = new Date(num(e.clock) * 1000);
    var key = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    if (days[key]) days[key][num(e.severity)]++;
  });
  S.bars = Object.keys(days).sort().map(function (k) {
    var v = days[k];
    return { key: k, vals: v, total: v.reduce(function (a, b) { return a + b; }, 0) };
  });
}

function renderBars() {
  var max = S.bars.reduce(function (a, b) { return Math.max(a, b.total); }, 1);
  var html = "";
  S.bars.forEach(function (b) {
    var segs = "";
    for (var i = 5; i >= 0; i--) {
      if (!b.vals[i]) continue;
      var hh = Math.max(1, b.vals[i] / max * 88);
      segs += '<span class="bseg" style="height:' + hh + "px;background:" + SEV[i].c + '" title="' +
        b.key + " " + SEV[i].n + ": " + b.vals[i] + '"></span>';
    }
    html += '<div class="bcol" title="' + b.key + " 共 " + b.total + ' 条">' + segs + "</div>";
  });
  $("bars").innerHTML = html;

  var xl = S.bars.map(function (b, i) {
    return "<span>" + (i % 2 === 0 ? b.key.slice(8) : "") + "</span>";
  }).join("");
  $("bxl").innerHTML = xl;

  var tot = S.bars.reduce(function (a, b) { return a + b.total; }, 0);
  var today = S.bars.length ? S.bars[S.bars.length - 1].total : 0;
  var firstD = S.bars.length ? S.bars[0].key.slice(5).replace("-", "/") : "";
  var lastD = S.bars.length ? S.bars[S.bars.length - 1].key.slice(5).replace("-", "/") : "";
  $("barsNote").textContent = firstD + " → " + lastD + "，横轴为日（每 2 天标注）。近 14 天共 " + tot +
    " 条事件，今日 " + today + " 条。按事件发生日统计，含已恢复事件。";
}

function renderTopHosts() {
  var c = {};
  S.rows.forEach(function (r) { c[r.host] = (c[r.host] || 0) + 1; });
  var arr = Object.keys(c).map(function (k) { return { n: k, v: c[k] }; })
    .sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
  var max = arr.length ? arr[0].v : 1;
  $("topHosts").innerHTML = arr.map(function (x) {
    return '<div class="sev-row"><span class="nm" style="width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + h(x.n) + '">' + h(x.n) + "</span>" +
      '<span class="bar"><span class="fill" style="width:' + Math.max(3, x.v / max * 100) + "%;background:#5EA9C4\"></span></span>" +
      '<span class="n">' + x.v + "</span></div>";
  }).join("");
}

/* ================= 主机页 ================= */
function hostIps(x) {
  return (x.interfaces || []).filter(function (i) { return i.main === "1" || !i.main; })
    .map(function (i) { return i.ip || i.dns; }).filter(Boolean);
}
function hostFlag(x) {
  if (String(x.status) === "1") return { dot: "#BFC9D3", label: "停用", color: "#7A8896", rank: 3 };
  if (hostUnreach(x)) return { dot: "#E05252", label: "不可达", color: "#C93B3B", rank: 2 };
  if (hostUnknown(x)) return { dot: "#E8A33D", label: "未知", color: "#B07A1E", rank: 1 };
  return { dot: "#1FA97B", label: "正常", color: "#1F8A62", rank: 0 };
}
function renderHostGroupChips() {
  var box = $("hostGroupChips");
  if (!box) return;
  var f = S.hostFilt;
  box.innerHTML = S.groups.map(function (g) {
    var on = f.groups.indexOf(g.name) >= 0;
    return '<button class="gchip' + (on ? " on" : "") + '" data-hg="' + h(g.name) + '">' +
      h(g.name) + '<span class="n">' + g.count + "</span></button>";
  }).join("") || '<span class="muted" style="font-size:11px">无分组</span>';
  Array.prototype.forEach.call(box.querySelectorAll(".gchip"), function (b) {
    b.onclick = function () {
      var name = b.getAttribute("data-hg");
      var i = f.groups.indexOf(name);
      if (i >= 0) f.groups.splice(i, 1); else f.groups.push(name);
      renderHosts();
    };
  });
}

function renderHosts() {
  var c = { avail: 0, unavail: 0, unknown: 0 };
  S.hosts.forEach(function (x) {
    if (hostUnreach(x)) c.unavail++;
    else if (hostUnknown(x)) c.unknown++;
    else c.avail++;
  });
  $("hTotal").textContent = S.hosts.length;
  $("hTotalSub").innerHTML = "启用 <b>" + S.hosts.filter(function (x) { return String(x.status) === "0"; }).length +
    "</b> · 停用 <b>" + S.hosts.filter(function (x) { return String(x.status) === "1"; }).length + "</b>";
  $("hAvail").textContent = c.avail;
  $("hUnavail").textContent = c.unavail;
  $("hUnknown").textContent = c.unknown;

  var probCnt = {}, probMax = {};
  S.rows.forEach(function (r) {
    probCnt[r.hostid] = (probCnt[r.hostid] || 0) + 1;
    probMax[r.hostid] = Math.max(probMax[r.hostid] || 0, r.sev);
  });

  var f = S.hostFilt;
  var q = f.q.trim().toLowerCase();
  renderHostGroupChips();

  var list = S.hosts.filter(function (x) {
    if (f.kind === "unavail" && !hostUnreach(x)) return false;
    if (f.kind === "unknown" && !hostUnknown(x)) return false;
    if (f.kind === "disabled" && String(x.status) !== "1") return false;
    if (f.kind === "problems" && !probCnt[x.hostid]) return false;
    if (f.kind === "sev4" && (probMax[x.hostid] || 0) < 4) return false;
    if (f.kind === "maint" && String(x.maintenance_status) !== "1") return false;
    if (f.groups.length) {
      var names = (x.hostgroups || []).map(function (g) { return g.name; });
      var hit = f.groups.some(function (g) { return names.indexOf(g) >= 0; });
      if (!hit) return false;
    }
    if (q) {
      var ips = (x.interfaces || []).map(function (i) { return (i.ip || "") + " " + (i.dns || ""); }).join(" ");
      var gs = (x.hostgroups || []).map(function (g) { return g.name; }).join(" ");
      var tpl = (x.parentTemplates || []).map(function (t) { return t.name; }).join(" ");
      var blob = (x.host + " " + x.name + " " + ips + " " + gs + " " + tpl).toLowerCase();
      if (blob.indexOf(q) < 0) return false;
    }
    return true;
  });

  var dir = f.dir;
  list.sort(function (a, b) {
    var va, vb;
    if (f.sort === "host") { va = a.host.toLowerCase(); vb = b.host.toLowerCase(); }
    else if (f.sort === "name") { va = (a.name || "").toLowerCase(); vb = (b.name || "").toLowerCase(); }
    else if (f.sort === "ip") { va = hostIps(a)[0] || ""; vb = hostIps(b)[0] || ""; }
    else if (f.sort === "avail") { va = hostFlag(a).rank; vb = hostFlag(b).rank; }
    else if (f.sort === "sev") { va = probMax[a.hostid] || 0; vb = probMax[b.hostid] || 0; }
    else { va = probCnt[a.hostid] || 0; vb = probCnt[b.hostid] || 0; }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.host.localeCompare(b.host);
  });

  $("hostBody").innerHTML = list.map(function (x) {
    var fl = hostFlag(x);
    var ips = hostIps(x);
    var pcn = probCnt[x.hostid] || 0;
    var mx = probMax[x.hostid] || 0;
    var dis = String(x.status) === "1";
    var maint = String(x.maintenance_status) === "1";

    return '<tr class="hrow" data-hid="' + h(x.hostid) + '" style="cursor:pointer">' +
      '<td><span class="dot" style="background:' + fl.dot + '"></span></td>' +
      '<td><span class="host">' + h(x.host) + "</span>" + (dis ? ' <span class="typ">停用</span>' : "") + "</td>" +
      '<td><span class="muted" style="font-size:11.5px">' + h(x.name) + "</span></td>" +
      '<td><span class="mono" style="font-size:11px;color:#415970">' + h(ips.join(", ") || "—") + "</span></td>" +
      '<td><span class="avail" style="color:' + fl.color + '"><i class="dot" style="background:' + fl.dot + '"></i>' + fl.label + "</span></td>" +
      '<td><span class="num' + (pcn ? " hot" : "") + '">' + (pcn || "—") + "</span></td>" +
      '<td>' + (mx ? '<span class="sev" style="font-size:10.5px;padding:1px 5px;border-radius:3px;background:' + SEV[mx].c + '22;color:' + SEV[mx].c + '">' + SEV[mx].n + "</span>" : '<span class="muted">—</span>') + "</td>" +
      '<td>' + (maint ? '<span class="typ" style="background:#FFF4E2;color:#9A6516">维护</span>' : '<span class="muted">—</span>') + "</td>" +
      '<td><span class="num muted">' + (x.parentTemplates || []).length + "</span></td>" +
      '<td><span class="hg">' + (x.hostgroups || []).slice(0, 3).map(function (g) { return "<em>" + h(g.name) + "</em>"; }).join("") +
        ((x.hostgroups || []).length > 3 ? '<em>+' + ((x.hostgroups || []).length - 3) + "</em>" : "") + "</span></td>" +
    "</tr>";
  }).join("") || '<tr><td colspan="10" class="empty">没有符合条件的主机</td></tr>';

  Array.prototype.forEach.call(document.querySelectorAll("#hostBody .hrow"), function (tr) {
    tr.onclick = function () { location.hash = "#host/" + tr.getAttribute("data-hid"); };
  });

  var sortName = { host: "主机名", name: "显示名", ip: "IP", avail: "可用性", prob: "在警数", sev: "最高严重度" }[f.sort] || f.sort;
  $("hostFoot").textContent = "显示 " + list.length + " / " + S.hosts.length + " 台主机 · 按" + sortName + (dir > 0 ? "升序" : "降序");
}

/* ================= 主机详情 ================= */
var IF_TYPE = { "1": "Agent", "2": "SNMP", "3": "IPMI", "4": "JMX" };
function hostTypeName(t) { return IF_TYPE[String(t)] || ("type " + t); }
function fmtVal(v, units) {
  var n = Number(v);
  if (!isFinite(n)) return "—";
  var u = units || "";
  if (u === "bps" || u === "Bps") return fmtBps(n);
  if (u === "%") return n.toFixed(1) + "%";
  var abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + " G" + (u ? " " + u : "");
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + " M" + (u ? " " + u : "");
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + " k" + (u ? " " + u : "");
  return (abs >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, "")) + (u ? " " + u : "");
}

function getHostProblems(hostid) {
  /* 7.0+/8.0 支持 problem.get 直接带 hostids；4.x 走 trigger 反查，避免参数被静默忽略 */
  if (!CAPS.problemHostids) return hostProblemsViaTriggers(hostid);

  return rpc("problem.get", {
    hostids: [hostid], output: "extend", selectTags: "extend",
    sortfield: ["eventid"], sortorder: "DESC", limit: 500
  }).catch(function () {
    return hostProblemsViaTriggers(hostid);
  });
}

function hostProblemsViaTriggers(hostid) {
  return rpc("trigger.get", {
    hostids: [hostid], output: ["triggerid"], only_true: 1, monitored: true
  }).then(function (ts) {
    var ids = (ts || []).map(function (t) { return t.triggerid; });
    if (!ids.length) return [];
    return rpc("problem.get", {
      objectids: ids, output: "extend", selectTags: "extend",
      sortfield: ["eventid"], sortorder: "DESC", limit: 500
    });
  });
}

function loadHostDetail(hostid) {
  S.hd.hostid = hostid;
  S.hd.page = 0;
  S.hd.lastData = {};
  S.hd.probed = false;
  $("hostCrumb").textContent = "主机详情 · " + hostid;
  $("hdName").textContent = "加载中…";
  $("hdStatus").textContent = "";
  $("hdSub").textContent = "host.get / problem.get / item.get / trigger.get / graph.get";
  $("hdDesc").textContent = "";
  $("hdHealth").style.display = "none";
  $("hdProbBox").innerHTML = '<div class="empty">读取活动问题…</div>';
  $("hdItemBox").innerHTML = '<div class="empty">读取监控项…</div>';
  $("hdTrigBox").innerHTML = '<div class="empty">读取触发器…</div>';
  $("hdIfaceBox").innerHTML = '<div class="foot-note">读取接口…</div>';
  $("hdGraphBox").innerHTML = '<div class="foot-note">读取图形…</div>';

  Promise.all([
    rpc("host.get", hostGetParams({
      hostids: [hostid],
      output: ["hostid", "host", "name", "status", "maintenance_status", "description", "inventory_mode"],
      selectParentTemplates: ["templateid", "name"],
      selectInventory: true,
      selectMacros: ["macro", "value", "type"]
    })),
    getHostProblems(hostid),
    rpc("item.get", {
      hostids: [hostid],
      output: ["itemid", "name", "key_", "units", "value_type", "lastvalue", "lastclock", "status", "state", "error"],
      limit: 2000
    }),
    rpc("trigger.get", {
      hostids: [hostid],
      output: ["triggerid", "description", "priority", "value", "status", "state", "lastchange", "error"],
      limit: 1000
    }),
    rpc("graph.get", {
      hostids: [hostid],
      output: ["graphid", "name", "graphtype", "width", "height"],
      limit: 500
    }).catch(function () { return []; })
  ]).then(function (r) {
    var H = (r[0] || [])[0];
    if (!H) throw new Error("host.get 没有返回该主机，可能已被删除或当前账号无权限");
    H.hostgroups = H.hostgroups || H.groups || [];
    H.groups = H.hostgroups;
    S.hd.data = { host: H, problems: r[1] || [], items: r[2] || [], triggers: r[3] || [], graphs: r[4] || [] };
    renderHostDetail();
    /* 采集失败的项：查最后一次历史值（最多 10 个），把"最近一次数据"说清楚 */
    probeLastData(S.hd.data.items).then(function (m) {
      if (S.hd.hostid !== hostid) return;
      S.hd.lastData = m;
      S.hd.probed = true;
      renderHdHealth();
      renderHdItems();
    });
  }).catch(function (e) {
    $("hdName").textContent = "加载失败";
    $("hdSub").textContent = e.message;
    $("hdProbBox").innerHTML = '<div class="empty">' + h(e.message) + "</div>";
  });
}

/* 对采集异常的监控项补查"最后一条历史"。
   history.get 必须带正确的 value_type，空结果再用 trend.get 兜底。
   只查前 10 个，避免主机详情页对大主机产生几十个请求。 */
function probeLastData(items) {
  var bad = (items || []).filter(function (i) {
    var k = itemHealth(i);
    return k === "unsupported" || k === "nodata";
  }).slice(0, 10);
  if (!bad.length) return Promise.resolve({});

  var jobs = bad.map(function (it) {
    var vt = Number(it.value_type);
    return rpc("history.get", {
      itemids: [it.itemid], history: isFinite(vt) ? vt : 0,
      sortfield: "clock", sortorder: "DESC", limit: 1
    }).then(function (rows) {
      if (rows && rows.length) {
        return { itemid: it.itemid, clock: num(rows[0].clock), value: rows[0].value, src: "history" };
      }
      return rpc("trend.get", {
        itemids: [it.itemid], sortfield: "clock", sortorder: "DESC", limit: 1
      }).then(function (tr) {
        var r = (tr || [])[0];
        return r ? { itemid: it.itemid, clock: num(r.clock), value: r.value_avg, src: "trend" } : null;
      }).catch(function () { return null; });
    }).catch(function () { return null; });
  });

  return Promise.all(jobs).then(function (res) {
    var m = {};
    res.forEach(function (x) { if (x) m[x.itemid] = x; });
    return m;
  });
}

function renderHdHealth() {
  var el = $("hdHealth");
  if (!el) return;
  var items = (S.hd.data && S.hd.data.items) || [];
  var bad = items.filter(function (i) {
    var k = itemHealth(i);
    return k === "unsupported" || k === "nodata";
  });
  if (!bad.length) { el.style.display = "none"; return; }

  var unsup = bad.filter(function (i) { return itemHealth(i) === "unsupported"; }).length;
  var nodata = bad.length - unsup;

  /* 合并相同错误，避免 4 条一样的 Timeout 重复铺满 */
  var errs = {};
  bad.forEach(function (i) {
    var e = String(i.error || "").trim();
    if (e) errs[e] = (errs[e] || 0) + 1;
  });
  var errTxt = Object.keys(errs).slice(0, 3).map(function (e) {
    return h(e) + (errs[e] > 1 ? " ×" + errs[e] : "");
  }).join("；");

  var last = null, lastItem = null;
  bad.forEach(function (i) {
    var d = S.hd.lastData[i.itemid];
    if (d && (!last || d.clock > last.clock)) { last = d; lastItem = i; }
  });

  /* 三种状态必须区分开：还在查 / 查到了 / 查完但确实没有历史。
     只按 lastData 是否为空判断会把"查完无结果"永久卡在"查询中…"。 */
  var lastTxt;
  if (last) {
    lastTxt = " · 最近一次数据 <b>" + fmtTime(last.clock) +
      (lastItem ? "（" + h(fmtVal(last.value, lastItem.units)) + "）" : "") + "</b>";
  } else if (!S.hd.probed) {
    lastTxt = " · 最近一次数据 <b>查询中…</b>";
  } else {
    lastTxt = " · 最近一次数据 <b>" +
      (bad.length > 10 ? "前 10 项均未找到" : "未找到（可能从未采集成功）") + "</b>";
  }

  el.style.display = "flex";
  el.innerHTML =
    '<div class="hh-ic">⚠</div>' +
    "<div><b>" + bad.length + " 个监控项采集异常</b>" +
      (unsup ? "（采集失败 " + unsup : "") + (nodata ? (unsup ? " · " : "（") + "无当前值 " + nodata : "") +
      (unsup || nodata ? "）" : "") +
      lastTxt +
      (errTxt ? '<br><span class="muted">原因：</span>' + errTxt : "") +
      '<br><span class="muted">采集异常不代表没有历史：图形页会自动回退显示最近数据。</span></div>' +
    '<div class="hh-act"><button class="btn2" id="hdBadOnly">只看异常</button></div>';

  var btn = $("hdBadOnly");
  if (btn) btn.onclick = function () {
    S.hd.filter = "bad";
    S.hd.page = 0;
    Array.prototype.forEach.call(document.querySelectorAll(".chip[data-if]"), function (x) {
      x.classList.toggle("on", x.getAttribute("data-if") === "bad");
    });
    renderHdItems();
  };
}

function renderHostDetail() {
  var D = S.hd.data;
  if (!D) return;
  var H = D.host, probs = D.problems, items = D.items, trs = D.triggers, graphs = D.graphs;
  var fl = hostFlag(H);
  $("hdDot").style.background = fl.dot;
  $("hdName").textContent = H.name || H.host;
  $("hdStatus").textContent = String(H.status) === "1" ? "已停用" : "已启用";
  $("hdStatus").className = "typ" + (String(H.status) === "1" ? "" : " ok");
  var ips = hostIps(H);
  $("hdSub").innerHTML =
    "<b>" + h(H.host) + "</b> · " + h(fl.label) +
    (ips.length ? " · " + h(ips.join(", ")) : "") +
    " · " + ((H.hostgroups || []).map(function (g) { return h(g.name); }).join(" / ") || "无分组") +
    " · 模板 " + ((H.parentTemplates || []).length) + " 个" +
    (String(H.maintenance_status) === "1" ? " · <b>维护中</b>" : "");
  $("hdDesc").textContent = H.description || "";

  var sev = 0;
  probs.forEach(function (p) { sev = Math.max(sev, num(p.severity)); });
  $("hdProb").textContent = probs.length;
  $("hdSev").innerHTML = sev ? '<span style="color:' + SEV[sev].c + '">' + SEV[sev].n + "</span>" : "—";
  var badCnt = items.filter(function (i) { return itemHealth(i) === "unsupported" || itemHealth(i) === "nodata"; }).length;
  $("hdItems").textContent = items.length;
  $("hdBad").innerHTML = badCnt
    ? '<span style="color:#C93B3B">' + badCnt + "</span>"
    : '<span style="color:#1F8A62">0</span>';
  $("hdTrig").textContent = trs.length;
  $("hdGraphs").textContent = graphs.length;
  renderHdHealth();

  /* 活动问题 */
  if (!probs.length) {
    $("hdProbBox").innerHTML = '<div class="empty">该主机当前没有活动问题</div>';
  } else {
    $("hdProbBox").innerHTML = '<table><thead><tr>' +
      '<th style="width:76px">严重度</th><th style="width:96px">开始</th><th style="width:72px">持续</th>' +
      '<th style="width:66px">确认</th><th>问题</th></tr></thead><tbody>' +
      probs.map(function (p) {
        var s = num(p.severity), t = fixEncoding(p.name || "");
        var age = Math.max(0, Math.floor(Date.now() / 1000) - num(p.clock));
        return "<tr>" +
          '<td><span class="sev" style="font-size:10.5px;padding:1px 5px;border-radius:3px;background:' + SEV[s].c + '22;color:' + SEV[s].c + '">' + SEV[s].n + "</span></td>" +
          "<td>" + fmtTime(p.clock) + "</td>" +
          '<td><span class="dur' + (age > 7 * 86400 ? " long" : "") + '">' + fmtDur(age) + "</span></td>" +
          "<td>" + (String(p.acknowledged) === "1" ? "已确认" : '<span class="muted">未确认</span>') + "</td>" +
          '<td><div class="desc" title="' + h(t.text) + '">' + h(t.text) + (t.fixed ? ' <span class="tag-mini">编码已修正</span>' : "") + "</div></td>" +
        "</tr>";
      }).join("") + "</tbody></table>";
  }

  /* 监控项 */
  S.hd.items = items.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  S.hd.page = 0;
  renderHdItems();

  /* 触发器 */
  var tl = trs.slice().sort(function (a, b) {
    var va = String(a.value) === "1" ? 0 : 1, vb = String(b.value) === "1" ? 0 : 1;
    if (va !== vb) return va - vb;
    return num(b.priority) - num(a.priority);
  }).slice(0, 150);
  $("hdTrigBox").innerHTML = tl.length ? ('<table><thead><tr>' +
    '<th style="width:70px">状态</th><th style="width:70px">严重度</th><th style="width:100px">最近变更</th><th>触发器</th></tr></thead><tbody>' +
    tl.map(function (t) {
      var on = String(t.value) === "1";
      var st = String(t.state) === "1" ? "未知" : (on ? "告警" : "正常");
      var stc = String(t.state) === "1" ? "#B07A1E" : (on ? "#C93B3B" : "#1F8A62");
      var s = num(t.priority);
      return "<tr>" +
        '<td><span style="font-size:10.5px;font-weight:600;color:' + stc + '">' + st + "</span></td>" +
        '<td><span class="sev" style="font-size:10.5px;padding:1px 5px;border-radius:3px;background:' + SEV[s].c + '22;color:' + SEV[s].c + '">' + SEV[s].n + "</span></td>" +
        "<td>" + fmtTime(t.lastchange) + "</td>" +
        '<td><div class="desc" title="' + h(t.description) + '">' + h(t.description) +
          (t.error ? ' <span class="tag-mini" style="background:#FDECEC;color:#B33535" title="' + h(t.error) + '">配置错误</span>' : "") +
        "</div></td></tr>";
    }).join("") + "</tbody></table>") :
    '<div class="empty">该主机没有触发器</div>';

  /* 接口 */
  var ifs = H.interfaces || [];
  $("hdIfaceMeta").textContent = ifs.length + " 个";
  $("hdIfaceBox").innerHTML = ifs.length ? ifs.map(function (i) {
    var av = String(i.available);
    var lbl = av === "1" ? "正常" : (av === "2" ? "不可达" : "未知");
    var c = av === "1" ? "#1F8A62" : (av === "2" ? "#C93B3B" : "#B07A1E");
    return '<div class="ifrow"><span class="ic">' + h(hostTypeName(i.type)) + "</span>" +
      '<div class="ib"><div class="ip">' + h(i.ip || i.dns || "—") + (i.port ? ":" + h(i.port) : "") + "</div>" +
      '<div style="font-size:10px;color:' + c + ';margin-top:2px">' + lbl + (i.main === "1" ? " · 主接口" : "") + "</div>" +
      (i.error ? '<div class="ie">' + h(i.error) + "</div>" : "") + "</div></div>";
  }).join("") : '<div class="foot-note">没有接口</div>';

  /* 图形 */
  var gs = graphs.slice().sort(function (a, b) {
    var sa = /traffic|流量/i.test(a.name) ? 0 : 1, sb = /traffic|流量/i.test(b.name) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return String(a.name).localeCompare(String(b.name));
  });
  $("hdGraphs").textContent = gs.length;
  $("hdGraphMeta").textContent = gs.length + " 张";
  $("hdGraphBox").innerHTML = gs.length ? gs.map(function (g) {
    return '<div class="lrow click" data-gid="' + h(g.graphid) + '" title="' + h(g.name) + '">' +
      '<span class="nm">' + h(g.name) + "</span>" +
      '<span class="n">' + (String(g.graphtype) === "1" ? "堆叠" : String(g.graphtype) === "2" ? "饼图" : "折线") + "</span></div>";
  }).join("") : '<div class="foot-note">该主机没有原生图形，可在图形页用监控项自定义</div>';
  Array.prototype.forEach.call($("hdGraphBox").querySelectorAll("[data-gid]"), function (r) {
    r.onclick = function () { location.hash = "#graphs/" + r.getAttribute("data-gid"); };
  });

  /* 资产 / 宏 */
  var inv = H.inventory || {};
  var invKeys = Object.keys(inv).filter(function (k) { return inv[k] !== "" && inv[k] != null; });
  var macs = H.macros || [];
  if (String(H.inventory_mode) === "-1" || !invKeys.length) {
    $("hdInvBox").innerHTML = "<dt>资产</dt><dd>未启用资产清单</dd>" +
      "<dt>宏</dt><dd>" + (macs.length ? macs.slice(0, 5).map(function (m) { return h(m.macro); }).join("<br>") + (macs.length > 5 ? "<br>…共 " + macs.length + " 个" : "") : "无") + "</dd>";
  } else {
    $("hdInvBox").innerHTML = invKeys.slice(0, 8).map(function (k) {
      return "<dt>" + h(k) + "</dt><dd>" + h(inv[k]) + "</dd>";
    }).join("") + "<dt>宏</dt><dd>" + (macs.length || 0) + " 个</dd>";
  }
}

function renderHdItems() {
  var box = $("hdItemBox");
  if (!box) return;
  var f = S.hd.filter, q = S.hd.q.trim().toLowerCase();
  var list = (S.hd.items || []).filter(function (i) {
    var hk = itemHealth(i);
    if (f === "num" && ["0", "3"].indexOf(String(i.value_type)) < 0) return false;
    if (f === "bad" && hk !== "unsupported" && hk !== "nodata") return false;
    if (f === "unsup" && hk !== "unsupported") return false;
    if (f === "enabled" && String(i.status) !== "0") return false;
    if (q && (String(i.name) + " " + String(i.key_)).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  var per = 40;
  var pages = Math.max(1, Math.ceil(list.length / per));
  if (S.hd.page >= pages) S.hd.page = pages - 1;
  var start = S.hd.page * per;
  var slice = list.slice(start, start + per);

  box.innerHTML = slice.length ? ('<table><thead><tr>' +
    '<th>名称</th><th style="width:180px">key_</th><th style="width:96px">最新值</th>' +
    '<th style="width:96px">最近数据</th><th style="width:78px">状态</th></tr></thead><tbody>' +
    slice.map(function (i) {
      var hk = itemHealth(i);
      var st = hk === "ok" ? '<span style="color:#1F8A62">正常</span>'
        : '<span style="color:' + healthColor(hk) + '" title="' + h(i.error || "") + '">' + healthLabel(hk) + "</span>";
      var val = num(i.lastclock) ? '<span class="num">' + h(fmtVal(i.lastvalue, i.units)) + "</span>"
        : '<span class="muted">—</span>';
      var ld = S.hd.lastData[i.itemid];
      var recent = ld ? '<span title="最后一次历史数据">' + fmtTime(ld.clock) + "</span>"
        : (num(i.lastclock) ? fmtTime(i.lastclock) : '<span class="muted">—</span>');
      return "<tr>" +
        '<td><div class="desc" title="' + h(i.name) + '">' + h(i.name) + "</div></td>" +
        '<td><span class="mono" style="font-size:10px;color:#5E7488">' + h(i.key_) + "</span></td>" +
        "<td>" + val + "</td>" +
        "<td>" + recent + "</td>" +
        "<td>" + st + "</td></tr>";
    }).join("") + "</tbody></table>") :
    '<div class="empty">没有符合条件的监控项</div>';

  var badAll = (S.hd.items || []).filter(function (i) {
    var k = itemHealth(i); return k === "unsupported" || k === "nodata";
  }).length;
  $("hdItemFoot").textContent = "共 " + list.length + " 项 · 第 " + (S.hd.page + 1) + " / " + pages + " 页" +
    (badAll ? " · 采集异常 " + badAll + " 项" : "");
  $("hdPrev").disabled = S.hd.page <= 0;
  $("hdNext").disabled = S.hd.page >= pages - 1;
}

/* ================= 监控项健康 / 收发配对 =================
   健康状态是"展示口径"，不改变 Zabbix 数据：
   - ok           有当前值（lastclock > 0）
   - unsupported  state=1，采集失败（error 里有原因）
   - nodata       从未取到当前值，但可能仍有历史
   - disabled     status=1
*/
var HEALTH = {
  ok: { label: "正常", color: "#1F8A62", rank: 3 },
  unsupported: { label: "采集失败", color: "#C93B3B", rank: 0 },
  nodata: { label: "无当前值", color: "#B07A1E", rank: 1 },
  disabled: { label: "已停用", color: "#8A99A8", rank: 2 }
};
function itemHealth(it) {
  if (String(it.status) === "1") return "disabled";
  if (String(it.state) === "1") return "unsupported";
  if (!num(it.lastclock)) return "nodata";
  return "ok";
}
function healthLabel(k) { return (HEALTH[k] || HEALTH.ok).label; }
function healthColor(k) { return (HEALTH[k] || HEALTH.ok).color; }

function healthSummaryText(metas) {
  var bad = (metas || []).filter(function (m) { return m.health && m.health !== "ok"; });
  if (!bad.length) return "正常";
  return bad.map(function (m) { return healthLabel(m.health); }).filter(function (v, i, a) {
    return a.indexOf(v) === i;
  }).join(" / ");
}

/* 收发配对：把方向词归一后比较。
   net.if.in[ifHCInOctets.10] 与 net.if.out[ifHCOutOctets.10] 归一后同为 net.if.DIR[IFOCTETS.10]，
   索引不同则不会被误配。 */
var DIR_OUT_RE = /(ifHCOutOctets|ifOutOctets|net\.if\.out\[|\.tx\.|tx_|transmit|发送|上行|出向)/i;
var DIR_IN_RE = /(ifHCInOctets|ifInOctets|net\.if\.in\[|\.rx\.|rx_|receive|接收|下行|入向)/i;

function pairKeyOf(it) {
  return String(it.hostid) + "|" + String(it.key_ || "")
    .replace(/ifHCInOctets|ifHCOutOctets|ifInOctets|ifOutOctets/gi, "IFOCTETS")
    .replace(/\.(in|out)\[/gi, ".DIR[")
    .replace(/\b(in|out)\b/gi, "DIR")
    .replace(/发送|接收|上行|下行|出向|入向/g, "DIR")
    .replace(/\s+/g, "");
}
function directionOf(it) {
  var s = String(it.key_ || "") + " " + String(it.name || "");
  if (DIR_OUT_RE.test(s)) return "out";
  if (DIR_IN_RE.test(s)) return "in";
  return "";
}
function buildPeerMap(items) {
  var groups = {};
  (items || []).forEach(function (it) {
    var d = directionOf(it);
    if (!d) return;
    var k = pairKeyOf(it);
    if (!groups[k]) groups[k] = {};
    if (!groups[k][d]) groups[k][d] = it.itemid;
  });
  var map = {};
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    if (g["in"] && g["out"]) { map[g["in"]] = g["out"]; map[g["out"]] = g["in"]; }
  });
  return map;
}

/* ================= 图形页 ================= */
var GRAPH_RANGES = {
  "1h": 3600, "6h": 21600, "12h": 43200, "24h": 86400,
  "7d": 604800, "30d": 2592000, "90d": 7776000
};
var GRAPH_COLORS = ["#00A9C7", "#16A87C", "#3B7DD8", "#E8A33D", "#E97659", "#8E6BD6", "#5EA9C4", "#B07A1E"];

function rangeFromTo() {
  var now = Math.floor(Date.now() / 1000);
  if (S.graph.range === "custom") {
    var to = S.graph.customTo || now;
    var from = S.graph.customFrom || (to - 86400);
    if (from >= to) from = to - 3600;
    return { from: from, to: to, useTrend: (to - from) > 86400, key: "custom" };
  }
  var span = GRAPH_RANGES[S.graph.range] || 86400;
  return { from: now - span, to: now, useTrend: span > 86400, key: S.graph.range };
}

function syncRangeSeg() {
  Array.prototype.forEach.call(document.querySelectorAll("#rangeSeg button"), function (b) {
    b.classList.toggle("on", b.getAttribute("data-range") === S.graph.range);
  });
  if (S.graph.range === "custom") {
    $("customRange").style.display = "flex";
    $("customRangeBtn").classList.add("on");
    if (S.graph.customFrom) $("rangeFrom").value = localInput(S.graph.customFrom * 1000);
    if (S.graph.customTo) $("rangeTo").value = localInput(S.graph.customTo * 1000);
  }
}

function loadGraphPage(graphid) {
  showView("graphs");
  syncRangeSeg();
  renderGraphHosts();
  if (S.graph.chart) setTimeout(function () { S.graph.chart.resize(); }, 80);

  if (graphid) {
    S.graph.pendingGraphid = graphid;
    rpc("graph.get", { graphids: [graphid], output: ["graphid", "name"], selectHosts: ["hostid", "host"] })
      .then(function (g) {
        var hostid = g && g[0] && g[0].hosts && g[0].hosts[0] ? g[0].hosts[0].hostid : null;
        if (!hostid) throw new Error("找不到该图形所属主机");
        return selectGraphHost(hostid);
      }).catch(function (e) {
        toast("图形加载失败：" + e.message);
      });
    return;
  }

  if (!S.graph.hostid) {
    var best = null, bc = -1e9;
    S.hosts.forEach(function (x) {
      var c = S.rows.filter(function (r) { return r.hostid === x.hostid; }).length;
      /* 优先选"有警且可达"的主机，避免默认落在采集不可达、没有新数据的设备上 */
      var score = c - (hostUnreach(x) ? 1000 : 0) - (String(x.status) === "1" ? 1000 : 0);
      if (score > bc) { bc = score; best = x; }
    });
    selectGraphHost((best || S.hosts[0] || {}).hostid);
  }
}

function loadItemPage(itemid) {
  showView("graphs");
  S.graph.pendingItem = itemid;
  rpc("item.get", { itemids: [itemid], output: ["itemid", "hostid", "name"] }).then(function (its) {
    var it = (its || [])[0];
    if (!it) throw new Error("找不到该监控项");
    return selectGraphHost(it.hostid);
  }).catch(function (e) {
    toast("监控项加载失败：" + e.message);
  });
}

/* 深链： #items/<id1>,<id2>,... 用于分享"某端口收发对比" */
function loadItemsPage(arg) {
  var ids = String(arg || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return;
  showView("graphs");
  S.graph.pendingItems = ids;
  rpc("item.get", { itemids: ids, output: ["itemid", "hostid"] }).then(function (its) {
    if (!its || !its.length) throw new Error("找不到这些监控项");
    return selectGraphHost(its[0].hostid);
  }).catch(function (e) {
    toast("监控项加载失败：" + e.message);
  });
}

function renderGraphHosts() {
  var box = $("gHostList");
  if (!box) return;
  var q = S.graph.hostQ.trim().toLowerCase();
  var cnt = {};
  S.rows.forEach(function (r) { cnt[r.hostid] = (cnt[r.hostid] || 0) + 1; });

  var list = S.hosts.filter(function (x) {
    if (!q) return true;
    var blob = [x.host, x.name, hostIps(x).join(" "), (x.hostgroups || []).map(function (g) { return g.name; }).join(" ")].join(" ").toLowerCase();
    return blob.indexOf(q) >= 0;
  }).sort(function (a, b) {
    var pa = cnt[a.hostid] || 0, pb = cnt[b.hostid] || 0;
    if (pa !== pb) return pb - pa;
    return a.host.localeCompare(b.host);
  });

  $("gHostCount").textContent = list.length + " / " + S.hosts.length;
  box.innerHTML = list.slice(0, 300).map(function (x) {
    var fl = hostFlag(x);
    var on = x.hostid === S.graph.hostid;
    return '<div class="ghitem' + (on ? " on" : "") + '" data-hid="' + h(x.hostid) + '" title="' + h(x.host) + '">' +
      '<span class="dot" style="background:' + fl.dot + '"></span>' +
      '<span class="nm">' + h(x.host) + "</span>" +
      '<span class="n">' + (cnt[x.hostid] || "") + "</span></div>";
  }).join("") || '<div class="empty">没有匹配的主机</div>';

  Array.prototype.forEach.call(box.querySelectorAll(".ghitem"), function (el) {
    el.onclick = function () {
      if (location.hash !== "#graphs") history.replaceState(null, "", "#graphs");
      selectGraphHost(el.getAttribute("data-hid"));
    };
  });
}

/* 默认图形：优先选当前有真实流量的端口图，避免落在空图上 */
function defaultGraph() {
  var traffic = S.graph.graphs.filter(function (g) { return /traffic|流量/i.test(g.name); });
  var pool = traffic.length ? traffic : S.graph.graphs;
  var best = null, bestScore = -1;
  pool.forEach(function (g) {
    var score = 0;
    var m = /^([^:]+):/.exec(g.name);
    var token = m ? m[1].trim() : "";
    if (token) {
      S.graph.items.forEach(function (it) {
        if (String(it.name).indexOf(token) >= 0 && num(it.lastclock) > 0) {
          score = Math.max(score, num(it.lastvalue));
        }
      });
    }
    if (score > bestScore) { bestScore = score; best = g; }
  });
  return best || S.graph.graphs[0];
}

function selectGraphHost(hostid) {
  if (!hostid) return Promise.resolve();
  S.graph.hostid = hostid;
  try { localStorage.setItem("zbx.graphHost", hostid); } catch (e) {}
  syncRangeSeg();
  renderGraphHosts();
  $("graphTitle").textContent = (S.hostById[hostid] || {}).host || "加载中…";
  renderGraphHostProblems(hostid);
  $("gList").innerHTML = '<div class="empty">读取图形与监控项…</div>';
  S.graph.curGraph = null;
  S.graph.curItems = [];
  S.graph.selItems = [];
  hideGraphWarn();

  return Promise.all([
    rpc("graph.get", {
      hostids: [hostid], output: ["graphid", "name", "graphtype", "width", "height"], limit: 500
    }).catch(function () { return []; }),
    rpc("item.get", {
      hostids: [hostid],
      output: ["itemid", "name", "key_", "units", "value_type", "lastvalue", "lastclock",
               "status", "state", "error"],
      filter: { value_type: [0, 3] },
      limit: 2000
    }).catch(function () { return []; })
  ]).then(function (r) {
    S.graph.graphs = (r[0] || []).sort(function (a, b) {
      var sa = /traffic|流量/i.test(a.name) ? 0 : 1, sb = /traffic|流量/i.test(b.name) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return String(a.name).localeCompare(String(b.name));
    });
    S.graph.items = (r[1] || []).filter(function (i) { return String(i.status) === "0"; });
    S.graph.peerMap = buildPeerMap(S.graph.items);
    renderGraphList();

    if (S.graph.pendingItems && S.graph.pendingItems.length) {
      var pids = S.graph.pendingItems;
      S.graph.pendingItems = null;
      setGraphMode("items");
      return selectItemChart(pids);
    }

    if (S.graph.pendingItem) {
      var pi = S.graph.pendingItem;
      S.graph.pendingItem = null;
      setGraphMode("items");
      return selectItemChart([pi]);
    }

    var target = S.graph.pendingGraphid;
    S.graph.pendingGraphid = null;
    var g = target ? S.graph.graphs.filter(function (x) { return x.graphid === target; })[0] : null;
    if (g) return selectNativeGraph(g.graphid);
    var dg = defaultGraph();
    if (dg) return selectNativeGraph(dg.graphid);
    if (S.graph.items.length) return selectItemChart([S.graph.items[0].itemid]);
    $("graphTitle").textContent = "没有可绘制的图形";
    clearChart('<div class="empty">该主机没有原生图形，也没有数值监控项</div>');
  }).catch(function (e) {
    S.graph.items = [];
    renderGraphList();
    clearChart('<div class="empty">加载失败：' + h(e.message) + "</div>");
  });
}

function setGraphMode(mode) {
  S.graph.mode = mode;
  Array.prototype.forEach.call(document.querySelectorAll("#gMode button"), function (b) {
    b.classList.toggle("on", b.getAttribute("data-gmode") === mode);
  });
  renderGraphList();
}

/* 已选序列工具条：勾选不立即绘图，点"对比绘制"才发请求，避免每勾一项打一次 API */
function renderSelBar() {
  var bar = $("gSelBar");
  if (!bar) return;
  if (S.graph.mode !== "items") { bar.style.display = "none"; return; }
  bar.style.display = "flex";

  var byId = {};
  S.graph.items.forEach(function (i) { byId[i.itemid] = i; });
  var chips = S.graph.selItems.map(function (id) {
    var it = byId[id];
    if (!it) return "";
    return '<span class="selchip" title="' + h(it.name) + '">' + h(shortName(it.name)) +
      '<button data-rm="' + h(id) + '" title="移除">×</button></span>';
  }).join("");

  bar.innerHTML =
    '<div class="selinfo">' + (S.graph.selItems.length
      ? '<b>' + S.graph.selItems.length + '</b> 项已选' + chips
      : '<span class="muted">勾选监控项后可多选对比（最多 8 项）；带 ⇄ 的项可一键配对收发</span>') + "</div>" +
    '<div class="selact">' +
      '<button class="btn2 primary" id="gDraw"' + (S.graph.selItems.length ? "" : " disabled") + ">对比绘制" +
      (S.graph.selItems.length ? " (" + S.graph.selItems.length + ")" : "") + "</button>" +
      '<button class="btn2" id="gClearSel"' + (S.graph.selItems.length ? "" : " disabled") + ">清空</button>" +
    "</div>";
}

function shortName(s) {
  s = String(s);
  return s.length > 18 ? s.slice(0, 17) + "…" : s;
}

function toggleSel(itemid) {
  var i = S.graph.selItems.indexOf(itemid);
  if (i >= 0) S.graph.selItems.splice(i, 1);
  else {
    if (S.graph.selItems.length >= 8) { toast("最多同时对比 8 个监控项"); return; }
    S.graph.selItems.push(itemid);
  }
  renderGraphList();
}

function addPair(itemid) {
  var peer = S.graph.peerMap[itemid];
  if (!peer) { toast("没有找到对应的收/发监控项"); return; }
  var ids = [itemid, peer].filter(function (v, i, a) { return a.indexOf(v) === i; });
  selectItemChart(ids);
}

function renderGraphList() {
  var box = $("gList");
  if (!box) return;
  var q = S.graph.listQ.trim().toLowerCase();
  var mode = S.graph.mode;
  renderSelBar();

  if (mode === "graphs") {
    var gs = S.graph.graphs.filter(function (g) { return !q || String(g.name).toLowerCase().indexOf(q) >= 0; });
    $("gListMeta").textContent = "graph.get · " + gs.length + " 张";
    box.innerHTML = gs.slice(0, 400).map(function (g) {
      var on = g.graphid === S.graph.curGraph;
      var type = String(g.graphtype) === "1" ? "堆叠" : String(g.graphtype) === "2" ? "饼图" : "折线";
      return '<div class="glrow' + (on ? " on" : "") + '" data-gid="' + h(g.graphid) + '">' +
        '<span class="nm" title="' + h(g.name) + '">' + h(g.name) + "</span>" +
        '<span class="tag">' + type + "</span></div>";
    }).join("") || '<div class="empty">没有匹配的图形</div>';

    Array.prototype.forEach.call(box.querySelectorAll("[data-gid]"), function (el) {
      el.onclick = function () { selectNativeGraph(el.getAttribute("data-gid")); };
    });
    return;
  }

  var its = S.graph.items.filter(function (i) {
    if (S.graph.onlyData && !num(i.lastclock)) return false;
    return !q || (String(i.name) + " " + String(i.key_)).toLowerCase().indexOf(q) >= 0;
  }).sort(function (a, b) {
    var ha = HEALTH[itemHealth(a)].rank, hb = HEALTH[itemHealth(b)].rank;
    if (ha !== hb) return hb - ha;
    return String(a.name).localeCompare(String(b.name));
  });

  var badCnt = S.graph.items.filter(function (i) { return itemHealth(i) !== "ok"; }).length;
  $("gListMeta").textContent = "item.get · " + its.length + " 项" + (badCnt ? " · 异常 " + badCnt : "");

  var sel = {};
  S.graph.selItems.forEach(function (id) { sel[id] = true; });

  box.innerHTML = (its.slice(0, 400).map(function (i) {
    var hk = itemHealth(i);
    var meta = HEALTH[hk];
    var peer = S.graph.peerMap[i.itemid];
    var tag = hk === "ok"
      ? '<span class="tag ok">' + h(fmtVal(i.lastvalue, i.units)) + "</span>"
      : '<span class="tag bad" title="' + h(i.error || "") + '">' + h(meta.label) + "</span>";
    return '<div class="glrow item' + (sel[i.itemid] ? " checked" : "") + '" data-iid="' + h(i.itemid) + '">' +
      '<input type="checkbox" class="gchk" data-chk="' + h(i.itemid) + '"' + (sel[i.itemid] ? " checked" : "") + ">" +
      '<span class="nm" title="' + h(i.name) + '">' + h(i.name) + "</span>" +
      (peer ? '<button class="pairbtn" data-pair="' + h(i.itemid) + '" title="同时选中收/发两项">⇄</button>' : "") +
      tag + "</div>";
  }).join("") || '<div class="empty">没有匹配的监控项</div>') +
    (its.length > 400 ? '<div class="foot-note">共 ' + its.length + ' 项，仅显示前 400 项，可用搜索缩小范围</div>' : "");

  Array.prototype.forEach.call(box.querySelectorAll(".glrow.item"), function (el) {
    el.onclick = function (ev) {
      if (ev.target.closest(".gchk") || ev.target.closest(".pairbtn")) return;
      selectItemChart([el.getAttribute("data-iid")]);
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll(".gchk"), function (el) {
    el.onclick = function (ev) {
      ev.stopPropagation();
      toggleSel(el.getAttribute("data-chk"));
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll(".pairbtn"), function (el) {
    el.onclick = function (ev) {
      ev.stopPropagation();
      addPair(el.getAttribute("data-pair"));
    };
  });
}

function clearChart(html) {
  if (S.graph.chart) {
    try { S.graph.chart.dispose(); } catch (e) {}
    S.graph.chart = null;
  }
  var box = $("chartBox");
  if (!box) return;
  box.innerHTML = html;
}

function selectNativeGraph(graphid) {
  S.graph.curGraph = graphid;
  S.graph.curItems = [];
  S.graph.selItems = [];
  hideGraphWarn();
  renderGraphList();
  var g = S.graph.graphs.filter(function (x) { return x.graphid === graphid; })[0] || {};
  $("graphTitle").textContent = g.name || "读取图形…";
  clearChart('<div class="empty">读取图形项…</div>');

  return rpc("graph.get", {
    graphids: [graphid], output: "extend",
    selectGraphItems: ["gitemid", "itemid", "color", "yaxisside", "calc_fnc", "drawtype", "type"]
  }).then(function (rows) {
    var gr = (rows || [])[0];
    if (!gr) throw new Error("graph.get 没有返回该图形");
    var gitems = gr.gitems || [];
    var ids = gitems.map(function (x) { return x.itemid; }).filter(function (x) { return x && x !== "0"; });
    if (!ids.length) {
      clearChart('<div class="empty">该图形没有任何图形项</div>');
      return;
    }
    return rpc("item.get", {
      itemids: ids,
      output: ["itemid", "name", "key_", "units", "value_type", "lastvalue", "lastclock",
               "status", "state", "error"]
    }).then(function (items) {
      var map = {};
      (items || []).forEach(function (i) { map[i.itemid] = i; });
      var metas = gitems.filter(function (gi) { return map[gi.itemid]; }).map(function (gi) {
        var it = map[gi.itemid];
        return {
          itemid: it.itemid, name: it.name, key: it.key_, units: it.units,
          vt: String(it.value_type), lastvalue: it.lastvalue, lastclock: it.lastclock,
          health: itemHealth(it), error: it.error || "",
          color: gi.color ? "#" + gi.color : null,
          side: String(gi.yaxisside || "0"),
          calc: String(gi.calc_fnc || "2"),
          drawtype: String(gi.drawtype || "0")
        };
      });
      return drawSeries(metas, String(gr.graphtype || "0"), gr.name, {
        kind: "graph", graphid: graphid, gitems: gitems.length
      });
    });
  }).catch(function (e) {
    clearChart('<div class="empty">图形取数失败：' + h(e.message) + "</div>");
  });
}

function selectItemChart(itemids) {
  itemids = (itemids || []).filter(Boolean);
  if (itemids.length > 8) {
    toast("最多同时对比 8 个监控项，已截取前 8 个");
    itemids = itemids.slice(0, 8);
  }
  S.graph.curGraph = null;
  S.graph.curItems = itemids.slice();
  S.graph.selItems = itemids.slice();
  renderGraphList();
  clearChart('<div class="empty">读取监控项…</div>');

  return rpc("item.get", {
    itemids: itemids,
    output: ["itemid", "name", "key_", "units", "value_type", "lastvalue", "lastclock",
             "hostid", "status", "state", "error"]
  }).then(function (items) {
    /* item.get 不保证按传入顺序返回，这里按 itemids 的顺序重排，颜色才稳定 */
    var byId = {};
    (items || []).forEach(function (it) { byId[it.itemid] = it; });
    var ordered = itemids.map(function (id) { return byId[id]; }).filter(Boolean);

    var metas = ordered.map(function (it, idx) {
      return {
        itemid: it.itemid, name: it.name, key: it.key_, units: it.units,
        vt: String(it.value_type), lastvalue: it.lastvalue, lastclock: it.lastclock,
        health: itemHealth(it), error: it.error || "", hostid: it.hostid,
        color: GRAPH_COLORS[idx % GRAPH_COLORS.length], side: "0", calc: "2", drawtype: "0"
      };
    });
    if (!metas.length) throw new Error("没有找到该监控项");
    $("graphTitle").textContent = metas.length === 1 ? metas[0].name : metas.length + " 个监控项对比";
    return drawSeries(metas, "0", $("graphTitle").textContent, { kind: "item" });
  }).catch(function (e) {
    clearChart('<div class="empty">监控项取数失败：' + h(e.message) + "</div>");
  });
}

/* ================= 序列取数 =================
   两种取数口径：
   1) fetchRange  —— 按用户选择的时间区间查 history/trend；
   2) fetchRecent —— 不带时间窗，取"最后 N 个点"，用于设备停采后仍能查看历史。
   两者输出同一结构，交给 renderSeries 统一绘制。
*/
function numericMetas(metas) {
  return metas.filter(function (m) { return m.vt === "0" || m.vt === "3"; });
}

function fetchRange(metas, rg) {
  var groups = {};
  numericMetas(metas).forEach(function (m) {
    (groups[m.vt] = groups[m.vt] || []).push(m.itemid);
  });
  var vts = Object.keys(groups);
  if (!vts.length) return Promise.reject(new Error("所选序列不是数值类型，无法绘制趋势"));

  var reqs = vts.map(function (vt) {
    var p = { itemids: groups[vt], time_from: rg.from, time_till: rg.to, limit: 5000 };
    if (rg.useTrend) return rpc("trend.get", p);
    p.history = Number(vt);
    p.sortfield = "clock";
    p.sortorder = "ASC";
    return rpc("history.get", p);
  });

  return Promise.all(reqs).then(function (results) {
    var byItem = {}, total = 0;
    results.forEach(function (rows, idx) {
      var vt = vts[idx];
      (rows || []).forEach(function (r) {
        var v;
        if (rg.useTrend) {
          var meta = metas.filter(function (m) { return m.itemid === r.itemid; })[0] || {};
          var calc = meta.calc;
          v = num(calc === "1" ? r.value_min : (calc === "4" ? r.value_max : r.value_avg));
        } else {
          v = num(r.value);
        }
        (byItem[r.itemid] = byItem[r.itemid] || []).push([num(r.clock) * 1000, v]);
        total++;
      });
    });
    return { byItem: byItem, total: total, source: rg.useTrend ? "trend.get" : "history.get" };
  });
}

/* 最近数据：先 history（原始值），空则 trend（小时聚合）。
   history 的 type 必须与 value_type 一致，否则会静默返回空数组。 */
function fetchRecent(metas, limitPer) {
  limitPer = limitPer || 160;
  var list = numericMetas(metas);
  var jobs = list.map(function (m) {
    return rpc("history.get", {
      itemids: [m.itemid], history: Number(m.vt),
      sortfield: "clock", sortorder: "DESC", limit: limitPer
    }).then(function (rows) {
      if (rows && rows.length) return { m: m, rows: rows.slice().reverse(), src: "history" };
      return rpc("trend.get", {
        itemids: [m.itemid], limit: limitPer,
        sortfield: "clock", sortorder: "DESC"
      }).then(function (tr) {
        return { m: m, rows: (tr || []).slice().reverse(), src: "trend" };
      }).catch(function () { return { m: m, rows: [], src: "trend" }; });
    }).catch(function () { return { m: m, rows: [], src: "history" }; });
  });

  return Promise.all(jobs).then(function (res) {
    var byItem = {}, total = 0, lastClock = 0, srcs = {};
    res.forEach(function (x) {
      if (!x.rows.length) return;
      srcs[x.src] = true;
      x.rows.forEach(function (r) {
        var v = x.src === "trend" ? num(r.value_avg) : num(r.value);
        (byItem[x.m.itemid] = byItem[x.m.itemid] || []).push([num(r.clock) * 1000, v]);
        total++;
      });
      var c = num(x.rows[x.rows.length - 1].clock);
      if (c > lastClock) lastClock = c;
    });
    return {
      byItem: byItem, total: total, lastClock: lastClock,
      source: Object.keys(srcs).sort().join(" + ") || "history.get"
    };
  });
}

function renderEmptyChart(metas, rg, recentTried) {
  var bad = metas.filter(function (m) { return m.health && m.health !== "ok"; });
  var html = '<div class="empty" style="line-height:1.9">' +
    (recentTried
      ? "所选区间没有数据，且该监控项<b>没有任何历史记录</b>（可能从未采集成功）。"
      : "所选区间没有数据。历史保留期可能已过，或对应 history/trend 未开启。") +
    (bad.length ? "<br>采集状态：" + bad.map(function (m) {
      return h(m.name) + " · " + h(healthLabel(m.health)) + (m.error ? "（" + h(m.error) + "）" : "");
    }).join("<br>") : "") +
    '<br><span class="muted">请求区间 ' + fmtTime(rg.from) + " 至 " + fmtTime(rg.to) +
    "，数据源 " + (rg.useTrend ? "trend.get" : "history.get") + "</span></div>";
  clearChart(html);
  $("sourceNote").textContent = "区间 " + fmtTime(rg.from) + " → " + fmtTime(rg.to) + " 无数据。";
}

/* ================= 绘制 ================= */
function drawSeries(metas, graphtype, title, info) {
  if (!window.echarts) {
    clearChart('<div class="empty">ECharts 未加载（vendor/echarts.min.js）</div>');
    return;
  }
  var rg = rangeFromTo();
  if (!numericMetas(metas).length) {
    clearChart('<div class="empty">所选序列不是数值类型，无法绘制趋势（文本/日志类请到主机详情查看）</div>');
    return;
  }

  clearChart('<div class="empty">读取 ' + (rg.useTrend ? "trend.get（小时聚合）" : "history.get（原始值）") + "…</div>");
  hideGraphWarn();

  return fetchRange(metas, rg).then(function (res) {
    if (res.total) {
      return renderSeries(res.byItem, metas, graphtype, title, info, {
        fallback: false, source: res.source, total: res.total, rg: rg
      });
    }
    /* 区间无点：不要直接报"没有数据"，先看看这个监控项历史上到底有没有值。
       这台环境里的 11.28 温湿度就是典型：当前采集失败，但 10-13 还有数据。 */
    clearChart('<div class="empty">该区间无数据，正在查找最近一次采集…</div>');
    return fetchRecent(metas, 160).then(function (rec) {
      if (!rec.total) return renderEmptyChart(metas, rg, true);
      renderSeries(rec.byItem, metas, graphtype, title, info, {
        fallback: true, source: rec.source, total: rec.total, rg: rg, lastClock: rec.lastClock
      });
    });
  }).catch(function (e) {
    clearChart('<div class="empty">取数失败：' + h(e.message) + "</div>");
  });
}

function renderSeries(byItem, metas, graphtype, title, info, ctx) {
  var series = metas.filter(function (m) { return byItem[m.itemid] && byItem[m.itemid].length; });
  if (!series.length) return;

  var units = series[0].units || "";
  var box = $("chartBox");
  if (!box) return;
  if (S.graph.chart) { try { S.graph.chart.dispose(); } catch (e) {} }
  box.innerHTML = "";
  var chart = echarts.init(box, null, { renderer: "canvas" });
  S.graph.chart = chart;

  var stacked = String(graphtype) === "1";
  var isPie = String(graphtype) === "2";
  var option;

  if (isPie) {
    var pdata = series.map(function (s) {
      var arr = byItem[s.itemid] || [];
      var sum = arr.reduce(function (a, b) { return a + b[1]; }, 0);
      return { name: s.name, value: arr.length ? sum / arr.length : 0, itemStyle: { color: s.color || "#00A9C7" } };
    });
    option = {
      animation: false,
      tooltip: { trigger: "item", valueFormatter: function (v) { return fmtVal(v, units); } },
      legend: { type: "scroll", bottom: 0, textStyle: { fontSize: 10 } },
      series: [{
        type: "pie", radius: ["38%", "68%"], center: ["50%", "48%"],
        data: pdata, label: { fontSize: 10, formatter: "{b}\n{d}%" }
      }]
    };
  } else {
    /* 多序列可能来自不同单位（如温度 °C + 湿度 %）。有第二种单位就自动开右轴，
       否则 Zabbix 那种"一条 23.8、一条 76"画在同一轴上会把温度压成一条直线。 */
    var unitsList = [];
    series.forEach(function (s) {
      var u = s.units || "";
      if (unitsList.indexOf(u) < 0) unitsList.push(u);
    });
    var multiUnit = unitsList.length > 1;
    var hasRight = series.some(function (s) { return s.side === "1"; }) || multiUnit;
    var rightUnit = multiUnit ? unitsList[1] : unitsList[0];
    var unitByName = {};
    series.forEach(function (s) { unitByName[s.name] = s.units || ""; });
    function axisOf(s) {
      if (multiUnit) return (s.units || "") === unitsList[1] ? 1 : 0;
      return s.side === "1" && hasRight ? 1 : 0;
    }
    var colors = series.map(function (s, i) { return s.color || GRAPH_COLORS[i % GRAPH_COLORS.length]; });
    option = {
      animation: false,
      color: colors,
      grid: { left: 56, right: hasRight ? 64 : 18, top: series.length > 4 ? 62 : 46, bottom: 42 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: function (ps) {
          if (!ps || !ps.length) return "";
          var d = new Date(ps[0].value[0]);
          var head = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
            pad2(d.getHours()) + ":" + pad2(d.getMinutes());
          return head + ps.map(function (p) {
            return "<br/>" + p.marker + h(p.seriesName) + " <b>" +
              h(fmtVal(p.value[1], unitByName[p.seriesName] || "")) + "</b>";
          }).join("");
        }
      },
      legend: { show: series.length > 1, type: "scroll", top: 2, left: 0, right: 0, itemWidth: 12, itemHeight: 3, textStyle: { fontSize: 10.5, color: "#54677B" } },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: "#D8E2EA" } },
        axisLabel: { fontSize: 10, color: "#93A1AE" },
        splitLine: { show: false }
      },
      yAxis: [{
        type: "value", name: unitsList[0] || "",
        nameLocation: "end", nameGap: 12,
        nameTextStyle: {
          fontSize: 10, color: "#7C8B99", align: "left",
          padding: [0, 0, 0, -2]
        },
        axisLabel: { fontSize: 10, color: "#93A1AE", formatter: function (v) { return fmtVal(v, ""); } },
        splitLine: { lineStyle: { color: "#EEF3F7" } }
      }].concat(hasRight ? [{
        type: "value", name: rightUnit || "",
        nameLocation: "end", nameGap: 12,
        nameTextStyle: {
          fontSize: 10, color: "#7C8B99", align: "right",
          padding: [0, 0, 0, 2]
        },
        axisLabel: { fontSize: 10, color: "#93A1AE", formatter: function (v) { return fmtVal(v, ""); } },
        splitLine: { show: false }
      }] : []),
      dataZoom: [{ type: "inside", filterMode: "none" }],
      series: series.map(function (s) {
        return {
          name: s.name,
          type: "line",
          yAxisIndex: axisOf(s),
          showSymbol: false,
          symbol: "none",
          sampling: "lttb",
          lineStyle: { width: 1.5, type: s.drawtype === "1" ? "dashed" : "solid" },
          areaStyle: stacked ? { opacity: 0.28 } : null,
          stack: stacked ? "total" : null,
          emphasis: { focus: "series" },
          data: byItem[s.itemid]
        };
      })
    };
  }
  chart.setOption(option);

  /* 统计按单位分组算，避免出现"湿度 76 °C"这种错误口径 */
  var statGroups = [];
  (function () {
    var seen = {};
    series.forEach(function (s) {
      var u = s.units || "";
      if (seen[u]) return;
      seen[u] = true;
      statGroups.push({ unit: u, list: series.filter(function (x) { return (x.units || "") === u; }) });
    });
  })();

  function calcStats(list) {
    var vals = [], lastTs2 = 0, lastV = 0;
    list.forEach(function (s) {
      var arr = byItem[s.itemid] || [];
      arr.forEach(function (p) { vals.push(p[1]); });
      if (arr.length && arr[arr.length - 1][0] >= lastTs2) {
        lastTs2 = arr[arr.length - 1][0];
        lastV = arr[arr.length - 1][1];
      }
    });
    return {
      last: lastV, lastTs: lastTs2,
      peak: vals.length ? Math.max.apply(null, vals) : 0,
      avg: vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0
    };
  }
  var stats = statGroups.map(function (g) { return { unit: g.unit, s: calcStats(g.list) }; });
  function joinStat(key) {
    return stats.map(function (x) { return fmtVal(x.s[key], x.unit); }).join(" / ");
  }
  var multiStat = stats.length > 1 ? ' class="v vm"' : ' class="v"';
  var lastTs = Math.max.apply(null, stats.map(function (x) { return x.s.lastTs; }).concat([0]));

  $("gLatest").innerHTML = '<span' + multiStat + ">" + h(joinStat("last")) + "</span>";
  $("gPeak").innerHTML = '<span' + multiStat + ">" + h(joinStat("peak")) + "</span>";
  $("gAvg").innerHTML = '<span' + multiStat + ">" + h(joinStat("avg")) + "</span>";
  $("gPoints").textContent = ctx.total.toLocaleString();

  $("chartLegend").innerHTML = series.map(function (s) {
    var hb = s.health && s.health !== "ok" ? ' <em class="lgbad">' + h(healthLabel(s.health)) + "</em>" : "";
    return '<span><i style="background:' + (s.color || "#00A9C7") + '"></i>' + h(s.name) + hb + "</span>";
  }).join("");

  var interval = "—";
  var firstArr = byItem[series[0].itemid] || [];
  if (!ctx.fallback && ctx.source === "history.get" && firstArr.length > 2) {
    interval = Math.round((firstArr[firstArr.length - 1][0] - firstArr[0][0]) / 1000 / (firstArr.length - 1)) + " 秒";
  }
  var unitText = (typeof unitsList !== "undefined" && unitsList && unitsList.length)
    ? unitsList.join(" / ") : (units || "—");

  if (ctx.fallback) {
    var ft = fmtTime(ctx.lastClock);
    showGraphWarn("所选区间（" + rangeLabel() + "）没有数据。该监控项<b>最近一次采集是 " + ft + "</b>，已回退绘制最近 " +
      ctx.total + " 个数据点。当前采集状态：" + healthSummaryText(metas) + "。");
    $("sourceNote").innerHTML = "数据源 <b>" + h(ctx.source) + "</b> · <b>最近数据</b>（非所选区间） · 最后一点 <b>" +
      ft + "</b> · " + series.length + " 个序列 · <b>" + ctx.total.toLocaleString() + "</b> 点";
  } else {
    var spanTxt = S.graph.range === "custom" ? (fmtTime(ctx.rg.from) + " → " + fmtTime(ctx.rg.to)) : S.graph.range;
    $("sourceNote").innerHTML = "数据源 <b>" + h(ctx.source) + "</b> · 区间 <b>" + h(spanTxt) +
      "</b> · " + series.length + " 个序列 · <b>" + ctx.total.toLocaleString() + "</b> 点" +
      (!ctx.rg.useTrend ? " · 采集间隔约 " + interval : " · 小时聚合（" + h(unitText || "值") + "）");
  }

  $("itemMeta").innerHTML =
    "<dt>" + (info && info.kind === "graph" ? "图形" : "序列") + "</dt><dd>" + h(title) + "</dd>" +
    "<dt>graphid</dt><dd>" + (info && info.graphid ? info.graphid : "—") + "</dd>" +
    "<dt>类型</dt><dd>" + (isPie ? "饼图" : stacked ? "堆叠" : "折线") + "</dd>" +
    "<dt>序列</dt><dd>" + series.length + " / " + metas.length + "</dd>" +
    "<dt>单位</dt><dd>" + h(unitText) + "</dd>" +
    "<dt>数据源</dt><dd>" + h(ctx.source) + (ctx.fallback ? "（最近数据）" : "") + "</dd>" +
    "<dt>采样点</dt><dd>" + ctx.total.toLocaleString() + "</dd>" +
    "<dt>最新时刻</dt><dd>" + (lastTs ? fmtTime(lastTs / 1000) : "—") + "</dd>";

  $("gSourceNote").innerHTML = ctx.fallback
    ? "所选区间无点，已回退到 <b>最近数据</b>。回退查询不限制时间窗（history 取最后 160 点，空则用 trend）。"
    : (ctx.rg.useTrend
      ? "区间超过 24 小时，自动使用 <b>trend.get</b> 小时聚合值；趋势默认保留 365 天。"
      : "区间不超过 24 小时，使用 <b>history.get</b> 原始值（history 必须与 value_type 一致：float=0 / uint=3）。若为空，会自动回退查询最近数据。");
}

function rangeLabel() {
  if (S.graph.range === "custom") return fmtTime(S.graph.customFrom) + " → " + fmtTime(S.graph.customTo);
  return S.graph.range;
}

function showGraphWarn(html) {
  var el = $("graphWarn");
  if (!el) return;
  el.innerHTML = html;
  el.style.display = "block";
}
function hideGraphWarn() {
  var el = $("graphWarn");
  if (el) { el.style.display = "none"; el.innerHTML = ""; }
}

function renderGraphHostProblems(hostid) {
  var rows = S.rows.filter(function (r) { return r.hostid === hostid; });
  var box = $("graphHostProblems");
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '<div class="foot-note" style="padding:10px 14px">该主机当前无在警问题。</div>';
    return;
  }
  box.innerHTML = rows.map(function (r) {
    return '<div class="notif" style="padding:7px 14px">' +
      '<span class="st" style="background:' + SEV[r.sev].c + '22;color:' + SEV[r.sev].c + '">' + SEV[r.sev].n + "</span>" +
      '<span class="nm" title="' + h(r.title) + '">' + h(r.title) + "</span>" +
      '<span class="tm">' + fmtDur(r.age) + "</span></div>";
  }).join("");
}

/* ================= 拓扑页 =================
   三种模式：
     auto 自动拓扑 —— 真实主机 + 数据推断连线（默认）
     map  原始 sysmap —— 有连线时原样渲染
     plan 规划编辑 —— 拖拽、连线、导出/导入
   连线只影响本页展示，不写回 Zabbix。
*/
var TOPO_NODE_W = 152, TOPO_NODE_H = 42, TOPO_GAP_X = 14, TOPO_GAP_Y = 14;
var TOPO_KIND = {
  map:    { label: "Zabbix 映射图", color: "#7FB3C8", dash: false, conf: 100 },
  manual: { label: "手工规划",     color: "#00A9C7", dash: false, conf: 100 },
  lldp:   { label: "LLDP/CDP 邻居", color: "#8E6BD6", dash: true,  conf: 90 },
  subnet: { label: "同网段推断",   color: "#B7C6D4", dash: true,  conf: 60 }
};

function topoPlanKey() { return "zbx.topo.plan.v1." + (PROFILE || "default"); }
function loadPlan() {
  var p = { nodes: {}, links: [] };
  try {
    var raw = localStorage.getItem(topoPlanKey());
    if (raw) p = JSON.parse(raw) || p;
  } catch (e) {}
  if (!p.nodes) p.nodes = {};
  if (!p.links) p.links = [];
  if (!p.hidden) p.hidden = [];
  return p;
}
function savePlan() {
  try { localStorage.setItem(topoPlanKey(), JSON.stringify(S.topo.plan)); } catch (e) {}
}

function isNetDevice(x) {
  return /(^|[-_\s])(SW|CORE|FW|RT|AP)[-_]|switch|交换机|防火墙|router|路由|核心/i.test(String(x.host));
}

function loadLldp() {
  if (S.topo.lldp) return Promise.resolve(S.topo.lldp);
  function q(key) {
    return rpc("item.get", {
      output: ["itemid", "hostid", "name", "key_", "lastvalue"],
      search: { key_: key }, limit: 300
    }).catch(function () { return []; });
  }
  return Promise.all([q("lldp"), q("cdp")]).then(function (r) {
    var seen = {}, out = [];
    (r[0] || []).concat(r[1] || []).forEach(function (it) {
      if (seen[it.itemid]) return;
      seen[it.itemid] = 1;
      if (String(it.lastvalue || "").trim().length >= 4) out.push(it);
    });
    S.topo.lldp = out;
    return out;
  });
}

function loadTopo(force) {
  if (S.topo.loaded && !force) { renderTopoPage(); return Promise.resolve(); }
  var wrap = $("mapWrap");
  if (wrap) wrap.innerHTML = '<div class="map-empty">读取 map.get / 主机接口…</div>';
  S.topo.plan = loadPlan();

  return Promise.all([
    rpc("map.get", {
      output: ["sysmapid", "name", "width", "height"],
      selectSelements: "extend", selectLinks: "extend", selectShapes: "extend"
    }).catch(function () { return []; }),
    loadLldp()
  ]).then(function (r) {
    S.topo.maps = r[0] || [];
    S.topo.map = S.topo.maps[0] || null;
    S.topo.loaded = true;

    var ids = [];
    ((S.topo.map && S.topo.map.links) || []).forEach(function (l) {
      (l.linktriggers || []).forEach(function (lt) {
        if (lt.triggerid && ids.indexOf(lt.triggerid) < 0) ids.push(lt.triggerid);
      });
    });
    if (!ids.length) { S.topo.linkStatus = {}; return null; }
    return rpc("trigger.get", {
      triggerids: ids, output: ["triggerid", "description", "value", "priority"], limit: 500
    }).then(function (ts) {
      var st = {};
      (ts || []).forEach(function (t) {
        st[t.triggerid] = { value: String(t.value), severity: num(t.priority), description: t.description };
      });
      S.topo.linkStatus = st;
    });
  }).then(function () {
    renderTopoPage();
    renderGroupBars();
    renderUnreach();
    renderUnreachProbs();
  }).catch(function (e) {
    if (wrap) wrap.innerHTML = '<div class="map-empty">拓扑数据读取失败：' + h(e.message) + "</div>";
  });
}

function hostMaxSev(hostid) {
  var s = 0;
  S.rows.forEach(function (r) { if (r.hostid === hostid) s = Math.max(s, r.sev); });
  return s;
}

function topoScopeHosts() {
  var all = S.hosts.slice();
  var list = all.slice();
  var scope = S.topo.group || "net";
  if (scope === "net") {
    list = list.filter(function (x) { return isNetDevice(x) || hostMaxSev(x.hostid) >= 2; });
    /* 非网络环境（比如只有 server + 传感器）不要把图画空 */
    if (!list.length) list = all.slice();
  } else if (scope.indexOf("grp:") === 0) {
    var g = scope.slice(4);
    list = list.filter(function (x) {
      return (x.hostgroups || []).some(function (y) { return y.name === g; });
    });
  }
  if (S.topo.onlyProb) list = list.filter(function (x) { return hostMaxSev(x.hostid) >= 2; });
  list.sort(function (a, b) {
    var sa = hostMaxSev(a.hostid), sb = hostMaxSev(b.hostid);
    if (sa !== sb) return sb - sa;
    return String(a.host).localeCompare(String(b.host));
  });
  return list.slice(0, 80);
}

/* ---- 连线推断 ---- */
function addLink(links, a, b, kind, label) {
  if (!a || !b || a === b) return;
  var key = [a, b].sort().join("|");
  var ex = links.filter(function (l) { return [l.a, l.b].sort().join("|") === key; })[0];
  if (ex) {
    if ((TOPO_KIND[kind] || {}).conf > (TOPO_KIND[ex.kind] || {}).conf) {
      ex.kind = kind; ex.label = label || "";
    }
    return;
  }
  links.push({ a: a, b: b, kind: kind, label: label || "" });
}

function mapLinks(map) {
  if (!map || !map.links || !map.links.length) return [];
  var seHost = {};
  (map.selements || []).forEach(function (s) {
    var hid = null;
    if (s.elements && s.elements[0]) hid = s.elements[0].hostid || s.elements[0].elementid;
    else if (String(s.elementtype) === "0" && s.elementid && s.elementid !== "0") hid = s.elementid;
    seHost[s.selementid] = hid;
  });
  var out = [];
  map.links.forEach(function (l) {
    addLink(out, seHost[l.selementid1], seHost[l.selementid2], "map", "");
  });
  return out;
}

function lldpLinks(hosts) {
  var items = S.topo.lldp || [];
  if (!items.length) return [];
  var byName = {};
  hosts.forEach(function (x) {
    byName[String(x.host).toLowerCase()] = x;
    byName[String(x.name).toLowerCase()] = x;
    (x.interfaces || []).forEach(function (i) { if (i.ip) byName[String(i.ip)] = x; });
  });
  var keys = Object.keys(byName).filter(function (k) { return k.length >= 4; });
  var out = [];
  items.forEach(function (it) {
    var src = S.hostById[it.hostid];
    if (!src) return;
    var v = String(it.lastvalue || "").toLowerCase();
    if (v.length < 4) return;
    var target = null;
    for (var i = 0; i < keys.length; i++) {
      if (v === keys[i] || v.indexOf(keys[i]) >= 0) { target = byName[keys[i]]; break; }
    }
    if (target && target.hostid !== src.hostid) {
      addLink(out, src.hostid, target.hostid, "lldp", it.name);
    }
  });
  return out;
}

function subnetLinks(hosts) {
  var by = {};
  hosts.forEach(function (x) {
    var ip = hostIps(x)[0];
    if (!ip || ip === "127.0.0.1") return;
    var m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip);
    if (!m) return;
    (by[m[1]] = by[m[1]] || []).push(x);
  });
  var out = [];
  Object.keys(by).forEach(function (sub) {
    var list = by[sub];
    if (list.length < 2) return;
    var hub = list.slice().sort(function (a, b) { return hubScore(b) - hubScore(a); })[0];
    list.forEach(function (x) {
      if (x.hostid !== hub.hostid) addLink(out, x.hostid, hub.hostid, "subnet", sub + ".0/24");
    });
  });
  return out;
}

function hubScore(x) {
  var s = 0;
  if (isNetDevice(x)) s += 100;
  s += (x.interfaces || []).filter(function (i) { return String(i.type) === "2"; }).length * 10;
  s += (x.interfaces || []).length;
  if (String(x.status) === "1") s -= 50;
  return s;
}

/* ---- 布局：按交换机前缀/主机组做货架式排布 ---- */
function topoClusterName(x) {
  var m = /^(SW-[A-Za-z0-9]+)/i.exec(String(x.host));
  if (m) return m[1].toUpperCase();
  var m2 = /^(CORE|FW|RT|AP)[-_]/i.exec(String(x.host));
  if (m2) return m2[1].toUpperCase();
  return (x.hostgroups && x.hostgroups[0] && x.hostgroups[0].name) || "未分组";
}

function buildAutoModel(hosts) {
  var clusters = [], byName = {};
  hosts.forEach(function (x) {
    var g = topoClusterName(x);
    if (!byName[g]) { byName[g] = { name: g, hosts: [] }; clusters.push(byName[g]); }
    byName[g].hosts.push(x);
  });
  clusters.sort(function (a, b) {
    var ca = /CORE/i.test(a.name) ? 0 : 1, cb = /CORE/i.test(b.name) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  });

  var MAXW = 1500, PAD = 18, HEAD = 24;
  var x0 = PAD, y0 = PAD, shelfH = 0, maxRight = PAD;

  clusters.forEach(function (c) {
    var n = c.hosts.length;
    var cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(n))));
    var rows = Math.ceil(n / cols);
    var bw = cols * TOPO_NODE_W + (cols - 1) * TOPO_GAP_X;
    var bh = HEAD + rows * TOPO_NODE_H + (rows - 1) * TOPO_GAP_Y;
    if (x0 + bw > MAXW - PAD && x0 > PAD) { x0 = PAD; y0 += shelfH + PAD; shelfH = 0; }
    c.box = { x: x0, y: y0, w: bw, h: bh };
    c.hosts.forEach(function (hh, i) {
      var col = i % cols, row = Math.floor(i / cols);
      hh._x = x0 + col * (TOPO_NODE_W + TOPO_GAP_X);
      hh._y = y0 + HEAD + row * (TOPO_NODE_H + TOPO_GAP_Y);
    });
    maxRight = Math.max(maxRight, x0 + bw);
    x0 += bw + PAD;
    shelfH = Math.max(shelfH, bh);
  });

  var nodes = hosts.map(function (x) {
    var pos = S.topo.plan.nodes[x.hostid];
    return {
      host: x,
      x: pos ? pos.x : x._x,
      y: pos ? pos.y : x._y,
      w: TOPO_NODE_W, h: TOPO_NODE_H
    };
  });

  var links = [];
  mapLinks(S.topo.map).forEach(function (l) { addLink(links, l.a, l.b, l.kind, l.label); });
  lldpLinks(hosts).forEach(function (l) { addLink(links, l.a, l.b, l.kind, l.label); });
  subnetLinks(hosts).forEach(function (l) { addLink(links, l.a, l.b, l.kind, l.label); });
  (S.topo.plan.links || []).forEach(function (l) { addLink(links, l.a, l.b, "manual", "规划"); });

  var ids = {};
  hosts.forEach(function (x) { ids[x.hostid] = 1; });
  var hidden = {};
  (S.topo.plan.hidden || []).forEach(function (k) { hidden[k] = 1; });
  links = links.filter(function (l) {
    return ids[l.a] && ids[l.b] && !hidden[[l.a, l.b].sort().join("|")];
  });

  return {
    W: Math.max(760, Math.min(MAXW, maxRight + PAD)),
    H: y0 + shelfH + PAD,
    nodes: nodes, links: links, clusters: clusters
  };
}

/* ---- 绘制 ---- */
function nodeById(model, id) {
  for (var i = 0; i < model.nodes.length; i++) if (model.nodes[i].host.hostid === id) return model.nodes[i];
  return null;
}

function topoLinkPath(A, B) {
  var ax = A.x + A.w / 2, ay = A.y + A.h / 2;
  var bx = B.x + B.w / 2, by = B.y + B.h / 2;
  if (Math.abs(ay - by) < 8) return "M" + ax + " " + ay + "H" + bx;
  if (Math.abs(ax - bx) < 8) return "M" + ax + " " + ay + "V" + by;
  var my = ay + (by - ay) * 0.5;
  return "M" + ax + " " + ay + "V" + my + "H" + bx + "V" + by;
}

function topoNodeStyle(host) {
  var sev = hostMaxSev(host.hostid);
  var fl = hostFlag(host);
  var dot = fl.dot, stroke = "#C9D6E2", fill = "#FFFFFF", rank = fl.rank;
  if (String(host.status) === "1") { stroke = "#C9D6E2"; fill = "#F7F9FB"; dot = "#BFC9D3"; }
  else if (rank === 2) { stroke = "#E05252"; fill = "#FFF6F6"; }
  else if (sev > 0) { stroke = SEV[sev].c; fill = sev >= 4 ? "#FFF3F2" : "#FFFBF2"; dot = SEV[sev].c; }
  else if (rank === 1) { stroke = "#E8A33D"; fill = "#FFFDF5"; }
  return { sev: sev, fl: fl, stroke: stroke, fill: fill, dot: dot, rank: rank };
}

function paintTopo(model) {
  var wrap = $("mapWrap");
  if (!wrap || !model) return;
  S.topo.model = model;
  var z = S.topo.zoom || 1;
  var s = '<svg viewBox="0 0 ' + model.W + " " + model.H + '" preserveAspectRatio="xMinYMin meet"' +
    ' width="' + Math.round(model.W * z) + '" height="' + Math.round(model.H * z) +
    '" style="display:block;width:' + Math.round(model.W * z) + "px;height:" + Math.round(model.H * z) + 'px">';
  s += '<rect x="0" y="0" width="' + model.W + '" height="' + model.H + '" fill="#FBFCFD"/>';

  (model.clusters || []).forEach(function (c) {
    s += '<rect x="' + c.box.x + '" y="' + c.box.y + '" width="' + c.box.w + '" height="' + c.box.h +
      '" rx="7" fill="#FFFFFF" stroke="#E6EDF3" stroke-dasharray="3 3"/>';
    s += '<text x="' + (c.box.x + 6) + '" y="' + (c.box.y + 15) +
      '" style="font-size:9.5px;fill:#8A99A8">' + h(c.name) + " · " + c.hosts.length + "</text>";
  });

  model.links.forEach(function (l) {
    var A = nodeById(model, l.a), B = nodeById(model, l.b);
    if (!A || !B) return;
    var kind = TOPO_KIND[l.kind] || TOPO_KIND.subnet;
    var sev = Math.max(hostMaxSev(l.a), hostMaxSev(l.b));
    var color = sev >= 1 ? SEV[sev].c : kind.color;
    var width = sev >= 1 ? 2.2 : 1.4;
    var dash = kind.dash ? ' stroke-dasharray="4 4"' : "";
    var tip = kind.label + " · 置信度 " + kind.conf + "%" + (l.label ? " · " + l.label : "") +
      (sev >= 1 ? " · 端点告警：" + SEV[sev].n : "");
    s += '<path class="topo-link" data-kind="' + h(l.kind) + '" data-a="' + h(l.a) + '" data-b="' + h(l.b) + '" d="' + topoLinkPath(A, B) +
      '" fill="none" stroke="' + color + '" stroke-width="' + width + '"' + dash +
      ' style="cursor:pointer"><title>' + h(tip) + "</title></path>";
  });

  model.nodes.forEach(function (n) {
    var st = topoNodeStyle(n.host);
    var name = String(n.host.name || n.host.host);
    if (name.length > 17) name = name.slice(0, 16) + "…";
    var ip = hostIps(n.host)[0] || "";
    var sel = S.topo.sel === n.host.hostid ? " sel" : "";
    s += '<g class="tn-node' + sel + '" data-hid="' + h(n.host.hostid) + '" style="cursor:' +
      (S.topo.mode === "plan" ? "move" : "pointer") + '">';
    s += '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h +
      '" rx="7" fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="' +
      (st.sev >= 3 ? 1.9 : 1.2) + '"/>';
    s += '<text x="' + (n.x + 9) + '" y="' + (n.y + 17) +
      '" style="font-size:10.5px;fill:#33475C">' + h(name) + "</text>";
    if (ip) s += '<text x="' + (n.x + 9) + '" y="' + (n.y + 31) +
      '" style="font-size:9px;fill:#8A99A8">' + h(ip) + "</text>";
    s += '<circle cx="' + (n.x + n.w - 9) + '" cy="' + (n.y + 9) + '" r="3.6" fill="' + st.dot + '"/>';
    s += "</g>";
  });

  if (S.topo.mode === "plan") {
    s += '<text x="10" y="' + (model.H - 8) + '" style="font-size:9px;fill:#A6B4C1">规划模式 · 拖拽移动 · 连线模式点两个节点</text>';
  }
  s += "</svg>";

  wrap.innerHTML = s;
  bindTopoEvents();
  updateZoomLbl();
}

function updateZoomLbl() {
  var el = $("topoZoomLbl");
  if (el) el.textContent = Math.round((S.topo.zoom || 1) * 100) + "%";
}

function svgPointFromEvent(e, svg) {
  var pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  var m = svg.getScreenCTM();
  return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
}

function bindTopoEvents() {
  var wrap = $("mapWrap");
  if (!wrap) return;

  Array.prototype.forEach.call(wrap.querySelectorAll(".tn-node[data-hid]"), function (el) {
    var hid = el.getAttribute("data-hid");
    el.addEventListener("pointerdown", function (e) {
      if (S.topo.mode !== "plan") return;
      var n = nodeById(S.topo.model, hid);
      if (!n) return;
      var svg = wrap.querySelector("svg");
      var p = svgPointFromEvent(e, svg);
      S.topo.drag = { node: n, dx: p.x - n.x, dy: p.y - n.y, moved: false };
      e.preventDefault();
      document.addEventListener("pointermove", onTopoDragMove);
      document.addEventListener("pointerup", onTopoDragEnd);
    });
    el.addEventListener("click", function (e) {
      if (S.topo.drag && S.topo.drag.moved) return;
      if (S.topo.mode !== "plan") { location.hash = "#host/" + hid; return; }
      if (S.topo.deleting) { toast("删除模式只处理连线，请点击连线"); return; }
      if (S.topo.linking) {
        if (!S.topo.pending) { S.topo.pending = hid; toast("已选起点，再点一个节点"); paintTopo(S.topo.model); }
        else if (S.topo.pending !== hid) {
          addManualLink(S.topo.pending, hid);
          S.topo.pending = null;
          renderTopoPage();   // 必须重建模型，否则新连线不在 model 里
        }
        return;
      }
      S.topo.sel = S.topo.sel === hid ? null : hid;
      paintTopo(S.topo.model);
    });
    el.addEventListener("dblclick", function () { location.hash = "#host/" + hid; });
  });

  Array.prototype.forEach.call(wrap.querySelectorAll("path.topo-link"), function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      if (S.topo.mode !== "plan" || !S.topo.deleting) return;
      var a = el.getAttribute("data-a"), b = el.getAttribute("data-b");
      var key = [a, b].sort().join("|");
      var before = S.topo.plan.links.length;
      S.topo.plan.links = S.topo.plan.links.filter(function (l) {
        return [l.a, l.b].sort().join("|") !== key;
      });
      if (S.topo.plan.links.length === before) {
        /* 推断连线：记入 hidden，否则会被同网段规则重新算出来 */
        if ((S.topo.plan.hidden || []).indexOf(key) < 0) S.topo.plan.hidden.push(key);
        toast("已隐藏该推断连线");
      } else {
        toast("已删除规划连线");
      }
      savePlan();
      renderTopoPage();
    });
  });
}

function onTopoDragMove(e) {
  var d = S.topo.drag;
  if (!d) return;
  var svg = $("mapWrap") && $("mapWrap").querySelector("svg");
  if (!svg) return;
  var p = svgPointFromEvent(e, svg);
  d.node.x = Math.max(0, Math.min(S.topo.model.W - d.node.w, p.x - d.dx));
  d.node.y = Math.max(0, Math.min(S.topo.model.H - d.node.h, p.y - d.dy));
  d.moved = true;
  if (!d.raf) {
    d.raf = requestAnimationFrame(function () {
      d.raf = null;
      paintTopo(S.topo.model);
    });
  }
}

function onTopoDragEnd() {
  var d = S.topo.drag;
  document.removeEventListener("pointermove", onTopoDragMove);
  document.removeEventListener("pointerup", onTopoDragEnd);
  if (!d) return;
  if (d.moved) {
    S.topo.plan.nodes[d.node.host.hostid] = { x: d.node.x, y: d.node.y };
    savePlan();
  }
  setTimeout(function () { S.topo.drag = null; }, 0);
}

function addManualLink(a, b) {
  if (!a || !b || a === b) return;
  var dup = (S.topo.plan.links || []).some(function (l) {
    return [l.a, l.b].sort().join("|") === [a, b].sort().join("|");
  });
  if (dup) { toast("这两个节点之间已有规划连线"); return; }
  S.topo.plan.links.push({ a: a, b: b });
  var key = [a, b].sort().join("|");
  S.topo.plan.hidden = (S.topo.plan.hidden || []).filter(function (k) { return k !== key; });
  savePlan();
  toast("已添加规划连线");
}

/* ---- 页面渲染 ---- */
function renderTopoPage() {
  if (!S.topo.plan) S.topo.plan = loadPlan();
  Array.prototype.forEach.call(document.querySelectorAll("#topoMode button"), function (b) {
    b.classList.toggle("on", b.getAttribute("data-tmode") === S.topo.mode);
  });
  renderTopoTools();
  $("mapWrap").className = "mapwrap" + (S.topo.mode === "plan" ? " plan" : "");

  if (S.topo.mode === "map") {
    if (S.topo.map && (S.topo.map.links || []).length) { renderRealMap(S.topo.map); return; }
    $("mapNote").innerHTML = "当前环境的 sysmap " +
      (S.topo.map ? "（" + h(S.topo.map.name) + "）" : "") +
      " 没有连线，无法作为拓扑使用，已回退到<b>自动拓扑</b>。";
    S.topo.mode = "auto";
    Array.prototype.forEach.call(document.querySelectorAll("#topoMode button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-tmode") === "auto");
    });
    renderTopoTools();
  }

  var hosts = topoScopeHosts();
  if (!hosts.length) {
    $("mapWrap").innerHTML = '<div class="map-empty">当前筛选条件下没有主机</div>';
    $("mapTitle").textContent = "自动拓扑";
    $("mapMeta").textContent = "0 节点";
    $("mapFacts").innerHTML = "<dt>节点</dt><dd>0</dd>";
    $("topoSources").textContent = "—";
    return;
  }

  var model = buildAutoModel(hosts);
  if (!S.topo.zoom) S.topo.zoom = defaultTopoZoom(model);
  paintTopo(model);

  var cnt = { map: 0, manual: 0, lldp: 0, subnet: 0 };
  model.links.forEach(function (l) { cnt[l.kind] = (cnt[l.kind] || 0) + 1; });
  var sevNodes = model.nodes.filter(function (n) { return hostMaxSev(n.host.hostid) > 0; }).length;

  $("mapTitle").textContent = S.topo.mode === "plan" ? "拓扑规划" : "自动拓扑";
  $("mapMeta").textContent = "节点 " + model.nodes.length + " · 连线 " + model.links.length +
    " · 在警节点 " + sevNodes + (hosts.length >= 80 ? "（已截断 80）" : "");

  $("mapFacts").innerHTML =
    "<dt>节点</dt><dd>" + model.nodes.length + " 台主机</dd>" +
    "<dt>连线</dt><dd>" + model.links.length + " 条</dd>" +
    "<dt>在警节点</dt><dd>" + sevNodes + " 个</dd>" +
    "<dt>主机组</dt><dd>" + (model.clusters || []).length + " 个</dd>" +
    "<dt>画布</dt><dd>" + model.W + " × " + model.H + "</dd>" +
    "<dt>规划数据</dt><dd>" + Object.keys(S.topo.plan.nodes).length + " 个位置 / " +
      (S.topo.plan.links || []).length + " 条连线</dd>";

  $("topoSources").innerHTML =
    '<div><span class="k">映射图</span><b>' + cnt.map + "</b> 条 · 置信度 100%</div>" +
    '<div><span class="k">手工规划</span><b>' + cnt.manual + "</b> 条 · 100%</div>" +
    '<div><span class="k">LLDP/CDP</span><b>' + cnt.lldp + "</b> 条 · 90%</div>" +
    '<div><span class="k">同网段</span><b>' + cnt.subnet + "</b> 条 · 60%</div>" +
    '<div style="margin-top:5px;color:#8A99A8">虚线为推断连线，需人工确认；可在「规划编辑」中补充或删除。</div>';

  $("mapNote").innerHTML = S.topo.mode === "plan"
    ? "拖拽节点调整位置；点「连线模式」后依次点两个节点建立连线；点「删除模式」后点连线删除；导出 JSON 可纳入版本管理。规划数据只存浏览器本地，<b>不写入 Zabbix</b>。"
    : "节点是真实主机，颜色来自实时 <code class=\"mono\">problem.get</code>；连线来自 sysmap / LLDP / 同网段推断，按优先级去重。" +
      "同网段推断以「交换机/接口最多」的主机为汇聚点，置信度 60%，请人工确认后再当资产拓扑使用。";

  $("topoHelp").innerHTML = S.topo.mode === "plan"
    ? "拖拽移动 · 连线/删除模式 · 自动布局恢复 · 导出/导入 JSON · 清空规划。节点双击可进入主机详情。"
    : "点击节点进入主机详情；滚轮/按钮缩放；「规划编辑」可手工补充链路。";
}

function fitTopoZoom(model) {
  if (!model) return 1;
  var wrap = $("mapWrap");
  if (!wrap) return 1;
  var cw = wrap.clientWidth || 960, ch = wrap.clientHeight || 540;
  var z = Math.min(cw / model.W, ch / model.H);
  return Math.max(0.3, Math.min(1.15, z));
}

/* 默认按宽度铺满（最多 100%），宁可纵向滚动，也不把字缩到看不清 */
function defaultTopoZoom(model) {
  var wrap = $("mapWrap");
  if (!wrap) return 1;
  var cw = wrap.clientWidth || 1400;
  return Math.max(0.55, Math.min(1, cw / model.W));
}

function renderTopoTools() {
  var box = $("topoTools");
  if (!box) return;
  var mode = S.topo.mode;
  var html = "";

  if (mode === "map") {
    html += '<select id="topoMapSel">' + (S.topo.maps || []).map(function (m) {
      return '<option value="' + h(m.sysmapid) + '">' + h(m.name) + "</option>";
    }).join("") + "</select>";
  } else {
    html += '<select id="topoScope">' +
      '<option value="net"' + (S.topo.group === "net" ? " selected" : "") + ">网络设备 + 在警主机</option>" +
      '<option value="all"' + (S.topo.group === "all" ? " selected" : "") + ">全部主机</option>" +
      (S.groups || []).slice(0, 14).map(function (g) {
        return '<option value="grp:' + h(g.name) + '"' +
          (S.topo.group === "grp:" + g.name ? " selected" : "") + ">组：" + h(g.name) + " (" + g.count + ")</option>";
      }).join("") + "</select>";
    html += '<button class="btn2' + (S.topo.onlyProb ? " on" : "") + '" id="topoOnlyProb">仅有在警</button>';
  }

  html += '<button class="btn2" id="topoZoomOut" title="缩小">−</button>' +
    '<span class="zoomlbl" id="topoZoomLbl">' + Math.round((S.topo.zoom || 1) * 100) + "%</span>" +
    '<button class="btn2" id="topoZoomIn" title="放大">+</button>' +
    '<button class="btn2" id="topoFit" title="适应窗口">适应</button>';

  if (mode === "plan") {
    html += '<button class="btn2' + (S.topo.linking ? " primary" : "") + '" id="topoLinkMode">连线模式</button>' +
      '<button class="btn2' + (S.topo.deleting ? " primary" : "") + '" id="topoDelMode">删除模式</button>' +
      '<button class="btn2" id="topoRelayout">自动布局</button>' +
      '<button class="btn2" id="topoExport">导出</button>' +
      '<button class="btn2" id="topoImport">导入</button>' +
      '<button class="btn2" id="topoReset">清空</button>';
  }

  box.innerHTML = html;

  var scope = $("topoScope");
  if (scope) scope.onchange = function () {
    S.topo.group = this.value; S.topo.zoom = null; renderTopoPage();
  };
  var op = $("topoOnlyProb");
  if (op) op.onclick = function () {
    S.topo.onlyProb = !S.topo.onlyProb; S.topo.zoom = null; renderTopoPage();
  };
  $("topoZoomIn").onclick = function () { S.topo.zoom = Math.min(2.2, (S.topo.zoom || 1) * 1.2); paintTopo(S.topo.model); updateZoomLbl(); };
  $("topoZoomOut").onclick = function () { S.topo.zoom = Math.max(0.3, (S.topo.zoom || 1) / 1.2); paintTopo(S.topo.model); updateZoomLbl(); };
  $("topoFit").onclick = function () { S.topo.zoom = fitTopoZoom(S.topo.model); paintTopo(S.topo.model); updateZoomLbl(); };

  if (mode === "plan") {
    $("topoLinkMode").onclick = function () {
      S.topo.linking = !S.topo.linking; S.topo.deleting = false; S.topo.pending = null;
      renderTopoTools();
      toast(S.topo.linking ? "连线模式：依次点击两个节点" : "已退出连线模式");
    };
    $("topoDelMode").onclick = function () {
      S.topo.deleting = !S.topo.deleting; S.topo.linking = false; S.topo.pending = null;
      renderTopoTools();
      toast(S.topo.deleting ? "删除模式：点击一条规划连线" : "已退出删除模式");
    };
    $("topoRelayout").onclick = function () {
      S.topo.plan.nodes = {}; savePlan(); S.topo.zoom = null; renderTopoPage();
      toast("已按主机组重新布局");
    };
    $("topoExport").onclick = exportTopoPlan;
    $("topoImport").onclick = importTopoPlan;
    $("topoReset").onclick = function () {
      if (!confirm("清空本实例的规划位置与手工连线？不影响 Zabbix。")) return;
      S.topo.plan = { nodes: {}, links: [], hidden: [] };
      savePlan(); S.topo.zoom = null; renderTopoPage();
      toast("已清空规划数据");
    };
  }
}

function exportTopoPlan() {
  var data = {
    version: 1, profile: PROFILE, exportedAt: new Date().toISOString(),
    nodes: S.topo.plan.nodes, links: S.topo.plan.links, hidden: S.topo.plan.hidden || []
  };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "zbx-topology-" + (PROFILE || "default") + "-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
}

function importTopoPlan() {
  var inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,application/json";
  inp.onchange = function () {
    var f = inp.files && inp.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var d = JSON.parse(fr.result);
        var nodes = d.nodes || {}, links = Array.isArray(d.links) ? d.links : [];
        var clean = [];
        links.forEach(function (l) {
          if (l && l.a && l.b && S.hostById[l.a] && S.hostById[l.b]) clean.push({ a: String(l.a), b: String(l.b) });
        });
        var n = 0;
        Object.keys(nodes).forEach(function (hid) {
          var p = nodes[hid];
          if (S.hostById[hid] && p && isFinite(p.x) && isFinite(p.y)) { S.topo.plan.nodes[hid] = { x: num(p.x), y: num(p.y) }; n++; }
        });
        S.topo.plan.links = clean;
        S.topo.plan.hidden = (Array.isArray(d.hidden) ? d.hidden : []).filter(function (k) {
          return typeof k === "string" && k.indexOf("|") > 0;
        });
        savePlan();
        renderTopoPage();
        toast("已导入 " + n + " 个节点位置、" + clean.length + " 条连线");
      } catch (e) {
        toast("导入失败：不是合法的拓扑 JSON");
      }
    };
    fr.readAsText(f);
  };
  inp.click();
}

/* ---- Zabbix 原始 sysmap ---- */
function renderRealMap(m) {
  var wrap = $("mapWrap");
  var W = num(m.width) || 900, H = num(m.height) || 400;
  var els = m.selements || [], links = m.links || [], shapes = m.shapes || [];
  var probByHost = {};
  S.rows.forEach(function (r) { probByHost[r.hostid] = Math.max(probByHost[r.hostid] || 0, r.sev); });

  var pos = {};
  els.forEach(function (e) { pos[e.selementid] = e; });

  var s = '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:100%">';
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#FBFCFD"/>';

  shapes.forEach(function (sh) {
    if (String(sh.type) !== "0") return;
    var txt = String(sh.text || "").replace("{MAP.NAME}", m.name);
    s += '<rect x="' + num(sh.x) + '" y="' + num(sh.y) + '" width="' + num(sh.width) + '" height="' + num(sh.height) +
      '" fill="' + (sh.background_color ? "#" + sh.background_color : "none") + '" stroke="#DCE6EE"/>';
    s += '<text x="' + (num(sh.x) + 6) + '" y="' + (num(sh.y) + num(sh.height) - 3) +
      '" style="font-size:' + (num(sh.font_size) || 11) + 'px;fill:#7C8B99">' + h(txt) + "</text>";
  });

  links.forEach(function (l) {
    var A = pos[l.selementid1], B = pos[l.selementid2];
    if (!A || !B) return;
    var ax = num(A.x) + num(A.width || 0) / 2, ay = num(A.y) + num(A.height || 0) / 2;
    var bx = num(B.x) + num(B.width || 0) / 2, by = num(B.y) + num(B.height || 0) / 2;
    var midY = (ay + by) / 2;
    var d = Math.abs(ax - bx) < 1 ? ("M" + ax + " " + ay + "V" + by)
      : ("M" + ax + " " + ay + "V" + midY + "H" + bx + "V" + by);

    var hot = 0, unknown = false, tips = [];
    (l.linktriggers || []).forEach(function (lt) {
      var st = S.topo.linkStatus[lt.triggerid];
      if (!st) return;
      tips.push(st.description + (st.value === "1" ? "（告警）" : "（正常）"));
      if (st.value === "1") hot = Math.max(hot, st.severity);
    });
    if ((l.linktriggers || []).length && !tips.length) unknown = true;
    var color = hot ? SEV[hot].c : "#B7C6D4";
    s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + (hot ? 2.4 : 1.5) + '"' +
      (unknown ? ' stroke-dasharray="4 4"' : "") + ">" +
      (tips.length ? "<title>" + h(tips.join("\n")) + "</title>" : "") + "</path>";
  });

  els.forEach(function (el) {
    var list = el.elements || [];
    var hid = list[0] ? (list[0].hostid || list[0].elementid)
      : (String(el.elementtype) === "0" && el.elementid !== "0" ? el.elementid : null);
    var host = hid ? (S.hostById[hid] || null) : null;
    var sev = hid ? (probByHost[hid] || 0) : 0;
    var label = String(el.label || "")
      .replace(/\{HOST\.NAME\}/g, (host && (host.name || host.host)) || "—")
      .replace(/\{HOST\.CONN\}/g, ((host && host.interfaces || [])[0] || {}).ip || "—")
      .replace(/\{HOST\.IP\}/g, ((host && host.interfaces || [])[0] || {}).ip || "—");
    var lines = label.split(/\r?\n/);
    var w = num(el.width) || 120, hh = num(el.height) || 42;
    var bw = Math.min(Math.max(w, 96), 168), bh = Math.min(Math.max(hh, 34), 54);
    var bx = num(el.x) + (w - bw) / 2, by = num(el.y) + (hh - bh) / 2;

    s += '<g class="tn-node" data-hid="' + (hid || "") + '"' + (hid ? ' style="cursor:pointer"' : "") + ">";
    s += '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh + '" rx="8" fill="' +
      (sev >= 4 ? "#FFF3F2" : (sev ? "#FFFBF2" : "#FFFFFF")) + '" stroke="' + (sev ? SEV[sev].c : "#C9D6E2") +
      '" stroke-width="' + (sev >= 3 ? 1.8 : 1.2) + '"/>';
    lines.forEach(function (ln, i) {
      s += '<text x="' + (bx + bw / 2) + '" y="' + (by + 18 + i * 13) +
        '" text-anchor="middle" style="font-size:10.5px;fill:#33475C">' + h(ln) + "</text>";
    });
    if (hid) {
      s += '<circle cx="' + (bx + bw - 10) + '" cy="' + (by + 10) + '" r="4" fill="' +
        (sev ? SEV[sev].c : (String(host && host.status) === "1" ? "#BFC9D3" : (host && hostUnreach(host) ? "#E05252" : "#1FA97B"))) + '"/>';
    }
    s += "</g>";
  });

  s += "</svg>";
  wrap.innerHTML = s;
  $("mapTitle").textContent = m.name;
  $("mapMeta").textContent = "sysmapid " + m.sysmapid + " · " + W + "×" + H;
  $("mapFacts").innerHTML =
    "<dt>元素</dt><dd>" + els.length + " 个</dd>" +
    "<dt>连线</dt><dd>" + links.length + " 条</dd>" +
    "<dt>图形块</dt><dd>" + shapes.length + " 个</dd>" +
    "<dt>画布</dt><dd>" + W + " × " + H + "</dd>" +
    "<dt>链路触发器</dt><dd>" + Object.keys(S.topo.linkStatus).length + " 个</dd>";
  $("topoSources").innerHTML = "<div><span class=\"k\">来源</span>Zabbix sysmap 原图</div>" +
    "<div><span class=\"k\">坐标</span>selements[].x/.y</div>" +
    "<div><span class=\"k\">链路状态</span>linktriggers → trigger.value</div>";
  $("mapNote").innerHTML = "坐标取自 <code class=\"mono\">selements[].x/.y</code>；节点颜色按真实在警级别。" +
    "链路颜色只看 <code class=\"mono\">linktriggers</code> 对应触发器的当前状态（<b>不是</b>“有触发器就高亮”），查不到状态用虚线。点击节点进入主机详情。";

  Array.prototype.forEach.call(wrap.querySelectorAll(".tn-node[data-hid]"), function (el) {
    var hid = el.getAttribute("data-hid");
    if (!hid) return;
    el.onclick = function () { location.hash = "#host/" + hid; };
  });
}

function renderGroupBars() {
  var c = {};
  S.rows.forEach(function (r) {
    if (!r.groups.length) c["(无组)"] = (c["(无组)"] || 0) + 1;
    r.groups.forEach(function (g) { c[g] = (c[g] || 0) + 1; });
  });
  var arr = Object.keys(c).map(function (k) { return { n: k, v: c[k] }; })
    .sort(function (a, b) { return b.v - a.v; }).slice(0, 8);
  var max = arr.length ? arr[0].v : 1;
  $("groupBars").innerHTML = arr.map(function (x) {
    return '<div class="grpbar"><span class="nm" title="' + h(x.n) + '">' + h(x.n) + "</span>" +
      '<span class="bar"><span class="fill" style="width:' + Math.max(3, x.v / max * 100) + '%"></span></span>' +
      '<span class="n">' + x.v + "</span></div>";
  }).join("") || '<div class="foot-note">无数据</div>';
}

function renderUnreach() {
  var box = $("unreachList");
  if (!box) return;
  var list = S.hosts.filter(hostUnreach);
  box.innerHTML = list.map(function (x) {
    var bad = (x.interfaces || []).filter(function (i) { return String(i.available) === "2"; });
    return '<div class="ui"><span class="uh">' + h(x.host) + "</span>" +
      '<span class="ue" title="' + h((bad[0] || {}).error || "") + '">' +
      h((bad[0] || {}).ip || "—") + "</span></div>";
  }).join("") || '<div class="foot-note">无不可达主机</div>';
}

function renderUnreachProbs() {
  var body = $("unreachProbs");
  if (!body) return;
  var list = [];
  S.hosts.filter(hostUnreach).forEach(function (x) {
    var ps = S.rows.filter(function (r) { return r.hostid === x.hostid; });
    if (!ps.length) {
      list.push({ host: x.host, cat: "—", sym: "无在警问题（仅采集不可达）", age: 0 });
    } else {
      ps.forEach(function (r) { list.push({ host: x.host, cat: r.cat, sym: r.symptom, age: r.age }); });
    }
  });
  body.innerHTML = list.slice(0, 14).map(function (r) {
    return "<tr>" +
      '<td><span class="host">' + h(r.host) + "</span></td>" +
      '<td><span class="typ">' + h(r.cat) + "</span></td>" +
      '<td><div class="desc" title="' + h(r.sym) + '">' + h(r.sym) + "</div></td>" +
      '<td><span class="dur' + (r.age > 7 * 86400 ? " long" : "") + '">' + (r.age ? fmtDur(r.age) : "—") + "</span></td>" +
    "</tr>";
  }).join("") || '<tr><td colspan="4" class="empty">当前没有不可达设备</td></tr>';
}

var FINDINGS = [
  ["<code>selectGroups</code> 静默失效", "host.get 传 selectGroups 返回的主机<b>全部没有 groups 字段</b>，且不报错，很容易误判为“环境没有分组”", "7.0+ 改用 <code>selectHostGroups</code>，返回键名是 <code>hostgroups</code>"],
  ["<code>problem.get</code> 不含主机", "问题对象 18 个字段里没有 hostid / host，只有 <code>objectid</code>（即 triggerid）", "必须 <code>trigger.get(triggerids=[...], selectHosts)</code> 二次关联"],
  ["按 priority + limit 取触发器会漏", "trigger.get 按 priority 倒序取 200 条，<code>value=1</code> 的有 <b>0</b> 条——真实在警的 36 个触发器全被截断在外", "告警必须从 <code>problem.objectid</code> 反查，不能靠排序分页"],
  ["<code>sortfield: lastclock</code> 被拒", "item.get 报 <code>Sorting by field \"lastclock\" not allowed.</code>", "改为默认顺序取回后客户端过滤"],
  ["history 类型必须匹配 value_type", "float 项传 <code>history=3</code> 时返回 <b>[]</b>，不报错，静默空结果", "float=0 / char=1 / log=2 / uint=3 / text=4"],
  ["拓扑元素没有 elementid", "<code>selements[].elementid</code> 为 <code>null</code>，主机在 <code>elements[].hostid</code>", "按 <code>elements[0].hostid</code> 取主机"],
  ["所有数值都是字符串", "<code>severity:\"4\"</code>、<code>acknowledged:\"0\"</code>，其中 \"0\" 在 JS 里是真值", "统一 <code>Number()</code> 后再比较"],
  ["告警媒介被禁用", "3992 条发送记录中 3632 条失败，error 全是 <code>Media type disabled.</code>", "需在 Zabbix 侧启用企微媒介（本页不改配置）"],
  ["打印机告警中文编码错乱", "2 条告警名称是 <code>E5 BA 9F E7 B2 89…</code>——这是「灰色硒鼓」的 UTF-8 字节被当成十六进制文本输出了", "界面已自动还原为可读中文并标记；根因在打印机模板编码，需改模板"]
];

function renderCaps() {
  var p = profileById(PROFILE);
  $("capsVer").textContent = "v" + CAPS.version;
  $("fndVer").textContent = "Zabbix " + CAPS.version;
  if ($("fndNote")) {
    $("fndNote").innerHTML = "以上均为本环境 <b>" + h(hostOf(PROFILE)) + "</b>（Zabbix " + h(CAPS.version) +
      "）实际请求返回，不是文档推测。";
  }
  $("capsBox").innerHTML =
    "<dt>版本</dt><dd>" + h(CAPS.version) + "</dd>" +
    "<dt>实例</dt><dd>" + h(p.label || PROFILE) + "</dd>" +
    "<dt>认证</dt><dd>" + (p.auth === "login" ? "账号会话 · user.login" : "Bearer Token") + "</dd>" +
    "<dt>主机组</dt><dd>" + CAPS.groupSelect + " → " + CAPS.groupField + "</dd>" +
    "<dt>可用性</dt><dd>interfaces[].available</dd>" +
    "<dt>拓扑节点</dt><dd>" + CAPS.mapNode + "</dd>" +
    "<dt>问题直查</dt><dd>" + (CAPS.problemHostids ? "problem.get hostids" : "trigger 反查") + "</dd>";
}

function renderFindings() {
  renderCaps();
  $("fndBody").innerHTML = FINDINGS.map(function (f) {
    return "<tr><td><b>" + f[0] + "</b></td><td>" + f[1] + "</td><td>" + f[2] + "</td></tr>";
  }).join("");
}

function renderLog() {
  fetch("/api/log").then(function (r) { return r.json(); }).then(function (d) {
    var log = (d.log || []).slice().reverse().slice(0, 30);
    $("logBody").innerHTML = log.map(function (x) {
      var d2 = new Date(x.ts * 1000);
      var t = pad2(d2.getHours()) + ":" + pad2(d2.getMinutes()) + ":" + pad2(d2.getSeconds());
      if (x.blocked) {
        return "<tr><td>" + t + '</td><td class="bl">' + h(x.method) + '</td><td>—</td><td class="bl">已拦截</td></tr>';
      }
      var shown = x.ctype === "auth" ? "登录认证"
        : (x.count == null ? "—" : (x.ctype === "value" ? "计数 " + x.count : x.count + " 条"));
      return "<tr><td>" + t + "</td><td>" + h(x.method) + "</td><td>" + (x.ms || 0) + " ms</td><td>" +
        shown + "</td></tr>";
    }).join("") || "<tr><td colspan=4>暂无记录</td></tr>";
  });
}

/* ================= 抽屉 ================= */
function openDrawer() {
  $("drawer").classList.add("on");
  $("mask").classList.add("on");
}
function closeDrawer() {
  $("drawer").classList.remove("on");
  $("mask").classList.remove("on");
}

function showProblemDrawer(eventid) {
  var r = S.rows.filter(function (x) { return x.raw.eventid === eventid; })[0];
  if (!r) return;
  var p = r.raw, t = r.trig;

  $("dTitle").textContent = r.title;

  var tagsHtml = (p.tags || []).map(function (x) {
    return '<em style="font-style:normal;font-size:10px;padding:1px 5px;border-radius:3px;background:#F1F5F8;color:#5E7488;margin:0 4px 4px 0;display:inline-block">' +
      h(x.tag) + (x.value ? " = " + h(x.value) : "") + "</em>";
  }).join("");

  $("dBody").innerHTML =
    '<div class="dgrid">' +
      "<dt>严重度</dt><dd><span class=\"sev\"><i style=\"background:" + SEV[r.sev].c + '\"></i>' + SEV[r.sev].n + "</span></dd>" +
      "<dt>主机</dt><dd class=\"mono\">" + h(r.host) + "</dd>" +
      "<dt>主机组</dt><dd>" + (r.groups.join(" · ") || "—") + "</dd>" +
      "<dt>类别</dt><dd>" + h(r.cat) + "</dd>" +
      "<dt>接口 / 对象</dt><dd class=\"mono\">" + h(r.iface || "—") + "</dd>" +
      "<dt>接口用途</dt><dd>" + h(r.target || "—") + "</dd>" +
      "<dt>现象</dt><dd>" + h(r.symptom) + (r.encFixed ? ' <span class="tag-mini">编码已修正</span>' : "") + "</dd>" +
      "<dt>开始时间</dt><dd>" + fmtTime(p.clock) + "（已持续 " + fmtDur(r.age) + "）</dd>" +
      "<dt>确认状态</dt><dd>" + (r.ack ? "已确认" : "未确认") + "</dd>" +
      "<dt>抑制</dt><dd>" + (r.supp ? "已抑制" : "未抑制") + "</dd>" +
      "<dt>opdata</dt><dd class=\"mono\">" + h(r.opdata || "—") + "</dd>" +
      "<dt>eventid</dt><dd class=\"mono\">" + p.eventid + "</dd>" +
      "<dt>triggerid</dt><dd class=\"mono\">" + p.objectid + "</dd>" +
      "<dt>触发器状态</dt><dd>" + (String(t.status) === "1" ? "已禁用" : "启用") + "</dd>" +
    "</div>" +
    '<div class="dsec">标签</div>' +
    '<div style="padding:2px 16px 10px">' + (tagsHtml || '<span class="muted" style="font-size:12px">无标签</span>') + "</div>" +
    '<div class="dsec">通知送达</div>' +
    '<div id="dNotif"><div class="foot-note">读取中…</div></div>' +
    '<div class="dsec">原始返回（problem.get）</div>' +
    '<div style="padding:2px 16px 12px"><div class="codeblock">' + hl(JSON.stringify(p, null, 2)) + "</div></div>";

  openDrawer();

  rpc("alert.get", {
    eventids: [p.eventid],
    output: ["alertid", "clock", "status", "error", "mediatypeid", "sendto", "retries"],
    limit: 30
  }).then(function (al) {
    var box = $("dNotif");
    if (!al || !al.length) {
      box.innerHTML = '<div class="foot-note">该事件没有生成通知记录（可能未命中 Action 条件）。</div>';
      return;
    }
    box.innerHTML = al.map(function (a) {
      var m = S.media[a.mediatypeid] || {};
      var ok = String(a.status) === "1";
      return '<div class="notif">' +
        '<span class="st' + (ok ? " ok" : "") + '">' + (ok ? "已送达" : "失败") + "</span>" +
        '<span class="nm" title="' + h(m.name || a.mediatypeid) + '">' + h(m.name || ("媒介 " + a.mediatypeid)) + "</span>" +
        '<span class="tm">' + fmtTime(a.clock) + "</span>" +
        '<span class="er" title="' + h(a.error || "") + '">' + h(a.error || "") + "</span>" +
      "</div>";
    }).join("");
  }).catch(function (e) {
    $("dNotif").innerHTML = '<div class="foot-note">通知记录读取失败：' + h(e.message) + "</div>";
  });
}

function showAlertDrawer() {
  $("dTitle").textContent = "告警通知发送记录";
  var failed = S.alerts.samples.filter(function (a) { return String(a.status) === "2"; });

  var mt = {};
  S.alerts.samples.forEach(function (a) { if (a.mediatypeid) mt[a.mediatypeid] = (mt[a.mediatypeid] || 0) + 1; });

  var mtHtml = Object.keys(mt).map(function (id) {
    var m = S.media[id] || {};
    var disabled = String(m.status) === "1";
    return '<div class="notif">' +
      '<span class="st' + (disabled ? "" : " ok") + '">' + (disabled ? "已禁用" : "启用中") + "</span>" +
      '<span class="nm">' + h(m.name || id) + "</span>" +
      '<span class="tm">mediatypeid ' + id + "</span>" +
      '<span class="er">' + h(m.type === "1" ? "webhook" : m.type === "0" ? "email" : "type " + m.type) + "</span>" +
    "</div>";
  }).join("");

  $("dBody").innerHTML =
    '<div class="dgrid">' +
      "<dt>发送总数</dt><dd>" + S.alerts.total.toLocaleString() + "</dd>" +
      "<dt>成功</dt><dd>" + S.alerts.sent.toLocaleString() + "</dd>" +
      "<dt>失败</dt><dd>" + S.alerts.failed.toLocaleString() + "</dd>" +
      "<dt>失败原因</dt><dd class=\"mono\">Media type disabled.</dd>" +
    "</div>" +
    '<div class="dsec">涉及的告警媒介</div>' +
    '<div id="dMt">' + (mtHtml || '<div class="foot-note">—</div>') + "</div>" +
    '<div class="dsec">最近 ' + failed.length + " 条失败记录</div>" +
    '<div id="dSamp">' + failed.map(function (a) {
      return '<div class="notif">' +
        '<span class="st">失败</span>' +
        '<span class="nm" title="' + h(a.sendto || "") + '">' + h(a.sendto || "—") + "</span>" +
        '<span class="tm">' + fmtTime(a.clock) + "</span>" +
        '<span class="er">' + h(a.error || "") + "</span>" +
      "</div>";
    }).join("") + "</div>" +
    '<div class="foot-note">这些记录来自 <code class="mono">alert.get</code>。本页只读，不会去启用媒介或修改任何配置。</div>';

  openDrawer();
}

function hl(json) {
  return h(json)
    .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (\d+)/g, ': <span class="n">$1</span>');
}

/* ================= 路由 ================= */
function showView(name) {
  var tabName = name === "host" ? "hosts" : name;
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
    b.classList.toggle("on", b.getAttribute("data-tab") === tabName);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".view"), function (v) { v.classList.remove("on"); });
  var el = $("view-" + name);
  if (el) el.classList.add("on");
  if (name === "graphs" && S.graph.chart) setTimeout(function () { S.graph.chart.resize(); }, 80);
  window.scrollTo(0, 0);
}

function applyRoute() {
  var raw = (location.hash || "").replace(/^#/, "");
  var parts = raw.split("/");
  var name = parts[0] || "problems";
  var arg = parts[1] || "";

  if (name === "host" && arg) { showView("host"); loadHostDetail(arg); return; }
  if (name === "items" && arg) { loadItemsPage(arg); return; }
  if (name === "item" && arg) { showView("graphs"); loadItemPage(arg); return; }
  if (name === "graphs") { showView("graphs"); loadGraphPage(arg || null); return; }
  if (name === "topo" || name === "topology") { showView("topo"); loadTopo(); return; }
  if (name === "api") { showView("api"); renderFindings(); renderLog(); return; }
  if (name === "hosts") { showView("hosts"); return; }
  showView("problems");
}

function activateTab(tab) { location.hash = "#" + tab; }

window.addEventListener("hashchange", applyRoute);

/* ================= 事件绑定 ================= */
$("refreshBtn").onclick = function () { boot(); };

$("tabs").addEventListener("click", function (e) {
  var btn = e.target.closest(".tab");
  if (!btn) return;
  var tab = btn.getAttribute("data-tab");
  if (location.hash === "#" + tab) applyRoute();
  else location.hash = "#" + tab;
});

document.querySelectorAll('.chip[data-sev]').forEach(function (c) {
  c.onclick = function () {
    document.querySelectorAll('.chip[data-sev]').forEach(function (x) { x.classList.remove("on"); });
    c.classList.add("on");
    S.filt.sev = c.getAttribute("data-sev");
    renderProblems();
  };
});

document.querySelectorAll('.chip[data-hf]').forEach(function (c) {
  c.onclick = function () {
    document.querySelectorAll('.chip[data-hf]').forEach(function (x) { x.classList.remove("on"); });
    c.classList.add("on");
    S.hostFilt.kind = c.getAttribute("data-hf");
    renderHosts();
  };
});

$("chipLong").onclick = function () {
  S.filt.long = !S.filt.long;
  this.classList.toggle("on", S.filt.long);
  renderProblems();
};
$("chipUnreachOnly").onclick = function () {
  S.filt.unreach = !S.filt.unreach;
  this.classList.toggle("on", S.filt.unreach);
  renderProblems();
};
$("groupSel").onchange = function () { S.filt.group = this.value; renderProblems(); };
$("q").oninput = function () { S.filt.q = this.value; renderProblems(); };
$("hq").oninput = function () { S.hostFilt.q = this.value; renderHosts(); };

document.querySelectorAll('#probTable thead th.s').forEach(function (th) {
  th.onclick = function () {
    var k = th.getAttribute("data-sort");
    if (S.filt.sort === k) S.filt.dir *= -1;
    else { S.filt.sort = k; S.filt.dir = k === "host" ? 1 : -1; }
    document.querySelectorAll('#probTable thead th.s').forEach(function (x) {
      x.querySelector(".ar").textContent = "";
    });
    th.querySelector(".ar").textContent = S.filt.dir > 0 ? "▲" : "▼";
    renderProblems();
  };
});

/* ---- 主机详情 ---- */
$("hostBack").onclick = function () { location.hash = "#hosts"; };
$("hdItemQ").oninput = function () { S.hd.q = this.value; S.hd.page = 0; renderHdItems(); };
document.querySelectorAll('.chip[data-if]').forEach(function (c) {
  c.onclick = function () {
    document.querySelectorAll('.chip[data-if]').forEach(function (x) { x.classList.remove("on"); });
    c.classList.add("on");
    S.hd.filter = c.getAttribute("data-if");
    S.hd.page = 0;
    renderHdItems();
  };
});
$("hdPrev").onclick = function () { if (S.hd.page > 0) { S.hd.page--; renderHdItems(); } };
$("hdNext").onclick = function () { S.hd.page++; renderHdItems(); };

/* ---- 主机列表排序 ---- */
function syncHostSort() {
  Array.prototype.forEach.call(document.querySelectorAll('#hostTable thead th.s'), function (th) {
    var ar = th.querySelector(".ar");
    if (!ar) return;
    ar.textContent = th.getAttribute("data-hsort") === S.hostFilt.sort ? (S.hostFilt.dir > 0 ? "▲" : "▼") : "";
  });
}
Array.prototype.forEach.call(document.querySelectorAll('#hostTable thead th.s'), function (th) {
  th.onclick = function () {
    var k = th.getAttribute("data-hsort");
    if (S.hostFilt.sort === k) S.hostFilt.dir *= -1;
    else { S.hostFilt.sort = k; S.hostFilt.dir = (k === "host" || k === "name" || k === "ip") ? 1 : -1; }
    syncHostSort();
    renderHosts();
  };
});
$("hostGroupClear").onclick = function () { S.hostFilt.groups = []; renderHosts(); };

/* ---- 图形页 ---- */
$("gHostQ").oninput = function () { S.graph.hostQ = this.value; renderGraphHosts(); };
$("gListQ").oninput = function () { S.graph.listQ = this.value; renderGraphList(); };
$("gOnlyData").onclick = function () {
  S.graph.onlyData = !S.graph.onlyData;
  this.classList.toggle("on", S.graph.onlyData);
  renderGraphList();
};
$("gSelBar").addEventListener("click", function (e) {
  var rm = e.target.closest("[data-rm]");
  if (rm) { toggleSel(rm.getAttribute("data-rm")); return; }
  if (e.target.closest("#gDraw")) {
    if (S.graph.selItems.length) selectItemChart(S.graph.selItems.slice());
    return;
  }
  if (e.target.closest("#gClearSel")) {
    S.graph.selItems = [];
    renderGraphList();
  }
});
$("gMode").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  setGraphMode(b.getAttribute("data-gmode"));
});

$("topoMode").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  S.topo.mode = b.getAttribute("data-tmode");
  S.topo.sel = null;
  S.topo.pending = null;
  S.topo.linking = false;
  S.topo.deleting = false;
  S.topo.zoom = null;
  renderTopoPage();
});

function redrawCurrentGraph() {
  if (S.graph.curGraph) return selectNativeGraph(S.graph.curGraph);
  if (S.graph.curItems.length) return selectItemChart(S.graph.curItems);
  return null;
}
function localInput(ms) {
  var d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function toEpoch(v) {
  if (!v) return null;
  var t = new Date(v).getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

$("customRangeBtn").onclick = function () {
  var box = $("customRange");
  var show = box.style.display === "none";
  box.style.display = show ? "flex" : "none";
  if (show && !$("rangeFrom").value) {
    var now = Date.now();
    $("rangeFrom").value = localInput(now - 86400000);
    $("rangeTo").value = localInput(now);
  }
  this.classList.toggle("on", show);
};
$("rangeApply").onclick = function () {
  var f = toEpoch($("rangeFrom").value);
  var t = toEpoch($("rangeTo").value) || Math.floor(Date.now() / 1000);
  if (!f) { toast("请选择开始时间"); return; }
  if (f >= t) { toast("开始时间必须早于结束时间"); return; }
  S.graph.customFrom = f;
  S.graph.customTo = t;
  S.graph.range = "custom";
  Array.prototype.forEach.call($("rangeSeg").querySelectorAll("button"), function (x) { x.classList.remove("on"); });
  redrawCurrentGraph();
};

$("rangeSeg").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  Array.prototype.forEach.call(this.querySelectorAll("button"), function (x) { x.classList.remove("on"); });
  b.classList.add("on");
  S.graph.range = b.getAttribute("data-range");
  $("customRange").style.display = "none";
  $("customRangeBtn").classList.remove("on");
  redrawCurrentGraph();
});

var _rz = null;
window.addEventListener("resize", function () {
  clearTimeout(_rz);
  _rz = setTimeout(function () { if (S.graph.chart) S.graph.chart.resize(); }, 160);
});

$("dClose").onclick = closeDrawer;
$("mask").onclick = closeDrawer;
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });

/* 启动 */
renderFindings();
syncHostSort();
boot();

})();
