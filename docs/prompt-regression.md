# 契约文本回归程序(阶段 1 ② + ROADMAP v2 P0 增补)

## 门 0|换模型代的消融仪式(P0 增补——"删"的半边)

契约散文是易腐品(Boris:三个月前为某模型写的东西下一代可能完全不迁移;本季
自证:每次做减法都赢)。制度:
1. 每条散文常量在 CONTRACT_TAGS 登记**适用模型代**(现全部 `deepseek-v4`);
2. **换模型 = 全部散文默认到期**。先跑消融轮:`DSH_ASSEMBLER_BARE=1` 起 host
   (剥净全部契约散文,只留代码闸与事实输出),8 场景战役 vs 现契约对照;
3. BARE 不掉的散文捆 → 删;掉的 → 保留并把 CONTRACT_TAGS 改成新模型代;
4. 报告进 bench/results/,负结果照发。
注:当前是捆级消融(整捆散文 on/off);逐句消融待 eval 甲具支持逐句开关。

装配器的行为一半住在代码里,一半住在**契约文本**里(工具描述、结果接力棒、
承重规则句)。代码有 13 套件把门,契约文本从今天起也有两道门——"改了就信"结束。

## 门 1|承重句钉(每次 npm test 自动跑)

承重契约句集中定义在 src/orchestrated-tools.ts 顶部的导出常量
(BASELINE_RULE / MINIMAL_SET_RULE / FRONTEND_FACT / PROBE_SKETCH_EXAMPLES),
工具描述与结果文本从常量引用;tests-orchestrated.mjs 的「契约钉」组断言每句的
关键负载还在。**改契约掉了哪句,套件立刻红**——防的是"顺手润色把实证过的
规则润没了"(C 臂教训:文本约束本来就弱,弱约束再被悄悄删掉等于没有)。

新增承重句的纪律:先有战役/文献出处,再进常量,再加钉。

## 门 2|措辞变更的实测 A/B(手动,改承重句必跑)

钉只保证"句子在",不保证"句子有效"。改动承重句措辞、或新增/删除承重句时:

1. 基线:bench/results/ 里最近一轮确认数据(当前 = 2026-08-23 forms-bcdf F 臂);
2. 起一台改后构建的 host(DSH_ASSEMBLER_MODE 缺省即检索形态);
3. `node bench/run-orch.mjs bench/ab-scenarios-armB.json <outdir> 1 '' <port> <label>`
   跑 8 场景(场景集与历轮同源,name 前缀换新防复用污染);
4. `node bench/sweep-forms.mjs 新=<outdir> 旧=<基线dir> out.md` 出五维对比;
5. 判读四门:PASS 率不掉、零件数 5-8/场、墙钟同级、草图过闸率不掉。
   任一门掉 → 措辞回退或继续迭代;过 → 数据落 bench/results/<date-label>/,提交。

方法论出处:sliceagent evals/prompt_ab(改 prompt 必须量化验证);本仓库已用
同款流程跑过三轮(A/B、四臂、确认轮),驱动与对比器就是现成甲具。
