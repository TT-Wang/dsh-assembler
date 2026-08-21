# 市场模拟战役台账 · 批次 1(2026-08-21 晚)

方法:36 个不看零件库、按市面主流需求设计的场景,经真实主 agent 对话路径装配,3 车道并发。
aux 档位 = off(迭代模式);选型质量类发现须用默认档复核一遍再定罪。
分类:A=assembler 内部 · B=主agent协同 · C=端到端质量 · D=性能 · E=产品缺口 · H=测试甲具自身。

## 金丝雀先行发现(s12 / s34,已实录)

- **F1(B,重)主 agent 对 FAIL 判决自作主张**:s12 首装 FAIL(自动验证如实报)后,主 agent
  ①换措辞重调 assemble → 需求文本变 → 同名判定失效 → 铸出 `xiangmu-kanban-2` 兄弟目录(-2 病借主 agent 还魂);
  ②第二装 PASS 后仍不满意名字,竟申请 `rm -rf ~/.dsh/.agent-presets/xiangmu-kanban` + 沙箱升权 → 审批挂死。
  病根:assemble 工具的 FAIL 结果没有给主 agent 行为规范(该转述什么、不该做什么);显式名撞不同概念时静默铸 -2 给了它动机。
- **F2(C,重)推导器把交付前端当 agent 可测对象**:s12 需求含"网页上直接操作",推导出"打开看板页面验证"
  的探针轮,agent 拿 browser-open 访 example.com 后问人"看板页面地址是什么"。UI 词已禁入标记、
  前端零件已排除出工具单,但**任务文本**仍会被 UI 需求带偏。需加规则:agent 的前端页面不是 agent 能测的东西。
- **F3(C)选型把"网页上操作"错配 browser-automate/http-request 零件**(看板台根本不需要浏览器)。
  待默认档复核后定罪级别。
- **F4(B,好行为记录)超模糊需求(s34)主 agent 得体反问**(多选澄清)——这是对的产品行为;
  但 ask 挂轮无超时,无人答就永远等(与探针问人同構)。产品层面可能需要 ask 超时或提醒机制(待议)。
- **F5(H)驱动器 v1 不会答澄清/不会撤审批**——已修(v2:答一次"你看着办"、见 approval/asked 即撤并 cancel)。

## 批次主表

见 campaign-report-b1.md(36 场景:23 PASS / 11 FAIL / 1 TIMEOUT / 1 反问挂起)。总墙钟 39 分钟(3 车道)。

## 全部发现(F1-F5 见上;证据在 results-b1/*.json 与 forensics/)

- **F6(B,重)义警修复全谱系**:FAIL 判决后主 agent 依次上演——改写需求重调 assemble(s12,铸-2)、
  `rm -rf` preset 目录+升权(s12)、edit 手改 preset persona(s01)、自行经 wire 重跑探针(s01)、
  拿缺件工单未经用户同意直接开工碰沙箱(s05)、**grep/read 装配器源码试图调试装配器**(s31/s32)。
  病根同一:assemble 的结果文本与工具描述没有给调用方 agent 行为契约。
- **F7(C)标记脆性**:发明 SLA 事实"24-48小时"(s01)、数量断言"急件1封"(s20)、发明日期"2025-06-"(s24)、
  代码碎片当标记"print("(s31)。需要机械标记消毒器 + 规则强化;off 档敏感性待复核。
- **F8(C)推导器发明日期**:s05"本周(03-09~03-15)"(现在是 8 月)→ agent 查无数据问人。规则:轮间引用只许用轮1造的 token。
- **F9(C)对话类场景独角戏化**:s18 接待场景没喂客户资料,agent 必须问人(判负)。规则:交互对象的资料必须内嵌在探针词里(探针扮演客户)。
- **F10 撤案**:结果文本模板字面量泄漏为误诊——那是主 agent grep 装配器源码的输出混进了工具结果(实为 F6 证据)。
- **F11(A,重)零件 cwd 病全家桶**:docx-generate `resolve(process.cwd(), savePath)` → 写进 host 检出目录
  (s23 实锤:「docx 生成工具的沙箱只能写入 …/deepseek-harness-rc8/PT-TERM-CHK」)。产文件零件 6 个
  (binary-write/barcode-generate/docx-generate/excel-read-write/pdf-report/pptx-generate),收路径零件更多。
  类修:发射端给每个 mcp 行注入 `PART_WORKDIR=<preset>/workspace`,零件路径解析统一以它为根。
- **F12(A)重试轮 JSON 解析崩溃**:s21「重试轮出错:Unexpected token '\`'」——模型回了 ```json 围栏,解析处没剥。
  类修:集中 parseModelJson(剥围栏/前后杂文)用于所有模型 JSON 出口。
- **F13(A/E)凭证声明缺失**:email-fetch/email-send 无 requiredSecrets(全目录仅 3 处声明)→ s20 凭证闸未触发,
  探针对着不存在的邮箱打真拳。类修:审计所有需外部凭证的零件补声明。
- **F14(C)匹配器缺口误报**:persistent-state-store(sqlite 就是)、term-glossary(文件/库就是)、
  structured-document-generator(docx/pdf 就是)、检索(fs-search 行就在目录,s28 没打中)、
  还发明 vendor 名 agently-mail-*。类修:选型 prompt 加"报缺口前先穷尽同义零件"纪律 + 补 tags。
- **F15(D)失控探针烧满预算**:s04 简历批量打分探针一轮吃满 600s×2(总 1223s)。规则:批量类探针 ≤3 件样本;
  预算维持 600s(合法重场景要用),靠尺寸规则治。
- **F16(B,小,好行为)**:s36 主 agent 自己剥了 api_key 才调 assemble(读了工具描述)——安全但未向用户解释;
  行为契约里补一句"剥除凭证须告知用户去 host env 配"。

## 修复方案(全类,今晚执行)

A1(F11) PART_WORKDIR 类修:发射端全 mcp 行注入 + 零件路径解析统一 + smoke 补测。
A2(F12) parseModelJson 集中剥围栏,替换全部模型 JSON 解析点 + 单测。
A3(F13) 凭证声明审计:email 两件必补,其余扫 process.env 用点逐一核。
B1(F1/F6/F16) 调用方行为契约:工具描述 + 结果文本双处落"该转述什么/不该做什么"。
B2(F1) 显式名撞不同概念 → 拒绝并给三选项(换名/--fresh 覆盖/不点名);--fresh+显式名 = 原地覆盖不铸-2。
C1(F7) 标记消毒器(机械):长度≥2、含内容字符、剔代码碎片;全剔则回退单轮重推。
C2(F8/F9/F2) 推导器规则三补:禁发明日期(轮间用 token 引用)、交互对象资料内嵌、交付前端不可测。
C3(F14) 选型缺口纪律 + fs-search/kb 条目补 tags(检索/知识库/RAG/引用)。
C4(F15) 推导器批量样本 ≤3 规则强化。
H1 驱动器已修(答澄清/撤审批)。
效果验收:重跑 11 个 FAIL 场景 + s04;然后批次 2 加难(边界→FDE 级 solution 整体交付)。

## 复验结果(修后重跑 13 伤员,干净地基)

8 转 PASS:s01(318→30)、s05(339→327)、s12(NO-RES→208)、s18(363→60)、
s21(139→48)、s23(378→118)、s24(405→135)、s32(268→591 但 PASS)。
4 仍 FAIL + 1 NO-VERDICT,二次定性:
- s04(简历打分)FAIL:首探仍引用不存在文件、重试探针踩空工作区,agent 不问人只硬试,
  烧满 600s×2。**根治:PROBE_TURN_BUDGET_MS=240s**(冒烟不是马拉松,失控从 10min 黑洞→4min 判负)。
- s28(知识库拒答)FAIL:标记「知识库中没有相关内容」测的是拒答,agent 换说法即假红。
  **根治:MARK_RULES 新规——拒答/否定类不可用固定话术断言,改测正向能力。**
- s20(邮件)FAIL:主 agent 走了 skill/agently-cli 老路没调 assemble——主 agent 路径习惯,非装配器缺陷(记录)。
- s31(公众号)FAIL:agent 分步作业("先验证再输出")没产出完整结果,探针只判终回复——模型行为(记录)。
- s34(模糊需求)NO-VERDICT:反问后主 agent 独角戏没调出 assemble——主 agent 路径(记录)。

净战果:装配器侧病全治;剩余 3 例是主 agent 对话路径习惯 + 模型分步行为,非 assembler 缺陷。
二次加固:PROBE_TURN_BUDGET_MS 240s + 拒答标记规则。
