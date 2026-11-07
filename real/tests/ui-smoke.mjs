#!/usr/bin/env node
/**
 * Zabbix 控制台 UI 冒烟测试（零依赖，Chrome DevTools Protocol）
 *
 * 用法：node tests/ui-smoke.mjs [profile] [baseUrl]
 *   profile   zbx8（默认，含 11.28 数据健康 + 多序列断言）/ zbx7 / zbx4
 *
 * 覆盖：
 *   1. 问题 / 主机列表 / 主机详情 / 图形 / 拓扑 无 JS 错误
 *   2. 8.0 专有：11.28 采集异常横幅、最近数据回退、双序列图例、多选交互
 *   3. 拓扑规划：切模式、手工连线、拖拽、localStorage 持久化
 *   4. 只读闸门：host.update 被代理拒绝
 *
 * 退出码 0 = 全部通过；1 = 有失败项（结果写入 /tmp/zbx-ui-smoke-<profile>.json）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const PROFILE = process.argv[2] || "zbx8";
const BASE = process.argv[3] || "http://127.0.0.1:8770";
const IS8 = PROFILE === "zbx8";
const HOST_ID = process.env.HOST_ID || (IS8 ? "10925" : "10084");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333 + (IS8 ? 0 : PROFILE === "zbx7" ? 1 : 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? "" : detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}
/* 前置数据不足（如认证失败导致没有节点）时用它，避免脚本抛异常掩盖真因 */
function skip(name, why) {
  results.push({ name, ok: true, skip: true, detail: why });
  console.log("SKIP " + name + "  " + why);
}

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/zbx-cdp-" + Date.now(),
  "--window-size=1600,1100", "about:blank"
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

async function js(expr, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error((r.result.exceptionDetails.exception || {}).description || "JS 异常");
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function goto(hash, waitExpr, timeout = 22000) {
  await send("Page.navigate", { url: `${BASE}/?profile=${PROFILE}${hash}` });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(300);
    try {
      if (await js(`!!(${waitExpr})`)) return true;
    } catch (e) { /* page still navigating */ }
  }
  return false;
}

async function noJsError(tag) {
  const txt = await js(`(function(){var e=document.getElementById('jsErr');return e&&e.style.display==='block'?e.textContent:''})()`);
  check(`无 JS 错误 · ${tag}`, !txt, txt || "");
}

async function waitFor(expr, tries = 24, gap = 300) {
  for (let i = 0; i < tries; i++) {
    if (await js(expr)) return true;
    await sleep(gap);
  }
  return false;
}

try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  // 远程开启 Basic Auth 时，给所有请求（含文档导航）统一附加凭据
  await send("Network.enable");
  if (process.env.BASIC_AUTH) {
    await send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Basic " + Buffer.from(process.env.BASIC_AUTH).toString("base64") }
    });
  }

  /* ---------- 1. 问题页 ---------- */
  const okProblems = await goto("#problems", `document.getElementById('lastRefresh') && document.getElementById('lastRefresh').textContent.indexOf('刷新于') === 0`);
  check("问题页加载完成", okProblems);
  check("问题页有表格行或空态", await js(`document.querySelectorAll('#probBody tr').length > 0 || /没有/.test(document.body.textContent)`));
  check("全局错误条在数据正常时保持隐藏", await js(`(function(){var e=document.getElementById('globalErr');return !!e && e.hidden === true})()`));
  await noJsError("problems");

  /* ---------- 2. 主机列表 ---------- */
  const okHosts = await goto("#hosts", `document.querySelectorAll('#hostBody tr').length > 0`);
  check("主机列表渲染", okHosts, "rows=" + (await js(`document.querySelectorAll('#hostBody tr').length`)));
  await noJsError("hosts");

  /* ---------- 3. 主机详情 ---------- */
  const okHost = await goto(`#host/${HOST_ID}`, `document.getElementById('hdItems') && document.getElementById('hdItems').textContent !== '—'`);
  check("主机详情加载", okHost);
  const hd = await js(`(function(){return {
    items: document.getElementById('hdItems').textContent,
    bad: document.getElementById('hdBad').textContent.trim(),
    banner: (document.getElementById('hdHealth').textContent||'').replace(/\\s+/g,' ').slice(0,80),
    rows: document.querySelectorAll('#hdItemBox tbody tr').length
  }})()`);
  check("主机详情渲染监控项", hd.rows > 0, JSON.stringify(hd));
  if (IS8) {
    check("采集异常计数 > 0", Number(hd.bad) > 0, "bad=" + hd.bad);
    check("采集异常横幅可见", /采集异常/.test(hd.banner) && /最近一次数据/.test(hd.banner), hd.banner);
  }
  await noJsError("host-detail");

  /* ---------- 4. 图形 ---------- */
  if (IS8) {
    const okItems = await goto("#items/140403,140529", `document.querySelectorAll('#gList .gchk').length > 0`);
    check("图形页多选模式加载", okItems);
    await waitFor(`document.querySelectorAll('#chartLegend span').length >= 2`);
    const g1 = await js(`(function(){return {
      title: document.getElementById('graphTitle').textContent,
      legend: document.querySelectorAll('#chartLegend span').length,
      sel: document.getElementById('gSelBar').textContent.replace(/\\s+/g,' ').trim().slice(0,60),
      canvas: document.querySelectorAll('#chartBox canvas').length
    }})()`);
    check("双序列图例", g1.legend >= 2, JSON.stringify(g1));
    check("图表已绘制", g1.canvas > 0);
    check("已选工具条显示 2 项", /2\s*项已选/.test(g1.sel), g1.sel);

    await js(`document.querySelector('#gList .gchk:not(:checked)').click()`);
    await sleep(200);
    const selTxt = await js(`document.getElementById('gSelBar').textContent.replace(/\s+/g,' ')`);
    check("勾选后计数变化", /3\s*项已选/.test(selTxt), selTxt.slice(0, 50));

    await js(`document.getElementById('gClearSel').click()`);
    await sleep(200);
    const cleared = await js(`document.getElementById('gSelBar').textContent.replace(/\s+/g,' ')`);
    check("清空选择", !/项已选/.test(cleared), cleared.slice(0, 50));
  } else {
    const okGraph = await goto("#graphs", `document.getElementById('graphTitle') && document.getElementById('graphTitle').textContent !== '—'`);
    check("图形页加载", okGraph);
  }
  await noJsError("graphs");

  /* ---------- 5. 拓扑自动模式 ---------- */
  const okTopo = await goto("#topo", `document.querySelectorAll('#mapWrap .tn-node').length > 1`);
  check("自动拓扑渲染节点", okTopo);
  const t1 = await js(`(function(){return {
    nodes: document.querySelectorAll('#mapWrap .tn-node').length,
    links: document.querySelectorAll('#mapWrap path.topo-link').length,
    facts: (document.getElementById('mapFacts').textContent||'').replace(/\\s+/g,' ').slice(0,90)
  }})()`);
  check("拓扑统计显示节点数", new RegExp("节点\\s*" + t1.nodes).test(t1.facts), JSON.stringify(t1));
  if (IS8) check("自动拓扑有连线", t1.links > 0, "links=" + t1.links);
  await noJsError("topo-auto");

  /* ---------- 6. 规划模式：连线 + 拖拽 ---------- */
  await js(`Array.from(document.querySelectorAll('#topoMode button')).find(b=>b.dataset.tmode==='plan').click()`);
  await sleep(700);
  check("进入规划模式", await js(`!!document.getElementById('topoLinkMode')`));

  const nodeN = await js(`document.querySelectorAll('#mapWrap .tn-node').length`);
  if (nodeN < 2) {
    // 节点不足通常意味着上游认证/权限失败，后续交互无从验证。
    // 明确跳过而不是让脚本抛 TypeError，避免掩盖真正的错误原因。
    skip("手工连线新增成功", "节点仅 " + nodeN + " 个");
    skip("拖拽改变节点坐标", "节点仅 " + nodeN + " 个");
    skip("规划数据已持久化", "节点仅 " + nodeN + " 个");
  } else {
    const before = await js(`document.querySelectorAll('#mapWrap path.topo-link[data-kind="manual"]').length`);
    await js(`document.getElementById('topoLinkMode').click()`);
    await js(`document.querySelectorAll('#mapWrap .tn-node')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(150);
    await js(`document.querySelectorAll('#mapWrap .tn-node')[1].dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(600);
    const after = await js(`document.querySelectorAll('#mapWrap path.topo-link[data-kind="manual"]').length`);
    check("手工连线新增成功", after === before + 1, `${before} -> ${after}`);

    const posBefore = await js(`(function(){var r=document.querySelector('#mapWrap .tn-node rect');return r?r.getAttribute('x')+'|'+r.getAttribute('y'):''})()`);
    await js(`(function(){
      var g=document.querySelectorAll('#mapWrap .tn-node')[0];
      var b=g.getBoundingClientRect();
      var opt={bubbles:true,pointerId:1,clientX:b.x+12,clientY:b.y+12};
      g.dispatchEvent(new PointerEvent('pointerdown',opt));
      document.dispatchEvent(new PointerEvent('pointermove',Object.assign({},opt,{clientX:b.x+72,clientY:b.y+62})));
      document.dispatchEvent(new PointerEvent('pointerup',Object.assign({},opt,{clientX:b.x+72,clientY:b.y+62})));
    })()`);
    await sleep(800);
    const posAfter = await js(`(function(){var r=document.querySelector('#mapWrap .tn-node rect');return r?r.getAttribute('x')+'|'+r.getAttribute('y'):''})()`);
    check("拖拽改变节点坐标", posBefore !== posAfter, `${posBefore} -> ${posAfter}`);

    const plan = await js(`localStorage.getItem('zbx.topo.plan.v1.${PROFILE}')`);
    let planObj = {};
    try { planObj = JSON.parse(plan || "{}"); } catch (e) {}
    check("规划数据已持久化", Object.keys(planObj.nodes || {}).length > 0 && (planObj.links || []).length > 0,
      `nodes=${Object.keys(planObj.nodes || {}).length} links=${(planObj.links || []).length}`);
  }
  await noJsError("topo-plan");

  /* ---------- 7. 只读闸门 ---------- */
  const blocked = await js(`fetch('/api_jsonrpc.php',{method:'POST',headers:{'Content-Type':'application/json-rpc'},body:JSON.stringify({jsonrpc:'2.0',method:'host.update',params:{hostid:'1'},id:1})}).then(r=>r.json()).then(d=>d.error&&d.error.message||'allowed')`);
  check("写操作被代理拦截", /Blocked/i.test(String(blocked)), String(blocked));

} catch (e) {
  check("执行异常", false, e.message);
} finally {
  try { ws && ws.close(); } catch (e) {}
  chrome.kill("SIGKILL");
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skip).length;
  const passed = results.length - failed.length - skipped;
  console.log("\n" + (failed.length
    ? "FAILED " + failed.length + " / " + results.length
    : "ALL PASS " + passed + (skipped ? "  SKIP " + skipped : "")));
  fs.writeFileSync(`/tmp/zbx-ui-smoke-${PROFILE}.json`, JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}
