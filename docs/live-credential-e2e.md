# 真凭证端到端验收(阶段 1 ③)——runbook

现状:所有外部服务零件(短信/邮件)的装配验收都停在「待配置凭证 SKIPPED」——
装配正确性已证,**真的能发出去**从没证过。这是生产可用的最后一公里,且只有
持有凭证的人能扣动扳机。装配器侧一切就绪,本文是那次扣扳机的完整步骤。

## 你要提供的(值不经对话、不进文件,只进 host 环境)

任选其一即可开跑:
- 短信(阿里云):SMS_ALIYUN_ACCESS_KEY_ID / SMS_ALIYUN_ACCESS_KEY_SECRET /
  SMS_ALIYUN_SIGN_NAME / SMS_ALIYUN_TEMPLATE_CODE
- 短信(腾讯云):SMS_TENCENT_SECRET_ID / SMS_TENCENT_SECRET_KEY /
  SMS_TENCENT_SDKAPPID / SMS_TENCENT_SIGN_NAME / SMS_TENCENT_TEMPLATE_ID
- 邮件:SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS(发)、IMAP_* 同型(收)

写进 `~/.dsh/.env`(DEEPSEEK_API_KEY 已在里面,同一通道),重启 DSH host。
机器纪律(已由代码锁死):凭证值永不进 preset/BOM/对话;零件从自己进程 env 读。

## 步骤(约 10 分钟)

1. 配好 env、重启 host(检索形态,默认即是);
2. 对主 agent 说:「装一个提醒 agent:我给一句话和手机号/邮箱,它立即发出提醒
   并把发送记录落库可查,名字 live-cred-e2e」;
3. 主 agent 走 search→emit→verify;此时凭证已在,verify **不再 SKIPPED**,
   探针真实发送(发给你自己的号/邮箱)并回查发送状态;
4. 验收 PASS 标准:你的手机/邮箱**真的收到**探针内容 + 探针回查到 delivered
   状态 + 发送记录在库。三者齐才算最后一公里打通;
5. 结果(含 verify 结果全文与台账行)拷进 bench/results/<date>-live-cred/。

## 已知边界

- 探针会真实发送 1-2 条:用自己的接收端,别写客户号码;
- 模板类短信(阿里/腾讯)要求内容匹配已备案模板——探针标记应取回查状态字段
  (delivered/message-id),不要标记短信正文;
- 失败最常见三因:签名/模板未过审、发送频控、地区限制——都属服务侧配置,
  与装配无关,verify 的证据会把它们和装配缺陷区分开。
