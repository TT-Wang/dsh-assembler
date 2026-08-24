// 语料入索引:corpus/ → data/index.json。确定性、零网络——实例化时(emit_app)
// 就跑完,交付即就绪;换语料后重跑本文件即可。
// 切块:按 markdown 标题(#/##/###)分段,段内 1500 字符滑窗;<40 字符的碎片丢弃。
import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const CORPUS = path.join(ROOT, "corpus");

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

if (!fs.existsSync(CORPUS)) {
  console.error("corpus/ 不存在——emit_app 需要 corpusDir,或手工把文档放进 corpus/ 后重跑");
  process.exit(1);
}

const chunks = [];
for (const f of walk(CORPUS).filter((f) => /\.(md|mdx|txt|html?)$/i.test(f))) {
  const raw = fs.readFileSync(f, "utf8");
  // html 只做去标签的朴素净化——语料以 md/txt 为主,html 是兜底通道
  const text = /\.html?$/i.test(f) ? raw.replace(/<[^>]+>/g, " ") : raw;
  const source = path.relative(CORPUS, f);
  let heading = path.basename(f);
  for (const block of text.split(/^(?=#{1,3} )/m)) {
    heading = block.match(/^#{1,3} (.+)/)?.[1]?.trim() ?? heading;
    for (let i = 0; i < block.length; i += 1500) {
      const piece = block.slice(i, i + 1500).trim();
      if (piece.length > 40) chunks.push({ id: chunks.length, source, heading, text: piece });
    }
  }
}

fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data", "index.json"), JSON.stringify(chunks));
console.log(`indexed ${chunks.length} chunks`);
