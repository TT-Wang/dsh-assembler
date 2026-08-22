/**
 * 能力目录:选型前的确定性粗筛器(两阶段选型的第一阶段)。
 *
 * 病灶(用户 2026-08-22 指出):选型把整个目录(~230 个能力)全文塞进 prompt,
 * 满档一次推理 225s——又慢又噪。先例(retrieve→rerank,"Tools Are Not Islands"
 * 的 set-level 检索)给的方案:先粗筛出相关子集,LLM 只在小集合上精选。
 *
 * 设计裁定:走 lexical(tags 倒排 + 打分),不上 embedding——230 规模 lexical
 * 毫秒级够快,tags 是人工标注的强信号,确定性可单测可解释,且 DeepSeek 的
 * embedding 端点可用性存疑。规模真涨到几千再上向量。
 *
 * set-level 落地:archSpec 的每个架构需求单独当 query 召回 top-M,并集去重
 * ——保证每个需求的最佳候选都进小集合,不被全局分挤掉(否则某需求的唯一匹配
 * 被压掉 = 假缺口)。数量少的架构类(persona/前端/状态)全保留,只粗筛量大的
 * mcp 工具。粗筛是加速器不是过滤器:召回优先,K 给足,可关(DSH_ASSEMBLER_SHORTLIST=0)。
 */
import type { CapabilityEntry } from './index.js'

/**
 * 中英混合分词:英文/数字词(长度≥2)+ 中文 2-gram。
 * 中文用 bigram 而非单字——单字太泛("单"匹配一切),bigram("审批")才有区分度。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  // 英文/数字词
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) out.push(m[0])
  // 中文连续段 → 2-gram
  for (const seg of text.matchAll(/[一-鿿]+/g)) {
    const s = seg[0]
    if (s.length === 1) continue
    for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2))
  }
  return out
}

/** 一个能力的词袋:tags 展开的词(高权)+ description 的词(低权)。 */
interface DocTokens {
  id: string
  tag: Set<string>
  desc: Set<string>
}

function buildDoc(c: CapabilityEntry): DocTokens {
  const tag = new Set<string>()
  for (const t of c.tags) for (const tok of tokenize(t)) tag.add(tok)
  const desc = new Set<string>()
  for (const tok of tokenize(c.description ?? '')) desc.add(tok)
  return { id: c.id, tag, desc }
}

/** 一个 doc 对一个 query 词袋的打分:tag 命中×3,description 命中×1。 */
function score(doc: DocTokens, queryTokens: readonly string[]): number {
  let s = 0
  for (const qt of queryTokens) {
    if (doc.tag.has(qt)) s += 3
    else if (doc.desc.has(qt)) s += 1
  }
  return s
}

/** mcp 判定:量大的库型/服务型工具,粗筛主要压的就是它们。 */
function isMcp(c: CapabilityEntry): boolean {
  return c.via === 'mcp'
}

/**
 * 粗筛:返回喂进选型 prompt 的候选 id 集。
 *
 * - 非 mcp(harness/frontend/package/knowledge 等,数量少、架构性强)全保留。
 * - mcp:每个 query(archSpec 需求 + requirement 兜底)召回 top-M,并集;再按
 *   全局最高分补到 maxMcp。命中 0 分的不进(纯噪音)。
 * - queries 为空(无 archSpec)时退化:只用 requirement 当单一 query。
 */
export function shortlistCapabilities(
  capabilities: readonly CapabilityEntry[],
  queries: readonly string[],
  opts: { perQueryTopM?: number; maxMcp?: number } = {},
): { ids: Set<string>; total: number; keptNonMcp: number; shortlistedMcp: number } {
  const perQueryTopM = opts.perQueryTopM ?? 6
  const maxMcp = opts.maxMcp ?? 60
  const ids = new Set<string>()
  let keptNonMcp = 0
  const mcpDocs: DocTokens[] = []
  const mcpById = new Map<string, CapabilityEntry>()
  for (const c of capabilities) {
    if (isMcp(c)) { mcpDocs.push(buildDoc(c)); mcpById.set(c.id, c) }
    else { ids.add(c.id); keptNonMcp++ }
  }
  const qTokens = queries.map((q) => tokenize(q)).filter((t) => t.length > 0)
  // 每个 query 召回 top-M(set-level:各需求的最佳候选都保住)
  const globalBest = new Map<string, number>()
  for (const qt of qTokens) {
    const scored = mcpDocs
      .map((d) => ({ id: d.id, s: score(d, qt) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
    for (const x of scored.slice(0, perQueryTopM)) ids.add(x.id)
    for (const x of scored) globalBest.set(x.id, Math.max(globalBest.get(x.id) ?? 0, x.s))
  }
  // 全局补齐到 maxMcp(并集已含各 query top-M;按全局最高分补剩余额度)
  const shortlistedMcpBefore = [...ids].filter((id) => mcpById.has(id)).length
  if (shortlistedMcpBefore < maxMcp) {
    const rest = [...globalBest.entries()]
      .filter(([id]) => !ids.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxMcp - shortlistedMcpBefore)
    for (const [id] of rest) ids.add(id)
  }
  const shortlistedMcp = [...ids].filter((id) => mcpById.has(id)).length
  return { ids, total: capabilities.length, keptNonMcp, shortlistedMcp }
}
