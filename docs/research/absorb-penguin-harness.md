# 吸收调研:PenguinHarness(Prism-Shadow/penguin-harness)

> 2026-08-24,读源码 @ 8fad011(浅克隆)。定位:开源"agent 造 agent"桌面/服务器产品,
> Apache-2.0,深度调优 DeepSeek/开源模型。2026-07-19 首个 tag → 08-21 已到 0.2.4,
> 一个月迭代密度极高。core 22.7k 行 TS,8 包 monorepo(core/cli/server/web/desktop/
> docs/landing/skills),18 个内置 SKILL.md。
> 主张:"With LangChain you build agents at 1× speed; with PenguinHarness agents build
> agents at 100×"、RAG app $0.02、数据分析基准 1/70 Claude Code 成本。

## 一句话判定

**同一命题的镜像解**。我们:零件供应链 + 确定性发射 + 独立考官(verified assembly)。
他们:极小工具面 + 一切教义放进带版本号的 SKILL.md + 自进化三件套(benchmark-design /
agent-evaluation / agent-optimization)。他们没有独立验收(初始化只有自查),没有零件
生态(app 靠配方实例化);我们没有版本化记分板,没有优化循环,探针出题方法论比他们
的评测协议粗。**最大的可学项 = 他们的评测/自进化协议;最大的确认项 = "教义进散文、
散文带版本"与我们的契约到期制同构。**

## 他们是什么(机制层)

- **Agent = 纯文件目录**:`agents/<id>/agent_state/{system_config.yaml, AGENTS.md,
  skills/, memory/, tools/, .vault.toml}` + `scratchpad/ + traces/ + benchmarks/ +
  snapshots/`。造 agent = builder agent 照 agent-initialization skill 写文件(拷默认
  config → 写 AGENTS.md → 装 skills)。**没有发射器、没有闸门、没有独立验收**——
  初始化验收是 builder 自查(parse yaml / 文件非空 / skill name 匹配目录)。
- **系统层/需求层分离**:`system_config.yaml` 的 system_prompt 是稳定系统层(默认仅
  ~50 行,release note 追踪"缩短了 1/10");AGENTS.md 是需求层(≈我们的 persona)。
  Skill 的 frontmatter(name/description/version/updated)自动注入 system prompt,
  正文按需 read_file——display 文案(short_description)与 prompt 文案分离。
- **$0.02 造 app 的真相 = 配方实例化**:penguin-sdk skill 363 行,内嵌一整套生产级
  RAG app 代码(BM25+CJK 单字分词、双语关键词映射、SSE 断连 abort、session 先于
  headers、空 tools 数组会 400、EPIPE 守卫、引用 [n] 弹层 1:1 契约……每个坑注释在
  代码里)。agent"生成"= 抄配方改参数。**工程幸存者知识全部沉淀在 skill 里**——
  这不是自由生成,是"一个大零件"。
- **自进化 = 三个 skill + 文件约定,零专用代码**(除快照目录与 scoreboard 格式):
  - `benchmark-design`:Capability Contract(先写清"要测的可观察行为/弱行为捷径/
    该基准应训练的通用 State 改进")→ Statement(公开)/Rubric(私有)分离 + 泄漏
    检查 → Pilot(每 Case 一跑)校准 → **冻结** → Formal Baseline 入 scoreboard。
    反作弊纪律成文:见过答案后禁改 Gold;禁为凑分改评分项;达标立即冻结、禁为
    余量继续加难;"加行数/干扰项不算加难,观察到的策略仍能解就不是难度"。
    **每次改难前须写"分离预测"**:预测捷径策略与期望行为各自产出什么、影响多少
    分——两者同分就换一个改法(可证伪性仪式)。
  - `agent-evaluation`:worker 子 agent,静默运行,**唯一输出 = 一份纯协议 YAML**
    (禁叙述/禁围栏);四个失败码(invalid_request / benchmark_invalid /
    version_changed / evaluation_failed);**评测失败绝不记零分**;格式坏了让 worker
    重发干净 YAML、**不重跑被测**、调用方不代为解析;传输元数据不算 worker 文本。
    评测前后校验 Agent State version 与 Statement/Rubric 快照未变(并发修改 →
    version_changed 丢弃)。
  - `agent-optimization`:Reference/Candidate 爬山循环。每轮:诊断能力缺口 → **可
    证伪假设**("只加分析步骤、不预测行为变化的改动不算假设")→ 从 Reference 造
    一个 Candidate(版本号只增、被拒版本号不复用)→ 改前必须存在
    `snapshots/v<N>.tar.gz`(原子归档,排除 .vault.toml,同版本不覆盖)→ 冻结
    Case 集全矩阵评测 → **严格更高才接受**,否则回滚 → 接受立即追加 scoreboard 并
    回读校验。**防污染**:优化者禁看 Rubric/Gold,私有评分信息一旦进上下文 →
    恢复现场、以 contaminated 停机(训练/测试分离!)。接受与"假设是否被支持"
    分开记录。
  - `scoreboard.yaml`:按版本追加(time/version/provider/model_id/thinking_level/
    score/cost/duration_ms/cases[].runs[].session_id),数字落盘即权威("不许任何
    server/前端/脚本重算校验")。
- **极小工具面 + 教义外置**:软件工程 skill 仅 34 行(浓缩版 Claude Code 教义);
  上网无专用工具("shell 里 Playwright 优先、否则 curl")。**工具面归 harness,
  一切流程知识归带版本号的 skill**。
- **凭证**:每 agent `.vault.toml`,值只注入 shell 子进程环境,"values never appear
  in your context";CLI 管理、UI 有 vault tab;(provider, model_id) 二元组强制成对
  ("从 id 猜厂商会把 key 发给别家端点");全局根 vs app 根反复成文死守("app 的
  key 永不进 ~/.penguin")。模型配置带三价目字段(cache read/write/output $/M)——
  成本核算一等公民。
- **上下文工程**:线性历史 + summarize 压缩(committed 语义精确处理 provider 严格
  tool_result 配对);窗口推导输出钳位(单一 margin 常数派生 floor 与 headroom,
  "小窗口模型 + 固定 max_tokens = 每请求 400"这类病根治);usage 三分账
  (cache_read/cache_write/output)。压缩/中断/转向全用 `[tag]` 合成块协议
  (turn_aborted/turn_retried/context_summary/user_steering)。
- **Memory**:与 Claude Code memory 同构(一事一文件 + frontmatter + MEMORY.md 索引
  行注入 + [[链接]]),user/workspace 两作用域,索引行数上限。
- **示范工程学**:examples/self-improving-agent 的任务设计——评分 10 分 = 5 分内容
  (任何模型都拿)+ 5 分房规(**只写在 AGENTS.md、任务文本推不出来**)→ 空白基线
  在任何模型上稳定丢 5 分。"**信息缺口而非能力缺口**",让干预效果结构性可归因。

## 模式 → 出处 → 怎么借

| # | 模式 | 出处 | 怎么借(dsh-assembler) | 代价 |
|---|---|---|---|---|
| 1 | **记分板版本史** | agent-optimization scoreboard.yaml | selfcheck.json 升级:每次(同名重发后)复验追加一行 {time, EMISSION_REV, preset 字节哈希, verdict, 墙钟, session}——第 30 天故事(契约稳定/行为漂移)有了纵向台账 | 小,半天 |
| 2 | **验中版本钉** | agent-evaluation 的 expected_version / version_changed | verify_preset 开跑前记 preset 字节哈希(台账现成),结束后再核;不一致 → 判 verdict 无效并报"探针期间 preset 被改动"。防并发装配互踩 | 极小 |
| 3 | **改前快照** | 优化 skill 的 snapshots/v\<N\>.tar.gz 纪律 | 同名重发前把旧 preset 目录原子归档到 `<preset>/snapshots/`(排除 kb/ 大件可选);FAIL 后一键回滚,数据安全叙事再加一环 | 小 |
| 4 | **出题方法论移植** | benchmark-design 的 Capability Contract + 分离预测 | 探针推导 prompt 补两句承重句:①先写"要测的行为 vs 强 agent 的捷径";②验收标记必须区分两者(标记≠出现即得分的礼貌词)。治我们已知病(考官回退推导出题质量);按 prompt-regression 程序 A/B 后转正 | 中,须实测 |
| 5 | **worker 协议措辞** | agent-evaluation "resend clean YAML, don't rerun / transport metadata is not worker text / 评测失败≠零分" | 我们 bench 驱动器与任何子 agent 判卷协议采用同款三条;P3 判卷员偏见教训的成文化 | 极小,文档 |
| 6 | **标记泄漏 = 未来污染源**(设计预警) | Statement/Rubric 分离 + 优化者防污染停机 | **发现我们的隐患**:selfcheck.json 里验收标记明文可见——今天无害(无优化循环),一旦有任何"按体检包自我改进"的流程,agent 可以对着标记词调 persona 作弊(Goodhart)。现在先记设计注记:任何未来优化流程禁读 selfcheck 标记原文,或标记转私有(考官侧持有) | 零(注记),未来护栏 |
| 7 | **优化循环 = 主 agent 的 skill** | 三件套全是 skill、不是 harness 代码 | 若做"persona 爬山"(P4 候选):以 DSH skill 形态给主 agent(冻结 selfcheck 探针集 + 严格更高接受 + 快照回滚),assembler 只当考官——正好贴我们的身份裁定(智力归主 agent) | 大,P4 |
| 8 | **IME 合成守卫** | web-design skill 的"non-negotiable"(isComposing / keyCode 229) | **已当场核实为真 bug**:`grep -rln isComposing frontends/` 为空,approval-desk/chat-console/data-desk×2/kanban 等全部 Enter 提交点裸奔——中文拼音选字回车会发出半句话。已挂修复任务 | 极小,已立项 |
| 9 | **交付完备清单** | web-design "Ship complete"(loading/empty/error 态、键盘路径、lang、暗色持久化) | 逐条对我们的模板做一次体检,缺的补进模板本体(不是加验收门——模板是确定性件,补一次全场受益) | 小 |
| 10 | **思维链前台化** | penguin-sdk("silent 20-second wait reads as a hang";可折叠思考块、首个答案 delta 到即收起) | 聊天台模板:DeepSeek 推理流若可从 wire 拿到,渲染成可折叠灰块。装配侧已有直播台,这是交付 agent 的对位改进 | 中,看 wire 是否透出 |
| 11 | **信息缺口式演示** | examples/self-improving-agent 的 5+5 评分设计 | 我们对外 demo/正赛出题时采用:让"装配的增量"结构性不可绕过(如:验收标记依赖只有零件能取到的实时数据),归因干净,免判卷员扯皮 | 方法论 |
| 12 | **每 preset 凭证库**(host 台账) | .vault.toml 每 agent 作用域 + UI vault tab | 非 assembler 职权:记入给 DSH 的反馈清单——pending secrets 目前靠 host 全局 env,若 host 提供 per-preset vault(值注入零件子进程、不进上下文),我们的凭证契约闭环更顺 | 转述给 DSH |
| 13 | **窗口推导钳位** | llm/context-limits.ts 单常数派生 margin/floor/headroom | ai-call 零件现在是固定 floor 256;若配了 context_window 元数据,可换成窗口减估算输入的派生钳位。低优先 | 小,低优 |
| 14 | **goal 文件所有权倒置 + 终止纪律** | goal-loop/goal-file/goal-prompts(内核细读) | 无人值守车道(trigger 零件)的循环控制直接抄:系统只写一次后只读、模型是唯一写者(篡改无效因 objective 每轮从内存重注)、容错读一律归一为 blocked、`blocked` 须同一障碍连续 3 轮、预算耗尽先跑一轮收尾、"预算快完≠complete"完成审计、`[goal]` 块内自带注入守卫 | 中,P1 尾款配套 |
| 15 | **description 参数置首的流式标签** | 六个慢工具第一个参数强制 description("先发它,用户看得到") | emit_preset/verify 的参数体很大,工具卡在参数流完前是哑的;给我们的工具 schema 首位加一个 description/label 参数,DSH 前端能即时渲染动作标签(直播台之外的另一层) | 小,试点一个工具 |
| 16 | **档案化截断** | truncated-tool-output-archive(全量落盘、可见结果给路径、上限=read 上限−1 字节保 EOF 读) | 我们探针证据/工具回显若将来撞长度截断,采用"截断可见+全量归档+回传路径",别发明第二套取回协议;归档尾巴用环形缓冲 | 备用模式 |

## 确认项(我们已在做、不必动)

- **散文契约带代际/版本 + 消融裁决**:他们每个 skill 带 version+updated、release note
  追踪 prompt 长度;我们 CONTRACT_TAGS @gen + BARE 消融。同构,互为佐证。
- **独立考官是真差异**:他们初始化只有 builder 自查,重验收要手动起三件套(重型、
  按需);我们默认交付即独立验收。保持。
- **配方实例化 ≈ 零件化**:他们用"skill 内嵌成品代码"达到我们"模板零件"的同等
  效果——都否定了自由缝合。他们配方里的工程细节(空 tools 400、SSE abort、引用
  弹层契约)值得挑进我们前端/服务件的 smoke 与文档。
- **凭证不进上下文/不进盘**:同宗;他们 401/403 协议(重试至多一次 → 停手让用户去
  vault 改、"secret 永不贴进对话")与我们 SKIPPED+配置指引同族。
- **确定性流出模型**:他们 RAG 配方里检索是 app 代码、QA 会话 deny 全部工具调用——
  与我们泛化 agent 裁定(模型不是强制中枢)、book-intake 直传同一结论。

## 不学(明确否决)

- **builder 手写 agent 目录**:他们的机制就是手编文件;我们有供应链与出处闸,手编
  是违约。目录性质不同(他们=每用户私有 agent;我们=可交付供应链)。
- **0-100 细分评分做交付门**:交付门保持二值 PASS/FAIL+证据(诚实、无调参空间);
  分数只在未来优化循环里才有意义(见 #7)。
- **凭证先行、无 key 不开工**:他们"credential first, code second"适合"app 必须
  当场能答";我们"接口先就位、探针 SKIPPED、key 后补"更适合交付流。各归其位。

## 内核细读补遗(子 agent 全量走读 core/src 后修正与新增)

- **goal loop(无人值守形态)**:chat 会话每条消息一个 Task;goal 模式用 `for(;;)`
  自合成下一条用户消息,直到 `GOAL.yaml` 的 status ≠ active。控制面就两个字段
  `{objective, status}`。精髓:**所有权倒置**——系统创建时写一次,此后只读;模型是
  唯一写者且只许写 complete/blocked;系统侧终局(budget_limited/aborted)不落盘,
  文件里永远是模型自己最后的话 = 天然续跑点。终止五源里两处巧:轮间检查 abort
  (防"幽灵轮"的 [goal] 块串进用户下一条消息);max_turns 截停靠**最后一条**助手
  文本的 stop_reason 判(中途失败后恢复不算)。硬上限 100 轮兜底。
- **agent 定义的轴分离**:model(provider/model_id)**不属于** agent——agent 是行为
  规格,模型是会话参数。skills 不进 config(纯文件系统,注入只有 frontmatter 行,
  **没有 skill 工具**,模型用普通 read_file 读正文)。
- **kernel-update 三向合并**(默认值换代不踩用户改动):每片叶子算哈希对历史代际
  查——缺失→补新默认;等于任一历史默认→用户没改过→换新;其余→用户定制→保守
  保留。`tools.builtin` 按工具名逐个成叶,连"用户故意删掉的工具"和"当年还没有
  这个工具"都靠 `newInLatestGeneration` 区分。钉哈希测试在 build 时强制历史与
  现实一致。(对我们:preset 是发射物、手编即违约,不需要这套;但 DSH host 自身
  配置换代、以及知识包/目录默认值演化可参考。)
- **prompt 注入硬化一则**:四个 section 占位符(VAULT/SKILLS/MEMORY/SCHEDULES)
  **最后、单趟**展开——模型写进 memory 索引的内容永远没机会二次展开出
  `{{VAULT_KEYS}}`。我们的 persona/知识包渲染若引入占位符机制,须同款单趟纪律。
- **trace 工程**:append-only JSONL,一文件=一个完整模型上下文(压缩即 rotate)。
  每次追加=open(O_APPEND)+**单次 write(2)**+close,明确弃用 fs.appendFile(异步版
  >512KiB 分块,崩溃留半行→其后每条都粘在断行上,一次崩溃变级联);写前探尾字节
  自愈断尾。resume 只保证**结构合法**不保证字节复原:孤儿 tool_call 合成
  "[interrupted]"占位、孤儿 tool_result 丢弃(provider 会拒)。
  (自查:我们 progress.log/台账用 **sync** 小行追加,无此病;守住"行小"即可。)
- **工具面全录**:11 个内置(read/edit/write_file、exec/input/kill_command、
  run/input/kill_subagent、read_image|describe_image 二选一),**没有** grep/glob/
  web/todo/skill 工具,全走 exec_command。六个慢工具第一个参数是强制 `description`
  ("先于其它参数发出,用户在运行中看到")——利用 JSON 参数流式顺序做即时标签。
  exec 完成判据=前台进程退出而非管道 EOF(后台孙进程不挂工具);input_command 真
  往 stdin 打字,ETX 单独出现才转 SIGINT、混文本报错;子 agent 反着来:**运行中
  只许 poll**、空闲后才能续 prompt(同一子会话多轮)。后台任务完成以"harness 合成
  用户消息"送达,送达时才盖 delivery 戳(steering vs 独立开轮)——**这就是我们 P3
  发现的"会话结束≠工作结束"判据的产品化答案**。
- **服务端没有评测 runner**:benchmark-service 纯只读展示;跑分/记分全是 agent 照
  skill 干。usage 只存 token 不存成本,成本查询时按当前价目折算(历史成本会随
  改价漂移——我们台账存当时成本,取舍不同,各有道理)。

**两处关键软肋(借鉴时必须反着做)**:
1. **自进化的安全性质全靠散文**:"改前必须快照"只写在 skill 里,优化路径上没有
   任何代码调 ensureSnapshot;模型跳过指令 = 无快照覆写 agent_state。污染停机、
   版本号不复用同样只是散文。
2. **记分板聚合数字由模型手算、服务端信任且明文禁止复算**——一次算错或一个有
   动机的 agent 就能抬高门槛分让自己的候选被接受。这是他们自进化环里最弱一环。
   两条正好撞我们宪法第 5 条(安全往代码压):**我们借 #1/#2/#3/#7 时,快照、
   版本钉、聚合复算一律做成代码闸**,这是我们能"做得比他们好"的确定点。

## 竞对情报(一段)

产品成熟度高:桌面三平台+离线安装包、SQLite trace 索引、usage 时序图、按 (provider,
model_id) 计价、后台执行带 harness 注入完成报告(他们已解我们 P3 发现的"会话结束≠
工作结束"判据问题)、Project 级破坏性命令黑名单(每种审批模式下都拒)。Roadmap:
benchmark 套件公开、**Agent company and templates / Company-level self evolving**(多
agent 班子方向,与我们 FDE 车道将正面相遇)。基准主张(1/70 Claude Code 成本)套件
未公开,暂不可复核。
