// kb-sdk-e2e 的定制看板页(scaffold 车道 S4 真装,写手=主 agent 席位)。
// 路由纪律:列板/拖卡/加任务 = 确定性 → face(毫秒级,零模型);
// "任务分析" = 判断 → wire。对照:模板版 kanban 每次拖卡都是一整轮 agent 会话。
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { sqliteFace, createClient, bindEnter, type SqliteFace } from '@/sdk/assembler-sdk'
import { RefreshCw, Sparkles } from 'lucide-react'

export const title = '任务看板'

const COLS = ['待办', '进行中', '已完成'] as const
type Task = { id: number; title: string; status: string }

export default function Board() {
  const [face, setFace] = useState<SqliteFace | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [analysis, setAnalysis] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh(f: SqliteFace | null = face) {
    if (!f) return
    try {
      const r = await f.sql('SELECT id, title, status FROM tasks ORDER BY id')
      setTasks((r.rows ?? []) as Task[])
      setErr('')
    } catch (e) { setErr('读取台账失败:' + String((e as Error).message)) }
  }

  useEffect(() => {
    void sqliteFace().then((f) => {
      setFace(f)
      if (f) void refresh(f)
      else setErr('服务脸不可达——请从 /assembler/ui/kb-sdk-e2e 同源打开,并确认 preset 已挂载')
    })
    const input = document.getElementById('draft')
    if (input) bindEnter(input, () => document.getElementById('addBtn')?.click())
  }, [])

  async function move(id: number, status: string) {
    if (!face) return
    try {
      await face.sql('UPDATE tasks SET status = ? WHERE id = ?', [status, id])
      await refresh()
    } catch (e) { setErr('移动失败:' + String((e as Error).message)) }
  }

  async function add() {
    if (!face || !draft.trim()) return
    try {
      await face.sql('INSERT INTO tasks (title, status) VALUES (?, ?)', [draft.trim(), '待办'])
      setDraft('')
      await refresh()
    } catch (e) { setErr('添加失败:' + String((e as Error).message)) }
  }

  async function analyze() {
    if (busy) return
    setBusy(true); setAnalysis('')
    const client = createClient({ onError: (m) => { setErr(m); setBusy(false) } })
    try {
      const out = await client.ask('请查看 tasks 表全部任务,给出一段简短的推进建议(哪些该先做、哪些卡住了)。纯文字即可。')
      setAnalysis(out.reply)
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      {err !== '' && <div className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">{err}</div>}
      <div className="flex gap-2">
        <Input id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="添加任务:一句话描述…(Enter,直连入库,零模型)" />
        <Button id="addBtn" onClick={add}>添加</Button>
        <Button variant="secondary" onClick={() => refresh()}><RefreshCw className="size-4" /></Button>
        <Button variant="outline" onClick={analyze} disabled={busy}><Sparkles className="mr-1 size-4" />{busy ? '分析中…' : '任务分析'}</Button>
      </div>
      <div className="grid items-start gap-4 md:grid-cols-3">
        {COLS.map((col) => {
          const cards = tasks.filter((t) => t.status === col)
          return (
            <Card key={col}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const id = Number(e.dataTransfer.getData('text/plain')); if (id) void move(id, col) }}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm">{col}</CardTitle>
                <Badge variant="secondary">{cards.length}</Badge>
              </CardHeader>
              <CardContent className="min-h-24 space-y-2">
                {cards.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">空</div>}
                {cards.map((t) => (
                  <div key={t.id} draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', String(t.id))}
                    className="cursor-grab rounded-lg border bg-muted p-3 text-sm active:cursor-grabbing">
                    <div className="font-medium">{t.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">#{t.id}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )
        })}
      </div>
      {analysis !== '' && (
        <Card><CardHeader><CardTitle className="text-sm">任务分析(agent)</CardTitle></CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{analysis}</CardContent></Card>
      )}
    </div>
  )
}
