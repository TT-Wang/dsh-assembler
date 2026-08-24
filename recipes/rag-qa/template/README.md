# 知识问答 app(由配方 rag-qa 实例化)

零依赖 Node 应用:本地检索(BM25,中英混合)+ DeepSeek 流式回答 + 可核引用。

## 运行

```bash
export DEEPSEEK_API_KEY=<你的 key>   # 只进环境变量,不写任何文件
npm start                            # 默认 http://127.0.0.1:4630,PORT 可改
```

没配 key 也能起:检索与引用照常,提问会收到配置指引。

## 换语料

把 md/txt/html 放进 `corpus/`,然后:

```bash
npm run ingest    # 重建 data/index.json
```

## 结构

- `server.mjs` 服务:`/api/ask`(SSE 流)、`/api/meta`、`/corpus/*` 原文、`/healthz`
- `ingest.mjs` 语料切块入索引(确定性,可重复跑)
- `lib/search.mjs` BM25 检索;`lib/ai.mjs` DeepSeek 流式调用
- `app.config.json` 实例参数(标题/角色/示例问题);`recipe.lock.yml` 配方出处与验收考题
