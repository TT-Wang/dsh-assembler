// 轻提示(零依赖,免 Provider):从任何页面直接 toast('已保存')。
// 命令式挂 DOM + 自动消退——不动 App 骨架、不引状态库,页面代码一行调用。
// variant: 'default' 深底白字;'destructive' 红底(错误提示)。
const HOST_ID = "__toast_host"

function host(): HTMLElement {
  let el = document.getElementById(HOST_ID)
  if (el === null) {
    el = document.createElement("div")
    el.id = HOST_ID
    el.setAttribute("data-slot", "toaster")
    el.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none"
    document.body.appendChild(el)
  }
  return el
}

export function toast(message: string, opts: { variant?: "default" | "destructive"; durationMs?: number } = {}): void {
  const el = document.createElement("div")
  el.setAttribute("data-slot", "toast")
  el.setAttribute("role", "status")
  el.textContent = message
  const palette = opts.variant === "destructive"
    ? "background:hsl(0 72% 42%);color:#fff"
    : "background:hsl(var(--foreground));color:hsl(var(--background))"
  el.style.cssText = `${palette};padding:8px 16px;border-radius:10px;font-size:13px;box-shadow:0 4px 16px rgb(0 0 0 / .18);opacity:0;transition:opacity .2s;max-width:80vw`
  host().appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = "1" })
  window.setTimeout(() => {
    el.style.opacity = "0"
    window.setTimeout(() => { el.remove() }, 250)
  }, opts.durationMs ?? 2600)
}
