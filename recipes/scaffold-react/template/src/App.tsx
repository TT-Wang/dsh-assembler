// 骨架(禁改):自动挂载 src/pages/ 下的页面。单页直出;多页时以 hash 路由切换,
// 每页默认导出组件,可导出 export const title = '页名' 进导航。
import React from 'react'

type PageMod = { default: React.ComponentType; title?: string }
const modules = import.meta.glob<PageMod>('./pages/*.tsx', { eager: true })
const pages = Object.entries(modules)
  .map(([path, mod]) => ({
    id: path.replace('./pages/', '').replace('.tsx', ''),
    title: mod.title ?? path.replace('./pages/', '').replace('.tsx', ''),
    Comp: mod.default,
  }))
  .sort((a, b) => a.id.localeCompare(b.id))

export default function App() {
  const [hash, setHash] = React.useState(location.hash.slice(1))
  React.useEffect(() => {
    const on = () => setHash(location.hash.slice(1))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  if (pages.length === 0) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground">src/pages/ 还没有页面——这是 scaffold 骨架的空态。</div>
  }
  const active = pages.find((p) => p.id === hash) ?? pages[0]
  return (
    <div className="min-h-screen">
      {pages.length > 1 && (
        <nav className="sticky top-0 z-10 flex gap-1 border-b bg-background/90 px-4 py-2 backdrop-blur">
          {pages.map((p) => (
            <a key={p.id} href={'#' + p.id}
               className={'rounded-md px-3 py-1.5 text-sm ' + (p.id === active.id ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-secondary/60')}>
              {p.title}
            </a>
          ))}
        </nav>
      )}
      <active.Comp />
    </div>
  )
}
