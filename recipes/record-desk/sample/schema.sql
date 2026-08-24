-- 云杉小队台账(虚构样例 schema,仅用于配方入库自证;幂等)
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT '支出',
  amount REAL,
  note TEXT NOT NULL DEFAULT '',
  entry_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(entry_date);
