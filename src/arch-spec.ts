/**
 * 架构 spec 的形状与探针草图的机械校验闸。
 *
 * 历史:本文件曾是"选型优先 vs 架构优先"的 A/B 实验模块(deriveArchSpec /
 * mapSpecToCatalog / spec_experiment 工具)。实验结论(2026-08-22,三例复杂
 * agent 实测)已落进宪法与 search 形态——架构师就是主 agent 本人,装配器只
 * 收它递来的 spec(orchestrated-tools 的 OrchSpec)。对照臂与实验工具随
 * pipeline 形态一并删除(宪法第八条,git 备查)。
 *
 * 留下的两件都是 search 形态的承重件:
 *  - {@link ArchSpec}:架构 spec 的完整形状(含探针草图槽);
 *  - {@link validateArchProbe}:编排者/架构师递来的探针草图过机械闸后直接
 *    构造 ProbePlan——省掉整段 LLM 探针推导;不合格返回 null,调用方回退
 *    考官自行推导,不冒质量险。verify_preset 的草图门就是它。
 */

export interface ArchSpec {
  purpose: string
  capabilities: Array<{ name: string; why: string }>
  dataModel: string
  workflow: string
  interfaces: string
  /**
   * 架构师顺手写的验收探针草图(确定性构造探针):架构师本来就在想 workflow,
   * 多写这四个字段边际成本几秒,却能省掉整段探针推导 LLM 调用。装配侧只做
   * 机械校验(validateArchProbe),不合格就回退 LLM 推导。
   */
  probe?: {
    kind: 'scenario' | 'single'
    /** scenario:轮1 建中心记录的完整指令(数据全内嵌,自给自足)。 */
    createTask?: string
    /** scenario:轮2 按 token 取回并报告的指令(不复述其余字段)。 */
    retrieveTask?: string
    /** 架构师发明的独特 token(如 INV-7781),两轮指令都要含它。 */
    token?: string
    /** single:一轮任务指令。 */
    task?: string
    /** 验收标记(1-3 个,内容型)。 */
    marks?: string[]
  }
}

/**
 * 架构探针草图的机械校验闸:合格 → 直接构造 ProbePlan(省掉整段 LLM 探针推导);
 * 任何一条不过 → null(调用方回退 LLM 推导)。校验的每一条都是战役里真踩过的坑:
 * 标记消毒(代码碎片/过短)、token 自给自足(两轮指令都得含它,轮1 造它轮2 用它)、
 * 取回轮不许复述标记值(否则 agent 照抄指令就能假 PASS,共享探针同款教训)。
 */
export function validateArchProbe(probe: NonNullable<ArchSpec['probe']>, sanitize: (marks: unknown[]) => string[]): import('./verify.js').ProbePlan | null {
  const marks = sanitize(probe.marks ?? [])
  if (marks.length === 0) return null
  if (probe.kind === 'single') {
    const task = (probe.task ?? '').trim()
    if (task.length < 10) return null
    return { kind: 'single', probe: { task, mustInclude: marks } }
  }
  const createTask = (probe.createTask ?? '').trim()
  const retrieveTask = (probe.retrieveTask ?? '').trim()
  const token = (probe.token ?? '').trim()
  // 15:自给自足的建档指令(含内嵌数据)不可能更短——更短的多半是残缺草图。
  if (createTask.length < 15 || retrieveTask.length < 10 || token.length < 3) return null
  // token 自给自足:轮1 造它、轮2 按它取——两轮都必须真含 token。
  if (!createTask.includes(token) || !retrieveTask.includes(token)) return null
  // 取回轮不许把标记值(除 token 本身)复述在指令里:否则照抄即假 PASS。
  for (const m of marks) {
    if (m !== token && retrieveTask.toLowerCase().includes(m.toLowerCase())) return null
  }
  return {
    kind: 'scenario',
    scenario: {
      goal: '架构直构:主工作流建档→取回(token 连续性)',
      turns: [
        { prompt: createTask, mustInclude: [token] },
        { prompt: retrieveTask, mustInclude: marks },
      ],
    },
  }
}
