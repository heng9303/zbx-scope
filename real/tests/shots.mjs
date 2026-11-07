#!/usr/bin/env node
/**
 * 页面截图（零依赖 CDP），用于人工/视觉复核。
 *
 * 用法：node tests/shots.mjs [profile] [hostid]
 * 输出：/tmp/zbx-shots/<profile>-<name>.png（整页长图）
 *
 * 只读：仅访问页面并截图，不写入 Zabbix。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const PROFILE = process.argv[2] || "zbx8";
const HOST_ID = process.argv[3] || (PROFILE === "zbx8" ? "10925" : "10084");
const BASE = process.env.BASE || "http://127.0.0.1:8770";
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "/tmp/zbx-shots";
const PORT = 9400 + Math.floor(Math.random() * 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/zbx-shot-" + Date.now(),
  "--window-size=1600,1150", "about:blank"
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        };
        return;
      }
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error("无法连接 Chrome DevTools");
}

function send(method, params = {}) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
}

/** 整页截图：先量内容高度，再覆盖设备指标，再截 beyond viewport。
 *  FULL=0 时只截首屏（复核顶部区域更省时，也避免超长图看不清细节）。 */
async function shot(name) {
  await sleep(900);
  if (process.env.FULL === "0") {
    const r0 = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const f0 = `${OUT}/${PROFILE}-${name}.png`;
    fs.writeFileSync(f0, Buffer.from(r0.result.data, "base64"));
    console.log("SHOT " + f0 + "  viewport");
    return;
  }
  const m = await send("Page.getLayoutMetrics");
  const h = Math.min(Math.ceil((m.result.cssContentSize || {}).height || 1100), 4200);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: h, deviceScaleFactor: 1, mobile: false
  });
  await sleep(450);
  const r = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true, fromSurface: true
  });
  const file = `${OUT}/${PROFILE}-${name}.png`;
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
  await send("Emulation.clearDeviceMetricsOverride");
  console.log("SHOT " + file + "  " + h + "px");
}

async function goto(hash, waitExpr, timeout = 25000) {
  await send("Page.navigate", { url: `${BASE}/?profile=${PROFILE}${hash}` });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(300);
    try { if (await js(`!!(${waitExpr})`)) return true; } catch (e) {}
  }
  return false;
}

try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  if (process.env.BASIC_AUTH) {
    await send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Basic " + Buffer.from(process.env.BASIC_AUTH).toString("base64") }
    });
  }

  if (await goto("#problems", `document.getElementById('lastRefresh') && document.getElementById('lastRefresh').textContent.indexOf('刷新于') === 0`)) {
    await shot("problems");
  } else console.log("SKIP problems (超时)");

  if (await goto("#hosts", `document.querySelectorAll('#hostBody tr').length > 0`)) {
    await shot("hosts");
  } else console.log("SKIP hosts (超时)");

  if (await goto(`#host/${HOST_ID}`, `document.getElementById('hdItems') && document.getElementById('hdItems').textContent !== '—'`)) {
    // 等"最近数据"探测跑完，避免截到"查询中…"的中间态
    await sleep(2600);
    await shot("host-detail");
  } else console.log("SKIP host-detail (超时)");

  // 监控项/图形：优先用双序列路由
  const itemRoute = process.env.ITEM_ROUTE || "";
  if (itemRoute) {
    if (await goto(`#items/${itemRoute}`, `document.querySelectorAll('#chartBox canvas').length > 0`)) {
      await shot("graph-multi");
    } else console.log("SKIP graph-multi (超时)");
  } else if (await goto("#graphs", `document.querySelectorAll('#chartBox canvas').length > 0`)) {
    await shot("graphs");
  } else console.log("SKIP graphs (超时)");

  if (await goto("#topo", `document.querySelectorAll('#mapWrap .tn-node').length > 1`)) {
    await shot("topo-auto");
    await js(`Array.from(document.querySelectorAll('#topoMode button')).find(b=>b.dataset.tmode==='plan').click()`);
    await sleep(900);
    await shot("topo-plan");
  } else console.log("SKIP topo (超时)");

  // 接口与审计页（#api 内含 renderLog 审计区）
  if (await goto("#api", `document.getElementById('view-api') && document.getElementById('view-api').classList.contains('on')`, 12000)) {
    await shot("api");
  } else console.log("SKIP api");

} catch (e) {
  console.log("ERROR " + e.message);
} finally {
  try { ws && ws.close(); } catch (e) {}
  chrome.kill("SIGKILL");
  console.log("DONE -> " + OUT);
}
