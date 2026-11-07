#!/usr/bin/env bash
# 本地打包脚本 —— 生成可直接上传到 Docker 服务器的 tar.gz
#
# 在项目根目录执行：
#   bash deploy/package.sh                    # 不含凭据（推荐，服务器上再填）
#   bash deploy/package.sh --with-config      # 带上 real/config.json（省事，注意分发范围）
#
# 产物：dist/zbx-console-deploy-<日期>.tar.gz

set -euo pipefail

cd "$(dirname "$0")/.."          # → 项目根

WITH_CONFIG=0
[ "${1:-}" = "--with-config" ] && WITH_CONFIG=1

STAMP=$(date +%Y%m%d)
NAME="zbx-console-deploy-${STAMP}"
OUT="dist/${NAME}.tar.gz"

[ -f real/server.py ]                        || { echo "✗ 找不到 real/server.py（请在项目根执行）" >&2; exit 1; }
[ -f real/public/vendor/echarts.min.js ]     || { echo "✗ 缺少 real/public/vendor/echarts.min.js" >&2; exit 1; }

STAGE=$(mktemp -d)/${NAME}
mkdir -p "$STAGE/public/vendor"

# 代码
cp real/server.py "$STAGE/"
cp real/public/index.html "$STAGE/public/"
cp real/public/css/app.css "$STAGE/public/css/" 2>/dev/null || { mkdir -p "$STAGE/public/css"; cp real/public/css/app.css "$STAGE/public/css/"; }
cp real/public/js/app.js   "$STAGE/public/js/"   2>/dev/null || { mkdir -p "$STAGE/public/js";   cp real/public/js/app.js   "$STAGE/public/js/"; }
cp real/public/vendor/echarts.min.js "$STAGE/public/vendor/"

# 部署文件
cp deploy/Dockerfile deploy/.dockerignore deploy/docker-compose.yml \
   deploy/config.docker.example.json deploy/nginx.conf.example deploy/deploy.sh \
   "$STAGE/"

# 可选：带凭据
if [ "$WITH_CONFIG" = "1" ]; then
    [ -f real/config.json ] || { echo "✗ 找不到 real/config.json" >&2; exit 1; }
    python3 - <<PY
import json
cfg = json.load(open("real/config.json"))
cfg["bind"] = "0.0.0.0"          # 容器内必须监听全部接口
json.dump(cfg, open("$STAGE/config.json", "w"), ensure_ascii=False, indent=2)
PY
    chmod 600 "$STAGE/config.json"
    echo "  · 已包含 config.json（含真实凭据，仅限本机 → 目标服务器传输）"
else
    echo "  · 未包含 config.json（部署时由 deploy.sh 从模板生成，需填凭据）"
fi

chmod +x "$STAGE/deploy.sh"
mkdir -p dist
tar -czf "$OUT" -C "$(dirname "$STAGE")" "$NAME"

echo
echo "✓ 已生成 $OUT  ($(du -h "$OUT" | cut -f1))"
echo
echo "上传："
echo "  scp $OUT  user@docker-host:/opt/"
echo
echo "服务器上："
echo "  cd /opt && tar -xzf ${NAME}.tar.gz && cd ${NAME}"
echo "  bash deploy.sh"
