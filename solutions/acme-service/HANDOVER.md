# acme-service 交付报告

- 客户:acme
- 方案版本:1.0.0
- 生成时间:2026-08-17T07:05:40.849Z
- 最近一次装配:2026-08-17T07:05:17.461Z

## 交付的 agent

| agent | 状态 | 零件数 | 验收 |
|---|---|---|---|
| acme-support-bot | 已装配 | 1 | PASS |
| acme-catalog-inspector | 已装配 | 2 | PASS |

## 部署参数

- `timezone` = Asia/Shanghai
- `language` = zh

## 待配置凭证

(本方案不需要凭证)

## 知识包

| 包 | 篇数 | 来源 | 版本 |
|---|---|---|---|
| acme-policies | 2 | ACME 客服中心知识库导出 | 2026-08 |

## 供应链清单(BOM 汇总)

| 零件 | 出处 | 许可 |
|---|---|---|
| petstore-demo | /api/v3 | Apache 2.0 |

## 重建方式

```bash
node scripts/solution.mjs apply solutions/acme-service/solution.yml --port <端口> [--param k=v]
```

同一方案交付给另一个租户:改 `--param`、配另一套凭证,零件与知识不变。
