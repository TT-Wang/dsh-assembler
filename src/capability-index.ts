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
 * 同分次序:词法证据打平时,先给**交付更完整**的那件——配方是整套可独立运行的
 * app 图纸,模板/零件都是要装进 preset 才成形的半件。只在同分时生效,不改分数。
 */
function completenessRank(c: CapabilityEntry): number {
  return c.via === 'recipe' ? 0 : 1
}

/**
 * 粗筛:返回喂进选型 prompt 的候选 id 集。
 *
 * - 非 mcp(harness/frontend/package/knowledge 等,数量少、架构性强)全保留。
 * - mcp:每个 query(archSpec 需求 + requirement 兜底)召回 top-M,并集;再按
 *   全局最高分补到 maxMcp。命中 0 分的不进(纯噪音)。
 * - queries 为空(无 archSpec)时退化:只用 requirement 当单一 query。
 */
/**
 * 带排名的全目录检索(检索形态的后端):对一个自然语言 query 返回按分排序的
 * top-N 条目(含 frontend/knowledge/persona 等非 mcp 条目——主 agent 要自己
 * 找到交互面和知识包,不能只搜库型工具)。纯机械,零 LLM,毫秒级,确定性可单测。
 *
 * 打分是 BM25 味的 IDF 加权(先例:Anthropic Tool Search Tool 开箱即 regex+BM25
 * 双变体):每个命中词按 idf = ln(1+(N-df+0.5)/(df+0.5)) 计权,tag 命中 ×3、
 * description 命中 ×1——"数据""管理"这类满目录都是的词自然降权,土法 tf 计数
 * 在 259 条规模就已经被它们污染(实测"数据分析"查询里通用件混进前排)。
 * 词只出现 0/1 次(词袋是 Set),不做长度归一——条目描述本来就一句话,等长。
 *
 * 同分次序不是小事(2026-08-25 取证):「记账」「收支记录」「设备巡检记录」三条
 * 查询里 `frontend-data-desk` 与 `recipe-record-desk` 分数**完全相同**(6.91),
 * 旧的字母序把 preset 车道的模板顶到榜首、把整套配方压到第二——榜首本身就是一次
 * 无声的车道推荐,而且推的是错的那条(A 档 3/3 走了 preset)。同分时改按**交付
 * 完整度**排:配方(整套独立 app,零对话税)先于其余;分数不同一律照旧。
 */
export function rankCapabilities(
  capabilities: readonly CapabilityEntry[],
  query: string,
  topN = 12,
): Array<{ entry: CapabilityEntry; score: number }> {
  const qt = [...new Set(tokenize(query))]
  if (qt.length === 0) return []
  const usable = capabilities.filter((c) => c.config?.enabled !== false)
  const docs = usable.map(buildDoc)
  // 文档频率:一个词在多少条目(tag ∪ description)里出现。
  const df = new Map<string, number>()
  for (const d of docs) {
    const seen = new Set([...d.tag, ...d.desc])
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = docs.length
  const idf = (t: string): number => {
    const f = df.get(t) ?? 0
    return Math.log(1 + (N - f + 0.5) / (f + 0.5))
  }
  return docs
    .map((d, i) => {
      let s = 0
      for (const t of qt) {
        if (d.tag.has(t)) s += 3 * idf(t)
        else if (d.desc.has(t)) s += idf(t)
      }
      return { entry: usable[i], score: Math.round(s * 100) / 100 }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score
      || completenessRank(a.entry) - completenessRank(b.entry)
      || a.entry.id.localeCompare(b.entry.id))
    .slice(0, topN)
}

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
