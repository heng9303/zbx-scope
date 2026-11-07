# Zabbix 7.0 界面改造方案评估

> 结论先行：**做同域独立页面，不做"替换主 UI"**。
> 视觉上可以像一套全新界面，架构上是通过 `api_jsonrpc.php` 取数的外挂应用。
> 原型见 `prototype/zabbix-ui-redesign.html`（可切换演示数据 / 真实实例）。

---

## 一、先回答那个问题：独立 UI，还是替代主 UI

答案是**第三条路**：**同域部署的独立页面 + 可选模块挂菜单**。

它同时满足两个看似矛盾的要求——"看起来像 Zabbix 自己的界面"，又"不承担改造 Zabbix 的成本"。

| | 方案 A：独立 SPA | 方案 B：前端模块 | 方案 C：改核心源码 |
|---|---|---|---|
| 做法 | Vue/React 或静态页，调 `api_jsonrpc.php` | 放 `modules/`，`manifest.json` 注册菜单，页面在模块内 | 直接改 `app/controllers`、`app/views` |
| 与主 UI 关系 | 独立入口，可挂同域子路径 | 出现在 Zabbix 左侧菜单，共用登录态 | 完全替代，用户无感知 |
| 登录/会话 | 同域复用 `zbx_session`；跨域需 Token | 天然复用 | 天然复用 |
| 开发量 | 中（只写前端） | 中（需懂模块结构与 PHP 入口） | 高（需读透原生页面逻辑） |
| 升级影响 | 无，只依赖 API 契约 | 低，升级时校验 manifest | 高，每次升级都要 merge |
| 许可风险 | 低，仅调 API | 中，与 Zabbix 同进程分发 | 高，衍生作品 |
| 像素级还原 | 完全可控 | 受布局槽位限制 | 可，但维护成本极高 |
| 适用 | 新入口、大屏、领导视图 | 要"融合进 Zabbix"且不做大改 | 不建议 |

### 为什么"替代主 UI"不成立

1. **前端没有可替换的壳。** Zabbix 7.0 是 PHP 服务端渲染 + `app/controllers` + `app/views`，没有前端路由层。要替换就等于重写整个前端。
2. **替代 ≠ 换一页。** 用户点进 Problems 之后还要去主机、最新数据、图形、报表、配置。要么全重写（数十人月），要么点一下就跳回原生——体验立刻断裂。
3. **登录、CSRF、角色权限都在 PHP 层。** 独立 SPA 接不了这套，只能复用会话或走 Token，做不了元素级权限控制。
4. **跟不起版本。** 7.0 本身就把前端重构成了 `app/` 目录结构，大版本一次改版，改源码的代价是每次升级重新 merge。

---

## 二、推荐架构

```
浏览器
  │  同域，自动携带 zbx_session cookie
  ▼
https://zabbix.example.com/
  ├── /api_jsonrpc.php          ← Zabbix 原生 API（不动）
  ├── /ui-custom/               ← 新增：静态 SPA（本原型）
  └── /modules/custom_menu/     ← 可选：极薄模块，只注册菜单项 + 跳转
```

**关键点：同域。** 一旦同域，三件事同时解决：

- 不需要处理 CORS；
- 不需要管理 Token；
- 浏览器自动带 `zbx_session`，用户从 Zabbix 点进来就是已登录状态。

官方文档明确：`zbx_session` cookie 就是供"来自模块或自定义控件的 JavaScript"调用 API 用的。

### 两种部署形态

**A1 同域子路径（推荐）**

```nginx
location /ui-custom/ {
    alias /usr/share/zabbix/ui-custom/;
    index index.html;
}
```

前端 `fetch('/api_jsonrpc.php', { credentials: 'include' })` 即可，无需 Token。

**A2 跨域独立站**

- 需要 Zabbix **7.0.7+**（该版本起 `Authorization` 头支持 CORS）；
- 用 API Token：`Authorization: Bearer <token>`；
- 注意 7.0 已**弃用** `auth` 请求字段，不要再按老教程写；
- Apache 默认不转发 `Authorization` 头，需加：
  `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`

**B 模块挂菜单（可选增强）**

只写一个极薄的 module：`manifest.json` + 一个菜单项，点击跳到 `/ui-custom/`。业务代码全部留在 A，模块不碰业务逻辑。这样用户从 Zabbix 左侧菜单就能进入，感知上就是"Zabbix 的新页面"，但升级风险几乎为零。

---

## 三、接口能力盘点（Zabbix 7.0 实测字段）

以下字段取自 `release/7.0` 分支源码，不是文档摘要。

### 3.1 问题列表

`problem.get` 输出字段共 18 个：

```
eventid, source, object, objectid, clock, ns, r_eventid, r_clock, r_ns,
correlationid, userid, name, acknowledged, severity, cause_eventid,
opdata, suppressed, urls
```

**没有 host 字段。** `objectid` 实际是 triggerid，主机名必须二次查询：

```json
{"method":"trigger.get","params":{
  "triggerids":["23891","23892"],
  "output":["triggerid","description","priority","value","lastchange"],
  "selectHosts":["hostid","host","name"]
}}
```

这是本项目最容易低估的一处工作量——列表页每次刷新都是 2 次请求，且必须批量，否则 N+1。

### 3.2 确认与关闭

`event.acknowledge` 的 `action` 是**位掩码组合**：

| 值 | 含义 |
|---|---|
| 0x01 | CLOSE 关闭 |
| 0x02 | ACKNOWLEDGE 确认 |
| 0x04 | MESSAGE 留言 |
| 0x08 | SEVERITY 改级别 |
| 0x10 | UNACKNOWLEDGE 取消确认 |
| 0x20 / 0x40 | SUPPRESS / UNSUPPRESS |
| 0x80 / 0x100 | 标记为因 / 标记为果 |

"确认并留言"= `2 | 4 = 6`。原型的确认按钮走的就是这条。

### 3.3 拓扑

`map.get` 支持 `selectSelements` / `selectLinks` / `selectLinkTriggers`。

- 节点坐标在 `selements[].x / .y`，逻辑画布 0–800 × 0–600；
- 连线用 `links[].selementid1 / selementid2` 关联；
- **`link.color` 是用户设置的样式色，不是状态色。** 链路告警变红要读 `linktriggers`，判断其所绑触发器是否有活动问题。

这意味着：**拓扑不需要新建数据源**，直接渲染客户已有的 Zabbix 网络映射图即可。前提是客户在 Zabbix 里画过这张图。

### 3.4 曲线

- `item.get` 拿 `itemid` + `value_type`（0 float / 1 char / 2 log / 3 uint / 4 text）；
- `history.get` 必须带 `history` 参数，且只能取保留期内的数据（默认 90 天）；
- 长周期走 `trend.get`（365 天，仅支持 0 和 3）；
- 24h × 1min = 1440 点/指标，必须降采样。

### 3.5 页面元素映射总表

| 页面功能 | API | 状态 |
|---|---|---|
| 问题列表 | `problem.get` | 原生支持 |
| 主机名 | `trigger.get` + `selectHosts` | 需二次 join |
| 级别/主机组/未确认/抑制筛选 | `problem.get` 的 `severities`/`groupids`/`acknowledged`/`suppressed` | 原生支持 |
| 搜索问题名 | `problem.get` 的 `search.name` | 原生支持（子串匹配） |
| 确认 / 关闭 | `event.acknowledge` | 原生支持 |
| 严重度统计 | `problem.get` + `countOutput` | API 无 group by，需 6 次或前端聚合 |
| 24h 新增趋势 | `event.get` + 前端分桶 | 需前端聚合 |
| 指标曲线 | `item.get` → `history.get` | 原生支持 |
| 拓扑 | `map.get` | 原生支持 |
| 节点状态上色 | `problem.get(hostids)` | 需二次 join |
| 通知送达记录 | `alert.get` | 只读展示 |
| **手动推送企业微信** | — | **不支持** |
| **拓扑自动发现** | — | **不支持** |

最后两条要特别注意，它们决定了需求边界：

- **Zabbix 没有"手动推送消息"的 API。** 消息由 Action + Media type（Webhook）触发，页面只能查 `alert.get` 看结果。原型里原本设计的"已推送至企业微信"按钮，改成了"通知送达"统计 + 失败原因展示——因为在真实系统里，那个按钮按下去没有对应的 API。
- **7.0 没有 LLDP 自动拓扑发现。** 原生拓扑是手工画的 sysmap。自动发现要另建采集（SNMP/LLDP）或从 CMDB 导入，属于独立工程。

---

## 四、必须提前知道的 8 个坑

1. **返回值全是字符串。** `severity: "5"`、`acknowledged: "0"`。JS 里 `"0"` 是真值，不 `Number()` 转换必然出 bug。
2. **没有 offset 分页。** 只有 `limit`。深分页要用 `eventid_till` 做游标，不能照搬常规 `page/size`。
3. **`problem.get` 没有 host。** 见 3.1，必须批量二次查询。
4. **history 会过期。** 默认 90 天，超期取不到，长周期必须切 trend。
5. **history 数据量大。** 单指标 24h 就是 1440 点，多指标叠加会拖死浏览器，必须降采样或换 trend。
6. **统计口径要统一。** 默认排除维护期抑制的问题；列表、统计卡、图表的口径不一致，会被现场质疑数据不准。
7. **认证方式变了。** 7.0 弃用 `auth` 字段，改 `Authorization: Bearer` 或 `zbx_session` cookie。
8. **权限在 API 层。** 独立 UI 不做前端元素级权限控制，但 API 会按登录用户过滤数据，不会越权。

---

## 五、工作量与风险

### 工作量（单人，基于本次原型）

| 阶段 | 内容 | 估算 |
|---|---|---|
| 已完成 | 静态原型（4 屏、真实数据结构、调用链展示、连接真实实例） | 1 人日 |
| P0 | 部署同域 + 接真实 API + 修字段差异 | 3–5 人日 |
| P1 | 问题页完整（筛选、游标分页、确认、详情、告警联动） | 8–12 人日 |
| P2 | 图形页（item 选择、history 降采样、trend 切换） | 5–8 人日 |
| P3 | 拓扑页（sysmap 渲染、状态联动、下钻） | 5–8 人日 |
| P4 | 大屏（可选） | 5–10 人日 |
| 合计 | MVP（P0–P3） | **约 4–6 周** |

### 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| AGPLv3 | 改源码再对内提供服务，开放义务边界需法务确认 | 走方案 A，仅调 API，不产生衍生作品 |
| 版本升级 | 7.0 前端结构已重构一次 | 只依赖 API 契约，不碰 PHP |
| 性能 | 大屏高频轮询直冲 API | 后端缓存 + 聚合，轮询间隔 ≥30s |
| 数据口径 | 抑制/维护状态导致数字对不上 | 固定口径并写进页面说明 |
| 拓扑数据源 | 客户没画 sysmap 就没有拓扑 | 先确认现场，没有则一期不做自动拓扑 |

---

## 六、落地路径建议

1. **第一步（1 周内可交付）**：把原型部署到 `/ui-custom/`，接真实实例，只上"问题"一页，内部试用。
2. **第二步**：补图形页与拓扑页；同时观察真实数据下的性能与口径问题。
3. **第三步**：需要入口曝光时，加极薄模块挂菜单，不搬业务代码。
4. **不做的**：不改核心 PHP、不重写全站、不在 7.0 上赌自动拓扑发现。

---

*本文接口字段取自 Zabbix `release/7.0` 分支源码（`CProblem.php` / `CEvent.php` / `CMap.php`），非二手文档。*
