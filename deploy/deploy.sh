#!/usr/bin/env bash
# Zabbix 只读控制台 · 远程服务器部署脚本
#
# 在**Docker 服务器上**、部署目录内执行：
#   bash deploy.sh
#
# 做的事：环境预检 → 网络连通性探测 → 构建镜像 → 启动 → 等待健康 → 打印访问方式
# 幂等：可重复执行，会自动重建容器

set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; DIM='\033[2m'; RST='\033[0m'
ok()   { printf "${GRN}  ✓${RST} %s\n" "$*"; }
warn() { printf "${YEL}  !${RST} %s\n" "$*"; }
die()  { printf "${RED}  ✗${RST} %s\n" "$*" >&2; exit 1; }
step() { printf "\n${DIM}── %s ─────────────────────────────${RST}\n" "$*"; }

# ─────────────────────────────── 1. 环境预检
step "1/6 环境预检"

command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker Engine"
ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"

if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    warn "使用旧版 docker-compose（建议升级到 compose v2）"
else
    die "未找到 docker compose 插件，也未找到 docker-compose"
fi
ok "compose: $($COMPOSE version --short 2>/dev/null || echo "$COMPOSE")"

docker info >/dev/null 2>&1 || die "docker 守护进程不可用（当前用户可能不在 docker 组）"

[ -f server.py ]  || die "缺少 server.py（请在部署目录内执行）"
[ -d public ]     || die "缺少 public/ 目录"
[ -f public/vendor/echarts.min.js ] || die "缺少 public/vendor/echarts.min.js（见 README 第二节）"
ok "代码文件齐全（app.js $(wc -c < public/js/app.js) 字节，echarts $(wc -c < public/vendor/echarts.min.js) 字节）"

# ─────────────────────────────── 2. 配置检查
step "2/6 配置检查"

if [ ! -f config.json ]; then
    if [ -f config.docker.example.json ]; then
        cp config.docker.example.json config.json
        warn "已从模板生成 config.json —— 请填入真实凭据后重新执行"
        printf "\n  编辑： ${DIM}vi %s/config.json${RST}\n\n" "$PWD"
        exit 1
    fi
    die "缺少 config.json"
fi

# JSON 合法性 + 是否还有占位符
python3 - <<'PY' || die "config.json 校验失败"
import json, sys
try:
    cfg = json.load(open("config.json", encoding="utf-8"))
except Exception as e:
    print(f"  ✗ config.json 不是合法 JSON: {e}"); sys.exit(1)

bad = [p.get("id", "?") for p in cfg.get("profiles", [])
       if "<" in str(p.get("token", "")) or "<" in str(p.get("password", ""))]
if bad:
    print(f"  ✗ 以下实例仍是占位符，请填入真实凭据: {', '.join(bad)}"); sys.exit(1)

n = len(cfg.get("profiles", []))
print(f"  ✓ config.json 合法，{n} 个实例: {', '.join(p.get('id','?') for p in cfg.get('profiles', []))}")
PY
chmod 600 config.json
ok "config.json 权限已收紧为 600"

# ─────────────────────────────── 3. 网络连通性（最常见的失败点）
step "3/6 上游连通性探测（在临时容器内，模拟运行时网络）"

UPSTREAMS=$(python3 -c "
import json
cfg=json.load(open('config.json'))
print('\n'.join(p.get('upstream','') for p in cfg.get('profiles',[])
                if p.get('upstream') and p.get('enabled') is not False))
")

# 用一个临时容器测，因为它和正式容器走同样的 docker 网络（NAT/路由一致）
IMG_SRC=$(grep -E '^FROM ' Dockerfile | awk '{print $2}')
PROBE_IMG="$IMG_SRC"
if ! docker image inspect "$PROBE_IMG" >/dev/null 2>&1; then
    PROBE_IMG="python:3.12-alpine"
fi

PROBE_FAIL=0
while IFS= read -r url; do
    [ -z "$url" ] && continue
    host=$(echo "$url" | sed -E 's#^https?://##; s#/.*$##')
    printf "  ${DIM}·${RST} %-28s " "$host"
    if docker run --rm --network bridge "$PROBE_IMG" \
        python -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1],timeout=6)" "$url" >/dev/null 2>&1; then
        printf "${GRN}可达${RST}\n"
    elif docker run --rm --network bridge "$PROBE_IMG" \
        python -c "import socket,sys; socket.create_connection((sys.argv[1],int(sys.argv[2])),5)" \
        "${host%%:*}" "${host##*:}" >/dev/null 2>&1; then
        printf "${GRN}端口可达${RST}${DIM}（HTTP 有响应，但非 2xx —— 检查 upstream 路径）${RST}\n"
    else
        printf "${RED}不可达${RST}\n"; PROBE_FAIL=$((PROBE_FAIL+1))
    fi
done <<< "$UPSTREAMS"

if [ "$PROBE_FAIL" -gt 0 ]; then
    warn "有 $PROBE_FAIL 个上游不可达。容器能启动，但取不到数据。"
    warn "排查：宿主机 curl 是否通？是否需要 host 网络或指定 --network？"
    warn "临时方案：把 docker-compose.yml 改成 network_mode: host 后重试"
    if [ "${ASSUME_YES:-0}" = "1" ] || [ ! -t 0 ]; then
        warn "非交互模式（ASSUME_YES=1），继续构建"
    else
        printf "\n  继续构建？[y/N] "
        read -r ans </dev/tty || ans=n
        case "$ans" in [yY]*) ;; *) die "已中止" ;; esac
    fi
fi

# ─────────────────────────────── 4. 构建
step "4/6 构建镜像"
$COMPOSE build --pull 2>&1 | tail -20 || die "镜像构建失败"
ok "镜像 zbx-console:4.1 构建完成（$(docker image inspect zbx-console:4.1 --format '{{.Size}}' 2>/dev/null | awk '{printf "%.0f MB", $1/1024/1024}')）"

# ─────────────────────────────── 5. 启动
step "5/6 启动容器"
$COMPOSE up -d 2>&1 | tail -10

printf "  等待健康检查"
for i in $(seq 1 40); do
    st=$(docker inspect -f '{{.State.Health.Status}}' zbx-console 2>/dev/null || echo "starting")
    case "$st" in
        healthy)   printf " ${GRN}healthy${RST}\n"; break ;;
        unhealthy) printf " ${RED}unhealthy${RST}\n"; break ;;
    esac
    printf "."; sleep 1.5
done

if [ "${st:-}" != "healthy" ]; then
    die "容器未进入 healthy 状态。查看日志： docker compose logs --tail=50"
fi

# ─────────────────────────────── 6. 验收
step "6/6 验收"

curl -sf --noproxy '*' http://127.0.0.1:8770/api/ping >/dev/null \
    && ok "/api/ping 正常" || die "/api/ping 无响应"

curl -sf --noproxy '*' http://127.0.0.1:8770/api/meta | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f\"  ✓ 实例 {[p['id'] for p in d['profiles']]}，只读方法 {len(d['allowed_methods'])} 个\")
" || warn "/api/meta 解析失败"

if curl -sf --noproxy '*' -X POST http://127.0.0.1:8770/api_jsonrpc.php \
    -H 'Content-Type: application/json-rpc' -H 'X-Zbx-Profile: '"$(python3 -c "import json;print(json.load(open('config.json'))['active'])")" \
    -d '{"jsonrpc":"2.0","method":"host.get","params":{"countOutput":true},"id":1}' 2>/dev/null | grep -q '"result"'; then
    ok "真实取数成功（host.get 有返回）"
else
    warn "host.get 无结果 —— 检查凭据与账号权限"
fi

if curl -s --noproxy '*' -X POST http://127.0.0.1:8770/api_jsonrpc.php \
    -H 'Content-Type: application/json-rpc' -H 'X-Zbx-Profile: '"$(python3 -c "import json;print(json.load(open('config.json'))['active'])")" \
    -d '{"jsonrpc":"2.0","method":"host.update","params":{"hostid":"1"},"id":1}' | grep -q "Blocked"; then
    ok "只读闸门生效（host.update 被拦截）"
else
    warn "只读闸门未按预期拦截 —— 请立即检查 README_ONLY 白名单"
fi

PORT=$(python3 -c "import json;print(json.load(open('config.json')).get('port',8770))")
cat <<EOF

${GRN}部署完成${RST}

  本机访问   http://127.0.0.1:${PORT}/
  审计日志   docker volume inspect zbx-console-audit --format '{{.Mountpoint}}'
  容器日志   docker compose logs -f --tail=50
  重启       docker compose restart
  停止       docker compose down
  更新       docker compose up -d --build

${YEL}注意${RST}：本工具没有内置认证，默认只绑 127.0.0.1。
      外部访问请用 SSH 隧道或前置 nginx（见 nginx.conf.example）。

EOF
