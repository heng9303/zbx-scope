# 02 · API 契约与版本适配

> 本文所有结论都来自对本环境 Zabbix 的**实测请求返回**，不是照抄官方文档。
> 判定依据：`10.51.26.102`（8.0.0）、`10.51.26.103`（7.0.31）、`10.51.31.201`（4.0.50）。

---

## 一、连接与认证

```
POST http://<host>/api_jsonrpc.php
Content-Type: application/json-rpc
```

| 版本 | 认证方式 | 请求头 / 请求体 |
|---|---|---|
| 5.0 及以上 | API Token | `Authorization: Bearer <token>` |
| 4.0 – 6.x | 会话 | `user.login` → `sessionid`，后续请求体带 `"auth": "<sid>"` |
| 4.0 的 `user.login` 参数 | | `{"user": "...", "password": "..."}` |
| 5.4+ 的 `user.login` 参数 | | `{"username": "...", "password": "..."}` |

> 参数名切换点不是「6.0」，而是 **5.4**。写适配时按 `major > 5 || (major == 5 && minor >= 4)` 判断。
> 不要用「失败后换字段名再试一次」的兜底——4.0 会返回
> `Invalid parameter "/": unexpected parameter "username"`，把真正的错误盖掉，还多消耗一次失败计数。

**4.0 的两个易错点（已实测踩过）**

```jsonc
// ✅ 正确：auth 与 params 平级
{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid"]},"auth":"<sid>","id":1}

// ❌ 错误：auth 塞进了 params
{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid"],"auth":"<sid>"},"id":1}
```

- 后者返回 `Invalid params / Not authorised.`，**但登录本身是成功的**，
  看起来极像「账号没有 API 权限」，实际是信封写错了。
- 4.0 的用户名字段叫 `alias`，5.4+ 才改叫 `username`。
  用 `output:["username"]` 查 4.0 不会报错，只是**静默丢字段**；
  `filter:{username:"x"}` 同样被忽略，变成「过滤条件凭空消失、返回全部用户」。

---

## 二、实测契约差异（10 条）

这 10 条都是「不报错但结果不对」或「报错但信息误导」，是最容易写出错误页面的地方。

| # | 现象 | 实测表现 | 正确处理 |
|---|---|---|---|
| 1 | `selectGroups` **静默失效** | `host.get` 传 `selectGroups` 时返回的主机**没有** `groups` 字段，且不报错，极易误判为「环境没有分组」 | 7.0+ 用 `selectHostGroups`，读 `hostgroups`；`<7` 用 `selectGroups`，读 `groups`。前端统一成 `hostgroups` 一份 |
| 2 | `problem.get` **不含主机** | 问题对象 18 个字段里没有 `hostid`/`host`，只有 `objectid`（即 `triggerid`） | `trigger.get(triggerids=[...], selectHosts=[...])` 二次关联 |
| 3 | 按 `priority + limit` 取触发器会漏 | `trigger.get` 按 `priority` 倒序取 200 条时，`value=1` 的只有 60 条——真正在警的 36 个触发器会被截在结果外 | 告警**必须**从 `problem.objectid` 反查，不能靠排序+分页 |
| 4 | `sortfield: "lastclock"` 被拒 | `item.get` 报 `Sorting by field "lastclock" not allowed.` | 用默认字段排序，前端本地排（本页取回全部监控项后本地分页） |
| 5 | `history` 必须匹配 `value_type` | float 项传 `history=3` 时返回 `[]`，**不报错** | `float=0 / char=1 / log=2 / uint=3 / text=4`，取 `item.value_type` 直接透传 |
| 6 | 拓扑元素没有 `elementid` | `selements[].elementid` 为 `null`，主机在 `elements[].hostid` | 按 `elements[0].hostid` 取主机；7.0+ 与 4.x 路径不同，见 `CAPS.mapNode` |
| 7 | 所有数值都是**字符串** | `severity:"4"`、`acknowledged:"0"`；`"0"` 在 JS 里是真值 | 一律 `Number()` 后再比较，不要写 `if (obj.acknowledged)` |
| 8 | 告警媒介被禁用 | 3992 条发送记录中 3632 条失败，错误全是 `Media type disabled.` | 需在 Zabbix 侧启用媒介；本页只负责**如实展示**，不改配置 |
| 9 | 打印机告警中文编码错乱 | 告警名称是 `ES 8A 9F E7 B2 89…`，即「灰色」的 UTF-8 字节被当成十六进制文本输出 | 前端按 UTF-8 原样复原；根治要在打印机模板编码里改 |
| 10 | 4.0 的 `auth` **必须在请求根级** | 把 `auth` 放进 `params` 时返回 `{"code":-32602,"message":"Invalid params.","data":"Not authorised."}`，**而 `user.login` 明明成功了**——极易误判成「账号没有权限」 | 信封写成 `{jsonrpc, method, params, id, auth}`；`auth` 与 `params` 平级。见 `server.py::_post()` |

第 3 条尤其值得记住：它说明「把 Zabbix 的列表接口当分页接口用」是不可靠的，
筛选/排序应当尽量在**取回全量之后**做，或者用接口明确支持的过滤字段。

---

## 三、本项目用到的请求

| 方法 | 关键参数 | 用途 | 备注 |
|---|---|---|---|
| `apiinfo.version` | — | 版本探测 → `buildCaps()` | 不需要认证，可最先调用 |
| `host.get` | `output`, `selectInterfaces`, `selectParentTemplates`, `<CAPS.groupSelect>` | 主机全量 | 上限 500 |
| `problem.get` | `output:"extend"`, `selectTags`, `selectAcknowledges`, `limit:500` | 当前告警 | 无主机字段 |
| `trigger.get` | `triggerids[]`, `selectHosts` | 问题→主机、触发器详情 | 一次批量，勿循环单条 |
| `event.get` | `time_from`, `source:0`, `limit:5000` | 14 天告警趋势 | 只取 `clock`/`severity` |
| `alert.get` | `countOutput:true` + `filter.status` | 发送总数/失败/成功 | 三个计数各一次 |
| `mediatype.get` | — | 告警媒介名称 | 用于解释失败原因 |
| `item.get` | `hostids` / `itemids[]`, `search.key_` | 监控项列表、LLDP 发现 | `sortfield:lastclock` 不可用 |
| `history.get` | `itemids[]`, `history=<value_type>`, `from/to` | 图形原始值 | 见坑 5 |
| `trend.get` | `itemids[]`, `time_from` | 长区间小时聚合 | 区间 > 24h 自动切换 |
| `graph.get` | `hostids`, `selectGraphItems` | 原生图形 | 无权限时静默空 |
| `map.get` | `selectSelements`, `selectLinks`, `selectShapes` | 映射图节点/连线 | 见坑 6 |
| `hostgroup.get` | — | 组列表（备用） | 本页组计数由 `host.get` 聚合得到 |

**批量原则**：凡接口支持 `itemids[]` / `triggerids[]` 的，一律一次多取。
多序列图形是 `item.get` 1 次 + `history.get` 1 次，无论选 2 条还是 8 条。

---

## 四、静默失败的坑

这几类请求**不会返回 error，只会给你空数组或错值**，排查时优先怀疑它们：

1. `history.get` 的 `history` 与 `value_type` 不一致 → `[]`
2. 7.0+ 用 `selectGroups` → 结果里没有组字段（不报错）
3. 4.x 用 `problem.get(hostids=...)` → 可能被忽略，返回全量问题
4. `item.get` 用了未列入白名单的 `sortfield` → 直接报错（这个会报）
5. 时间区间超出保留期（history 默认 7 天、trend 365 天）→ `[]`

**排查手法**：拿到空结果时，先单独发一条最小请求（只带 `limit:1`，不带时间窗），
确认「这个对象到底有没有数据」，再回头怀疑参数。

---

## 五、错误对象与前端呈现

Zabbix 的错误是 JSON-RPC 标准结构：

```json
{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params.","data":"..."},"id":1}
```

代理的两类补充：

| 来源 | code | message | data |
|---|---|---|---|
| 白名单拦截 | `-32601` | `Blocked by read-only proxy` | `方法 X 不在只读白名单内，请求未发送到 Zabbix` |
| 认证/网络失败 | `-32000` | `Proxy error` | 上游原文（含版本号、参数名、排查提示） |

前端 `rpc()` 遇到 `error` 会抛 `Error(method + ": " + (data || message))`，
页面顶部出现红色 `jsErr` 条，同时把这条失败写进「接口页」的调用链。**不吞错**是硬约定。

---

## 六、新增一个版本的适配清单

以「要接 6.0」为例：

1. `config.json` 加一个 profile（6.0 用 `login` 认证，`user`/`username` 由代理自动判定）
2. 启动后看顶栏 `v6.0.x` 是否出现、`/api/meta` 是否连上
3. 核对 `buildCaps()` 的分支：6.0 应落在 `<7` 分支（`groups` / `selectGroups` / `elementid`）
4. 若该版本 `problem.get` 支持 `hostids`，可把 `CAPS.problemHostids` 放宽（当前阈值 `>=6`）
5. 跑 `node tests/ui-smoke.mjs <profile>`，至少保证：主机列表有行、详情有监控项、图形能画、拓扑有节点、写操作被拦
6. 在本文第二节补一行实测结论（哪条坑在该版本不同）

> 判断「要不要改业务代码」的标准：**只看 `CAPS` 有没有表达出这个差异**。
> 如果需要写 `if (version...)`，说明该补一个 CAPS 字段，而不是就地判断。
