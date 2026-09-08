# 深审：客户端/前端面 wire/frontend/scaffold-dom/client/persona-lint

- 任务 key: `t4_client` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t4_client`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `surface`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- evidenceIds: ['evidence_5b01e5b7-f5e4-4c84-afac-31e02ccda0ff', 'evidence_ca2d6564-7bba-443c-9cbf-ac83ccc730c8', 'evidence_cec65479-2316-44a1-ae81-ae20a13ee31f']

---

# 深审报告：客户端/前端面（A4 / t4_client）
审查方式：纯只读。5 个焦点文件全文通读（wire.ts 411 行 / frontend.ts 278 行 / scaffold-dom.ts 381 行 / client/index.ts 118 行 / persona-lint.ts 106 行），并核对消费方与产物面（frontends/ 9+ 模板、_vendor SDK、tests-frontend.mjs、tests-orchestrated.mjs 相关段、tsconfig）。证据 = 本 attempt host 记录运行（read/bash/grep/sed 全只读，run_bfa5ee2e / run_51691cf9 / run_9217e156 / run_7c4a0b07 等）。未修改任何文件。

## 1. 模块职责与架构定位
- **wire.ts**：DSH host 公开 wire 的双代（legacy/new）共享 Node 客户端，被 verify.ts 探针、bench 驱动器、index-add auto 与 cron-trigger 复用；鉴权三通道（缓存 cookie→env→启动日志 token 兑换，87-106），两代判定不读版本只探应答（109-122）；remote.mux 逻辑流开流（204-243）；openWireSession 统一门面（284-411）。浏览器侧 SDK 是同协议同构的另一份实现（不 import 本文件）。
- **frontend.ts**：前端发射（emitFrontend 模板填参→preset/frontend/，字节确定性）+ host 路由（/assembler/ui/<id> 静态伺服 + _console 直播 SSE/数据 + .service 服务脸端点）。与 lib/ 产物关系：编译进 lib/index.js 供 index.ts 路由注册消费；模板资产在 frontends/（本文件外）。
- **scaffold-dom.ts**：verify_app 第六门（DOM 层考）的器官：考卷校验纯件、考场小服务器、浏览器手（MCP 驱动 browser-automate 零件）、runDomExam 本体；不 import scaffold.ts（DI 注入共享件避免环）。
- **client/index.ts**：浏览器半区（betterSidebar 两个 tab + 自动弹出环），esbuild 打包（tsconfig exclude src/client:18，不进 tsc）。
- **persona-lint.ts**：persona 文本 lint（约束式散文/工具引用核对/长度/持久化与安全边界完备性），advisory 不拦发射。

## 2. 发现列表（critical 0 / major 1 / minor 9 / nit 6）
### major
**CF-1 [major·安全] emitFrontend 槽位零上下文转义：存储型 XSS + 脚本破坏面**
- 位置：src/frontend.ts:51-53（fillTemplate 原样替换）、100-114（title/requirement/workdir 入 slots）；模板证据 frontends/chat-console/index.html:8/27/47（HTML 元素区 {{title}}/{{requirement}}）、:50 与 bilingual-reader:157 等 9+ 模板 `const CFG = { presetId: '{{presetId}}', workdir: '{{workdir}}' }`（JS 单引号字符串区）。
- 现象：全模板与 frontend.ts 无任何 escape（grep 零命中）；title/requirement 源自用户/agent 需求文本（100-104），是外部输入而非注释自称的"值都来自装配器自身"（:50 注释与事实相悖）；workdir 为宿主绝对路径（Windows 路径 `\u` 序列致 SyntaxError/撇号破串可注入）。
- 影响：需求文本含 `<img onerror=…>` 即成为交付页的存储型 XSS，页面在 host 同源执行：可经 frontend.ts:208-216 的 /assembler/ui/<id>/.service 读取本机全部 preset 的服务脸 token、开 wire 会话、读写他 preset 数据面；Windows/撇号路径会静默产出坏页（交付物自毁）。
- 修复：按上下文转义——element 区 HTML-escape，CFG 整值经 JSON.stringify 后再放入单引号外（或用 textContent/DOM API 注入）；补转义测试（tests-frontend.mjs:51 只验槽位存在）。

### minor
**CW-1 [minor·正确性] legacy answer() 非 JSON/非 200 回执误报 accepted** — src/wire.ts:306-310：res.json() 失败（非 JSON/5xx）即 return {accepted:true}，与 :306 注释"host 对无效应答静默拒收且 HTTP 200,必须核回执"自相矛盾；被 host 拒收的回答会被探针当作已接受。修复：先核 res.status===200 再 parse，失败即 accepted:false。
**CW-2 [minor·健壮性] openWireSession 失败路径孤儿会话** — src/wire.ts:332-335（legacy events.mux open 拒绝）、370-409（new-wire session/follow、session/control、$events 任一 openStream 抛错）：session/create 已成功但未 cancel/detach 即抛错，每次失败留一个无人认领的运行中会话。修复：catch/错误出口统一 cancel。
**CW-3 [minor·健壮性] probeCohort 异常一律回落 'new'** — src/wire.ts:109-122：网络断/host 未起也判 new，后续错误文案指向"换 cookie"，误导排障。建议区分"不可达"与"401"。
**CF-2 [minor·安全/隔离] .service 端点把全部 preset 服务脸 token 暴露给整个同源** — src/frontend.ts:208-216：任何同源页面/脚本（含其他 preset 页面、CF-1 XSS 注入体）可读任一台 preset 的 workspace/.service.json（sqlite url+token）；preset 间数据面隔离依赖"页面只属于自己"的隐含假设。建议：文档化信任域或在发射时把本页 token 直接嵌入（配合页面级隔离），至少加 audit。
**CF-3 [minor·一致性] 考场缺资产回落 index.html 200，与生产 404 语义不一致** — scaffold-dom.ts:153-156 vs frontend.ts:266：缺失资产（如 assets/x.js 被删）在考场拿到 200 text/html，行为与生产不一致，静态资产错误在 DOM 考里更难归因。建议 fallback 只作用于无扩展名路由。
**CS-1 [minor·安全/健壮性] DOM 考 upload 文件名无 basename 校验 + 临时目录不清理** — src/scaffold-dom.ts:335-338：PAGE-SPEC 的 upload.name 含 ../ 可把内容写出 mkdtemp 目录（宿主任意位置写小文件）；每 upload 一个临时目录永久泄漏。修复：basename+白名单校验，finally rmSync。
**CS-2 [minor·正确性] dom 动作 a.page 幽灵 id 未过纸面闸** — src/scaffold-dom.ts:321：a.page 不在 pageIds 时考的是 App 回退/首页，可能假绿，与 pageIdFileMismatches（:108-115）防的错配同类；validateDomPaper 应顺带校验 a.page∈pageIds。
**CS-3 [minor·健壮性] runDomExam 资源在 try/finally 前创建，异常路径泄漏浏览器进程** — src/scaffold-dom.ts:292-298：startExamServer/acquireSqliteFace 抛错时 hand（chromium 子进程）不 close、异常也不转 FAIL/SKIPPED 证据。修复：资源创建纳入 finally 管辖或包成带证据的 FAIL。
**CC-1 [minor·功能断链] client 自动弹出 agent 操作台的 done 标记无生产者** — src/client/index.ts:98 判 tail 含 '装配完成'；全仓 grep（ts/mjs/md，排除本文件）零生产者——本仓 emit 写'发射完成'（orchestrated-tools.ts:884）、verify 写'验收完成'（:1226）。对 dsh-assembler 自身装配流该自动弹出永不触发，魔法串契约无测试无文档。修复：统一常量/正则（发射完成|验收完成|装配完成）并加契约测试。
**CP-1 [minor·正确性边界] persona-lint 的工具引用核对只认 mcp__server__tool 形** — src/persona-lint.ts:78：package/harness 工具被 persona 点名不查（如直接引用文件名工具）；unknown-tool 覆盖面与注释承诺不完全一致（低危、advisory）。建议补 package 工具集合核对。

### nit
**NW-1** wire.ts:30 COOKIE_LIFETIME_MS=28 天与注释"名义 30 天提前 1 天"（应为 29）不符；**NW-2** wire.ts:47-50 wire-auth.json 明文 cookie 无权限硬化（0600）；**NW-3** wire.ts:56-73 findLaunchUrl 整读全部日志文件（多 MB 级日志内存开销，可流式）；**NF-1** frontend.ts:228-243 SSE 每 15s 全量重读 20 个 progress.log 各 120 行，多连接时 IO 放大；**NC-1** client/index.ts 在 tsconfig exclude（tsconfig:18），typecheck 与 npm test 均不覆盖其类型（tests-frontend 只断产物字符串 89-93）；**NS-1** scaffold-dom.ts:319/371 '预算耗尽'路径只记结果不记 FAIL（GATE_SOFT_BUDGET 耗尽静默降级为覆盖缺口，语义可再明确）。

## 3. 测试盲区（对照 tests-frontend.mjs 97 行 / tests-orchestrated.mjs 674 行）
已覆盖：fillTemplate 逐槽/缺槽（tests-frontend 42-43）、发射落盘与 no-op（49-55）、路由安全包含闸全矩阵（62-79，含 %2e%2e/点文件/超深/_vendor）、直播台数据函数（81-86）、client.js 产物字符串（89-93）；scaffold-dom 纯件 validateDomPaper/页 id 错配/考场服务器穿越/assertEffect 轮询（tests-orchestrated 269-322 区）；persona-lint 持久化/安全边界 3 例（361-369）。
盲区：
1. **转义面零用例**（CF-1 主因）：tests-frontend 无任何"槽值含 <>&'\" 或 `</script>` 的发射后字节断言"——模板改动或转义器引入都无回归网。
2. **client/index.ts 行为零覆盖**：自动弹出环/done 标记（CC-1）、iframe、去重逻辑无任何测试（连 fake ctx 都没有）；lib/client.js 只验字符串包含。
3. **wire.ts 无直接单测**（协议两代/鉴权缓存/开流超时/answer 回执全无）；npm test 链中 wire 只经 e2e/bench 间接验证。
4. **persona-lint 的 procedure-steps/unknown-tool/too-short/too-long 四类无断言**（只测了 missing-* 两维）。
5. scaffold-dom 的 runDomExam 全流程（真浏览器）不在 npm test；upload 名穿越（CS-1）、幽灵 page（CS-2）无用例。
6. .service 路由（CF-2）与 .service.json 读取面在 tests 中只经考场服务器路径（tests-orchestrated 304-307 是考场侧）,生产 frontendRouteHandler 的 .service 分支无测试。

## 4. 文档声明一致性
- wire.ts 头注释（双代协议/纪律）与实现一致；例外：legacy answer 回执注释（"必须核回执"）与代码不符（CW-1）；cookie 名义寿命注释与常量不符（NW-1）。
- frontend.ts:50"值都来自装配器自身"注释与 100-104 行（requirement 外部文本入槽）矛盾——XSS 根因的文档化错位（CF-1）。
- client/index.ts:80 注释宣称"含'装配完成'+新鲜+真 preset id"即弹操作台，但生产者不存在（CC-1）；scaffold-dom 头注释"逐字镜像 src/frontend.ts 生产语义"与缺资产回落差异（CF-3）不符。

## 5. 优点（供汇总）
路由/资产安全包含闸极扎实（ID_RE/ASSET_RE 双正则+resolve 双重包含+点文件拒绝+decode 后复验，frontend.ts:129-163）；scaffold-dom 区分口令闸（validateDomPaper:90-102）阻断"行为考直打 SQL 冒充页面点击"的假 PASS 设计严谨；wire 双代协商"不读版本号只看应答"、错误即界面（换 cookie 指引/开流逐字报网关错）贯彻了本仓的取证纪律；persona-lint 保守判据与 advisory 定位（探针才是硬门）自洽。DOM 层考把"挂载即死/点击没接线/写了不刷新"三类死法机械化是本仓最有原创性的部分。

证据：本 attempt host 记录只读运行 run_bfa5ee2e / run_51691cf9 / run_9217e156 / run_7c4a0b07 及同 attempt 全部 read 调用（wire.ts/frontend.ts/scaffold-dom.ts/client/index.ts/persona-lint.ts 全文、frontends 模板抽查、tsconfig、全仓 '装配完成' grep）。已发布阶段性发现 evidence_5b01e5b7 / evidence_ca2d6564 / evidence_cec65479。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_5b01e5b7-f5e4-4c84-afac-31e02ccda0ff`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_9217e156-28f4-4a27-bb0f-7c3add060ebf", "run_7c4a0b07-187e-4e21-b0a9-cb3848e39fc2"]

[major·安全(存储型注入)] emitFrontend 槽位零上下文转义:frontend.ts:51-53 fillTemplate 原样替换 + :100-114 把 title/requirement/workdir 直接填进模板——模板在 HTML 元素区(<title> chat-console/index.html:8、div:27/47)与 JS 单引号字符串(CFG 行 50/157 等 9+ 模板)使用槽面;grep 证实模板与 frontend.ts 无任何 escape 逻辑。requirement/title 源自用户/agent 需求文本(外部输入),`<img onerror>` 载荷可注入交付页(存储型 XSS,host 同源),引号/反斜杠可破坏 CFG 脚本(如 Windows 路径含 \u 序列致 SyntaxError、撇号破串);frontend.ts:50 注释"值都来自装配器自身"与事实相悖(100-104 行值源自 requirement)。影响:页面打开即执行同源 JS——可经 frontend.ts:208-216 /assembler/ui/<id>/.service 读取全部 preset 服务脸 token、开 host wire 会话,构成跨 preset 数据面。修复:按上下文转义(element→HTML escape,CFG 整值→JSON.stringify),补 escaping 测试(现 tests-frontend.mjs 只验槽位存在:51 行)。

### evidence `evidence_ca2d6564-7bba-443c-9cbf-ac83ccc730c8`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_bfa5ee2e-624f-488c-8230-903df2574930", "run_51691cf9-3be3-488b-a7c5-e8090529ea63"]

[minor×3 wire.ts] (a) legacy answer() 对非 JSON/非 200 回执一律 accepted:true(wire.ts:306-310),与其注释"host 对无效应答静默拒收且 HTTP 200,必须核回执"(:306)矛盾——被拒回答误报为接受;应先核 res.status 再 parse;(b) openWireSession 开流失败路径孤儿会话:legacy events.mux open 拒绝(:332-335)、new-wire session/follow/session/control/$events 任一 openStream 抛错(:370-409)时 session/create 已成功但未 cancel/detach 即抛——每次失败积累无人认领的运行中会话(探针环境每失败一次留一个);修复:catch 中 session.cancel;(c) probeCohort 任意异常(含网络断)一律回落 'new'(:109-122),host 未起/网络错时错误文案指向换 cookie 误导排障。[nit] COOKIE_LIFETIME_MS(:30)=28 天,与注释"名义 30 天提前 1 天"不符(应为 29 天);auth 缓存 wire-auth.json 明文 cookie 无权限硬化(:47-50)。

### evidence `evidence_cec65479-2316-44a1-ae81-ae20a13ee31f`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_bfa5ee2e-624f-488c-8230-903df2574930", "run_51691cf9-3be3-488b-a7c5-e8090529ea63"]

[minor×4 scaffold-dom.ts + client/index.ts] (a) DOM 考 upload name 无 basename 校验且临时目录永不清理(scaffold-dom.ts:335-338):PAGE-SPEC 的 upload.name 含 ../ 可把内容写出 mkdtemp 目录(宿主任意位置,内容受 spec 控制);(b) dom 动作 a.page 不校验 ∈ pageIds(:321):幽灵页 id 落到 App 回退首页考错对象,与 pageIdFileMismatches(:108-115)防的假绿同类但纸面闸漏这半;(c) runDomExam 的 browser hand/exam server/sqlite face 创建在 try/finally 之前(:292-298):acquireSqliteFace/startExamServer 抛错时 hand(浏览器进程)不 close 即泄漏、异常也不转 FAIL/SKIPPED 证据;(d) client/index.ts:98 done 判据魔法串 '装配完成'——全仓 grep(ts/mjs/md) 无任何生产者写该文本(emit 写'发射完成'orchestrated-tools.ts:884、verify 写'验收完成':1226),agent 操作台自动弹出对 dsh-assembler 自身装配流永不触发,断链无测试;tsconfig.json:18 exclude src/client 使该文件不参与 typecheck。
