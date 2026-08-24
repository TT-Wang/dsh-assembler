// 记录台 app:schema 自适应的"记录+查询"独立应用。
// 账 = SQLite 文件:默认本地 data/app.db(由 schema.sql 建),或经 DB_PATH 指向
// 一份**外部共享账**(双面交付:与 agent preset 共用同一个 workspace/data.db)。
// AI 只出现在一处薄判断:自然语言 → 结构化行(/api/record);增删查改全是直连 SQL。
// 页面不认识任何具体业务:表和列从库里读(schema 驱动渲染)——一张配方通吃记录域。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { complete } from "./lib/ai.mjs";

const ROOT = import.meta.dirname;
const PUB = path.join(ROOT, "public");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "app.config.json"), "utf8"));
const DB_PATH = CFG.DB_PATH && CFG.DB_PATH.startsWith("/") ? CFG.DB_PATH : path.join(ROOT, "data", "app.db");
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL"); // 双面共账:与零件进程并发读写靠 WAL
const FORBIDDEN = /^\s*(ATTACH|DETACH|VACUUM)\b/i;

const tables = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const schemaOf = (t) => db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all()
  .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull === 1, pk: c.pk > 0, dflt: c.dflt_value ?? null }));

const json = (res, code, obj) => { if (!res.writableEnded) { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); } };
const readBody = async (req) => { let b = ""; for await (const p of req) { b += p; if (b.length > 256 * 1024) throw new Error("too large"); } return JSON.parse(b || "{}"); };

http.createServer(async (req, res) => {
  res.on("error", () => {});
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  try {
    if (req.method === "GET" && pathname === "/healthz")
      return json(res, 200, { ok: true, chunks: tables().length, db: DB_PATH, keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY) });
    if (req.method === "GET" && pathname === "/api/meta")
      return json(res, 200, { appName: CFG.APP_NAME ?? "记录台", roleLine: CFG.ROLE_LINE ?? "", keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY) });
    if (req.method === "GET" && pathname === "/api/schema")
      return json(res, 200, { tables: tables().map((t) => ({ name: t, columns: schemaOf(t) })) });
    if (req.method === "GET" && pathname === "/api/rows") {
      const t = q.get("table") ?? tables()[0];
      if (!t || !tables().includes(t)) return json(res, 400, { error: "未知表" });
      const limit = Math.min(Number(q.get("limit") ?? 50) || 50, 500);
      return json(res, 200, { table: t, rows: db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}" ORDER BY rowid DESC LIMIT ?`).all(limit) });
    }
    if (req.method === "POST" && pathname === "/api/sql") {
      const { sql, params } = await readBody(req);
      if (typeof sql !== "string" || FORBIDDEN.test(sql)) return json(res, 400, { error: "非法 SQL(需单条语句,ATTACH/DETACH/VACUUM 拒)" });
      const stmt = db.prepare(sql);
      const p = Array.isArray(params) ? params : [];
      // node:sqlite 无 reader 标志:SELECT/WITH/PRAGMA 开头按读处理
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) return json(res, 200, { rows: stmt.all(...p).slice(0, 500) });
      const info = stmt.run(...p);
      return json(res, 200, { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) });
    }
    if (req.method === "POST" && pathname === "/api/record") {
      // 薄判断:自然语言 → {table, values};schema 随 prompt 给足,模型只做解析
      const { text } = await readBody(req);
      if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "需要 { text }" });
      const sch = tables().map((t) => `${t}(${schemaOf(t).map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}`).join(", ")})`).join("\n");
      let parsed;
      try {
        const out = await complete({
          system: CFG.ROLE_LINE ?? "你把用户的一句话记录解析成结构化行。",
          prompt: `库里的表:\n${sch}\n\n把这句话解析成一条要插入的记录,只输出一个 JSON 对象 {"table":"表名","values":{列:值}}:自增主键与有默认值的列不要填;日期列没说就用今天(${new Date().toISOString().slice(0, 10)});类型/分类类列按语义取最贴切值。\n\n这句话:${text}`,
          model: CFG.MODEL || "deepseek-v4-flash",
        });
        parsed = JSON.parse((/\{[\s\S]*\}/.exec(out) ?? ["{}"])[0]);
      } catch (error) {
        if (error?.code === "no-key") return json(res, 200, { error: String(error.message) });
        return json(res, 500, { error: `解析失败:${error.message}` });
      }
      const t = String(parsed.table ?? "");
      if (!tables().includes(t)) return json(res, 400, { error: `解析出的表不存在:${t}` });
      const valid = new Set(schemaOf(t).map((c) => c.name));
      const cols = Object.keys(parsed.values ?? {}).filter((c) => valid.has(c));
      if (cols.length === 0) return json(res, 400, { error: "解析出的列为空" });
      const sql = `INSERT INTO "${t.replace(/"/g, '""')}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      const info = db.prepare(sql).run(...cols.map((c) => parsed.values[c]));
      const row = db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}" WHERE rowid=?`).get(Number(info.lastInsertRowid));
      return json(res, 200, { table: t, row });
    }
    // 静态
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(PUB, rel));
    if (file.startsWith(PUB + path.sep) || file === path.join(PUB, "index.html")) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(404); res.end("not found");
  } catch (error) {
    json(res, 400, { error: String(error?.message ?? error) });
  }
}).listen(Number(process.env.PORT ?? 4700), "127.0.0.1", function () {
  console.log(`ready http://127.0.0.1:${this.address().port} — db=${DB_PATH}, tables=${tables().length}`);
});
