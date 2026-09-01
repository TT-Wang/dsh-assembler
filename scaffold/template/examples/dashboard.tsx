// 仪表盘范例(BACKLOG 1.0 ③:模式库新件)——"数据落库后老板要看一眼"的标准形状:
// 统计卡首排 + 柱状/环图 + 原生 select 过滤 + 回车速录 + toast 反馈。
// 路由纪律:全部动作都是确定性(读表/汇总/插入)→ 一律 face,零模型零轮次。
// 交互元素全带稳定 id(#rangeSel/#quick/#quickBtn)——DOM 考的 select/press 动词
// 直接够得着;图表容器带 data-chart/data-points,考官 extract 可断言。
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SimpleBarChart, SimplePieChart, StatCard, type ChartDatum } from '@/components/ui/chart'
import { toast } from '@/components/ui/toast'
import { sqliteFace, bindEnter, type SqliteFace } from '@/sdk/assembler-sdk'

export const title = '总览'

type Row = Record<string, unknown>

export default function Dashboard() {
  const [face, setFace] = useState<SqliteFace | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState('all')
  const [total, setTotal] = useState(0)
  const [byStatus, setByStatus] = useState<ChartDatum[]>([])
  const [recent, setRecent] = useState<Row[]>([])
  const [quick, setQuick] = useState('')

  // 按需求换表名/列名:表结构以配套 preset 的装备 DDL 为准(read_preset 可查),别发明。
  const TABLE = 'tasks'

  async function refresh(f: SqliteFace | null = face, r: string = range) {
    if (!f) return
    setLoading(true)
    try {
      const where = r === 'all' ? '' : ' WHERE status = ?'
      const params = r === 'all' ? [] : [r]
      const cnt = await f.sql(`SELECT COUNT(*) AS n FROM ${TABLE}${where}`, params)
      setTotal(Number((cnt.rows?.[0] as { n?: number } | undefined)?.n ?? 0))
      const grp = await f.sql(`SELECT status AS label, COUNT(*) AS value FROM ${TABLE} GROUP BY status ORDER BY value DESC`)
      setByStatus(((grp.rows ?? []) as Array<{ label: unknown; value: unknown }>).map((x) => ({ label: String(x.label), value: Number(x.value) })))
      const rec = await f.sql(`SELECT * FROM ${TABLE}${where} ORDER BY id DESC LIMIT 8`, params)
      setRecent((rec.rows ?? []) as Row[])
      setErr('')
    } catch (e) { setErr('读取台账失败:' + String((e as Error).message)) } finally { setLoading(false) }
  }

  useEffect(() => {
    void sqliteFace().then((f) => {
      setFace(f)
      if (f) void refresh(f)
      else { setErr('服务脸不可达——从 /assembler/ui/<presetId> 同源打开,并确认 preset 已挂载'); setLoading(false) }
    })
    const input = document.getElementById('quick')
    if (input) bindEnter(input, () => document.getElementById('quickBtn')?.click())
  }, [])

  async function quickAdd() {
    if (!face || !quick.trim()) return
    try {
      await face.sql(`INSERT INTO ${TABLE} (title, status) VALUES (?, ?)`, [quick.trim(), '待办'])
      toast('已入库:' + quick.trim())
      setQuick('')
      await refresh()
    } catch (e) { setErr('入库失败:' + String((e as Error).message)); toast('入库失败', { variant: 'destructive' }) }
  }

  const cols = recent.length > 0 ? Object.keys(recent[0] as object).slice(0, 5) : []

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      {err !== '' && <div className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">{err}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {/* 原生 select:考官的 select 动词直接可考;要更好看的下拉再换 shadcn Select(考官走两步 click) */}
        <select id="rangeSel" className="h-9 rounded-md border bg-background px-2 text-sm" value={range}
          onChange={(e) => { setRange(e.target.value); void refresh(face, e.target.value) }}>
          <option value="all">全部状态</option>
          {byStatus.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
        </select>
        <div className="flex-1" />
        <Input id="quick" className="max-w-64" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="速录一条…(Enter 入库)" />
        <Button id="quickBtn" onClick={quickAdd}>入库</Button>
      </div>
      {loading ? (
        <div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label={range === 'all' ? '总记录' : `「${range}」记录`} value={total} hint={`表 ${TABLE}`} />
          <StatCard label="状态种数" value={byStatus.length} />
          <StatCard label="最新一条" value={recent.length > 0 ? String((recent[0] as { title?: unknown }).title ?? '#' + String((recent[0] as { id?: unknown }).id ?? '')) : '—'} />
        </div>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">按状态计数</CardTitle></CardHeader>
          <CardContent>{byStatus.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">空表——右上速录一条试试</div> : <SimpleBarChart data={byStatus} />}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">构成占比</CardTitle></CardHeader>
          <CardContent>{byStatus.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">空</div> : <SimplePieChart data={byStatus} />}</CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">最近记录</CardTitle></CardHeader>
        <CardContent>
          {recent.length === 0 ? <div className="py-6 text-center text-sm text-muted-foreground">空</div> : (
            <table className="w-full text-sm" id="recentTable">
              <thead><tr className="border-b text-left text-muted-foreground">{cols.map((c) => <th key={c} className="py-2 pr-3 font-normal">{c}</th>)}</tr></thead>
              <tbody>{recent.map((r, i) => (
                <tr key={i} className="border-b last:border-0">{cols.map((c) => <td key={c} className="py-2 pr-3">{String((r as Record<string, unknown>)[c] ?? '')}</td>)}</tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
