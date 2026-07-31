# Next

**專案狀態:已交付,不再繼續開發(2026-07-31)。**

程式完成、驗證完成、說明頁上線、願望池已交答案並補了指路。
yazelin 決定到此告一段落,下面的項目留著當紀錄,不是待辦。
之後若有人要接手,從 README 與 VERIFICATION.md 開始讀就夠了。

## 交付了什麼

- repo:https://github.com/yazelin/taigi-caption (MIT,林亞澤)
- 說明頁與 demo 影片:https://yazelin.github.io/taigi-caption/
  重新佈署跑 `scripts/publish-pages.sh`(每次從 web/ 重新複製,不會漂移)
- 願望池願望 #37:交了實作(本 repo)與一則指路答案(雅婷逐字稿),
  狀態維持「實現中」,完成條件寫在該願望的進度裡:有人把後端架成公開網址就算成真。

## 收尾時完成的

- repo 的 Social preview 已上傳(2026-07-31),已驗證 og:image 指向自訂圖,
  願望池的 og proxy 也正確帶出,所以池子上會顯示成果預覽。
- FB 貼文已發。全文備份在 yaze-journal/projects/fb-posts-backup.md 最前面。
- **真人真機實測順暢**(2026-07-31,yazelin 本人)。切句時機自然,不用等硬上限。
  詳見 VERIFICATION.md 五之五。

## 已知還沒做的(留著,不是待辦)

- 真人自然口語的 CER 沒有樣本(手上 14 段都是專業配音的廣播)。使用起來順暢是體驗回報,
  不是準確度量測,兩者不要混為一談。
- 沒有真 iOS Safari 測過,只有 Chrome 的手機視埠模擬;真機實測當時用的裝置與瀏覽器沒有記錄。

## 本機環境已經清掉

模型 `WizardForest/faster-whisper-Breeze-ASR-26-int8`(1.56GB)已從 Hugging Face 快取刪除,
`testdata/` 的音檔還在但不進版控。要重新跑起來:`scripts/run.sh` 會自動重新下載模型,
第一次啟動要等下載完。venv 還在 `.venv/`。
