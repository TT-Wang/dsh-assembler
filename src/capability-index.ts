/**
 * 能力目录的机械检索——search 形态的心脏(search_catalog 的后端)。
 *
 * 设计裁定:走 lexical(tags 倒排 + IDF 加权),不上 embedding——当前规模
 * lexical 毫秒级够快,tags 是人工标注的强信号,确定性可单测可解释。规模真涨
 * 到几千条再上向量混合召回(ROADMAP 阶段 4 的规模触发器)。
 *
 * 历史:本文件曾另有两阶段选型的粗筛器 shortlistCapabilities(选型 LLM 的
 * 输入压缩)。A/B 实测(2026-08-22)证明选型是推理绑定而非目录大小绑定,粗筛
 * 不提速还有召回风险;其唯一消费者(llmMapRequirement)随 pipeline 形态删除
 * (宪法第八条),粗筛器同葬,git 备查。
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

/**
 * 带排名的全目录检索:对一个自然语言 query 返回按分排序的 top-N 条目
 * (含 frontend/knowledge/persona 等非 mcp 条目——主 agent 要自己找到交互面
 * 和知识包,不能只搜库型工具)。纯机械,零 LLM,毫秒级,确定性可单测。
 *
 * 打分是 BM25 味的 IDF 加权(先例:Anthropic Tool Search Tool 开箱即 regex+BM25
 * 双变体):每个命中词按 idf = ln(1+(N-df+0.5)/(df+0.5)) 计权,tag 命中 ×3、
 * description 命中 ×1——"数据""管理"这类满目录都是的词自然降权,土法 tf 计数
 * 在 259 条规模就已经被它们污染(实测"数据分析"查询里通用件混进前排)。
 * 词只出现 0/1 次(词袋是 Set),不做长度归一——条目描述本来就一句话,等长。
 *
 * 同分次序的教训留档(2026-08-25 取证):曾在配方与模板同分时靠字母序破平,
 * 榜首本身成了一次无声的错误车道推荐。配方车道并入 scaffold(宪法第九条)后
 * 该分叉不复存在,同分退回稳定的 id 序;若未来再出现"同分即抉择"的条目对,
 * 破平规则必须重新按交付语义设计,不许交给任意序。
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
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, topN)
}
