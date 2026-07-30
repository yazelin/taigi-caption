# 台語即時字幕（taigi-caption）

對手機講台語，螢幕即時顯示繁體中文字，讓旁邊不懂台語的人當場讀。單向：台語語音進，繁體中文字出。

辨識與台語到華語的轉寫由同一顆模型一步完成。`MediaTek-Research/Breeze-ASR-26`（BreezeASR-Taigi）本身就把台語語音寫成華語用字的繁體中文，所以這裡沒有第二段翻譯流程。實跑用社群的 CTranslate2 int8 量化版 `WizardForest/faster-whisper-Breeze-ASR-26-int8`（1.56GB），跑在 faster-whisper 上。

它「不是」這些：

- 不做中文轉台語。方向只有一邊。
- 不做語音輸出。不會把結果唸出來，只出文字。
- 不做多人分離。不標記誰在講話，也不分軌。
- 不存逐字稿。後端不寫檔、沒有資料庫，字幕只活在瀏覽器畫面上，重新整理就沒了。瀏覽器本機只記後端位址、字級與示範模式開關。
- 不做帳號。沒有登入，也沒有使用者資料。
- 不是離線工具。辨識需要網路與後端，離線時只有介面外殼會開，不會有字幕。

## 準確度：請先讀這一段

### 官方公布的數字

Breeze-ASR-26 在官方 Taigi ASR Benchmark（30 筆測試樣本）的平均 CER 是 30.13%，單筆最好 14.49%、最差 52.78%。同一張表裡的其他系統：

| 系統 | 平均 CER |
| --- | --- |
| BreezeASR-Taigi（本專案用的模型） | 30.13% |
| 教育部台灣台語輸入法 | 30.70% |
| 雅婷逐字稿 | 32.11% |
| Gemini 3 Flash | 32.52% |

來源：模型卡 https://huggingface.co/MediaTek-Research/Breeze-ASR-26 與論文 arXiv 2603.19259。

### 本專案自己量的數字

素材是 14 段行政院公共服務台語廣播的真人音檔，加 3 段合成音檔，共 17 段。套用本專案 production 用的同一組防幻聽過濾器之後：

| 語言 token | 平均 CER | 中位數 | 平均耗時 |
| --- | --- | --- | --- |
| `en`（預設） | 29.7% | 31.4% | 2495ms |
| `zh` | 30.4% | 30.1% | 2638ms |

與官方公布的 30.13% 是同一個量級。逐段落差很大：最好 0%、最差 67.5%。量法與完整紀錄見 [VERIFICATION.md](VERIFICATION.md)，可以用 `bench.py` 自己重跑。

### CER 30% 不等於「三成的字一定錯」

台語與華語不是一對一對應，同一句台語可以有好幾種合理的華語說法。以華語稿當基準算 CER 時，「意思對但用詞不同」也會被算成錯。模型卡自己就寫了這件事：因為台語與華語的對應不是一對一，一個完美的台語 ASR 也不會在華語逐字稿上拿到 0% CER，所以絕對值要小心解讀，適合用來做系統之間的相對比較，不適合當成轉寫正確率。

### 錯起來長什麼樣

實測抄下來的兩個例子（VERIFICATION.md 三之二）：

- 「駕駛朋友」被聽成「教師朋友」。這種錯會誤導語意。
- 「潛伏結核」被聽成「前腹結核」。同一段裡持續錯成同一個音近詞，但整段意思還讀得懂。

### 所以請這樣期待它

它足以讓不懂台語的人當場抓到意思，但會有明顯錯字。人名、機關名、專有名詞要特別留意，不適合當正式紀錄。

## 硬體需求

實測環境：Ubuntu 24.04、NVIDIA GeForce RTX 4060 Laptop（8GB）、driver 580.173.02、CUDA 12.6。

| 項目 | 實測 |
| --- | --- |
| 模型佔用 VRAM | 約 2.0GB（基線 1184MiB，載入後 3203MiB） |
| 模型載入 | 1.5 秒 |
| 第一次推論（冷） | 728ms |
| 之後推論（2 秒音檔） | 374 到 381ms |
| 30 秒真人音檔 | 1.5 到 3.3 秒，即時倍率 0.05 到 0.11 |

純 CPU 要分兩種用法看，同一台機器會得到相反的結論。原因是 Whisper 不論音檔多短都會補滿成一個 30 秒的窗去跑編碼器，所以**每次請求有一個固定成本，與音檔長度幾乎無關**：

| 音檔長度 | CPU 耗時（int8、4 執行緒） |
| --- | --- |
| 1.9 秒 | 4.8 秒 |
| 5.0 秒 | 4.6 秒 |
| 10.0 秒 | 6.1 秒 |
| 29.9 秒 | 9.4 秒 |

**即時字幕這個用途實質上需要一張 NVIDIA GPU。** 一句話講完要等四到八秒才出字，而下一句已經在講了，只會越積越多。

**但整段轉寫用純 CPU 很划算。** 30 秒音檔在四執行緒上 9.4 秒跑完，比即時快三倍多，兩核心也只要 13 秒。「錄一段丟進去、等十幾秒拿逐字稿」這種用法，不需要 GPU。

## 快速開始

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
scripts/run.sh
```

第一次啟動會自動從 Hugging Face 下載模型，約 1.56GB，之後會走本機快取。`requirements.txt` 裡釘的版本就是上面那台機器實測過的組合。

前後端是同一個 process。`server.py` 同時服務 `web/` 的靜態檔與 `/transcribe`，所以手機只要連一個位址，也沒有 CORS 問題。`scripts/run.sh` 找得到 `certs/` 就走 HTTPS（預設 8443），找不到就走 HTTP（預設 8000）並提醒你手機在 HTTP 下拿不到麥克風。

兩個端點：

- `GET /health` 回 `{ok, model, device, compute, lang}`，前端右上角的狀態燈就是打這個。
- `POST /transcribe` 收 `Content-Type: audio/wav` 的原始位元組，或 multipart 的 `file` 欄位。只吃 16000Hz、單聲道、16-bit PCM 的 WAV，上限 25MB，短於 0.2 秒直接回空字串。選填查詢參數 `prev` 是上一句已確定的字幕，會當成模型的上下文。回傳 `{text, seconds, ms, dropped}`，`dropped` 是被防幻聽過濾器丟掉的段數。

## 手機怎麼連（這一步最容易卡住）

瀏覽器只在 HTTPS 或 localhost 下才給麥克風權限，所以手機不能直接連 `http://` 的區網位址，連得上也按不動「開始」。做法是產一張自簽憑證再跑 HTTPS：

```bash
scripts/make-cert.sh     # 產 certs/key.pem 與 certs/cert.pem，會印出手機要開的網址
scripts/run.sh           # 有憑證就自動走 HTTPS，預設 8443
```

1. 手機與這台電腦接同一個 Wi-Fi。
2. 手機瀏覽器開 `https://<這台電腦的 IP>:8443/`。
3. 第一次連線會跳安全性警告。這是自簽憑證，瀏覽器不認識簽發者，屬於正常現象，要自己按繼續：Android Chrome 是「進階」再「繼續前往」，iOS Safari 是「顯示詳細資訊」再「瀏覽此網站」。
4. 允許麥克風權限，按「開始」。

`scripts/make-cert.sh` 已經有憑證時不會重產，可以重複執行。要換 IP 或換連線位址，先自己把 `certs/` 刪掉，再用 `TAIGI_IP=192.168.1.50 scripts/make-cert.sh` 重產。憑證裡會帶 `IP:<你的 IP>`、`IP:127.0.0.1` 與 `DNS:localhost`，有效 3650 天。`certs/` 裡是私鑰，已經寫進 `.gitignore`，不要進版本控制。

## 環境變數

`server.py` 讀的（全部可選，括號裡是預設值）：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `TAIGI_MODEL` | `WizardForest/faster-whisper-Breeze-ASR-26-int8` | 模型名稱或本機路徑，換其他 CTranslate2 版本就改這個。 |
| `TAIGI_LANG` | `en` | 解碼用的語言 token，可填 `en`、`zh`、`auto`。預設 `en` 不是筆誤，理由見下面。 |
| `TAIGI_DEVICE` | `auto` | `auto` 會問 ctranslate2 有沒有 CUDA 裝置，有就 `cuda`、沒有就 `cpu`。也可以直接指定 `cuda` 或 `cpu`。 |
| `TAIGI_COMPUTE` | `cuda` 時 `int8_float16`，`cpu` 時 `int8` | faster-whisper 的 compute type。 |
| `TAIGI_MIN_LOGPROB` | `-1.0` | 防幻聽門檻。`avg_logprob` 低於這個值的段落丟掉。真的在講話卻沒出字，就把它調更負（例如 `-1.5`）。 |
| `TAIGI_MAX_CR` | `2.4` | `compression_ratio` 高於這個值的段落丟掉，擋重複迴圈型的幻聽。預設值沿用 Whisper 上游慣例，比實測到的迴圈案例 2.24 寬，所以那種段落通常是被 logprob 那條線先攔下來的；要讓壓縮比自己攔住它，得收到 2.2 附近。 |
| `TAIGI_PROMPT_CHARS` | `200` | 當成上下文餵回模型的字數上限，只取尾端這麼多字。設 `0` 就關掉上下文。 |
| `TAIGI_BEAM` | `1` | beam size。即時優先，調大會變慢。 |
| `TAIGI_CPU_THREADS` | `min(8, CPU 核心數)` | 跑在 CPU 上時的執行緒數。 |

`scripts/` 裡的兩支腳本另外看兩個變數，`server.py` 不讀它們：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `TAIGI_PORT` | 有憑證 `8443`，沒憑證 `8000` | `run.sh` 的監聽埠，也是 `make-cert.sh` 印出來的網址用的埠。 |
| `TAIGI_IP` | 自動抓對外那張網卡的 IP | 憑證要帶的位址，以及啟動訊息裡印的位址。多網卡時用它指定。 |

### 為什麼語言 token 預設 `en`

這顆模型的 `config.json` 把 `forced_decoder_ids` 寫成 `<|en|>`（50259），`generation_config.json` 的語言槽卻是 `null`，官方模型卡沒有給用法範例。所以我們沒有猜，三種都跑過。

語言 token 只是解碼時的條件，輸出仍然是繁體中文，不會變成英文。17 段音檔上 `en` 平均 CER 29.7%、`zh` 30.4%，逐段成對比較是 `en` 勝 10 段、`zh` 勝 4 段、平手 3 段。

但這是「有證據的預設」，不是定論：平均只差 0.7 個百分點，中位數反而略偏 `zh`，17 段的樣本數不足以下結論。換成 `TAIGI_LANG=zh` 完全合理，建議用自己的音檔跑 `bench.py` 決定。`auto` 不建議：會多花約 45% 時間做語言偵測，而且偵測結果是錯的（回報緬甸語，信心值 0.13 到 0.17），輸出卻仍是正常中文。

## 兩個設計重點

### 防幻聽：看 `avg_logprob`，不看 `no_speech_prob`

模型會對雜訊與句尾編出句子。餵三秒隨機雜訊，它回「爸，辛苦你了」；音檔尾巴剩下的零點幾秒被 Whisper 填充成一個新的 30 秒窗，它就對著填充值再編一句。

而 `no_speech_prob` 在這顆模型上恆為 0.00，真語音與純雜訊都一樣，完全不能當判斷依據。`avg_logprob` 可以：實測真內容落在 -0.02 到 -0.89，幻聽落在 -1.02 到 -1.97，中間有空隙。所以後端逐段過濾，丟掉 `avg_logprob` 低於門檻或 `compression_ratio` 高於門檻的段落，留下來的接起來就是字幕。逐段丟而不是整次回應一起丟，是因為一段幻聽尾巴不該讓整句真內容消失。

17 段音檔（14 段真人加 3 段合成）全跑一次共產生 27 段，丟掉 9 段，人工看過每一段：九段全部都是肉眼可見的幻聽，沒有一段真內容被誤殺。誠實說邊界很窄，最接近門檻的幻聽是 -1.02，離預設門檻 -1.0 只差 0.02，所以門檻做成環境變數。細節見 VERIFICATION.md 第四節。

### 切段：一定切在靜音處

前端用能量法 VAD 加自適應噪音底線判斷句子講完了才送出，不按固定秒數切。這是量出來的結論，不是偏好：同一段真人音檔用固定 6 秒硬切，其中一段被讀成整句捏造的「採訪撰稿人 金汝外交官」，而它的 `avg_logprob` 是 -0.93，高於 -1.0 的門檻，過濾器擋不住。logprob 門檻能擋掉「對著靜音或雜訊編故事」，擋不掉「把切斷的半句話硬讀成別的詞」。

避免有人一直講不停，還是需要一個硬上限（目前 12 秒）。觸發時不會正好切在時間到的那一刻，而是往回看最近 500ms、挑音量最低的一格下刀，尾巴留給下一段接著用。另外前端會把「上一句已通過過濾器的字幕」傳回後端當上下文（`initial_prompt`）：上面那句捏造的「採訪撰稿人 金汝外交官」在給了上一句之後，就變成正確的「台灣台語輸入法App 透過語音辨識...」，logprob 從 -0.93 變成 -0.24。只傳通過過濾器的字幕，否則會把幻聽當上下文傳染給下一句。細節見 VERIFICATION.md 四之二與四之三。

## 自己驗

### `bench.py`：比較設定、算 CER

```bash
.venv/bin/python bench.py                    # 跑 testdata/ 下所有 manifest*.json，比 zh / en / auto
.venv/bin/python bench.py --langs zh en       # 只比這兩種
.venv/bin/python bench.py --langs en --no-filter   # 不套防幻聽過濾器，看過濾器幫了多少
.venv/bin/python bench.py --device cpu        # 量 CPU
```

還可以用 `--model` 換模型、`--compute` 換 compute type。它會逐段印出 CER、耗時、被丟掉的段數與辨識結果，最後印平均。CER 用的是 Levenshtein 字元錯誤率，只有那筆音檔同時有 `ref_text` 且 `ref_orthography` 是 `mandarin_chars` 時才算。過濾器直接 import `server.py` 的 `keep_segments`，不是另寫一份，所以量到的就是使用者真正看到的字幕。

### `test_server.py`：不需要模型的邏輯檢查

```bash
.venv/bin/python test_server.py       # 或 pytest test_server.py -q（本專案 venv 沒裝 pytest）
```

驗 WAV 解碼的合法與不合法輸入、過濾器的門檻行為、以及 HTTP 契約（`/health` 欄位、`/transcribe` 的位元組與 multipart 兩種送法、太短、壞檔、超過大小上限）。模型用假的塞進去，不會載真權重。

### `scripts/e2e-check.mjs`：真瀏覽器走完整條路

```bash
scripts/run.sh                                        # 另一個終端先把後端跑起來
NODE_PATH=$(npm root -g) node scripts/e2e-check.mjs [url] [wav]
```

用瀏覽器的假麥克風播放一段真人台語音檔，走完 Web Audio 收音、VAD 切段、包 WAV、POST `/transcribe`、真模型辨識、畫面出字幕，然後斷言畫面上真的出現中文字幕，並存一張 `e2e-shot.png`。預設 url 是 `http://127.0.0.1:8000`。音檔必須是 16-bit PCM WAV，Chrome 的假麥克風只吃這種。

兩個環境限制寫在這裡免得重踩：

- 要用真 Chrome 的有頭模式，所以需要可用的 X display。headless chromium 連 `getUserMedia({audio:true})` 都會回 `NotSupportedError`，安全環境、`mediaDevices`、裝置列舉全正常，就是沒有音訊擷取。
- 假麥克風有機率完全沒餵進音訊（多個 Chrome 交替啟動搶音訊裝置時特別容易）。腳本會先確認音訊真的進來，沒進來就重開瀏覽器重試，最多三次，並在訊息裡區分「測試環境的問題」與「app 真的壞了」。

可用 `E2E_CHANNEL` 換 Chrome channel、`E2E_DEBUG=1` 印逐秒診斷。`E2E_HEADLESS=1` 存在但依上面第一點通常會失敗。

### `testdata/` 與 manifest 格式

`bench.py` 會讀 `testdata/manifest*.json`，每個檔案是一個陣列，每筆是一段音檔。要放自己的音檔，就寫一份 manifest。

`bench.py` 真正會用到的三個欄位：

| 欄位 | 說明 |
| --- | --- |
| `file` | WAV 路徑。相對路徑以 repo 根目錄為基準，也可以給絕對路徑。檔案不存在會印出「略過」。 |
| `ref_text` | 華語對照文字。算 CER 用，空白會被忽略，所以不用煩惱斷詞。 |
| `ref_orthography` | 對照文字的用字系統。只有 `mandarin_chars` 會算 CER，填別的值就只印辨識結果。 |

其餘欄位 `bench.py` 不看，是給人追出處與判斷結果可信度用的：`ref_text_verbatim`（含標點與角色的原始腳本）、`taigi_text`（台語漢字）、`kip`（台羅）、`source_url`、`source_file`、`source_item`、`license`、`is_synthetic`、`seconds`、`notes`。合成音檔請務必標 `is_synthetic`，理由見「已知限制」。

`testdata/` 不隨 repo 散布，已經寫進 `.gitignore`。行政院的廣播文稿依政府資料開放授權條款第 1 版可以重製（須註明出處），但同一份宣告把「影音」列為須另行取得同意的項目，所以台語音檔本身只留在本機。

## 模型選項

| 版本 | 大小 | 說明 |
| --- | --- | --- |
| `WizardForest/faster-whisper-Breeze-ASR-26-int8` | 1.56GB | 本專案預設。CTranslate2 int8 量化。 |
| CTranslate2 float16，例如 `phate334/Breeze-ASR-26-float16-CT2` | 3.09GB | 同樣可以直接餵給 `TAIGI_MODEL`。 |
| `MediaTek-Research/Breeze-ASR-26` 原始權重 | 6.2GB | F32，兩個 safetensors 檔（4.99GB 加 1.18GB）。要用 transformers 跑，不是 faster-whisper 的格式。 |
| GGML | 1.08 到 3.09GB | 給 whisper.cpp 的社群轉檔版，有 fp16 與 q8_0、q5_0 量化。 |
| MLX | 3.08GB 起 | 給 Apple silicon 的社群轉檔版，另有 4bit、8bit。 |

CTranslate2 量化版與 GGML、MLX 版都是社群轉檔。原始權重來自 MediaTek Research 與陽明交通大學 Speech AI Research Center，授權 Apache-2.0，兩種轉檔版都沿用同一個授權。

本專案沒有逐段比對過 int8 與原始 F32 的辨識差異，因為本機磁碟放不下兩份。能說的是：用 int8 量到的 CER 與官方公布值是同一個量級。

## 已知限制

- 講很長又完全不停頓時，字幕可能出現讀錯的句子。硬上限觸發時就算挑最安靜的位置下刀，還是有機會切在字中間，而那種錯誤的 `avg_logprob` 不夠低，過濾器抓不到。附帶資料：專業配音又壓了配樂的廣播音檔，30 秒內只有兩處超過 0.4 秒的停頓，硬上限在這種音源上會常常觸發；一般對話的停頓密得多，情況會好很多。
- 語言 token 的最佳值樣本數不足以定論。17 段、平均只差 0.7 個百分點、中位數方向還相反。
- 合成語音的分數偏樂觀。這顆模型的訓練語料本身就是合成語音，三句合成音檔在 `zh` 下量到的 5.6% CER 是最寬鬆的條件，不能拿來宣稱真人準確度。真人請以 30% 這個量級為預期。
- 防幻聽門檻的邊界很窄。實測最接近門檻的幻聽是 -1.02，預設門檻 -1.0，只差 0.02。在吵雜環境講話有可能被誤殺，發現真的在講話卻沒出字就調 `TAIGI_MIN_LOGPROB`。
- 需要網路與後端，不做離線辨識。介面外殼有 service worker 快取，離線時頁面會開，但不會有字幕。
- 想放上線給陌生人試玩的話,選項與各家限制整理在 [docs/HOSTING.md](docs/HOSTING.md)。
  重點結論:這顆模型是別人微調的,所有「託管模型 API」都跑不了它(Cloudflare Workers AI 只有內建模型、
  HF 也沒有任何 inference provider 在服務它),所以一定要自己出算力。
- 用自簽憑證連線時 service worker 根本不會註冊。Chrome 不讓有憑證錯誤的來源註冊 service worker（主控台會出現 An SSL certificate error occurred when fetching the script），所以走 `scripts/make-cert.sh` 那條路時沒有離線外殼、也不能「加到主畫面」，只有字幕功能本身可用。要完整的 PWA 行為需要一張被信任的憑證，例如自己的網域，或 Tailscale 之類會發真憑證的通道。實測見 [VERIFICATION.md](VERIFICATION.md) 五之三。
- 單機單模型，同時進模型的請求刻意壓在 2 個，其餘排隊。給多人同時用要另外上多 worker 或外部佇列。
- 只吃 16000Hz、單聲道、16-bit PCM 的 WAV。後端不帶轉檔器，也不依賴 ffmpeg，格式轉換由前端負責。

## 參考資料與素材出處

模型與評測基準:

- 模型卡 https://huggingface.co/MediaTek-Research/Breeze-ASR-26 (Apache-2.0,MediaTek Research 與陽明交通大學 Speech AI Research Center)
- 論文 Breeze Taigi: Benchmarks and Models for Taiwanese Hokkien Speech Recognition and Synthesis,arXiv 2603.19259
- 本專案實際載入的 CTranslate2 int8 量化版 https://huggingface.co/WizardForest/faster-whisper-Breeze-ASR-26-int8 (社群轉檔)
- 推論框架 faster-whisper https://github.com/SYSTRAN/faster-whisper

驗證素材(都不隨 repo 散布,授權見各自 manifest 的 `license` 欄位):

- 行政院公共服務廣播台語音檔與華語腳本,共 14 段。來源是行政院全球資訊網音檔下載區的三個月包:
  https://www.ey.gov.tw/Page/463789EEBA7377FC/9c1f7ecb-a125-4aee-aaa0-ed46f4b296a8 (115 年 3 月)、
  https://www.ey.gov.tw/Page/463789EEBA7377FC/c892b96e-7f4b-4702-9b51-d2bc5e0db6c8 (115 年 8 月)、
  https://www.ey.gov.tw/Page/463789EEBA7377FC/8dc67b2b-32a8-46e9-ab03-6bab7cff46bc (114 年國慶交管)。
  文稿依政府網站資料開放宣告適用政府資料開放授權條款第 1 版,可重製但須註明出處;
  同一份宣告把「影音」列為須另行取得同意,所以音檔本身只留在本機,不進版控也不放進公開影片。
- 教育部臺灣台語常用詞辭典例句錄音,取自 https://huggingface.co/datasets/sarahwei/Taiwanese-Minnan-Example-Sentences ,授權 CC BY-NC-SA 4.0。
- 台語連續劇語料,取自 https://huggingface.co/datasets/thomas0104/nan_tw_soap_opera ,授權未宣告,只用於本機聽感參考,不列入任何數字。
- 三段合成短句由意傳科技媠聲 demo 端點產生 https://hapsing.ithuan.tw/ ,句子內容由本專案指定,僅供本機測試。

平台限制的官方依據(README 裡幾個「為什麼要這樣做」的出處):

- 麥克風需要安全環境 https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- 前端不使用 MediaRecorder 分段的原因,見 MediaStream Recording API https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API

## 出處與致謝

這是 yazelin 的 AI 願望池願望 #37「台語即時語音翻譯手機工具」的實作：https://yazelin.github.io/wish-pool/

許願者的原話：「在使用台語溝通時，只要有一位聽者不懂台語，對話就會受阻」。

模型要致謝 MediaTek Research 與陽明交通大學（NYCU）的 Speech AI Research Center。沒有 Breeze-ASR-26，這個專案不會存在。CTranslate2 轉檔要謝社群的 WizardForest。

同一條線上的相關專案：

- https://github.com/yazelin/mandarin-taigi 國台語詞語對照
- https://github.com/yazelin/taigi-news-reader 新聞台語朗讀

## 授權

程式碼採 MIT，著作權人林亞澤，全文見 [LICENSE](LICENSE)。

模型權重不在本 repo 內，授權為 Apache-2.0，著作權屬原作者 MediaTek Research 與陽明交通大學 Speech AI Research Center。`testdata/` 的音檔與文稿也不在 repo 內，各自的出處與授權記在 manifest 的 `license` 欄位。

**`web-pages/demo.mp4` 是例外,它不適用 MIT。** 那支影片的聲軌是教育部臺灣台語常用詞辭典的例句錄音,授權為 CC BY-NC-SA 4.0(取自 https://huggingface.co/datasets/sarahwei/Taiwanese-Minnan-Example-Sentences ),依 ShareAlike 條款,含有該聲軌的影片同樣以 CC BY-NC-SA 4.0 釋出,並須註明出處。要把影片用在商業用途,得換成自己錄的聲音重錄一支。

## 作者

- 原始碼 GitHub:https://github.com/yazelin/taigi-caption
- Facebook:https://www.facebook.com/yaze.lin.gm
- 請我喝杯咖啡:https://buymeacoffee.com/yazelin
- 部落格:https://yazelin.github.io/
