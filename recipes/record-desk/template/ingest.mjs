// 备账:确定性、可重复。两种形态——
// ① 本地账(默认):schema.sql → data/app.db(不存在才建,幂等)
// ② 共享账(双面交付):app.config.json 里 DB_PATH 指向外部库(preset 的
//    workspace/data.db)——不建库不动表,只核对能打开、有表。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = import.meta.dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "app.config.json"), "utf8"));
const external = CFG.DB_PATH && CFG.DB_PATH.startsWith("/");
const dbPath = external ? CFG.DB_PATH : path.join(ROOT, "data", "app.db");

if (!external) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const schemaFile = path.join(ROOT, "schema.sql");
  if (!fs.existsSync(schemaFile)) {
    console.error("缺 schema.sql——emit_app 需要 schemaFile 输入(或用 DB_PATH 指向已有共享账)");
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(schemaFile, "utf8")); // DDL 必须幂等(CREATE TABLE IF NOT EXISTS)
  db.close();
}
const db = new DatabaseSync(dbPath);
const n = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
db.close();
if (n === 0) { console.error(`库 ${dbPath} 里没有表——schema.sql 是空的还是 DB_PATH 指错了?`); process.exit(1); }
console.log(`indexed ${n} chunks (tables) — db=${dbPath}`);
