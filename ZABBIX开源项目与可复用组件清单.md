# ZABBIX 开源项目与可复用组件清单（可直接利用 / 二次开发底座）

> 整理日期：2026-09-20 ｜ 数据经 GitHub API 实时核实（星标 / 协议 / 最后提交）

## 一句话结论

**有，而且分层很清晰：**
- **想最快见效**：Grafana + grafana-zabbix 插件，**零代码**出大屏，1–3 天。
- **想完全可控自研**：ECharts 做图表 + AntV G6 做拓扑 + 自封装 Zabbix API，2–3 个月。
- **⚠️ 唯一要避开的坑**：ZabbixWatch（现名 ITOps-Watch）**已商业化且无开源协议**，只能当功能参考，**不能**作为二次开发底座。

---

## 一、平台级：可直接部署使用（零/低代码）

### ⭐ Grafana + grafana-zabbix 插件 —— 首选
| 项 | 值 |
|---|---|
| 仓库 | `grafana/grafana-zabbix`（已从个人仓 `alexanderzobnin` 迁入 **Grafana 官方组织**） |
| 协议 | **Apache-2.0**（商用友好） |
| 星标 / 活跃 | 2244★，最后提交 **2026-09-20**（当天，非常活跃） |
| 安装 | `grafana-cli plugins install alexanderzobnin-zabbix-app` |

**能力**：正则批量选指标、模板变量做可复用仪表盘、Annotations 把事件叠加到曲线上、**Triggers 面板**直接显示活动问题、告警（Alerting）、多数据源混合。**Direct DB Connection** 可直连 Zabbix 库查历史，大幅提速。

**用于本项目**：
- 大屏：Dashboard + 播放/幻灯片模式，可直接导入社区模板（ID `8677`、`6098`）。
- 拓扑：可用 Grafana **Node Graph** 面板或社区 **Flowcharting** 插件，接 Zabbix 数据源渲染。
- 坑：插件 4.6.1+ 要求 **Grafana ≥ 10**，老版本 Grafana 需降级到 4.5.7。

---

## 二、组件/SDK 层：拿来做二次开发的底座

### 1）数据接入层
| 项目 | 协议 | 星标 | 最后提交 | 说明 |
|---|---|---|---|---|
| **Zabbix JSON-RPC API**（原生） | 随 Zabbix | — | — | 端点 `/api_jsonrpc.php`，`host.get`/`item.get`/`trigger.get` 等。**首选，最稳** |
| `lukecyca/pyzabbix` | **无 License** | 985★ | 2025-09 | Python 客户端，能用但**无协议有法律风险**，建议参考其封装思路后自己用 requests 写 |
| `initMAX/zabbix-mcp-server` | **AGPL-3.0** | 203★ | 2026-08 | Zabbix MCP Server（AI 场景）。AGPL 有强传染性，商用二开**慎用** |

> 建议：后端直接用 `requests` / `httpx` 自己封装一层薄 API 客户端（<200 行），既避开无协议依赖，又便于加缓存。

### 2）大屏可视化层
| 项目 | 协议 | 星标 | 最后提交 | 说明 |
|---|---|---|---|---|
| **Apache ECharts** | Apache-2.0 | 67353★ | 2026-09-16 | 图表主力，国内生态最成熟；内置 `graph` 关系图也能画轻量拓扑 |
| `DataV-Team/DataV` | MIT | 9707★ | **2024-06-14（约 2 年未更新）** | 大屏边框/装饰/数字翻牌组件。**维护已停滞**，建议只借鉴其 CSS/视觉思路，别绑死依赖 |
| DataV-React | MIT | — | — | React 版大屏装饰组件，可做备选 |

### 3）拓扑图引擎层（本项目核心选型）
| 项目 | 协议 | 星标 | 最后提交 | 适用场景 |
|---|---|---|---|---|
| **AntV G6** ⭐ | MIT | 12300★ | 2026-07-15 | **首选**。10+ 布局算法（含力导向/层级）、Canvas/SVG/WebGL 渲染、节点边高度可定制，最适合运维网络拓扑 |
| **AntV X6** | MIT | 6707★ | 2026-08-11 | 图**编辑**引擎，适合需要拖拽手绘、连线编辑、拓扑编排的场景 |
| `cytoscape/cytoscape.js` | MIT | 11220★ | 2026-09-16 | 交互与图算法(中心性/最短路径)极强，做故障影响面分析很合适 |
| `visjs/vis-network` | Apache-2.0 | 3631★ | 2026-09-20 | 上手最快、轻量，力导向开箱即用，**做 MVP 最快** |

> 选型建议：MVP 用 `vis-network` 快速出图；正式版用 **G6**（要编辑能力就 X6）。

---

## 三、⚠️ 看起来很香，但【不能】拿来做二次开发

### ZabbixWatch / ITOps-Watch
- 主仓已从 `zlpu/zabbixwatch-demo` **改名为 `zlpu/ITOps-Watch-demo`**，128★，最后提交 2026-09-17。
- **协议：NONE（无任何开源许可证）** → 法律上默认「保留所有权利」。
- Gitee 页面明确写明：**「v4 及后续版本需要有偿提供，v3 版免费不开源」**（v4 走淘宝付费）。
- v4（2026-01-18）才新增的「自定义网络拓扑」功能，**属于付费版本**。

**结论**：可以拿它的**界面截图和功能清单**做需求参考、给领导演示；但**不能** clone 下来改代码交付（无协议 + 商业化授权风险）。

---

## 四、重要决策提示：别赌 Zabbix 8.0 的原生拓扑

- 当前**最新稳定版仍是 7.4**；Zabbix 官方文档中 **8.0 仍标注为 `devel` / In development**（尚未正式 GA）。
- 官方 Roadmap 确实列了「**网络拓扑的自动发现和直观可视化**」「NetFlow 采集与可视化」「网络设备可视化小部件」「开箱即用的网络自动发现」，但在已公开的 8.0 文档导航中**尚未确认落地**。
- **建议**：一期按自研推进（G6 + CMDB/LLDP 数据），不要为等 8.0 而停工；8.0 GA 后再评估是否迁移到原生能力。

---

## 五、推荐组合方案

| | **方案 A：低代码快速见效** | **方案 B：完全自研可控** |
|---|---|---|
| 大屏 | Grafana + grafana-zabbix | Vue3/React + ECharts（+ DataV 装饰思路） |
| 拓扑 | Grafana Node Graph / Flowcharting | **AntV G6**（需编辑则 X6） |
| 取数 | 插件自带 + Direct DB | 自封装 Zabbix API 客户端 |
| 后端 | 无需 | Flask / FastAPI + 定时聚合缓存 |
| 工期 | **1–2 周** | **2–3 个月** |
| 优点 | 快、稳、零代码、官方维护 | 视觉/交互完全可控，可产品化 |
| 缺点 | 大屏炫酷度有限，深度定制难 | 投入大，需自维护 |

> **务实建议**：先用**方案 A 跑 1–2 周**验证真实需求、拿到领导认可，再决定是否投方案 B。

---

## 六、License 红线（一句话速查）

- 🟢 **放心商用/二开**：MIT、Apache-2.0 → G6、X6、Cytoscape.js、ECharts、vis-network、grafana-zabbix
- 🟡 **谨慎/别依赖**：**无 License** → pyzabbix、ZabbixWatch（自己封装替代）
- 🔴 **商用二开避开**：**AGPL-3.0** → zabbix-mcp-server（衍生作品需同协议开源）
- ⚠️ 另注：Zabbix 自身 7.0 起为 **AGPLv3**，但**外部独立应用经 API 调用不受传染**（进程隔离），坚持「外部应用 + API」架构即可规避。
