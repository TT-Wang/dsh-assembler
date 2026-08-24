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

## P2|把已建成的铺满(存量收益,不改架构)

- [ ] **ai-thin 路由实装**(半晚):页面的薄判断("午饭32"式解析)直连 ai-call 的
      服务面,不再借道 wire;PAGE-SPEC 的 `route: ai-thin` 从留档变成真路由,
      behavior 考补对应执行器。
- [ ] **公共文件通道**(一晚,分类法欠账②):book-intake 泛化为 `file-channel`
      (上传/下载/列目录),17 件字节口零件一次受益,页面喂文件/取文件不过模型。
- [ ] **触发考升格一等工具**(半晚):现为战役脚本形态 → `verify_trigger`
      (打一发 + 验后果),无人值守形态的第四格考官补齐。
- [ ] **判断器双脸制度化**(小):ai-call 的 app 镜像(配方内 ai.mjs)登记为目录
      里成对工件,改纪律两边同步。
- [ ] **剩余 4 张模板迁 SDK**(小):chat-console/file-desk/bilingual-reader/
      reader-upload-web-ui(现仅 chat-console 补了 IME 守卫)。
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

- [ ] **adopt 门**:`index-add.mjs adopt <npm-mcp-package>`——收编现成 MCP server
      (装包锁版本 → 嗅探 listTools → smoke → 凭证声明 → 条款登记),省写胶水。
- [ ] 头部缺件按序采购:**TTS/ASR** → **embedding+向量检索**(兼作目录规模化前置)
      → **S3 兼容对象存储** → **日历写入** → **企微/钉钉**(国内交付刚需)→ **翻译**
      → Notion/飞书文档写。每件走"采→转→造"三级,能采不造。

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
