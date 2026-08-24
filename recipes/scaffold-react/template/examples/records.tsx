// 范例:记录台(schema 驱动)。示范三件事:
// ① face.schema() 读表结构 → 动态渲染列与表单(页面不硬编码业务字段)
// ② 直录/汇总全走 face(零模型);③ 错误必须出声(不许静默 catch)
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { sqliteFace, type SqliteFace } from '@/sdk/assembler-sdk'

export const title = '记录台'

type Col = { name: string; type: string; notnull: boolean; pk: boolean }

export default function Records() {
  const [face, setFace] = useState<SqliteFace | null>(null)
  const [tables, setTables] = useState<{ name: string; columns: Col[] }[]>([])
  const [table, setTable] = useState('')
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')

  const cur = tables.find((t) => t.name === table)
  const fillable = (cur?.columns ?? []).filter((c) => !(c.pk && /INT/i.test(c.type)))

  async function refresh(f = face, t = table) {
    if (!f || !t) return
    try {
      const r = await f.sql(`SELECT * FROM "${t.replace(/"/g, '""')}" ORDER BY rowid DESC LIMIT 50`)
      setRows((r.rows ?? []) as Record<string, unknown>[])
      setErr('')
    } catch (e) { setErr('读取失败:' + String((e as Error).message)) }
  }

  useEffect(() => {
    void sqliteFace().then(async (f) => {
      setFace(f)
      if (!f) { setErr('服务脸不可达——请从 preset 页面同源打开'); return }
      const sch = await f.schema()
      setTables(sch.tables)
      const first = sch.tables[0]?.name ?? ''
      setTable(first)
      void refresh(f, first)
    })
  }, [])

  async function insert() {
    if (!face || !cur) return
    const cols = fillable.filter((c) => (draft[c.name] ?? '') !== '')
    if (cols.length === 0) return
    try {
      await face.sql(
        `INSERT INTO "${cur.name.replace(/"/g, '""')}" (${cols.map((c) => `"${c.name}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map((c) => draft[c.name]),
      )
      setDraft({})
      await refresh()
    } catch (e) { setErr('入库失败:' + String((e as Error).message)) }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      {err !== '' && <div className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">{err}</div>}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">直录</CardTitle>
          <Select value={table} onValueChange={(v) => { setTable(v); void refresh(face, v) }}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{tables.map((t) => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}</SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          {fillable.map((c) => (
            <label key={c.name} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {c.name}{c.notnull ? ' *' : ''}
              <Input className="w-36" value={draft[c.name] ?? ''} onChange={(e) => setDraft({ ...draft, [c.name]: e.target.value })} placeholder={c.type} />
            </label>
          ))}
          <Button onClick={insert}>入库</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">台账(直连,最近 50 条)</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? <div className="py-6 text-center text-sm text-muted-foreground">空表</div> : (
            <Table>
              <TableHeader><TableRow>{Object.keys(rows[0]).map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{rows.map((r, i) => <TableRow key={i}>{Object.keys(rows[0]).map((c) => <TableCell key={c}>{String(r[c] ?? '')}</TableCell>)}</TableRow>)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
