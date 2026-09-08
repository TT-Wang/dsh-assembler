# 交叉汇总报告：全库 TOP 风险与修复路线

- 任务 key: `t7_report` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t7_report`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `rev`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- dependencies: ['t1_arch', 't2_verify', 't3_tools', 't4_client', 't5_scripts', 't6_tests']
- evidenceIds: ['evidence_e28960f8-42a4-4f52-b331-d3c0f4710cf4']

---

# 交叉汇总报告：dsh-assembler 全库 TOP 风险与修复路线（t7_report）

任务：task_…_t7_report / attempt_af54a633。方法：以 6 份已 accepted 分模块报告为源（t1_arch、t2_verify、t3_tools、t4_client、t5_scripts、t6_tests，各自 reviewOf 复核结论见 evidence_3dd938fd/5ef4a6f8/96be987c/3467edec/289984bb/852fa03f），交叉核对重复/冲突/互证；关键论断由本 attempt host 记录只读运行复核（run_ce53104f/run_4f01a03c/run_d189c547/run_b04bc113 等：index-add.mjs:264-292、orchestrated-tools.ts:1178-1186/1250-1260/2266-2292、README.md:19-23/170-174、index/catalog.yml 计数、index.ts 台账段、verify.ts marksPresent 等）。全程只读，未修改任何文件。修正记录：t3_tools 的 OT-3 经挑战与运行时实证（evidence_d100da7e → evidence_ec1a893f supersedes → 复核 accept evidence_96be987c）由 major 降为 minor，本汇总一律采用修正后口径。

## 一、跨模块一致性问题清单（重复/互证/冲突）

**C1 shipped 数据（capabilities.yml/index/catalog.yml）零结构闸——三份报告互证的最强跨模块主题。**
t1_arch M1 证实真实违例：capabilities.yml:769-776 两条静态 `via: mcp` 条目（sms-gateway/mobi-parser）无 config.server，发射端 index.ts:422-424 静默剔除、BOM 1259-1265 误记 `plane:'host'`（供应链记录与事实相反）；t6_tests M2 独立证实同一缺口无任何测试闸（13 个 tests-*.mjs 只做存在性抽查，"一一对应"声明 index/catalog.yml:11-12 无机械保证）；t1_arch m6 补根因：loadCatalog（index.ts:196-221）对条目零形状校验，脏数据可让 rankCapabilities 崩溃（capability-index.ts:19-31）。同族还有 t5_scripts M2：registerCore 把机器绝对路径写进被 git 跟踪并随 npm 发布的 capabilities.yml（index-add.mjs:465-471；实文件 capabilities.yml:37 等；消费端 index.ts:1158-1162 原样透传）——换机即全体 stdio 服务器失效。结论：capabilities.yml 是"既被跟踪、又被发布、还零校验"的高危数据面，三份报告从正确性（M1）、测试盲区（M2）、可移植性（M2）三面独立命中，应合并为一条修复主线。本 attempt 复核 catalog 计数 103 行/27 service/5 first-party/311 工具行与 t6 M1 实测一致；tests-*.mjs 全文无 sms-gateway/mobi-parser 引用（t1 复核确认）。

**C2 文档/生成物同步空档——"声明即纪律"文化的自我悖论。**
t6_tests M1：README.md:21/:172 与 README.zh.md:21/:174 计数陈旧（"90 parts/244 tools/66 library/19 service" vs 实测 103/311/71/27/5，本 attempt 复核属实），违反 catalog-report.mjs:3-7 自述"过期的清单比没有清单更坏"与 DESIGN.md:63 负面清单 5；t5_scripts m7 同源指出 catalog-report --check（scripts/catalog-report.mjs:58-62）从不比对 README 内嵌片段。其余声明-实现漂移点（各报告独立发现，交叉印证"注释承诺处恰是漂移处"）：t4_client CF-1 中 frontend.ts:50 注释"值都来自装配器自身"与 100-106 外部 requirement 入槽相悖；t3_tools OT-7 中 verify.ts:758-759 注释"沿用轮只跑门 1"与 orchestrated-tools.ts:1024-1032 carry 早退（门 1 也不跑）不符；t1_arch m2 中 scaffold.yml:43-44 声称"自由区外全锁"而 lockPaths（45-56）漏 package.json/app.config.json；t1_arch m4 static-reach 证据文本夸大（取 20 断言全部，scaffold.ts:535/545）；t4_client CC-1 client/index.ts:98 等待的'装配完成'无任何代码生产者（src 只写'发射完成'/'验收完成'）。

**C3 验收"沿用(carry)"语义三角与台账信任边界。**
t1_arch m1：台账 last-verify.json 与被验 preset 同目录、无签名/HMAC（index.ts:853/887-918），能写 preset 目录者可预置 PASS 台账使 verify_preset 不经真实探针即"沿用 PASS"（调用侧 orchestrated-tools.ts:1009-1030，carry 即 settle PASS 无复核）；t3_tools OT-7：carry 路径整段跳过前端门；t2_verify：carried 标志如实携带（verify.ts:93-101），但台账与"四级黑盒、考官独立、造件者不给自己发合格证"（DESIGN.md:49/:300）的信任模型无实现保障。三报告一致指向：沿用机制需要明示信任边界（host 侧签名/独立位置），或至少在文档中声明"台账防误用不防伪造"。

**C4 空串标记恒命中——同类缺陷两处独立出现。**
t2_verify v3：marksPresent 对 mustInclude 含 '' 恒真（verify.ts:194-203，本 attempt 复核 :199 `hay.includes(m)` 对 '' 恒真）；t3_tools OT-4：add_knowledge 检索门 mustInclude:[''] 恒命中（orchestrated-tools.ts:2030-2034）。同一"includes('')"空串陷阱在验证器与入库门各犯一次 → 应抽出共享的标记校验件（复用 sanitizeMarks 纪律，verify.ts:283-289）。

**C5 子进程与资源生命周期纪律——失败路径五处独立缺口。**
t1_arch M2（scaffold.ts:432-438/247/634 spawn 无 'error' 监听、stdout pipe 无人消费 → 考官崩溃/假超时）；t3_tools OT-1（submit_part 门禁 npm install 无 --ignore-scripts、实探 connect/listTools 无超时、env 全量 process.env 2286）；t2_verify v1（缺省 cwd 探针工作区 /tmp 永久残留，verify.ts:621-625）；t4_client CW-2（openWireSession 失败路径孤儿会话，wire.ts:332-335/370-409）+ CS-3（runDomExam 资源先于 try/finally，scaffold-dom.ts:292-298）；t5_scripts M5（auto() 内 die=process.exit 跳过 finally 的 session.close，index-add.mjs:75-78/749-794）。共同根因：宿主长驻进程 + LLM 驱动的高频失败路径，缺乏"统一 spawn/会话/临时目录的兜底清理件"。

**C6 "前端同一张考卷"语义族。**
t3_tools OT-2（前端门 FAIL 不入总判定：head 只随 verification.status，orchestrated-tools.ts:1254-1257；门有 index.html 存在性门槛 1182）+ OT-7（carry 跳门）+ t4_client CF-3（考场缺资产回落 index.html 200 与生产 404 不一致，scaffold-dom.ts:153-156 vs frontend.ts:266）。交付面健康信息在判定、台账、考场三层都有失真点。

**C7 测试链的结构性盲区（unit 链 vs 真会话/战役制）。**
六份报告独立收敛：npm test 13 闸全部离线纯件级（t6 m6 自述诚实边界）；verify.ts 的 runProbe/runScenario/runFrontendGate/runSharedDataProbe/runTriggerProbe 零直接覆盖（t2）；orchestrated-tools 13 工具 execute 真跑面零覆盖——OT-1/OT-2 恰在此面上（t3）；wire.ts 零直测（t4）；scripts 9 个中 6 个无自动化覆盖、index:check/check-all/scaffold-gate 不在 npm test（t5）；shipped 数据与文档闭环闸缺失（t1/t6）。结论：纯件面被钉得极密，但"纯件与真会话之间的契约面"（帧形状、判定组合、门禁行为）是共同空档，bench 战役制补不了 unit 链的回归速度。

**C8 已解决冲突（审计过程记录，非仓库缺陷）。**
OT-3 原 major 论断（userinfo URL 击穿 127.0.0.1 白名单 → SSRF/伪造 PASS）被独立复核挑战并以运行时实证推翻：Node ≥18/undici 在 Request 构造期即拒绝含 credentials 的 URL（TypeError，零连接，fail-closed）。修正后残余为 minor：白名单是 startsWith 前缀而非 new URL() 解析（orchestrated-tools.ts:1373-1374），校验语义与真实连接目标脱节、错误文案误导、对将来 http.request/axios 类实现埋雷。教训：机制型安全论断必须先做宿主运行时实证再定级——本库其余 major 均为结构直接可证的类型。

## 二、TOP 风险清单（影响 × 可能性，来源报告 + 证据）

| # | 风险 | 影响 | 来源（报告 key / 文件:行号） | 定级 |
|---|---|---|---|---|
| R1 | 命令注入：index-add execSync 直拼 repoSlug/pkg（`npm view ${pkg}`/`git clone …${repoSlug}`），仅验含 '/'；CLI 设计给 LLM 调用 | 以使用者权限任意代码执行 | t5_scripts M1：scripts/index-add.mjs:278/287/268（本 attempt 复核） | major |
| R2 | 存储型 XSS：emitFrontend 槽位零上下文转义，requirement（外部文本）进 HTML 元素区与 JS 单引号 CFG，全链无 escape/CSP；交付页 host 同源可读任意 preset .service token | 打开即执行；跨 preset 数据面窃取 | t4_client CF-1：src/frontend.ts:51-53/100-106；frontends/chat-console/index.html:8/27/47/50（9 模板 CFG） | major |
| R3 | 供应链持久注入：add_knowledge/submit_part 让会话 agent 无人复核把条目/代码写入共享目录，description/tags 无标注进入后续所有装配/验收 prompt（buildMatchPrompt tagsIndex:318、search 1323、deriveProbe 工具清单 verify.ts:407） | 对后续会话的持久 prompt 注入与后门零件扩散 | t3_tools OT-5：src/orchestrated-tools.ts:2069-2074/2294-2308/316-319 | major |
| R4 | shipped 目录数据违例 + 零闸：via:mcp 条目无 config.server → 选中静默空发射 + BOM 记 plane:host（供应链记录失实）；13 测试无一致性闸 | 装配"成功"而无能力；审计记录错误 | t1_arch M1（capabilities.yml:769-776；index.ts:422-424/1259-1265）互证 t6_tests M2 | major |
| R5 | 机器绝对路径入库：capabilities.yml 全量 /Users/tongtao/code/dsh-assembler/…（git 跟踪 + npm files 发布） | 换机/发布安装后全部 stdio MCP 指向不存在路径 | t5_scripts M2：index-add.mjs:465-471；capabilities.yml:37 等；index.ts:1158-1162 | major |
| R6 | 前端门脱钩：行为全 PASS 而 runFrontendGate FAIL 时 head 仍「验收 PASS」，台账/记分板无痕；无 index.html 则门永不跑 | 坏脸/无脸 preset 以 PASS 交付并被下游闸放行 | t3_tools OT-2：orchestrated-tools.ts:1182/1254-1257/1194-1201/1209-1218；1604-1628 | major |
| R7 | 宿主级执行门禁无纪律：submit_part npm install 跑生命周期脚本、smoke 继承全量 env、MCP 实探无超时 | 注入即 RCE（设计内）＋坏零件无限挂起 DoS 工具通道 | t3_tools OT-1：orchestrated-tools.ts:2249-2291（2269/2274-2279/2283-2291/2286；本 attempt 复核） | major |
| R8 | 考官进程面崩溃：三处 spawn 无 error 监听、stdout 不消费；缺零件入口即进程级崩溃而非 FAIL 证据 | 验收路径崩坏装配器进程/假超时 | t1_arch M2：src/scaffold.ts:432-438/247/634 | major |
| R9 | 全新检出不可用：index-add 顶层静态 import lib/wire.js（lib gitignore，仅 build 后有），任何子命令模块解析期失败；发布 files 与运行面分叉（knowledge/generated 不在 files） | DX 断链；检出版与发布版行为分叉 | t5_scripts M3（index-add.mjs:29；.gitignore:5）＋t3 OT-9（package.json:17-22） | major |
| R10 | 验证器假阳敞口：帧类型契约未钉（reasoning 若以 text 块进 reply 即假 PASS）；空串标记恒命中；runTriggerProbe 盲发盲等折叠 ERRORED/FAIL | 验收欺骗最敏感面无检测 | t2_verify v4（verify.ts:676-683 vs 587-593）/v3（194-203）/v2（937-967）；t3 OT-4 同族 | minor（条件升 major） |
| R11 | 台账可伪造 + carry 跳前端门：同目录无鉴真台账 + 沿用早退 | 不经真探针的 PASS；窗口期页面坏不被发现 | t1_arch m1（index.ts:853/887-918）；t3_tools OT-7（1024-1032 vs verify.ts:758-759） | minor |
| R12 | README 能力清单过期两语言四处且无闸 | 文档可信度损伤（违反自身负面清单） | t6_tests M1（README.md:21/172 等）＋t5 m7 | major(文档) |
| R13 | loadCatalog 零形状校验 → 客户 catalog 脏数据使 search 崩溃；nameFor 前缀歧义/serverName>32 无闸；gap 工单 draft.id 路径穿越 | 检索面整段不可用/工单越界写 | t1_arch m6/m7/m8（capability-index.ts:19-31；index.ts:1253-1255/1405-1407） | minor |
| R14 | 探针工作区 /tmp 无界累积；wire 会话失败路径孤儿；runDomExam 异常泄漏浏览器进程；auto die() 跳过会话清理 | 长驻 host 磁盘渐满/会话与子进程泄漏 | t2 v1（verify.ts:621-625）；t4 CW-2/CS-3；t5 M5 | minor |

## 三、按优先级排序的可执行修复路线（改动点 + 验证方式）

**P0（合入前必修；对应 R1-R6 的安全与判定主线）**

1. 注入面三杀（R1/R2/R3）：scripts/index-add.mjs:278/287 execSync → spawnSync 数组参数或白名单校验（repoSlug `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`、pkg 包名正则）杜绝 shell 拼接；src/frontend.ts fillTemplate 按上下文转义（HTML 槽 HTML-escape；CFG 槽整值经 JSON.stringify 后入模板，9 份模板 `'{{workdir}}'` 形同步改造）并更正 :50 注释；orchestrated-tools.ts:2069-2074 入库条目强制 submittedByAgent/at 溯源 + 人工确认点（或 host 审批钩子），prompt 渲染侧（316-319/1323/verify.ts:407）对未审条目加「机器提交、未审」标注。验证：新增注入样本单测（`; id`/`$()`/`<img onerror>`/`</script>`/`\u` 形态断言不经 shell/不进字节）、escaping 回归断言，全部进 npm test。
2. shipped-catalog 一致性闸（R4/R5，一次改动覆盖 C1 全部）：loadCatalog（index.ts:196-221）加条目结构归一与不变量校验——via==='mcp' ⇒ config.server 存在且 ∈ mcp-servers（违者装载报错点名条目；或先给 capabilities.yml:769-776 补 config.server）；capabilities.yml args 改仓库相对路径/专用槽位（registerCore index-add.mjs:465-471 写 `@@REPO@@/generated/...`，消费端 index.ts:1158-1162 与列举端进程内解析）；顺带修 t1 m6/m7/m8（条目形状归一、nameFor 精确解析、draft.id 套 PRESET_ID_RE 形状闸）。验证：新增 shipped-catalog 闸（并入 tests-catalog-layer）：真实 capabilities.yml 每条 via:mcp 条目 config.server 可解析、catalog 行↔mcp-servers 键↔generated/<id> 双向完备、无机器绝对路径残留；register 输出快照（相对路径断言）进 npm test。
3. 验收判定完整性（R6/R11）：orchestrated-tools.ts verify_preset——前端门 FAIL 时总判定不得 PASS（或记分板/台账单列门级 FAIL 行，head 按门级真实汇报）；carry 早退路径（1024-1032）补一次廉价门 1（复用 runFrontendGate loop:false）；台账信任边界——host 侧独立位置或附签名，至少沿用行明示"来源=本目录台账，可被写手重置"。验证：verdict×feLine 组合矩阵测试（PASS×门FAIL 必须非 PASS）、carry×坏页用例、篡改台账后必须走真探针的用例。
4. 进程/资源纪律统一件（R7/R8/R14）：抽共享 spawn 封装（child.on('error') 转 FAIL 证据、stdout 'ignore' 或 drain、spawn 前 statSync 入口存在）替换 scaffold.ts:432-438/247/634；submit_part 门禁（2249-2291）加 AbortSignal.timeout+kill、env 按 SECRET_KEY_RE 剥离、npm install --ignore-scripts（或显式风险提示）；openWireSession 失败路径统一 session.cancel（wire.ts:332-335/370-409）；auto() die 改设 exitCode 让 finally 收尾（index-add.mjs:75-78）；探针 close 时清理 mkdtemp 工作区（verify.ts:621-625）；runDomExam 资源纳入 finally 管辖（scaffold-dom.ts:292-298）。验证：mock 缺失 start 命令断言返回 FAIL 而非未捕获异常；listTools 永不返回的 mock 断言超时 kill；会话失败后无孤儿（契约级 mock 测试）。

**P1（下一迭代；R10/R12/R13 与契约钉死）**
5. 帧契约与语义钉死（t2 v2/v3/v4；t3 OT-4）：tests-verify 补 reasoning 块/多 assistant 帧夹具（思维链标记不得假 PASS 或明确过滤语义）；marksPresent 空串/空集返回 false + runners 入口 validate（turns≥1、mustInclude 非空）；add_knowledge 检索门复用同一标记校验；runTriggerProbe 保留最小错误面（挂载失败以 ERRORED 早退）；verify 原语补契约级 mock 测试进 npm test。
6. README/生成物同步闸（R12/C2）：catalog-report --check 增"README 内嵌片段 === 生成输出"比对（或构建期注入）；修复注释漂移清单（frontend.ts:50、verify.ts:758-759、scaffold.yml:43-44 锁定面声明、client/index.ts:98 done 标记统一常量并加契约测试）；scaffold-sync-vocab 双向同步（t5 m5）。
7. 数据方言与盲区补测（t5 M4/m9、t6 m1/m2/m3、t1 盲区）：spec-intake $ref 本地解引 + HEAD/OPTIONS 边界（tests-spec-intake 补 $ref/body-ref 用例）；readSecret 纪律扫描按读取点重扫（覆盖双引号/解构形态）；纯中文名发射级兜底用例；shipped catalog 检索冒烟（tests-capability-index.mjs:44 放开 via:mcp 过滤或另加断言）；gap 工单文件名穿越用例。

**P2（卫生与可移植性收尾）**
8. lock-check 泛化到全部被跟踪 package-lock.json（t5 m1）；index-add wire 改动态 import（t5 M3）；package.json files 与运行面/检出模式声明（t3 OT-9）；registry-add ns/type/锁行 license 校验 + 落盘 assertYaml（t5 m3/m6）；.service.json 入 .gitignore 并 git rm --cached（t5 m4）；临时目录/环境还原 nits（t6：catalog-layer/proving-grade mkdtemp 清理、tests-verify env 还原、orchestrated 固定日期 fixture 改相对时间）；COOKIE_LIFETIME_MS 注释对齐（t4 NW-1）；verify.ts 模型默认值收敛单点（t2 v5）；t4 NW-2/NF-1 与 t1 n1-n8 随补测处理。

## 四、仓库整体质量结论

**架构定位评估**：spec→arch→scaffold→verify 主链路职责分明——确定性发射（index.ts）+ 机械探针闸（arch-spec）+ 六门考官（scaffold）+ 独立黑盒探针（verify.ts）+ 工具面编排（orchestrated-tools.ts），与 DESIGN.md 的"三件本分/负面清单/宪法"自洽；t2 复核确认 verify.ts 独立性声明成立（不 import 装配器发射逻辑），t1/t4 复核确认模块边界与依赖方向干净。proving-grade 判卷层实际在 bench/lib、探针原语在 src/verify.ts 的两目录分居是真实架构事实（t2 已标注），建议 DESIGN 明示该边界。
**优点**：闸文化密度极高（错误即界面、出声不静默、验收只认盘上工件、字节确定性/代际、SECRET 双闸、路由安全包含闸、区分口令闸防直打 SQL 假绿、事故回放型测试与"概念账"钉）；注释普遍带战役取证、历史教训制度化快；测试链纯件面覆盖质量上乘（判定矩阵/正反例/文案断言）；无 critical 级缺陷。
**主要弱点**集中在四类：(1) 对 shipped 数据/文档的闭环闸缺失（目录违例已真实发生且零拦截、README 过期、机器路径入库）——"测试全用合成数据 + 真实数据被无条件信任"的空档是最一致的结构性发现；(2) LLM/外部文本边界卫生（shell/HTML/prompt/文件名四处注入面同根因：外部文本进信任区前缺形状闸与转义）；(3) 失败路径的资源生命周期（spawn/会话/临时目录多处独立缺口）；(4) unit 链与真会话之间的契约空档（execute 面与探针原语零直测，回归依赖战役制）。
**总体评估**：接近生产级的高自省代码库——核心算法与纪律面质量高；合入前优先闭合 P0 四条主线（注入面三杀、shipped-catalog 一致性闸、验收判定完整性、进程/资源纪律），并把"真实数据一致性闸"补进 npm test，以匹配其文档宣称的保证强度。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_e28960f8-42a4-4f52-b331-d3c0f4710cf4`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_ce53104f-8735-4181-9f03-69700bd5b5bc", "run_4f01a03c-d123-435f-9c98-194a55e5dc16", "run_1e12ad3c-62a4-4cd6-a5bf-54aa7bdd4186", "run_df1ddf82-da64-4c27-a8df-0ac990fba117", "run_4880a98c-93d1-43b1-825c-232e3ba25c24", "run_7c0d562c-4c0a-48a2-9c9f-495f1aa2618d", "run_d189c547-b1d2-415a-8094-ea9eadedf02d", "run_b04bc113-7de4-4929-a46b-cf50548f6453"]

[汇总阶段性发现] t7_report 交叉核对完成，8 项跨模块一致性清单(C1-C8)+14 项 TOP 风险(R1-R14)+P0/P1/P2 修复路线已成形。核心结论：(1) C1 最强互证——capabilities.yml shipped 数据零结构闸被三份报告从三面命中(t1 M1 真实违例 via:mcp 无 config.server、t6 M2 零测试闸、t5 M2 机器绝对路径入库)；本 attempt 只读复核 catalog 计数 103/27/5/311 与 README 陈旧计数(90/244/66/19)双证成立；(2) C4 空串标记恒命中两处独立出现(verify.ts:199 includes、orchestrated-tools.ts:2030-2034)；(3) C3/C6 验收语义族——台账可伪造(t1 m1)+carry 跳前端门(t3 OT-7)+前端门脱钩(t3 OT-2)；(4) C5 资源生命周期六处独立缺口(t1 M2 spawn、t3 OT-1 门禁无超时、t2 v1 /tmp 泄漏、t4 CW-2/CS-3、t5 M5)；(5) C8 已解决冲突记录——OT-3 经运行时实证由 major 降 minor(evidence_d100da7e→ec1a893f→96be987c)；(6) 修复路线按 P0 四条主线(注入面三杀: index-add.mjs:278/287 spawnSync、frontend.ts 槽位转义+9 模板 CFG、OT-5 溯源与 prompt 标注; shipped-catalog 一致性闸进 npm test; 验收判定完整性 verdict×feLine 矩阵; 统一 spawn/超时/清理件)排列，每条带改动点+验证方式。关键论断均有本 attempt host 记录只读运行支撑(run_ce53104f/run_4f01a03c/run_d189c547/run_b04bc113: index-add.mjs:264-292、orchestrated-tools.ts:1178-1186/1250-1260/2266-2292、README.md:19-23/170-174、index/catalog.yml 计数、index.ts 台账段、verify.ts marksPresent)。
