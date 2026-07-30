# 要放上線給人試玩的話,可以放哪裡

這份是 2026 年 7 月 31 日查證過的部署選項筆記,附官方來源。
會寫這份是因為它反直覺:這個專案用的是「別人微調的模型」,而那件事本身就刷掉了一半的選項。

判斷依據是 VERIFICATION.md 量到的兩個數字:GPU 上每次請求約 0.4 秒、即時倍率 0.05 到 0.11;
純 CPU 短句連續辨識慢於即時 2.6 到 4.4 倍。**即時字幕需要 GPU,這是硬條件。**

## 先講死路

**任何「託管模型 API」都跑不了這顆模型。**

- Cloudflare Workers AI 的語音模型只有 Deepgram Flux、Deepgram Nova-3、OpenAI Whisper(large-v3-turbo、tiny-en),
  文件裡沒有任何上傳自訂模型的機制。https://developers.cloudflare.com/workers-ai/models/
  用原版 Whisper 聽台語是另一回事:官方 benchmark 上沒針對台語微調的 Whisper large-v2 是 49.99% CER,
  而 Breeze-ASR-26 是 30.13%。拿它當 demo 等於展示一個壞掉的東西。
- Hugging Face 的 serverless 推論也不存在:`MediaTek-Research/Breeze-ASR-26` 的
  `inferenceProviderMapping` 是空物件,沒有任何 provider 在服務它。
- Cloudflare Containers 沒有 GPU,規格最大到 4 vCPU / 12GiB,而且沒有免費層,
  要 Workers Paid 每月 5 美元(含 375 vCPU-分鐘)。https://developers.cloudflare.com/containers/pricing/

## Hugging Face Spaces:2026 年 7 月之後基本上不通

官方文件現在寫:「Static Spaces are free for everyone. Gradio and Docker Spaces run on compute and
require a paid plan to create: PRO for personal accounts, Team or Enterprise for organizations.」
也就是**免費個人帳號只能建 Static Space**。https://huggingface.co/docs/hub/spaces-overview

唯一還免費的運算路徑是 ZeroGPU,但代價很高:

- ZeroGPU **只支援 Gradio SDK**(官方原文 exclusively compatible with the Gradio SDK),
  這支 FastAPI 必須重寫。https://huggingface.co/docs/hub/spaces-zerogpu
- ZeroGPU 是為 PyTorch 設計的,`@spaces.GPU` 的函式跑在另一個 process、參數靠 pickle 傳遞。
  本專案用的 CTranslate2 不是 PyTorch,很可能不能用,得退回 transformers 跑原始權重,
  等於放棄 int8 量化版。
- 免費個人帳號最多 2 個 ZeroGPU Space,而且**額度算在訪客頭上**:
  未登入訪客每天 2 分鐘 GPU、免費帳號 5 分鐘、PRO 40 分鐘。
- 免費硬體閒置 48 小時就睡,喚醒實測約 126 秒,第一個訪客就吃這個。
- Spaces 的持久儲存已經下架,磁碟是暫時的,1.56GB 模型要靠 README 的 `preload_from_hub` 烘進 build 階段。

純 CPU 的 Space 也別想:拿同一顆模型跑在 cpu-basic 的公開 Space 實測,
1.94 秒音檔要等 23.7 秒、30 秒音檔要等 43.9 秒(含上傳與 Gradio 佇列)。
連「錄一段等一下」都很勉強。

好消息只有兩個:CORS 沒問題(hf.space 會原樣回吐 Origin,GitHub Pages 前端打得到);
而且已經有人證明 Breeze-ASR-26 走 transformers 加 `@spaces.GPU` 在 ZeroGPU 上跑得起來
(`georgelin29/taigi-mood-backend`),真要走這條路可以抄它的骨架。

## 真的可行的三條

### 一、自己的機器加免費通道(零成本、零改寫)

`cloudflared` 把本機服務變成公開 HTTPS 網址,程式碼完全不動。
額外好處:**通道給的是受信任的憑證**,所以自簽憑證下 service worker 註冊不了那個限制會消失,PWA 正常。
Tailscale Funnel 與 ngrok 也都給真憑證。

要注意:

- named tunnel(網址不漂、能套 WAF 與 rate limiting)需要你有一個掛在 Cloudflare 的網域;
  免網域的 trycloudflare 每次重啟就換網址,而且有 200 併發硬上限、不支援 SSE。
- Cloudflare 的 proxy 讀取逾時是 125 秒,超過回 524。GPU 後端(1.5 到 3.3 秒)無感,
  但如果流量落到純 CPU 機器,一段 30 秒音檔要 84 到 120 秒,會貼著天花板。
- 免費層的濫用防護很陽春:rate limiting 只給 1 條規則、只能用 IP 當維度、
  計數與封鎖週期固定 10 秒;另有 5 條 WAF custom rules。
- ngrok 免費層每月 20,000 次請求,對「給陌生人試玩」很快會撞牆。
- Tailscale Funnel 只能監聽 443 / 8443 / 10000,而且官方沒公布頻寬上限數字。

適合:「今晚開放試玩三小時」這種有人看著的場合。

### 二、Beam(每月重置的免費額度,FastAPI 幾乎不用改)

官方定價頁寫 `$30 free credit refreshed monthly`,Developer 方案 0 元月費,
含 5 個 GPU 容器併發。RTX 4090 每秒 0.000191667 美元,約每小時 0.69 美元,
換算約 43.5 GPU-小時/月。https://www.beam.cloud/pricing

它的 `@asgi` 可以直接吃 FastAPI,`authorized=False` 能開公開端點,
所以這支 `server.py` 幾乎原封不動就能上。

**未確認的兩件事(官方頁面沒寫,不要當作已知)**:要不要綁信用卡、額度用完會不會自動扣款。
另外計費語意有疑點:endpoint 文件說容器預設閒置 180 秒才關,同一頁又說只算 active 時間,
兩者差 40 倍,正式用之前一定要自己跑一次對帳。

### 三、Modal(文件最扎實,但信用卡必填且閒置照算)

同樣是每月 30 美元免費額度,T4 每秒 0.000164 美元。
`@modal.asgi_app()` 一樣能把 FastAPI 整包搬上去。https://modal.com/pricing

兩個明確的坑:官方 billing 文件白紙黑字寫必須有付款方式;
scaledown_window(預設 60 秒閒置)期間 GPU 是被你佔住的,那段照樣計費。
以「一場 demo 兩分鐘加 60 秒閒置」估,一場約 0.04 美元,30 美元大約 750 場。

## 其他評估過但不建議的

- **Baseten**:30 美元是一次性,不是每月重置,撐不了長期展示。冷啟動文件最誠實(SDXL 加 cache 後 9 到 10 秒),可當技術參考。
- **RunPod Serverless**:沒有免費額度,但它是唯一有硬牆的(餘額歸零自動停掉所有 Pod)。
  想「儲 10 美元、最多賠 10 美元」的話,這個確定性比免費額度更值錢。
- **Replicate**:官方自己寫冷啟動有時要「several minutes」,而且是非同步輪詢介面,不適合即時字幕。
- **Together AI**:只跑他們目錄裡的模型,塞不進 CTranslate2;自訂容器要找業務,而且只有 H100。
- **Koyeb**:免費層沒有 GPU,要信用卡且會壓 29 美元預授權;公司已被 Mistral 收購,方向在變。
- **Fly.io GPU**:2026 年 7 月 31 日正式停役。

## 所有方案共通的一件事

**沒有任何一家會免費幫你熱著 GPU**,第一個訪客一定吃到 5 到 20 秒冷啟動。
務實解法是前端在頁面載入時就先送一發空的暖機請求(趁使用者還在讀說明),
而不是等他講完第一句才開機。這個改動很小,不管選哪條路都該做。
