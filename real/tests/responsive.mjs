#!/usr/bin/env node
/**
 * 窄屏适配检查（零依赖 CDP）
 *
 * 用法：node tests/responsive.mjs [profile] [hostid]
 * 输出：/tmp/zbx-shots/rw-<profile>-<w>-<page>.png（可选，SHOT=1 时）
 *
 * 断言四件事：
 *   1. 页面没有横向溢出（scrollWidth <= 视口宽度）
 *   2. 顶栏底部 ≤ 页签顶部（品牌区换行不会压住导航）
 *   3. 品牌文案单行（高度不超过 1.6 行）
 *   4. 表格都在卡片内（表格右边界不超出视口）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const PROFILE = process.argv[2] || "zbx8";
const HOST_ID = process.argv[3] || (PROFILE === "zbx8" ? "10925" : "10084");
const BASE = process.env.BASE || "http://127.0.0.1:8770";
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "/tmp/zbx-shots";
const SHOT = process.env.SHOT === "1";
const SHOT_WIDTHS = (process.env.SHOT_WIDTHS || "1100,980,830,560").split(",").map(Number);
const PORT = 9800 + Math.floor(Math.random() * 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = (process.env.WIDTHS || "1440,1280,1100,980,830,760,560").split(",").map(Number);
const PAGES = [
  ["#problems", "problems"],
  ["#hosts", "hosts"],
  [`#host/${HOST_ID}`, "host"],
  ["#topo", "topo"]
];

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/zbx-rw-" + Date.now(),
  "--window-size=1440,1000", "about:blank"
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
  return new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error("JS 异常");
  return r.result && r.result.result ? r.result.result.value : undefined;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}

async function setWidth(w) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700
  });
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

  for (const w of WIDTHS) {
    await setWidth(w);
    for (const [hash, tag] of PAGES) {
      const ok = await goto(hash, `document.body && document.body.getBoundingClientRect().width > 0`);
      await sleep(1200);
      const m = await js(`(function(){
        function r(sel){var e=document.querySelector(sel);return e?e.getBoundingClientRect():null}
        var tb=r('.topbar'), tabs=r('.tabs'), bt=document.querySelector('.bt');
        var tw=document.querySelector('.tw');
        var wide=[];
        document.querySelectorAll('.card').forEach(function(c){
          if(c.getBoundingClientRect().right > window.innerWidth + 1) wide.push((c.querySelector('h3')||{}).textContent||'card');
        });
        return {
          scrollW: document.documentElement.scrollWidth,
          bodyW: document.body.scrollWidth,
          vw: window.innerWidth,
          topbarH: tb?Math.round(tb.height):0,
          topbarBottom: tb?Math.round(tb.bottom):0,
          tabsTop: tabs?Math.round(tabs.top):0,
          btH: bt?Math.round(bt.getBoundingClientRect().height):0,
          overflowCards: wide,
          tblScroll: tw ? (tw.scrollWidth > tw.clientWidth + 1) : null
        };
      })()`);
      const label = `${w}px ${tag}`;
      check(`${label} 无横向溢出`, m.scrollW <= m.vw + 1, `scrollW=${m.scrollW} vw=${m.vw}`);
      check(`${label} 顶栏不压页签`, m.topbarBottom <= m.tabsTop + 1, `topbar底部=${m.topbarBottom} 页签顶部=${m.tabsTop}`);
      check(`${label} 品牌单行`, m.btH <= 24, `bt高=${m.btH}`);
      check(`${label} 无卡片越界`, m.overflowCards.length === 0, m.overflowCards.join(",") || "");
      if (SHOT && SHOT_WIDTHS.indexOf(w) >= 0) {
        const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
        const f = `${OUT}/rw-${PROFILE}-${w}-${tag}.png`;
        fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
        console.log("SHOT " + f);
      }
    }
  }

  await send("Emulation.clearDeviceMetricsOverride");
} catch (e) {
  check("执行异常", false, e.message);
} finally {
  try { ws && ws.close(); } catch (e) {}
  chrome.kill("SIGKILL");
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (failed.length ? "FAILED " + failed.length + " / " + results.length : "ALL PASS " + results.length));
  process.exit(failed.length ? 1 : 0);
}
