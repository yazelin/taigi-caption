#!/usr/bin/env bash
# 一鍵啟動。有憑證就走 HTTPS(手機才能用麥克風),沒有就走 HTTP 並提醒。
#
# 常用旋鈕:TAIGI_PORT、TAIGI_LANG(zh/en/auto)、TAIGI_DEVICE(auto/cuda/cpu)、
#           TAIGI_MIN_LOGPROB(幻聽門檻,講話卻沒出字就調更負)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$HERE/.venv/bin/python"
KEY="$HERE/certs/key.pem"
CRT="$HERE/certs/cert.pem"
IP="${TAIGI_IP:-$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || echo 127.0.0.1)}"

cd "$HERE"

if [ -f "$KEY" ] && [ -f "$CRT" ]; then
  PORT="${TAIGI_PORT:-8443}"
  echo "HTTPS 啟動中,手機開 https://$IP:$PORT/(第一次會有安全警告,按繼續)"
  exec "$PY" -m uvicorn server:app --host 0.0.0.0 --port "$PORT" \
    --ssl-keyfile "$KEY" --ssl-certfile "$CRT"
else
  PORT="${TAIGI_PORT:-8000}"
  echo "沒有憑證,用 HTTP 啟動:http://127.0.0.1:$PORT/"
  echo "注意:手機瀏覽器在 HTTP 下不會給麥克風權限,要手機測請先跑 scripts/make-cert.sh。"
  exec "$PY" -m uvicorn server:app --host 0.0.0.0 --port "$PORT"
fi
