#!/usr/bin/env bash
# 发布快照脚本 —— 把当前稳定版冻结成「可复现、可交付」的版本包
#
# 在项目根目录执行：
#   bash deploy/release.sh --tag v4.2-full --note "P0 后的首个稳定基线"
#   bash deploy/release.sh --tag v4.2-full --with-config     # 带真实凭据（仅限本机→目标机）
#   bash deploy/release.sh --tag v5.0-baseline --edition baseline   # B0-2 完成前会明确拒绝
#
# 产物：dist/releases/zbx-console-<tag>/  +  同名 .tar.gz
#   code/   可运行源码 + 脱敏配置模板
#   deploy/ Docker 部署文件与部署说明
#   docs/   README + 00-08（自动脱敏真实口令）
#   README-交付.md   版本说明、启动方式、验证基线、已知限制
#   manifest.json    每个文件的 SHA-256 与大小
#
# 与 package.sh 的区别：package.sh 只出「部署用」的精简包；
# release.sh 出的是「版本归档 / 对外交付」包，带文档、哈希清单和版本元数据。

set -euo pipefail
cd "$(dirname "$0")/.."          # → 项目根

TAG=""
EDITION="full"
NOTE=""
WITH_CONFIG=0
NO_TAR=0

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --tag)       TAG="${2:-}"; shift 2 ;;
        --edition)   EDITION="${2:-}"; shift 2 ;;
        --note)      NOTE="${2:-}"; shift 2 ;;
        --with-config) WITH_CONFIG=1; shift ;;
        --no-tar)    NO_TAR=1; shift ;;
        -h|--help)   usage ;;
        *) echo "✗ 未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
    esac
done

[ -n "$TAG" ] || TAG="v$(date +%Y%m%d-%H%M)"
case "$EDITION" in
    full) ;;
    baseline|standard)
        echo "✗ edition=$EDITION 暂不可用。" >&2
        echo "  三档交付需要先完成 B0-2（edition 功能开关），见 docs/08-产品路线与发展方向.md 第七节。" >&2
        echo "  在此之前请勿用「改名 / 隐藏入口」伪装基础版：功能仍可通过深链访问。" >&2
        echo "  当前可交付的是完整稳定版：去掉 --edition 参数，或显式 --edition full。" >&2
        exit 3 ;;
    *) echo "✗ edition 只能是 full（baseline/standard 待 B0-2）" >&2; exit 2 ;;
esac

# ---- 1. 必需文件检查 ----------------------------------------------------
REQ=(
    real/server.py
    real/public/index.html
    real/public/css/app.css
    real/public/js/app.js
    real/public/vendor/echarts.min.js
    real/config.4x.example.json
    deploy/Dockerfile
    deploy/.dockerignore
    deploy/docker-compose.yml
    deploy/config.docker.example.json
    deploy/nginx.conf.example
    deploy/deploy.sh
    deploy/package.sh
    deploy/README-部署.md
    docs/README.md
)
for f in "${REQ[@]}"; do
    [ -f "$f" ] || { echo "✗ 缺少必需文件：$f" >&2; exit 1; }
done
[ -f real/config.json ] || { echo "✗ 缺少 real/config.json" >&2; exit 1; }

STAGE="dist/releases/zbx-console-${TAG}"
[ -e "$STAGE" ] && { echo "✗ $STAGE 已存在，请换一个 --tag（脚本不覆盖历史快照）" >&2; exit 1; }
mkdir -p "$STAGE/code/public/css" "$STAGE/code/public/js" "$STAGE/code/public/vendor" \
         "$STAGE/deploy" "$STAGE/docs"

# ---- 2. 语法自检（失败就不出包） ----------------------------------------
if command -v node >/dev/null 2>&1; then
    node --check real/public/js/app.js || { echo "✗ app.js 语法检查失败" >&2; exit 1; }
    for t in real/tests/*.mjs; do node --check "$t" || exit 1; done
else
    echo "  · 未找到 node，跳过 JS 语法检查"
fi
python3 -c "import ast;ast.parse(open('real/server.py',encoding='utf-8').read())" \
    || { echo "✗ server.py 语法检查失败" >&2; exit 1; }

# ---- 3. 组装 ------------------------------------------------------------
cp real/server.py "$STAGE/code/"
cp real/public/index.html "$STAGE/code/public/"
cp real/public/css/app.css "$STAGE/code/public/css/"
cp real/public/js/app.js "$STAGE/code/public/js/"
cp real/public/vendor/echarts.min.js "$STAGE/code/public/vendor/"
cp real/config.4x.example.json "$STAGE/code/"

cp deploy/Dockerfile deploy/.dockerignore deploy/docker-compose.yml \
   deploy/config.docker.example.json deploy/nginx.conf.example \
   deploy/deploy.sh deploy/package.sh deploy/README-部署.md "$STAGE/deploy/"
chmod +x "$STAGE/deploy/deploy.sh" "$STAGE/deploy/package.sh"
cp docs/*.md "$STAGE/docs/"

if [ "$WITH_CONFIG" = "1" ]; then
    # 真实 config.json 由下面的 Python 段写入 STAGE（顺带统一 bind=0.0.0.0）
    echo "  · 已包含真实 config.json（含凭据，注意分发范围）"
else
    cp deploy/config.docker.example.json "$STAGE/code/config.example.json"
    echo "  · 未包含真实凭据：code/config.example.json 为脱敏模板"
fi

# ---- 4. 脱敏 + 生成交付说明 + manifest ---------------------------------
export REL_STAGE="$STAGE" REL_TAG="$TAG" REL_EDITION="$EDITION" \
       REL_NOTE="$NOTE" REL_WITH_CONFIG="$WITH_CONFIG"

python3 - <<'PY'
import hashlib, json, os, re, datetime, pathlib

stage = pathlib.Path(os.environ["REL_STAGE"])
tag, edition, note = os.environ["REL_TAG"], os.environ["REL_EDITION"], os.environ["REL_NOTE"]
with_config = os.environ["REL_WITH_CONFIG"] == "1"

# --with-config 的 config.json 由 python 直接写（避免 shell 里猜路径）
if with_config:
    cfg = json.load(open("real/config.json", encoding="utf-8"))
    cfg["bind"] = "0.0.0.0"
    with open(stage / "code" / "config.json", "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(stage / "code" / "config.json", 0o600)

# 4.1 脱敏：字面口令 + 文档示例里的 password/token 值
TEXT_EXT = {".md", ".json", ".html", ".js", ".css", ".py", ".sh", ".yml", ".example"}
# 真实口令字面串只放在「本地词表」里（已 .gitignore，仓库中绝不出现）。
# 没有词表时只做下面的字段级脱敏。词表每行一个字面串，# 开头为注释。
words_file = pathlib.Path("deploy/redact-words.local.txt")
extra_words = ([w.strip() for w in words_file.read_text(encoding="utf-8").splitlines()
                if w.strip() and not w.strip().startswith("#")]
               if words_file.exists() else [])
redacted_hits = []
for p in sorted(stage.rglob("*")):
    if not p.is_file() or (p.suffix not in TEXT_EXT and not p.name.endswith(".example.json")):
        continue
    # 用户显式 --with-config 带进来的真实凭据文件不做任何替换
    if with_config and str(p.relative_to(stage)) == "code/config.json":
        continue
    try:
        s = p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    orig = s
    for w in extra_words:
        if w in s:
            redacted_hits.append(str(p.relative_to(stage)))
            s = s.replace(w, "<PASSWORD>")
    # 只处理文档与说明，不动配置文件本身（模板已是占位符 / 或用户显式带凭据）
    if p.suffix == ".md":
        s = re.sub(r'("(?:password|token)"\s*:\s*")[^"]*(")',
                   r'\1<FILL_ME>\2', s)
    if s != orig:
        p.write_text(s, encoding="utf-8")

# 4.2 交付说明
readme = f"""# 交付说明 · {tag}

| 项 | 值 |
|---|---|
| 版本 tag | `{tag}` |
| 档位 edition | `{edition}` |
| 生成时间 | {datetime.datetime.now().astimezone().isoformat(timespec='seconds')} |
| 说明 | {note or '（未提供）'} |
| 真实凭据 | {'已包含（code/config.json，600 权限）' if with_config else '**未包含**，见 code/config.example.json'} |

## 包里有什么

```
code/     server.py + public/（含 ECharts vendor）+ 配置模板   ← 可运行源码
deploy/   Dockerfile / compose / deploy.sh / package.sh / 配置模板 / 部署说明
docs/     README + 00–09 开发文档
manifest.json   每个文件的 SHA-256 与字节数
```

## 5 分钟跑起来

```bash
cd code
cp config.example.json config.json      # 填入各实例 token / 只读账号
python3 server.py                       # → http://127.0.0.1:8770/
```

Docker 部署见 `deploy/README-部署.md`；一键部署包用 `bash deploy/package.sh` 生成。

## 验证基线（打包时的状态）

- 冒烟：`zbx7 20/20`、`zbx4 20/20`（`real/tests/ui-smoke.mjs`，远程需设 `BASIC_AUTH`）
- 响应式：7 档宽度 × 4 页 × 4 断言 = 112 项
- 只读闸门：`host.update` 被服务端拒绝并计入审计
- 语法自检：打包脚本已跑过 `node --check` 与 Python AST；**运行时回归仍需在目标环境复验**

## 已知限制

- 当前档位为 **full（功能全集）**。`baseline / standard` 档需先完成 B0-2 功能开关改造，
  见 `docs/08-产品路线与发展方向.md` 第四、七节；本包不含任何"隐藏入口假装精简版"的做法。
- `zbx8`（8.0 生产）测试环境临时下线，配置保留为 `enabled=false`，恢复后改回 `true` 重启即可。
- 拓扑连线为推断结果（置信度已标注），不等同于物理拓扑。
- 只读红线：不提供任何写操作；不替代 Zabbix 官方 UI。

## 完整性校验

```bash
python3 -c "import json,hashlib,pathlib;m=json.load(open('manifest.json'));\\
print(all(hashlib.sha256(pathlib.Path(f['path']).read_bytes()).hexdigest()==f['sha256'] for f in m['files']))"
```
"""
(stage / "README-交付.md").write_text(readme, encoding="utf-8")

# 4.3 manifest（README 自身也要计入，最后再算）
files = []
for p in sorted(stage.rglob("*")):
    if not p.is_file():
        continue
    b = p.read_bytes()
    files.append({"path": str(p.relative_to(stage)),
                  "size": len(b),
                  "sha256": hashlib.sha256(b).hexdigest()})
manifest = {
    "tag": tag,
    "edition": edition,
    "note": note,
    "created_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "source": "real/ + deploy/ + docs/（当前工作区快照）",
    "with_config": with_config,
    "redactions": {"literal": [f"本地词表命中 {len(extra_words)} 个词 -> <PASSWORD>（词表不入库）"],
                   "doc_fields": ["password", "token"],
                   "files_touched": sorted(set(redacted_hits))},
    "file_count": len(files),
    "total_bytes": sum(f["size"] for f in files),
    "files": files,
}
(stage / "manifest.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"  · manifest: {len(files)} 个文件 / {manifest['total_bytes']:,} 字节")
PY

# ---- 5. 归档 ------------------------------------------------------------
if [ "$NO_TAR" = "0" ]; then
    tar -czf "dist/releases/zbx-console-${TAG}.tar.gz" \
        -C dist/releases "zbx-console-${TAG}"
fi

echo
echo "✓ 已冻结版本 ${TAG}（edition=${EDITION}）"
echo "  目录：$STAGE/"
[ "$NO_TAR" = "0" ] && echo "  归档：dist/releases/zbx-console-${TAG}.tar.gz  ($(du -h "dist/releases/zbx-console-${TAG}.tar.gz" | cut -f1))"
echo "  校验：python3 -c \"import json;m=json.load(open('$STAGE/manifest.json'));print(m['file_count'],'files')\""
echo
echo "  提醒：handoff/ 与 dist/*.tar.gz 是 v4.1 旧快照，对外交付请一律从本目录出包。"
