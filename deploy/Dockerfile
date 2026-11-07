# Zabbix 只读控制台 · 生产镜像
#
# 构建前置：本目录需与 server.py、public/ 同级（deploy.sh 会自动准备）
# 构建：  docker build -t zbx-console:4.1 .
#
# 设计要点：
#   1. config.json 绝不进镜像（凭据会残留在层里），运行时挂载
#   2. 非 root 运行（UID 10001）
#   3. 审计日志通过 symlink 写到 /data 卷，兼容只读根文件系统
#   4. 不装 curl，健康检查用 python 标准库

FROM python:3.12-slim

# 不写 .pyc（只读根文件系统下必须）；不缓冲输出（docker logs 实时可见）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    ZBX_BIND=0.0.0.0 \
    ZBX_PORT=8770

WORKDIR /app

# 只拷代码。config.json / audit.jsonl 刻意不拷
COPY server.py ./
COPY public/ ./public/

# 非 root 用户；/data 供审计日志卷挂载
RUN useradd -r -u 10001 -s /usr/sbin/nologin zbx \
    && mkdir -p /data \
    && chown -R zbx:zbx /app /data \
    && ln -s /data/audit.jsonl /app/audit.jsonl

USER zbx

EXPOSE 8770

# /api/ping 返回 {"ok": true}，无需认证，适合做存活探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8770/api/ping',timeout=3).status==200 else 1)"

CMD ["python", "server.py"]
