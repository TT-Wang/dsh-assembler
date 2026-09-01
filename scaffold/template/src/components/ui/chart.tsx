// 图表原语(BACKLOG 1.0 ④):recharts 早在依赖里,这里给它配"面"——三张一行代码
// 就能用的标准图 + 主题色自动接入(CSS 变量),并内建考官可断言的 data-* 标记
// (data-chart 类型 / data-points 数据点数),DOM 考的 waitText/extract 够得着。
// 需要更花的图,直接 import 'recharts'(它是骨架依赖,页面自由区随便用)。
import * as React from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"

const SERIES_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const

function themeColor(i: number): string {
  if (typeof window !== "undefined") {
    const v = getComputedStyle(document.documentElement).getPropertyValue(SERIES_VARS[i % SERIES_VARS.length] as string).trim()
    if (v !== "") return v.startsWith("#") || v.startsWith("rgb") || v.startsWith("hsl") || v.startsWith("oklch") ? v : `hsl(${v})`
  }
  const fallback = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4"]
  return fallback[i % fallback.length] as string
}

export interface ChartDatum { label: string; value: number }

interface SimpleChartProps {
  data: ChartDatum[]
  /** 高度像素,默认 220。 */
  height?: number
  className?: string
}

function frame(kind: string, points: number, height: number, className: string | undefined, child: React.ReactElement) {
  return (
    <div data-slot="chart" data-chart={kind} data-points={points} className={className} style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">{child}</ResponsiveContainer>
    </div>
  )
}

/** 柱状图:分类对比的默认选择。 */
export function SimpleBarChart({ data, height = 220, className }: SimpleChartProps) {
  return frame("bar", data.length, height, className, (
    <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
      <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
      <YAxis width={36} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
      <RTooltip cursor={{ fill: "hsl(var(--muted))" }} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
      <Bar dataKey="value" fill={themeColor(0)} radius={[4, 4, 0, 0]} maxBarSize={48} />
    </BarChart>
  ))
}

/** 折线图:趋势/时间序列的默认选择。 */
export function SimpleLineChart({ data, height = 220, className }: SimpleChartProps) {
  return frame("line", data.length, height, className, (
    <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
      <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
      <YAxis width={36} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
      <RTooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
      <Line type="monotone" dataKey="value" stroke={themeColor(0)} strokeWidth={2} dot={{ r: 3 }} />
    </LineChart>
  ))
}

/** 环图:构成占比的默认选择(每片自动轮换主题色)。 */
export function SimplePieChart({ data, height = 220, className }: SimpleChartProps) {
  return frame("pie", data.length, height, className, (
    <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
      <RTooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
      <Pie data={data} dataKey="value" nameKey="label" innerRadius="55%" outerRadius="85%" paddingAngle={2} strokeWidth={0}>
        {data.map((_, i) => <Cell key={i} fill={themeColor(i)} />)}
      </Pie>
    </PieChart>
  ))
}

/** 统计卡:数字 + 标签的最小陈列件(仪表盘首排标配)。 */
export function StatCard({ label, value, hint, className }: { label: string; value: React.ReactNode; hint?: string; className?: string }) {
  return (
    <div data-slot="stat-card" className={`rounded-xl border bg-card text-card-foreground p-4 ${className ?? ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {hint !== undefined && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  )
}
