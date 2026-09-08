# 独立复核结论、OT-3 挑战/更正闭环（全文）

## v1_arch → 复核 t1_arch

独立复核通过。在同 commit(db10fb3b)双工作树上逐字抽核 t1_arch 提交工件:范围覆盖 A1 全部文件(index/arch-spec/scaffold/capability-index/js-yaml.d.ts + capabilities.yml 消费侧);2 条 major 全部成立——M1(shipped catalog capabilities.yml:769-776 两条 via:mcp 条目无 config.server、mcp-servers 键 460-478、头注释不变量 12-15;发射端 index.ts:422-424 空 server 静默剔除、BOM 1259-1265 误记 plane:'host';tests-*.mjs 无任何相关断言)、M2(scaffold.ts:432-438 spawn 无 'error' 监听且 stdout pipe 无人消费,247/634 同缺,全文件 .on('error') 仅 364,无零件入口 existsSync 前置);m1-m8 每条 minor 的 文件:行号 证据逐一核验一致;分级(0 critical/2 major/8 minor/8 nit)恰当;A7 五维覆盖,作者 27 个工具运行全为只读(read/grep/bash 只读命令/todo_write),工作树 git clean、changedPaths 空,无违规写。仅两处 nit 级措辞瑕疵(测试盲区段 "17 个 check" 实为 16;M1 中"测试面全用合成 catalog"过宽——tests-capability-index.mjs:43 实际读真实 catalog 做召回冒烟,但 44 行显式滤除 via:mcp 条目,故其承重论断"无闸断言 shipped via:mcp↔server 一致性"仍成立),不影响任何发现的有效性与分级。复核结论已发布为 evidence_3dd938fd。

## v2_verify → 复核 t2_verify

独立复核通过（复核工件 evidence_5ef4a6f8）。范围覆盖：t2_verify 报告对 src/verify.ts 全模块逐件分类（纯判定/推导/执行件、判定协议四态、独立性声明核验），并准确界定 proving-grade 语义边界——判卷层在 bench/lib/proving-grade.mjs、verify.ts 只供探针原语，标注 t7 交叉核对项——A2 满足。证据抽核（本 attempt 只读 sed/grep 复核）：v1 verify.ts:14 仅 mkdtempSync import、:621-625 cwd??mkdtempSync('assembler-probe-')、src/ 无清理——属实；v3 marksPresent(:194-203) 空串标记恒真与空数组恒假及归一 ≥2 字符守卫——与代码一致；v4 注释假设(:587-593 "TEXT blocks only…reasoning 不进 reply")vs reply 拼接(:676-683)，tests-verify.mjs reasoning 夹具 grep 计数为 0——假阳敞口成立；v5 派生器默认(:354-355)三处各持一份——属实；v2 runTriggerProbe events:false 盲发盲等(:937-967)——与代码一致；独立性声明经 import 面 grep 证实（仅 node:*/cordis/dsh-llm/index.js 类型/wire.js，无 scaffold/arch-spec）。分级恰当：0 critical/0 major 合理（最强问题为资源/语义边界 minor，v4 已给条件升级路径）；nit 均为可接受降级或注释补充。A7 合规：发现均带 文件:行号 与 host 工具运行证据（evidence_58dd51ac/32bc5149），无无证据断言；源工件 commit==baseCommit、changedPaths 为空；本复核全程只读。判 accept。

## task_595f33ee-41a1-45a9-bb12-ae1021f1495a → 复核 t3_tools(更正后复核)

独立复核通过（复核工件见 evidence_96be987c）。更正证据 evidence_ec1a893f 与本复核人此前挑战结论一致：Node ≥18 undici 在 Request 构造期拒绝含 userinfo 的 URL（本 attempt 只读复测 http://127.0.0.1:8080@example.com/y 同样 TypeError、零连接），原 OT-3 major·SSRF/伪造PASS 机制不成立、fail-closed；更正后降为 minor·安全形状缺陷（startsWith 前缀非 URL 解析、校验语义与连接目标脱节、误导性文案、对未来 http.request 类实现埋雷），修复建议（new URL() 校验 protocol/hostname + 禁 userinfo + fail-closed 单测）保留——更正准确、分级恰当。其余 findings 本 attempt 复测成立：OT-1（submit_part 门禁无 --ignore-scripts、env 全量直传、实探无显式超时）、OT-2（前端门 FAIL 不并入判定/台账，PASS 头条照打）、OT-4（add_knowledge 空标记恒命中/半包残留/内存无界）、OT-5（agent 可控文本无标注进 aux prompt 与目录条目无溯源）。A3 范围覆盖与 A7 只读合规（源工件 commit==base、changedPaths 空）。判定：accept。

## v4_client → 复核 t4_client

独立复核通过。t4_client 报告在同 commit(db10fb3b)工作树上逐字抽核:A4 范围全覆盖(wire/frontend/scaffold-dom/client/index/persona-lint);唯一 major CF-1(存储型 XSS)抽核全部成立——fillTemplate(frontend.ts:51-53)零转义、slots 100-106 含外部 requirement(调用方 orchestrated-tools.ts:851)、chat-console 模板上下文行号 8/27/47/50 与 bilingual-reader:157 等 9 模板 CFG 单引号区逐一吻合、全链无 escape/CSP、.service 208-216 同源读任意 preset token;9 条 minor(CW-1/2/3、CF-2/3、CS-1/2/3、CC-1、CP-1)与 6 条 nit 全部在引证行号核验一致;测试盲区段对 tests-frontend.mjs(97 行)行号属实;分级恰当;A7 合规(作者 10 个工具运行全为 read+只读 bash,工作树 git clean,changedPaths 空)。仅两处 nit 级措辞瑕疵(CC-1 "md 零命中"过宽——docs 转录含该字样但无运行时生产者,断链论断成立;NS-1 预算行号 319/371 应为 308/319),不影响任何发现。结论已发布 evidence_3467edec。判定:accept。

## v5_scripts → 复核 t5_scripts

独立复核通过（复核工件见 evidence_289984bb）。范围覆盖：t5_scripts 报告逐文件覆盖 scripts/ 全部 9 个脚本（index-add/catalog-report/registry-add/build-client/link-dsh/lock-check/yaml-write/spec-intake/scaffold-sync-vocab）与 package.json/tsconfig.json/.gitignore/.service.json 工程配置，并评估了 npm test 闸门链实际约束力——满足 A5。证据抽核（本复核 attempt 只读运行 run_a6c78f64/run_81beb9d5）：M1 index-add.mjs:278 `npm view ${pkg}` 与 :287 `git clone …${repoSlug}.git` execSync 直拼未转义、repoSlug 仅验含 '/'（:268）——shell 注入成立；M2 registerCore :464-471 以 join(root,…) 绝对路径写被 git 跟踪且列入发布清单的 capabilities.yml（实文件 args=/Users/tongtao/code/dsh-assembler/…），消费端 src/index.ts:1158-1166 仅对 @@WORKSPACE@@/@@KBDIR@@ 槽位替位、其余 arg 原样透传 StdioClientTransport——机器路径入库成立；M3 index-add.mjs:29 顶层静态 import '../lib/wire.js' + .gitignore:5 /lib/ + git ls-files 无 lib（复核工作树实测亦无 lib/ 与 node_modules、git status 干净）——全新检出未构建即整体失败成立；M4 spec-intake.mjs:46-57 对 $ref 参数不解引、prm.name/in 为 undefined 产出 undefined(undefined) 且 hasBody 判定失真——结构证实；M5 die()=process.exit(1) 在 auto() try/finally 内 :760/:777 早退，finally session.close()（:792-794）不会执行——会话清理跳过成立。minor 抽核 m1（lock-check 只读根 package-lock.json）与 m3（registry-add --ns 无格式校验、type 原样插锁、resolve 防线随 dest 同逃逸）亦属实。分级恰当（无 critical 合理；M5 处 major/minor 边界但非失当，M1 注入成立性无争议）。A7 合规：报告维度覆盖正确性/健壮性/安全性/可维护性/测试盲区，发现均带 文件:行号 与行为探针/工具运行证据，无无证据断言；源工件 commit==baseCommit、changedPaths 为空，审查只读。判 accept。

## v6_tests → 复核 t6_tests

独立复核通过（复核工件见 evidence_852fa03f）。范围覆盖 A6 全部 13 个 tests-*.mjs 与 README/DESIGN 一致性、盲区清单。两条 major 全部抽核成立：M1 README 计数过期（README.md:21/172、README.zh.md:21/174 实文 "90 parts/244 tools — 66/19/5"；实测 index/catalog.yml 103 行/311 工具/27 服务/5 第一方，71 库型自洽）——分级合理（直接违反 DESIGN 负面清单 5 与 catalog-report.mjs 自述哲学）；M2 三向一致性无闸（实测 catalog 103 行⊂mcp-servers 104 键、多余键仅 filesystem；tests-orchestrated.mjs:579/588-589 仅为抽查；t1 evidence_e5ab8665 实违例交叉背书准确）。minor 抽样 m1（$ref 零用例）、m2（readSecret 扫描掩蔽面与正则漏双引号）、m3（tests-naming.mjs:18-19 固化空串）、m4（cwd 依赖）均与代码一致；未发现无证据断言。A7 合规：源工件 changedPaths 空、commit==base，审查只读。分级恰当，判 accept。

## v7_report → 复核 t7_report

独立复核通过（复核证据 evidence_ee73c3e7）。A8 要素齐全：t7_report 含 C1-C8 跨模块一致性清单（含 C8 对 OT-3 降级的冲突解决记录，口径与 evidence_ec1a893f/96be987c 更正链一致）、R1-R14 TOP 风险表（每条带影响/来源报告 key/文件:行号/定级，无夸大——R10 条件升级、R12 文档级标注均与源报告一致）、P0/P1/P2 按优先级修复路线（每条含改动点+验证方式）、整体质量结论（含架构定位与 proving-grade 边界说明）。交叉引用与 6 份 accepted 分模块报告一致：本复核独立只读抽核 R4（capabilities.yml:769-776 两条 via:mcp 无 config、server 键 460/475、index.ts:422-424 静默剔除）、R6（orchestrated-tools.ts:1182 门槛/1254-1257 PASS 头条）、R7（:2269 无 --ignore-scripts、:2274、:2286）、C4（verify.ts:199 与 orchestrated-tools.ts:2030-2034 双处空串 includes）全部属实；目录计数 103/27/5/311 与 README 陈旧计数与我 t6 实测一致。仅发现 nit 级措辞瑕疵（C5 标题"五处"与列举六项计数不一致）与 minor 小项未逐一入路线（可接受省略），不影响判定。A7 合规：关键论断有 host 记录运行支撑、无无证据断言、源工件 commit==baseCommit 且 changedPaths 空，本复核亦全程只读。

## OT-3 挑战/更正闭环（evidence 全文）
### `evidence_d100da7e-5e23-468c-bd91-1772ce04630f` ｜ outcome supported ｜ status verified

[major·安全] verify_shared_data 的「本机 app」白名单可绕过(1373-1374):校验是 startsWith('http://127.0.0.1:') 前缀而非 URL 解析。WHATWG URL 中 userinfo 在主机前,http://127.0.0.1:80@任意主机[:端口]/ 的 authority 解析为 userinfo=127.0.0.1:80、host=任意主机——前缀校验通过但 fetch 实际连任意主机/端口(默认 80),「127.0.0.1 限定」形同虚设;可对任意内网/外网主机发 POST /api/sql(SSRF 面),远端可控应答(rows 含 payload)可伪造 PASS(1430-1431)。建议:new URL() 解析后校验 protocol==='http:' && hostname==='127.0.0.1',并禁止 userinfo。

### `evidence_ec1a893f-53b3-4144-99ab-84633025fcda` ｜ outcome supported ｜ status unverified
supersedes: ["evidence_d100da7e-5e23-468c-bd91-1772ce04630f"]

[更正·supersedes evidence_d100da7e(t3_tools),severity 降为 minor·安全形状缺陷] 独立复现证实 v3_tools 复核挑战成立:Node v22.22.3(undici)fetch 对含 userinfo 的 URL 在 Request 构造期即抛 TypeError("Request cannot be constructed from a URL that includes credentials";本复核 attempt 只读探针实测 http://127.0.0.1:80@127.0.0.1:9/x 与 http://127.0.0.1:8080@example.com/y 均构造期拒绝、零网络连接)——原 major 论断(orchestrated-tools.ts:1373-1374 startsWith 前缀被 userinfo 语法击穿 → SSRF/远端伪造 PASS)的机制不成立:穿透后的 URL 只会在 appSql/fetch 失败路径 fail-closed(判 FAIL),无出向请求、无法伪造 PASS。真实残余为 minor:白名单是 startsWith 前缀而非 new URL() 解析后的 hostname/protocol 校验——校验语义与真实连接目标脱节、错误文案("必须是本机 app 地址")在 userinfo 输入下误导;且对将来改用接受 userinfo 的请求实现(http.request/axios 等)埋雷。修复建议不变:new URL() 解析后校验 protocol==='http:' && hostname==='127.0.0.1' 且禁 username/password,并补含 userinfo URL 的单元测试钉死 fail-closed 语义。t3_tools 其余发现与 A3 验收义务不受影响。

### `evidence_96be987c-c8a0-4e51-a411-8a4040cf55b3` ｜ outcome supported ｜ status unverified

[复核结论·accept(更正后)] t3_tools 更正复核:(1) 更正证据 evidence_ec1a893f 与我的挑战结论完全一致——undici 对含 userinfo URL 在 Request 构造期抛 TypeError、零网络连接、fail-closed(本复核 attempt 只读复测 `http://127.0.0.1:8080@example.com/y` 同样构造期拒绝);OT-3 由 major·SSRF/伪造PASS 降为 minor·安全形状缺陷(startsWith 前缀非 URL 解析、校验语义与真实连接目标脱节、userinfo 输入下错误文案误导、对将来 http.request/axios 类实现埋雷),修复建议(URL 解析校验 protocol/hostname + 禁 userinfo + fail-closed 单测)保留——更正内容、残余面与分级均恰当。(2) 其余发现复核(本 attempt 只读):OT-1 submit_part 门禁(2269 npm install 无 --ignore-scripts、2274 smoke 直跑 180s、2286 env 全量 process.env 直传被审零件、实探 connect/listTools 无显式超时,SDK 默认 60s 界)属实;OT-2 verify_preset head 只随 verification.status、前端门 FAIL 仅进 feLine 文本、台账/记分板无痕、index.html 缺失即门永不跑(1182)属实;OT-4 add_knowledge 扁平化写盘无冲突检测、全树语料常驻内存、includes('') 空标记恒命中、仅检索门失败才清理(2038)属实;OT-5 buildMatchPrompt tagsIndex(318) 原样 description/tags 进 aux prompt、capabilities.yml 条目无溯源直追加(2069-2074)属实。(3) A3 范围覆盖(major 4 + minor 6 + nit 4 逐条带 文件:行号)与 A7(源工件 commit==baseCommit、changedPaths 空,全程只读)合规,无无证据断言。判定:ACCEPT。
