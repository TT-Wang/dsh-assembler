# 待办账本(2026-08-25 结算)

> 本文件是活账本:开工即改状态,完成即划掉并注明战役/commit。排序 = 杠杆,
> 不是时间。ROADMAP.md 管方向,本文件管队列。

## 已完成基线(免得重复造)

配方车道(rag-qa/record-desk/scaffold-react)· 双面化四件套(sqlite 服务脸/
记录配方/app↔agent 交接考/cron-trigger)· SDK 蒸馏 · scaffold 五门 + 行为考 ·
写手席接轨(WRITE-ME/接力棒/deploy_app,真会话 406s 一把过)· 零件分类法 ·
采购地图 · penguin 调研。

---

## P1|检验刚建成的东西(最高杠杆:未经压测的车道等于没建成)

- [ ] **app 三档泛化战役**(一晚):同一批需求分三档出题——①槽内(配方直接覆盖)
      ②形内变体(必须写页/改造)③形外(应被诚实劝退到写码或造件)。量:形状贴合度、
      墙钟、门失败分布、路由标注正确率(face/wire 该分的分了没)。**这是 scaffold
      泛化断点的实测,也是 vs Lovable 正赛的资格赛。**
- [ ] **三岔口契约句回归**(半晚,与上条同轮):ARCHITECTURE_CONTRACT 的 app 分支
      (先配方→次服务件→劝退)与 SCAFFOLD_BATON 都是新承重句,按 prompt-regression
      程序在战役轮里验;顺手把"三岔口"改写为"流谱分解 + 形态投影"(公理落地到契约)。

## P1.5|机械闸:契约要求的事,必须有够得着的手

- [x] **车道闸**(2026-08-25,4df48d4):装 frontend 模板 = 交付 app 形态 → 没有
      `lane` 一句话声明就拒印;同分排序改按交付完整度(配方先于模板);检索榜算出
      车道分叉行。**实测收益不是纠正 agent,是把它的理由逼进 BOM,从而露出我考卷
      的病**(A 档 3/3 的拒绝理由都是题面那句"preset 名用 X")。
- [ ] **死知识闸**(下一件,同形状):`knowledgeLocatorText` 明写"直接读文件即可",
      但发射时**没有一处检查交付 agent 是否挂了能读它的零件**。A1 实录:装了知识包、
      没挂 filesystem → 交付出去的 agent 当场向用户求助「本会话无法读取手册文件」,
      探针判 FAIL;agent 第二版自己补挂 filesystem,还在 persona 里加了一句"本会话
      拥有读文件工具,不存在无法读取"——**用散文压物理缺件**,正是刚判定无效的那种修法。
      修:装了 knowledge 包却无任何读取面 ⇒ emit 拒印(或自动补挂),照 `CONTRACT_ACTIONS`
      同款机械对照表。
- [ ] **战役不许污染产品目录**:`add_knowledge` 直接写共享 `capabilities.yml`,于是
      四包战役语料(虚构的"星轨 X1 净水器手册")长期躺在目录里当能力卖——已清理
      (2026-08-25),但机制没修。修法照 `claimApps` 的**按绑定认领**:知识包的
      `source` 已进索引报告,战役清场按"source 在本战役语料目录下"回收,不靠名字猜。

## P2|把已建成的铺满(存量收益,不改架构)

- [x] **ai-thin 路由实装**(2026-08-25):ai-call 长服务脸(POST /complete,双脸
      共用同一段实现)+ SDK 双版 `aiFace()` + behavior 考 ai-thin 执行器(缺 key
      SKIPPED)+ WRITE-ME 四档路由判据。smoke 8/8。
- [x] **公共文件通道**(2026-08-25):新件 `file-channel` 入库(直传/取回/列目录/
      删除 + 服务脸,穿越拒绝、64MB 上限、字节逐位一致 smoke 10/10);SDK 双版
      `filesFace()`;file-desk 模板接上直传卡。
- [x] **触发考升格一等工具**(2026-08-25):`verify_trigger`——像 cron 到点那样
      经 wire 打一发(带无人值守纪律头),**不看回复**、轮询服务脸验落库效果;
      闸门:口令须在任务里 / effectSql 只读 / expect ≥4 字符。实测 3s PASS。
- [x] **判断器双脸制度化**(2026-08-25):机械钉——两张配方的 app 镜像
      (lib/ai.mjs)与 ai-call 零件守同款纪律(key 只从 env、maxTokens 地板 256),
      改一处两边红。
- [~] **剩余 4 张模板迁 SDK**:file-desk 已迁(并接直传);chat-console 已补 IME
      守卫、其余保留内联(测试钉允许"SDK 或内联"两形态);两张 reader 页留待与
      book-intake→file-channel 合流时一并处理。
- [ ] **README 用户切片更新**(小):配方车道 + scaffold 车道 + 双面交付进 README
      (中英),仍守"无内部实验细节"纪律。

## P3|penguin 吸收(证据链纵向化,三便宜活)

- [ ] **selfcheck 升版本记分板**:每次同名重发/零件升级后复验追加一行(时间/
      EMISSION_REV/preset 字节哈希/verdict/墙钟/成本/session id)——第 30 天故事
      的纵向台账。**聚合数字由代码算,不由模型写**(反着做他们的软肋)。
- [ ] **验中版本钉**:verify 开跑前记 preset 字节哈希,结束后重核,不一致判
      verdict 无效(防并发装配互踩)。
- [ ] **同名重发前快照**:旧 preset 原子归档进 `<preset>/snapshots/`,FAIL 一键
      回滚;**快照由代码强制,不靠散文**。
- [ ] 设计注记(不动代码):任何未来"按体检包自我改进"的流程**禁读 selfcheck 标记
      原文**(Goodhart 防线),或标记转私有由考官持有。

## P4|采购(库存生长,三级采购已定策)

- [x] **adopt 门**(2026-08-25):`index-add.mjs adopt <npm-pkg> [--probe tool:json]`
      ——装包锁实际版本 → 找包内 bin → **独立实探 listTools + 真调一发**(报错即拒)
      → 出处链(adopted/pkg/rev/repo/license)→ register 直接可用。首收
      `kg-memory`(官方知识图谱 server,9 工具,v2026.7.4)。
- [x] **头部缺件采购完成**(2026-08-25,7 件入库,`bench/verify-faces.mjs` 按脸
      验收 12/12):`speech-io`(TTS 零凭证真出音频 + ASR 凭证契约 + 服务脸传字节)·
      `vector-store`(本地向量索引,跨进程持久,服务脸零模型语义搜索)· `embed-text`
      (OpenAI 兼容嵌入,凭证契约)· `translate-text`(MyMemory 免费,真调双向)·
      `route-plan`(OSRM 真调,北京→天津 125km 量级正确)· `im-bot`(企微/钉钉/飞书
      群机器人,mock 真推 + 钉钉加签)· `object-store`(S3 兼容,presign 直取,
      凭证契约含"半配置也拒")。**采-vs-造 诚实记录**:npm 上这批缺件没有可采的
      成品 MCP server(TTS 只有库、IM 只有需凭证的第三方件),故走"造";
      `node-edge-tts`(库)与 `minio`(库)是借来的实现,出处已入 BOM。
- [ ] 下一批候选:日历写入(CalDAV)· Notion/飞书文档写 · 快递物流 · A股行情
      (前两者需凭证,后两者上游质量待评估)。

## P5|产品体验与迭代回路

- [ ] **页面级迭代**(一晚):页面同名重发(字节台账已支持 no-op)+ 消息锚定版本卡
      + FAIL 一键回滚——把最小变更单位从"整 preset 重装"降到"一条消息"。
- [ ] **sessionProjections 替轮询**(小):装配直播台 `_console` 现为 2.5s 轮询,
      改注册投影拿推送通道(宿主现成能力,白捡)。
- [ ] **独立态 scaffold**(中):scaffold 产物配自带 server(record-desk 式),
      交付给不装 host 的客户。

## P6|正赛(证明层)

- [ ] **P3 战③ vs Lovable**(需你定形式与预算):同题 app 需求对打,量形状贴合、
      验收覆盖、迭代成本、毕业成本。地基已备(scaffold+配方+行为考)。
- [ ] **第 30 天 app 版**:app 形态的生命周期战(需求变更序列 → 页面级重发 vs
      重新生成),复用第 30 天方法论。

## P7|远期/条件触发

- [ ] **装配器 MCP 化**(P4 老条目):三工具+考官打包成 MCP server,任何 harness 可用。
- [ ] **DOM 层考**(已知诚实缺口):puppeteer 零件补"DOM 事件→SDK 调用"那一跳。
- [ ] **规模触发**(挂条件):目录 >2000 条 → 向量混合召回 + match 复活为精排。
- [ ] **移动车道**:Expo CNG 对齐(app-shell + config-plugin + EAS 零件)。

## 等用户(我做不了)

- [ ] **重启 3096**(你的主 host 仍是旧构建:无 `/.service` 路由、无 scaffold 工具面)
- [ ] **真凭证端到端**:按 docs/live-credential-e2e.md 配 env 后扣扳机
- [ ] **Lovable 正赛**:真 Lovable 账号对打 vs 开源复刻预赛,以及预算口径
