// 入库门样例页:证明词汇表(shadcn 组件)+ 骨架 + 构建链全通。
// 不出网(无 face/wire 调用),lint 门天然过——门考的是词汇与骨架,行为考在真装配时考。
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CheckCircle2 } from 'lucide-react'

export const title = '样例'

export default function Demo() {
  const [items, setItems] = useState<string[]>(['词汇表已通'])
  const [draft, setDraft] = useState('')
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-5" /> scaffold 样例页</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="加一条…" />
            <Button onClick={() => { if (draft.trim()) { setItems([...items, draft.trim()]); setDraft('') } }}>添加</Button>
          </div>
          <Tabs defaultValue="list">
            <TabsList><TabsTrigger value="list">清单</TabsTrigger><TabsTrigger value="table">表格</TabsTrigger></TabsList>
            <TabsContent value="list" className="flex flex-wrap gap-2 pt-2">
              {items.map((it, i) => <Badge key={i} variant="secondary">{it}</Badge>)}
            </TabsContent>
            <TabsContent value="table">
              <Table>
                <TableHeader><TableRow><TableHead>#</TableHead><TableHead>内容</TableHead></TableRow></TableHeader>
                <TableBody>{items.map((it, i) => <TableRow key={i}><TableCell>{i + 1}</TableCell><TableCell>{it}</TableCell></TableRow>)}</TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
