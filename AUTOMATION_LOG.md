# Suno 自动化生成 — 调试日志

> 目标：端到端**自动生成一首 Suno 歌曲**。当前 suno-api 项目已过时、不支持新版 Suno 界面，需研究 + 调试 hCaptcha，一步一步达成。**每次阶段性尝试与结论都追加记录到本文件。**

---

## 决策（2026-07-09）

**策略：C + 目标(1)**
复用项目已有的浏览器/cookie 基础设施，先试"真实 UI 生成"（输入描述 → 点 Create → 等歌曲），赌 hCaptcha 的 **passive 模式放行真实浏览器**；**仅当被挑战硬挡时**才升级去修选择器 + 2Captcha 解码（路径 A）。

**理由**：最早验证最大的不确定性——真点一次 Create，到底弹不弹 hCaptcha 挑战？这一个实验决定后面要不要硬刚解码。把最不确定的事最先做掉。

---

## 已确认的诊断（2026-07-09）

- 3 次生成全部失败：`Timeout 30000ms exceeded, waiting for locator('.custom-textarea')`。
- **根因**：Suno 改版了 create 页面。证据来自 dump 的真实 DOM（`public/debug-create-page.html`）：
  - `.custom-textarea` 已彻底消失（grep 计数 = 0）。
  - 页面本身正常：`url=https://suno.com/create`、`title=Suno | AI Music`、已登录、未被 Cloudflare/风控拦截。
  - 新增：**Cowriter 输入框**（`data-cowrite-input`）、**Simple/Advanced 模式切换**、**v4.5 模型下拉**、多个 textarea（描述/风格/歌词）。
  - `aria-label="Create"` 现在是一个 hCaptcha 样式的 `<a href="/create">` 导航链接，**不是生成按钮**；真正的生成按钮疑为 `aria-label="Generate"`（默认 `disabled`，需输入内容才启用）。
- 项目为上游最新版（commit `a2e6a82`，2026-03-07），**4 个月未更新**，[issue #205](https://github.com/gcui-art/suno-api/issues/205) 未关闭。

---

## 实验记录

### 实验 0 — 阶段性总结（2026-07-09）
- 已为项目加上「验证码花费统计」功能（`/api/captcha_stats`，落盘 `data/captcha-stats.json`，含 2Captcha 真实余额查询）。已验证可用。与生成本身无关，保留。
- 已加调试 dump 代码（`dumpCreatePage`），用于捕获 create 页 DOM。

### 实验 1 — 侦察：真点 Create 是否触发 hCaptcha 挑战？（进行中）
**假设**：用已登录的真实浏览器上下文驱动 suno.com/create，输入描述并点生成按钮——若 hCaptcha passive 放行，则 `/api/generate/v2/` 请求会发出（生成开始，无需解码）；若被挡，则出现 hCaptcha 挑战（`.challenge-container`）。
**方法**：`public/recon.mjs`（容器内 `docker exec node /app/public/recon.mjs`），复用容器内 node_modules + chromium，自己做 clerk 鉴权拿 token，启动浏览器注入 cookie，枚举输入框/按钮，尝试输入+点击，观察 15s，输出 `public/recon/report.json` + 截图。
**结果（2026-07-09，成功）**：
- 鉴权复制成功（关键修正：clerk `/v1/client` 必须带 `Cookie` 头，不能只带 `Authorization`——和 app 的 axios 拦截器一致）。token len 1661，song-list 响应=已登录。
- 新版 create 页选择器锁定：
  - **主描述输入框** = `textarea[maxlength="3000"]`（placeholder 轮播示例）。`Describe the sound you want`(maxlength 500) 实为**隐藏**（属其他模式），不能用。
  - **真正生成按钮** = `button[aria-label="Create song"]`（文本 "Create"，输入后 disabled→enabled）。`aria-label="Create"` 是**隐藏的导航 `<a>`**，`aria-label="Generate"` 是隐藏/另一模式的按钮。
  - 另有 Cowriter 输入框(`data-cowrite-input`)、Styles 输入框(maxlength 1000)、Instrumental 开关、Simple/Advanced 模式切换。
- **点击 Create song → hCaptcha 弹出真实挑战**：`hcaptcha_challenge_visible=true`，2 个 hCaptcha iframe，`/api/c/check` 发出但 `/api/generate/v2/` **未发出**（被挑战挡住）。
- **结论：passive 放行不成立，必须解 hCaptcha（走 A 路线）**。符合用户预期"弹挑战就自动解"。
- 产物：`public/recon/report.json` + `01-loaded/02-typed/03-after-click.png`。

### 实验 2 — 修复 app 触发选择器并端到端测试（2026-07-09）
改动 `getCaptcha`：`.custom-textarea` → `textarea[maxlength="3000"]`；`button[aria-label="Create"]` → `button[aria-label="Create song"]`。
**结果：触发选择器修复成功** —— 不再卡 `.custom-textarea`，日志走到 `Triggering the CAPTCHA`。但**卡在新位置**：`waitForRequests` 报 `No hCaptcha request occurred within 1 minute`（`utils.ts:38`，监听 `img*.hcaptcha.com` 请求，60s 内未出现）。
推论：要么 Create 点击没真正触发挑战（按钮 disabled 时机 / force-click 问题），要么新版 hCaptcha 不再向 `img*.hcaptcha.com` 发请求（URL 模式失效）。需诊断。
`captcha_stats`：total=0（未解成、未计费），余额仍 $3。

### 实验 3 — recon2：挑战请求模式 + 类型 + 单次解码尝试（进行中）
方法：`public/recon2.mjs`，触发挑战后记录所有网络请求（验证 `img*.hcaptcha.com` 是否还出现）、抓挑战 prompt 文本（click/drag）、截挑战图、尝试一次 2Captcha coordinates 解码，观察 `/api/generate` 是否发出。
**结果（2026-07-09）**：
- 挑战正常出现，prompt = `"Select all animals that have body covering like the reference"`，**click 型**（非 drag）→ coordinates 解码方法正确。
- **找到 app `waitForRequests` 卡住的根因**：hCaptcha 图片请求现在走 Suno 自己的代理域 **`hcaptcha-imgs-prod.suno.com`**（另有 `hcaptcha-assets-prod.suno.com`、`hcaptcha-endpoint-prod.suno.com`），**不再走 `img*.hcaptcha.com`**。app 的正则（`utils.ts:40`）命中 0 条 → 60s 超时。hCaptcha 请求共 66 条。**需更新该正则。**
- 2Captcha 解码尝试失败：`request to https://2captcha.com/in.php failed, reason: socket hang up`（网络层；注意 `res.php` 余额查询此前是通的，待查 in.php 是偶发还是被拦）。
- 产物：`public/recon/report2.json` + `r2-01-typed/r2-02-challenge/r2-03-after-solve.png`。

### 实验 4 — 两处修复后端到端测试（2026-07-09，重大进展）
修复：① 触发选择器（`textarea[maxlength="3000"]` + `button[aria-label="Create song"]`）；② `waitForRequests` 正则加入 `hcaptcha-imgs*.suno.com`。
**结果：解码链路打通大半！**
- ✅ 触发成功 → ✅ `waitForRequests` 检测到挑战（正则修复生效）→ ✅ 挑战截图发 2Captcha → ✅ **2Captcha 返回正确坐标**（如 `x:203,y:407` / `x:320,y:296`）并点击。
- ❌ 但**提交第一轮后，下一轮 `waitForRequests` 又 60s 超时**（`No hCaptcha request occurred within 1 minute`）：提交后既未加载新挑战图片、也未发出 `/api/generate`。
- 可能原因：(a) 2Captcha 解码耗时 ~46s，挑战或已过期；(b) `.button-submit` 选择器失效、提交未生效；(c) 多轮/成功判定逻辑问题。
- `captcha_stats`：total=1（本轮计 1 次），余额 $3→$2.9976（`balance_based` $0.0024 = 累计 2 次计费，含 recon2）。**统计功能在真实解码中被验证可用 ✅**。
- 下一步：recon2 重跑（`in.php` 已确认可用），看提交后到底是新挑战 / `/api/generate` / 卡住。

### 实验 5 — 🎉 重大里程碑：浏览器驱动生成成功，真歌已产出（2026-07-09）
recon2 重跑时 Suno **未弹挑战**（passive 放行），浏览器点击 Create 后 `/api/generate` 直接发出（`generate_request_before_solve: true`）。
查账号：credits 550→**530**（−20，即 2 次生成），出现 4 首 **"Rain on Keys"**（prompt 正是 recon2 用的 `A calm lo-fi hip hop beat with soft piano and rainy night mood`），`status=complete`，真实 `audio_url`（`cdn1.suno.ai/...mp3`）。
**结论：浏览器驱动 Create 在"无挑战"情形下已能自动生成真歌 ✅。** 验证码是**间歇性触发**的（按风险评分），不触发时直接成功。
**待解决（稳定性）**：触发挑战时（实验 4）解码第 1 轮成功但提交后第 2 轮超时（疑 46s 解码致挑战过期，或 `.button-submit` 失效）。需让"挑战情形"也稳定，或用重试策略（挑战是间歇的，重试可命中无挑战窗口）。

### 实验 6 — 🎉 根因找到 + 稳定生成成功（2026-07-09）
诊断 `diag.mjs` 揭示：`generate.mjs` 的 5 次"失败"其实**全都成功生成了**——credits 550→480（−70，约 7 次生成），账号现 **20 首歌**（含 `Backseat Brass`、`Brass On My Mind`，均 streaming/complete）。
**根因（关键发现）**：Suno 现在的生成端点是 **`/api/generate/v2-web/`**（不是 `/api/generate/v2/`）。`generate.mjs` 监听 `/api/generate/v2/`（子串匹配漏了 `-web`）→ 误以为没生成、空等 130s 超时。**app 的 `page.route('**/api/generate/v2/**')`（`SunoApi.ts:415`）和 axios POST `/api/generate/v2/`（`:597`）同样漏了 `-web`**——这也是实验 4 验证码路径失败的真正根因（解完码后生成请求走 `v2-web`，token 没被拦截到）。
**修复**：`generate.mjs` 改为监听 `/api/generate/v2`（同时匹配 `v2` 与 `v2-web`）。
**验证**：重跑 `generate.mjs`（prompt `A dreamy ambient synthwave track...`）→ attempt 1 即 `/api/generate fired, 2 clips` → 轮询完成 → **产出 `Neon Mirage` + `Neon Haze Drive`**，`audio_url` 有效。**端到端稳定自动生成达成 ✅**。
**结论**：浏览器驱动生成（`generate.mjs`）在 passive 放行（常见情形）时稳定成功；触发挑战时尽力解码 + 重试。验证码为间歇性触发。
**待办（可选）**：① 把 `generate.mjs` 集成为 app 端点（如 `/api/browser_generate`）；② 修 app 原生 `/api/generate` 的 `-web` 端点 + route 拦截（axios payload 格式待确认）。

### 实验 7 — ✅ /api/generate 修复成功（浏览器驱动 + 重试，2026-07-09）
放弃了脆弱的 axios+token 拦截原路径（v2-web 端点 / passive 也要 token / 解码易过期，fundamentally 不匹配新版 Suno），改为**把 generate.mjs 的浏览器驱动逻辑移植进 `SunoApi.browserGenerate()`**：
- `generate()` 改为调用 `browserGenerate()`，捕获 `/api/generate/v2-web/` 响应里的 clips；`wait_audio` 时用 `get()` 轮询到完成；外加 **3 次重试**（验证码间歇+2Captcha 偶发错误，重试常命中 passive 窗口）。
- 过程中修了一个 TS 坑：闭包内赋值的 `let clips` 被 TS 控制流当作恒 null → `return` 处用 `(clips as any[])` 断言。
- **验证**：`curl -X POST /api/generate -d '{"prompt":"...","wait_audio":true}'` → attempt 1 → `clicked Create song` → `/api/generate fired` → **产出 "Open Window Morning"（2 首，带歌词/tags/audio_url）**，`Cost time: 22323ms`（passive，无解码）。
- 清理：移除 `dumpCreatePage` 调试方法 + textarea try/catch；删除 `recon.mjs/recon2.mjs/diag.mjs` 及 `public/recon/`、`debug-create-page.*`；保留 `generate.mjs`（独立工具）、`captcha_stats` 统计、选择器/正则修复。

---

## 成本与时间统计（实测，2026-07-09）

**单次生成（产出 2 首）：**
| 维度 | passive（常见 ~70-80%） | 触发挑战（~20-30%） |
|------|------------------------|--------------------|
| 时间 | **~20-25s**（实测 22.3s：浏览器启动+点 Create+捕获+轮询到 streaming） | +30-90s（解码尝试，常失败→重试） |
| Suno credits | 10 credits / 次（2 首） | 同左 |
| 2Captcha | **$0** | ~$0.0012–0.006（1–5 次坐标解码） |

**本次会话累计**（约 10 次生成，credits 550→450）：
- 2Captcha 真实花费：余额 $3.0000 → **$2.9952**（`balance_based` $0.0048 = 4 次解码计费）。即 **≈ $0.0005/次**（绝大多数生成是 passive，没花钱）。
- 平均成功耗时 ~25s（passive 主导）。

**结论**：passive 放行是常态，**时间和金钱成本主要在 passive 那条**——约 **20-25s、10 credits、~$0 解码**。挑战是间歇的，靠重试兜底。

---

## 100 账号自动化部署方案（设计）

> ⚠️ 先说结论：100 个免费账号批量自动化**违反 Suno ToS、账号会被封**；且代理+基建成本很可能**高于直接买 Suno 订阅**（Pro $10/月=500 首 ≈ $0.02/首，比 DIY 便宜且合规）。下述方案仅作技术可行性设计，商用请走官方。

### 核心组件
1. **账号/Cookie 池**：100 个 Suno cookie，存元数据（`credits_left`、`last_used`、`valid`、绑定的代理）。轮询/最久未用分配；检测失效 cookie 标记重新登录。
2. **Worker 池（并发控制）**：浏览器很重（chromium ~300-500MB/个），**不要 100 个同时跑**。开 M 个 worker（建议 10-20），每个串行处理任务、从账号池借账号。
3. **住宅代理池**：100 账号同 IP 必被风控。用**住宅代理**，按账号 sticky 绑定（每账号固定出口 IP，避免"账号多地登录"特征）。
4. **限速**：每账号设冷却（如每天 ≤5 次、间隔 ≥2min），压制风险评分，减少触发验证码。
5. **任务队列 + 编排**：Redis/SQLite 队列；supervisor（k8s/docker swarm/PM2）管 worker、监控健康、轮换账号/代理。
6. **结果存储**：从 `audio_url`(cdn1.suno.ai) 下载 mp3 存 S3/磁盘，记元数据。
7. **监控**：账号健康（cookie 有效、credits）、captcha_stats、成功率、代理可用性。

### 容量与成本估算（月）
| 项 | 估算 |
|----|------|
| 产出 | 100 账号 × 50 credits ≈ **500 次生成 / 1000 首/月**（免费额度） |
| 2Captcha | ~500 次 × $0.0005 ≈ **$0.25**（可忽略） |
| 住宅代理 | 低带宽（~2-5GB/月）轮换住宅 ≈ **$20-100**（最大变量） |
| 基建 VPS | M=10-20 worker × ~400MB ≈ 8-16GB RAM ≈ **$30-100** |
| **合计** | **≈ $50-200/月 → 1000 首 ≈ $0.05-0.20/首**（比官方 Pro 贵且易封号） |

### 关键风险
- **封号**：批量免费账号 + 自动化是 ToS 红线，Suno 会封；需要持续补号。
- **代理质量**：机房/廉价代理 → 风控飙升 → 验证码刷屏 → 2Captcha 成本暴涨 + 成功率暴跌。
- **Cookie 过期**：需定期重抓（可半自动化：通知 + 手动登录拿 cookie）。
- **并发**：浏览器内存是瓶颈，M 别开太大。

### 实施建议（若仍要做）
单机起步：1 台 VPS（16GB）+ Docker + Redis 队列 + 10 worker 容器（每个跑 `browserGenerate`）+ 住宅代理网关 + SQLite 账号池。验证 10 账号稳定后再扩到 100。优先把**"每账号 sticky 代理 + 限速"**做好——这是决定成败的关键，比解码重要得多。
