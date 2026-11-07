# 部署到远程 Docker 服务器

> 目标：把本地 `python3 server.py` 这套东西，变成远程服务器上的一个容器，7×24 跑着。
> 全过程约 5 分钟，前提是**网络能通**（第 1 节）。

---

## 一、先确认一件事：服务器能访问 Zabbix

这是唯一可能让整个部署白做的环节。镜像构建、容器启动都不会报错，
但页面打开是空的 —— 因为容器连不到 `10.51.26.102` 这类内网地址。

**在 Docker 服务器上执行：**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://10.51.26.102/api_jsonrpc.php
```

- 返回 `200`/`405`/`412` → 通，继续
- 卡住或 `Connection refused` → **先解决路由**，否则后面都是白忙

然后确认**容器**也能通（Docker 的 NAT 与宿主机不完全等价）：

```bash
docker run --rm python:3.12-alpine \
  python -c "import urllib.request;print(urllib.request.urlopen('http://10.51.26.102/api_jsonrpc.php',timeout=6).status)"
```

如果宿主机通、容器不通，把 `docker-compose.yml` 里加一行 `network_mode: host`
（同时删掉 `ports:`，容器直接用宿主机网络栈）。

> `deploy.sh` 的第 3 步会自动做这件事，不用手动跑。

---

## 二、准备两张东西

### 2.1 ECharts（1 MB，没打进代码库）

```bash
# 在有网的机器上
curl -o public/vendor/echarts.min.js \
  https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js
```

`deploy.sh` 会检查这个文件，缺了直接报错。

### 2.2 凭据

```bash
cp config.docker.example.json config.json
vi config.json
chmod 600 config.json
```

填 `token` 或 `user`/`password`。三个实例可以只留一个，删掉不需要的 `profiles` 项即可。

**为什么凭据不打包进镜像**：Docker 镜像分层存储，即使后续 `RUN rm config.json`，
凭据仍留在历史层里，`docker history` 能挖出来。所以 `Dockerfile` 里**根本没有**
`COPY config.json`，改为运行时只读挂载。

---

## 三、上传并部署

### 方式 A：一键打包（推荐）

```bash
# 本地，项目根目录
bash deploy/package.sh
# → dist/zbx-console-deploy-20261107.tar.gz

scp dist/zbx-console-deploy-*.tar.gz ops@docker-host:/opt/
```

```bash
# 服务器
cd /opt && tar -xzf zbx-console-deploy-*.tar.gz
cd zbx-console-deploy-*
bash deploy.sh
```

`package.sh --with-config` 会把 `real/config.json` 一起带上（自动把 `bind` 改成 `0.0.0.0`），
省去在服务器上填凭据这一步。**注意这会带着明文凭据走网络**，按你的安全要求选。

### 方式 B：rsync 直传

```bash
rsync -av --delete \
  --exclude 'audit.jsonl' --exclude 'data/' --exclude 'tests/' --exclude 'config.json' \
  real/ ops@docker-host:/opt/zbx-console/
# 再把 deploy/ 下的 6 个文件拷过去
```

### 方式 C：git（如果代码在仓库里）

服务器上 `git clone` 后，把 `deploy/` 里的文件软链或拷到仓库根，再 `bash deploy.sh`。

---

## 四、访问方式（三选一）

当前实际部署（10.51.67.93 开发环境）采用 **a) 内网直连**：
`${ZBX_HOST_BIND:-0.0.0.0}:8770:8770`。**这个工具没有内置认证**，
任何能访问端口的人都能看到全部监控数据（含主机名、IP、告警详情），
因此只适合可信内网/开发环境。按场景选：

### a) 内网直连（当前方式）

```bash
# 浏览器直接打开（本机需绕过企业代理，或在代理白名单里加该 IP）
http://10.51.67.93:8770/
```

零隧道、开箱即用。收紧到仅本机：`ZBX_HOST_BIND=127.0.0.1 docker compose up -d`。

### a2) SSH 隧道（仅绑回环时的备选）

```bash
ssh -N -L 8770:127.0.0.1:8770 ops@docker-host
# 然后浏览器打开 http://127.0.0.1:8770/
```

### b) nginx + Basic Auth（推荐，团队共用）

```bash
# 服务器
sudo cp nginx.conf.example /etc/nginx/conf.d/zbx-console.conf
sudo htpasswd -c /etc/nginx/.htpasswd ops      # 设置访问密码
sudo vi /etc/nginx/conf.d/zbx-console.conf     # 改 server_name、放通内网段
sudo nginx -t && sudo systemctl reload nginx
```

配置里已经写好两个容易漏的点：
- `proxy_read_timeout 180s`（Zabbix 大范围取数慢，默认 60s 会 504）
- `location = /api/ping { auth_basic off; }`（健康检查免认证）

### c) 内网直连（仅限完全可信的网段）

```yaml
# docker-compose.yml
ports:
  - "8770:8770"        # 改这一行
```

改完必须配防火墙白名单：

```bash
sudo ufw allow from 10.51.0.0/16 to any port 8770
```

---

## 五、验证

```bash
curl http://127.0.0.1:8770/api/ping
# {"ok": true}

curl http://127.0.0.1:8770/api/meta | python3 -m json.tool | head -20
# 应看到三个实例、34 个只读方法

# 真实取数
curl -s -X POST http://127.0.0.1:8770/api_jsonrpc.php \
  -H 'Content-Type: application/json-rpc' -H 'X-Zbx-Profile: zbx8' \
  -d '{"jsonrpc":"2.0","method":"host.get","params":{"countOutput":true},"id":1}'
# {"jsonrpc":"2.0","result":"70",...}

# 只读闸门（必须被拦）
curl -s -X POST http://127.0.0.1:8770/api_jsonrpc.php \
  -H 'Content-Type: application/json-rpc' -H 'X-Zbx-Profile: zbx8' \
  -d '{"jsonrpc":"2.0","method":"host.update","params":{"hostid":"1"},"id":1}'
# {... "message": "Blocked by read-only proxy" ...}
```

`deploy.sh` 会自动跑完这四条并打印结果。

浏览器打开后，如果某个实例报错，看审计日志确认请求是否发出去了：

```bash
docker exec zbx-console sh -c 'tail -20 /app/audit.jsonl'
```

---

## 六、更新与回滚

```bash
# 更新代码
cd /opt/zbx-console-deploy-*
# 传新文件进来后：
docker compose up -d --build

# 只重启
docker compose restart

# 回滚：镜像打了 tag 的话
docker tag zbx-console:4.1 zbx-console:rollback
# ...出问题后...
docker compose down && docker run -d --name zbx-console \
  -v ./config.json:/app/config.json:ro -v zbx-console-audit:/data \
  -p 127.0.0.1:8770:8770 zbx-console:rollback
```

数据只有审计日志（named volume `zbx-console-audit`），`docker compose down`
**不会**删它；只有 `down -v` 才删。

---

## 七、六个容易踩的坑

### 坑 1 · `config.json` 挂载后变成目录

宿主机上文件**不存在**时，Docker 会在挂载点创建一个同名**目录**，
容器里 `open("/app/config.json")` 报 `IsADirectoryError`，启动即崩。

```bash
ls -ld config.json        # 必须是 -rw------- 的文件，不能是 drwxr-xr-x
```

`deploy.sh` 第 2 步会拦住这种情况。

### 坑 2 · 端口映射了但外面连不上

容器里 `BIND` 还是 `127.0.0.1`，只监听容器自己的回环，映射形同虚设。

已通过 `environment: ZBX_BIND: 0.0.0.0` 解决（`server.py:38` 优先读环境变量）。
如果你手动 `docker run`，别忘了带上：

```bash
docker run -e ZBX_BIND=0.0.0.0 -p 127.0.0.1:8770:8770 ...
```

### 坑 3 · 审计日志静默丢失

`audit()` 里是 `except OSError: pass`。当 `/app` 不可写（只读根文件系统、非 root 用户）时，
**不会报错，只是不写**。看起来一切正常，出问题时才发现没有审计记录。

所以镜像里做了 `ln -s /data/audit.jsonl /app/audit.jsonl`，
compose 挂 `zbx-audit:/data`。验证：

```bash
docker exec zbx-console sh -c 'wc -l /app/audit.jsonl'
```

数字应该随访问增长。

### 坑 4 · 服务器拉不到 `python:3.12-slim`

内网 Docker 服务器常见没有 Docker Hub 出口。在有网的机器上：

```bash
docker pull python:3.12-slim
docker save python:3.12-slim | gzip > python312slim.tar.gz
# 传到内网服务器
docker load < python312slim.tar.gz
```

然后 `docker compose build`（去掉 `--pull`，或者直接 `docker build`）。

### 坑 5 · 页面时间显示和服务器时区不一致

**不影响。** 前端 `fmtTime()` 用的是 `new Date(sec*1000)` + `getHours()`，
按**浏览器**本地时区渲染，与容器 `TZ` 无关。
容器设 `TZ=Asia/Shanghai` 只是让日志更好读。

### 坑 6 · 大区间查询 504

nginx 默认 `proxy_read_timeout 60s`。查 30 天数据时 Zabbix 可能超过这个时间。
`nginx.conf.example` 里已设 180s，照抄即可。

---

## 八、容器里和本地有什么不同

| 项 | 本地 | 容器 |
|---|---|---|
| 绑定地址 | `127.0.0.1`（config.json） | `0.0.0.0`（环境变量覆盖） |
| 运行用户 | 你 | `zbx` (UID 10001)，非 root |
| 根文件系统 | 可写 | **只读**（`/tmp` 为 tmpfs） |
| 审计日志 | `real/audit.jsonl` | 卷 `zbx-console-audit` → `/data/audit.jsonl` |
| 配置 | `real/config.json` | 只读挂载 `/app/config.json` |
| 重启策略 | 手动 | `unless-stopped` |
| 健康检查 | 无 | `/api/ping` 每 30s |

代码本身**一行没改** —— 全部差异靠环境变量和挂载解决。这是当初把
`BIND`/`PORT` 做成可被环境变量覆盖的收益。

---

## 九、文件清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 镜像定义：python:3.12-slim、非 root、只读根、审计 symlink |
| `.dockerignore` | 挡住 `config.json` / `audit.jsonl` / `data/` 进构建上下文 |
| `docker-compose.yml` | 编排：端口、卷、只读根、健康检查、日志轮转 |
| `config.docker.example.json` | 凭据模板（`bind` 已设为 `0.0.0.0`） |
| `nginx.conf.example` | 反代 + Basic Auth + 超时调优 |
| `deploy.sh` | 服务器端一键：预检 → 探网 → 构建 → 启动 → 验收 |
| `package.sh` | 本地打包成 tar.gz |
| `README-部署.md` | 本文 |

---

## 八、实际部署记录（2026-11-07 · 10.51.67.93）

已按本方案在 `dev-ubuntu`（10.51.67.93，Ubuntu 24.04 / Docker 29.8 / Compose v5.5.1）完成部署并验收通过。

- 目录：`/opt/zbx-console`（独立目录，未动服务器上其他项目）
- 镜像：`zbx-console:4.1`；容器：`zbx-console`；网络：`zbx-console_default`；卷：`zbx-console-audit`
- 端口：**`0.0.0.0:8770` 内网直连**（用户确认本机可直接访问开发环境端口，无需 SSH 隧道）
  → 浏览器打开 `http://10.51.67.93:8770/`；需要收紧时 `ZBX_HOST_BIND=127.0.0.1 docker compose up -d`
- 客户端注意：本机有企业代理时，浏览器/命令行访问该内网 IP 需绕过代理
  （curl 用 `--noproxy '*'`；测试脚本已给 Chrome 加 `--no-proxy-server`）

### 验收结果（容器内实测）

| 项 | 结果 |
|---|---|
| `/api/ping` | `{"ok": true}`，HEALTHCHECK healthy |
| `/api/meta` | 只加载 `zbx7`/`zbx4`，34 个只读方法，`access_mode=basic` |
| 取数 | zbx7 `host.get`=2（该实例本就只有 2 台主机）；zbx4 `host.get`=157 |
| 只读闸门 | `host.update` → `Blocked by read-only proxy`，审计留痕 |
| 审计卷 | `/data/audit.jsonl` 经 symlink 正常落卷，超过 5 MB 自动轮转（保留 5 份） |
| **访问控制（v4.2）** | 未认证访问 `/`、`/api/meta`、静态资源、POST → **401**；错误口令 → 401；带凭据 → 200；`/api/ping` 免认证供健康检查 |
| **审计轮转（v4.2）** | 单测：阈值 300 B / 保留 3 份 → 生成 `.1/.2/.3`，无 `.4`，当前文件回落阈值内 |
| **统一错误态（v4.2）** | 上游不可达时显示明确错误卡片（含实例、失败方法、原因、重试/关闭），顶栏与导航仍在，不白屏；正常加载时错误条隐藏 |
| UI 冒烟（真实浏览器） | zbx7 `ALL PASS 20`、zbx4 `ALL PASS 20`（新增"错误条默认隐藏"断言） |
| 响应式检查 | zbx7/zbx4 各 `ALL PASS 112`（1100/980/830/760/560 五档） |
| 整页截图 | 7 页全部正常，CSS/图表/拓扑渲染无异常，无意外错误条 |

### 本次实际踩到并已修的坑

1. **`config.json` 属主**：容器以 UID 10001 运行，宿主机上须 `chown 10001:10001 config.json`
   （只 `chmod 600` 不够，属主不对照样读不到，报 `KeyError: upstream`）。
2. **实例下线开关**：实例临时停用不必删配置，加 `"enabled": false` 后重启即可
   （`server.py` 已支持；zbx8 下线期间即用此方式）。
3. **`deploy.sh` 非交互执行**：已支持 `ASSUME_YES=1` 跳过确认；探测自动跳过停用实例。

---

## 九、安全加固（v4.2 · P0 批次）

端口绑 `0.0.0.0` 后，同网段任何人都能读到全部监控数据，因此在 `server.py` 里加了三层防护。
**全部零依赖**（Python 标准库），不需要额外容器。

### 9.1 HTTP Basic Auth

`config.json` 新增 `access` 段：

```jsonc
"access": {
  "mode": "basic",              // "off" = 免认证（本地开发默认）
  "user": "zbxview",
  "password": "<随机口令>",
  "public_paths": ["/api/ping"] // 必须保留，否则 HEALTHCHECK 会失败
}
```

- 凭据**只在服务端**，不下发浏览器；比对用 `hmac.compare_digest`（抗时序攻击）。
- 所有 HTTP 入口（GET/POST/HEAD/OPTIONS）统一过闸，包括静态资源。
- `/api/ping` 只返回 `{"ok":true}`，不含任何监控数据，可安全放行。
- 浏览器第一次访问会弹登录框，之后自动记住（同源请求自动带 Authorization）。
- **想回到完全免认证**：把 `mode` 改成 `off`，`docker compose restart` 即可，无需重建镜像
  （配置是运行时挂载的）。

浏览器之外访问：

```bash
curl -u 'user:password' http://10.51.67.93:8770/api/meta
```

### 9.2 自动化测试如何带凭据

三个测试脚本都读环境变量 `BASIC_AUTH`（`user:password`），通过 CDP 的
`Network.setExtraHTTPHeaders` 给所有请求（含文档导航）统一附加 Authorization：

```bash
export BASIC_AUTH='user:password'
node real/tests/ui-smoke.mjs zbx4 http://10.51.67.93:8770
BASE=http://10.51.67.93:8770 node real/tests/responsive.mjs zbx4 10084
BASE=http://10.51.67.93:8770 node real/tests/shots.mjs zbx4 10084
```

不设该变量时脚本行为不变（用于本地 `access=off` 环境）。

### 9.3 审计日志轮转

`config.json` 新增 `audit_rotate`（默认 5 MB × 5 份）。写审计时在同一把 `LOCK` 内
先检查大小再追加，超过阈值滚成 `audit.jsonl.1/.2/...` 并淘汰最老一份，避免多线程竞争。
轮转失败（只读文件系统等）只影响归档，主流程照常。

查看：`docker exec zbx-console sh -c 'ls -l /data/'`

### 9.4 统一错误态

上游不可达 / 凭据失效 / 代理异常时，页面顶部显示统一错误卡片：
实例 ID、Zabbix 版本、失败方法、原因说明、「重新加载」「关闭」按钮；顶栏与导航保留，不会白屏。
正常加载后自动收起。运行时若返回 401，会提示刷新页面重新认证。

对应代码：`app.js` 的 `showGlobalError / clearGlobalError / noteRpcFailure`，
`rpc()` 统一规范化网络错误与 401，`boot()` 的 catch 负责展示。
冒烟脚本有断言「全局错误条在数据正常时保持隐藏」。
