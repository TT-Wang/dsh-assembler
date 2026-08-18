# chart 多序列(series)字段勘误

> 出处:@omdsh-dev/dsh-genui@0.8.7 的 `src/client/spec.ts`(SKILL.md 只说"series
> 字段 = 分组柱状图",没有给出条目字段名;实测用错字段名时折线图渲染为空坐标轴,
> 且 validate_dsh_ui 不报错——所以这一页必须逐字写清)。

chart 的 `series` 数组里,**每个序列条目的字段是**:

```json
{"type":"chart","kind":"line","title":"...","series":[
  {"label":"最高温","color":"#f97316","data":[{"label":"8/18","value":23.6},{"label":"8/19","value":26.2}]},
  {"label":"最低温","data":[{"label":"8/18","value":21.7},{"label":"8/19","value":21.3}]}
]}
```

三条硬规则:

1. 序列名的字段叫 **`label`,不是 `name`**——写 `name` 折线画不出来(空坐标轴),而且 validate 不会拦你。
2. 每个数据点必须是 **`{"label":"...","value":n}` 对象**,不能是裸数字数组;规范里没有顶层 `labels` 字段,x 轴刻度就来自每个数据点自己的 `label`。
3. 单序列直接用顶层 `data` 字段即可;`series` **只对 `bars`(分组柱状)有效**(见下节),用了 `series` 就不要再放顶层 `data`。

## line 不支持 series(0.8.7 实测,渲染器源码确认)

`LineChartNode` 只读**顶层 `data`**,`series` 字段对折线图完全无效——写了 series 的
line 图会渲染成一张只有坐标轴的空图,且 validate_dsh_ui 不报错。`series` 只对
`bars`(分组柱状)生效。

要画多条趋势线,可用的两个形状:

1. **拆成多张单序列 line 图**(每张用顶层 `data`),标题里写清是哪条序列;
2. **一张 `bars` 分组柱状图**(series 合法),同一天的两根柱并排,对比更直观。

```json
{"type":"chart","kind":"bars","title":"未来7天高低温(°C)","series":[
  {"label":"最高温","data":[{"label":"8/18","value":23.6}]},
  {"label":"最低温","data":[{"label":"8/18","value":21.7}]}
]}
```
