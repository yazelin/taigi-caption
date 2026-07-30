#!/usr/bin/env bash
# 產一張自簽憑證給手機用。手機瀏覽器只在 HTTPS(或 localhost)下才給麥克風權限,
# 所以區網測試繞不過這一步。已經有憑證就不重產,可以重複執行。
#
# 換 IP 或想多帶一個位址:先自己 rm -rf certs/,再跑 TAIGI_IP=192.168.1.50 scripts/make-cert.sh
#(這支腳本偵測到憑證存在就不重產,不會自己刪)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS="$HERE/certs"
KEY="$CERTS/key.pem"
CRT="$CERTS/cert.pem"
PORT="${TAIGI_PORT:-8443}"

# ponytail: 只抓對外那張介面的 IP。多網卡或想指定其他位址就用 TAIGI_IP 覆寫,不在腳本裡列舉。
IP="${TAIGI_IP:-$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || echo 127.0.0.1)}"

if [ -f "$KEY" ] && [ -f "$CRT" ]; then
  echo "憑證已存在,不重產:$CRT"
  echo "憑證裡帶的位址:"
  openssl x509 -in "$CRT" -noout -ext subjectAltName | tail -n +2
else
  mkdir -p "$CERTS"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=$IP" \
    -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
  chmod 600 "$KEY"
  echo "已產生自簽憑證,有效 3650 天:$CRT"
  echo "帶的位址:IP:$IP、IP:127.0.0.1、DNS:localhost"
fi

cat <<EOF

手機怎麼連:
  1. 手機與這台電腦接同一個 Wi-Fi。
  2. 先在這台電腦跑 scripts/run.sh。
  3. 手機瀏覽器打開 https://$IP:$PORT/
  4. 第一次會跳安全性警告(自簽憑證,瀏覽器不認識簽發者,這是正常的)。
     Android Chrome:進階 → 繼續前往。iOS Safari:顯示詳細資訊 → 瀏覽此網站。
  5. 允許麥克風權限。

certs/ 裡是私鑰,不要進版本控制。
EOF
