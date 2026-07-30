#!/usr/bin/env bash
# 把說明頁與字幕介面佈到 GitHub Pages(gh-pages 分支)。可重複執行。
#
# 網站結構:
#   /            web-pages/index.html 說明頁,以及 demo 影片與封面圖
#   /app/        web/ 的完整複製,就是實際的字幕介面
#
# 為什麼要有這支腳本而不是手動複製:app 的本體只有 web/ 一份,
# 這裡每次都是重新複製,不會有「Pages 上的版本忘了跟著更新」的漂移。
#
# 用法:scripts/publish-pages.sh        (預設推上去)
#       DRY=1 scripts/publish-pages.sh  (只建到暫存目錄看內容,不推)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$(mktemp -d)"
BRANCH="gh-pages"
trap 'rm -rf "$BUILD"' EXIT

cd "$HERE"
[ -f web-pages/index.html ] || { echo "缺 web-pages/index.html"; exit 1; }

echo "組裝網站內容到 $BUILD"
cp web-pages/index.html "$BUILD/"
for f in web-pages/demo.mp4 web-pages/demo-poster.jpg; do
  [ -f "$f" ] && cp "$f" "$BUILD/"
done
mkdir -p "$BUILD/app"
cp web/index.html web/app.js web/styles.css web/sw.js web/manifest.webmanifest \
   web/icon-192.png web/icon-512.png web/selfcheck.md "$BUILD/app/"
touch "$BUILD/.nojekyll"   # 沒有這個,Jekyll 會吃掉底線開頭的檔案並亂處理 .md

echo "內容:"
find "$BUILD" -type f | sed "s|$BUILD|  |" | sort

if [ "${DRY:-0}" = "1" ]; then
  echo "DRY=1,只建不推。目錄留在 $BUILD(離開時會自動刪,要看請自己複製)"
  trap - EXIT
  echo "$BUILD"
  exit 0
fi

echo "推上 $BRANCH"
WT="$(mktemp -d)"
git worktree add --detach "$WT" >/dev/null
(
  cd "$WT"
  # 用一個臨時的 orphan 分支名,再 push 到 gh-pages。
  # 不要直接 checkout --orphan gh-pages:第二次跑會因為分支已存在而失敗,
  # 而且如果把錯誤導掉,腳本會在 set -e 下無聲中止,看起來像成功但其實什麼都沒推上去。
  TMPB="pages-build-$$"
  git checkout --orphan "$TMPB"
  git rm -rf . >/dev/null 2>&1 || true
  cp -r "$BUILD"/. .
  git add -A
  git -c user.name="${GIT_NAME:-yazelin}" -c user.email="${GIT_EMAIL:-yazelin@ching-tech.com}" \
      commit -q -m "publish: 台語即時字幕說明頁與介面"
  git push -f origin "HEAD:$BRANCH"
)
git worktree remove --force "$WT"

# 推完一定要回頭確認遠端真的變了,不要相信「指令沒報錯」
PUSHED="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
echo "遠端 $BRANCH 目前指向 ${PUSHED:0:12}"
echo "完成。網址 https://yazelin.github.io/taigi-caption/"
echo "第一次佈署要到 repo Settings → Pages 把來源設成 gh-pages 分支的根目錄。"
