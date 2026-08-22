# 战役续 · #1 共享数据探针 + #2 缺件工单自主闭环(2026-08-21 深夜)

用户 /goal 续:做 #1(方案级共享数据探针)和 #2(缺件工单自主闭环),再做 #3。

## #1 方案级共享数据探针 —— FDE 天花板最后一环闭合

**缺口**:FDE 此前只证到"结构共享"(各 agent 的 SQLITE_DEFAULT_DB 钉到同一文件),
没证"数据真流动"。**补**:`deriveSharedDataProbe`(快模型设计跨 agent 写→读交接、
发明独特 token)+ `runSharedDataProbe`(writer 会话写→reader 会话读→判 reader 回复
含 token,两会话绑不同 preset 但同一共享库)。装完所有 agent、声明共享库、≥2 agent
可挂载时自动跑,结果进 sharedDataCheck + solution.yml + HANDOVER。

**首跑暴露派生器缺陷**:让对账 agent 读"库存"(共享表只有 products/orders)→ reader
找不到中途求助 → 假红。两道闸根治:派生 prompt 立铁律(锁定 ONE 共享表,writer 写、
reader 读同一张表的同一行)+ table 字段校验(选的表必须是声明的共享表之一)。

**复跑 PASS(实锤)**:HANDOVER 写下「共享验收 ✅ PASS — recon-agent 读到了 cs-agent
写入的记录(cs-agent 写 → recon-agent 读)。班子确实读写同一份账,不只是各库钉到
同一文件。」黑盒证明数据在两个独立 agent 间真的流动。

## #2 缺件工单自主闭环 —— "自愈"是真能力(超出预期)

**问题**:gpx-parse 那次照工单造件是**我手动**扮演主 agent 做的。真主 agent 能自己
跑通"报缺→造件→入库→重跑"吗?我预判会撞沙箱审批墙。

**观察驱动器**(run-closure.mjs):发需求→若带工单,追一句"照工单造件入库重跑,放手做"。
两个必然缺料场景:
- g01(ical 订阅):gap=false——目录已有 calendar-parse 覆盖(目录够丰富,非缺口)。
- **g02(短信网关):gap=true → 主 agent 42 条 bash,零审批墙,全自主闭环**:
  - 造出全新零件 `generated/sms-gateway/`(3 工具:sms-send/delivery-status/provider-info,
    阿里云+腾讯+通用+mock 四 provider,HMAC 签名,凭证全走 env)
  - 过 verify 质检门(独立复跑 smoke ALL PASS)
  - register 入 capabilities.yml + index/catalog.yml,凭证声明合宪(8 个 env,无一当参数)
  - **重跑 assemble,工单清理,"闭环完成 ✅"**,末尾给凭证配置指引

**结论**:缺件自愈是端到端真能力。sms-gateway 作为主 agent 自主产出的正经零件留在
仓库(过全套 10 套件 + 独立 smoke),是这条能力的活证据。审过零件代码:标准 MCP
结构,无 exec/spawn/eval,只读 env——干净。

## 待办

#3(再跑一批更狠的压测)——用户排在 #1#2 之后。