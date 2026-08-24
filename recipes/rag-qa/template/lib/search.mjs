// 词法检索(BM25,k1=1.2 b=0.75)。零依赖、纯内存;语料统计在 buildIndex 一次建好,
// 每问 O(词数×命中块),不重扫语料。
// 分词:英文/数字按词,CJK 出单字 + 相邻双字(单字保短查询召回,双字保精度)。

export function tokenize(s) {
  const lower = String(s).toLowerCase();
  const out = lower.match(/[a-z0-9]+/g) ?? [];
  const cjk = lower.match(/[一-鿿]/g) ?? [];
  out.push(...cjk);
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1]);
  return out;
}

export function buildIndex(chunks) {
  const tf = [];
  const len = [];
  const df = new Map();
  for (const c of chunks) {
    const toks = tokenize(`${c.heading} ${c.text}`);
    const m = new Map();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tf.push(m);
    len.push(toks.length);
  }
  const avg = len.reduce((n, l) => n + l, 0) / Math.max(len.length, 1);
  return { tf, len, df, avg, n: chunks.length };
}

export function search(index, chunks, query, k = 6) {
  const q = [...new Set(tokenize(query))];
  const scores = [];
  for (let i = 0; i < chunks.length; i++) {
    let s = 0;
    for (const t of q) {
      const f = index.tf[i].get(t) ?? 0;
      if (f === 0) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + (0.75 * index.len[i]) / index.avg));
    }
    if (s > 0) scores.push([s, i]);
  }
  scores.sort((a, b) => b[0] - a[0]);
  return scores.slice(0, k).map(([, i]) => chunks[i]);
}
