# DSH rc.8 → 0.1.2-alpha.2 同步与迁移底册(2026-08-31)

> 情报官全量考据 + 本机实弹验证(协议已打通)。一句话总判:**换血不换骨**——
> 六承重面里五面不变或利好,唯 wire 一面整体重铸(alpha.1 分水岭;0.1.1-rc.2
> 是旧 wire 末班车)。业务判定逻辑(按 label 代答/turn-end 计数/动用率聚合)
> 全部可原样保留,迁移成本集中在传输层。

## 一、已完成的本机同步(2026-08-31)

拉取 +14450 提交 → pnpm install → **`pnpm run clean && pnpm run build`**(必须:
增量 tsc 留 rc.8 孤儿 lib/types/*.js,tsdown 照收报 14×MISSING_EXPORT;且 alpha.2
启动强制要求 web 客户端 bundle)→ profile 的 dsh-better-sidebar 升 0.18.0-alpha.0
(旧版 import 已消失的 CallId)→ **host 3097 在 alpha.2 上运行,dsh-assembler
全测试链(32+ 钉)对新类型面直接全绿**。战役 cron 残留 4 条已回收。

## 二、新 wire 协议(全部实弹验证过的配方)

- **鉴权**:抓 host stdout `dsh web: <URL>?token=…` → `GET /?token=…`
  (redirect:manual)→ `set-cookie: dsh-auth-<authority>=v1....`(30 天,HttpOnly;
  **cookie 名含 `=`,curl jar 存不了,手动带头**)。回环不豁免;/api 与
  remote.mux upgrade 同过此闸。
- **一元 RPC**:`POST /api/<namespace>/<method>`(斜杠制);信封仍
  `{type:'client-request',rpcId,method,payload}`,但 payload **双包裹**
  `{args:{request:{…}}}`。实测:`session/create` `{args:{request:{cwd}}}` →
  `{sessionId,agentPreset}`;`session/prompt` 新必填 **requestId**(客户端自铸),
  回执 `result.value={accepted:true}`,拒收走 `result.error{code,message,details}`。
- **事件流**:`ws /api/remote.mux`,逻辑流:client `{type:'open',streamId,endpoint,
  payload}` / server `{type:'item'|'error'|'end',streamId,…}`。
  - `endpoint:'session/follow'`:首帧 snapshot{cursor,records,projections},后续
    `{type:'event',event:{type,seq,time,data,ignorable?}}`——**事件带 seq,
    turn/end 改锚 seq 计数,迟到帧问题协议层消失**;断线按 last-seq 恢复。
  - `endpoint:'session/control'`:`{type:'projection',sessionId,key:'tokenUsage',
    value,seq}`(基线帧 type:'baseline')。
  - **问答代答**:open `endpoint:'$events'` → 首帧 `{type:'ready',clientId}`;
    问题为 waterfall 帧 `{type:'waterfall',event:'user-questions/request',eventId,
    agentId,request:{questions}}`(**agentId===sessionId**);应答
    `POST /api/$events/result` `{args:{clientId,eventId,outcome:{kind:'result',
    value:{answers:[{id,selected:[label],custom?}]}}}}`——答案项形状原样。
    **approval/request 走同一条 waterfall**(探针可程序化审批,新考卷面)。
- 参考真迹:`apps/web/tests/smoke-real.e2e.ts:36-96`。

## 三、六承重面判决(细节见情报官报告原文,已并入本文关键处)

| 面 | 判决 |
|---|---|
| wire | **重铸**(见上);tool/call data `{turn,step,callId,name,arguments}` 与 turn/end `{turn,reason}` 形状不变 |
| 插件挂载 | 不变:cordis.patch.yml 机制/inject/defineTool 原样;cordis 4.0.2 仅版本号,**tsx 从检出根启动之法照旧**;web profile patchReload=live(改 patch 免重启,改 lib 仍需) |
| preset | 演进利好:目录约定/每调用重扫不变;**挂载改每会话 scope,serverName 预留按 scope 释放——「host 永不释放旧 serverName」旧物理作废**(字节代际后缀无害可留);新挂载守卫:发布进 ROOT realm 的行拒挂;session/create 可带 agentPreset |
| llm | 不变:ctx.llm.stream/GenerateOptions/agentDefaultModel.currentSelection 全在;默认 deepseek-v4-flash 不变 |
| 凭证/env | 擦除逻辑一字未改(readSecret 约定安全);**新雷:`$DSH_HOME/.env` 出现 DSH_*/XDG_*/PATH/NODE_*/GIT_*/代理/DEEPSEEK_BASE_URL/SSL_* 即拒启**——DSH_ASSEMBLER_* 只能 shell export(本机 .env 已核干净,仅 DEEPSEEK_API_KEY) |
| webServer | 注册面不变(register/registerUpgrade/registerFallback);/assembler/ui/* 照挂;但页面里的 wire 调用连带整改,且浏览器需 30 天内开过一次 ?token URL |

其余:SQLite 会话库 schema 19→20 且预发布格式拒读不迁移(3096 重启看首启报错,
必要时换新 $DSH_HOME 或清会话库);`ignorable` 事件字段经 revert 战保住,上游
注记明言为外部插件护城。

## 四、受影响的我方代码(迁移工单 = BACKLOG 0.9)

1. **src/verify.ts 的真会话探针**(openProbeSession/sendTurn/问答代答)——
   **alpha.2 上 verify_preset 的 wire 探针不可用直到迁移**(face/装备/前端门不受
   影响;verify_app 六门里仅 wire 动作受累)。
2. src/frontend.ts 模板页的会话调用(chat-console 等)。
3. bench 三驱动器(run-generalization / run-proving / run-writer-seat)。
4. scripts/index-add.mjs auto 路。
   业务层零改动;传输层建 **一份共享 wire 客户端**(cookie/RPC/流/代答)四处复用。
   备选:SDK/ACP stdio profile 无 cookie 无 WS,但 initialize 尚无 agentPreset 口。

## 五、3096(生产 host)重启操作卡

1. `cd /Users/tongtao/code/deepseek-harness-rc8`(必须检出根,tsx 靠根 tsconfig)
2. 已由本次同步完成:pnpm install、clean+build、sidebar 0.18.0-alpha.0、.env 体检
3. 停旧 → 原命令启动 → 首启盯 session-persistence 报错(schema 20)
4. 浏览器开一次启动行的 `?token=` URL(30 天 cookie)
5. 注意:verify_preset 的 wire 探针待 0.9 迁移;其余装配功能可用

## 实测发现的 alpha.2 UI bug(2026-08-31,浏览器 DOM 验尸)

新 web UI 的 markdown **表格渲染成空壳**:agent 回复含表格时,DOM 里 `<table>`
存在但 1 行 0 单元格、高度 0(V1MMBW_tableWrap 内),页面呈现为大段空白——
渲染器对某种表格语法变体静默吞掉且不降级为文本。复现:任意让 agent 用 markdown
表格作答。规避:提示词里叫 agent 用列表不用表格。值得报上游。

## 六、白捡新能力 Top5(后续吸收议程)

seq 化事件流(探针台账记 seq 区间)· approval waterfall(需审批零件进考卷)·
session/modelCatalog+selectModel(aux 模型不再硬编码)· SDK/ACP stdio 三 profile
(CI 车道免 cookie)· 设置页按 preset 分组+坏行显示(发射物原生展销面)。
另:官方 schedule 已覆盖 dsh-cron 职能(退役评估,等用户);Code Mode/PTC 与
多供应商 subagent(Claude Code/Codex 当零件)是装配语言的新可组合面。
