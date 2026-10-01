import { Check, Copy } from "lucide-react"
import { createContext, memo, useContext, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { blockCommand, isShellBlock } from "@shared/command-values"
import { codeRef, textRefs } from "@shared/file-refs"

import { FileRefLink, useRefScope } from "@/components/file-ref"
import { TakeToTerminal } from "@/components/take-to-terminal"
import { cn } from "@/lib/utils"

/** Si el código entre backticks son comandos (los pasos de una tarea para vos): llevan su botón. */
const InlineCommands = createContext(false)

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false)
  const text = String(children ?? "").replace(/\n$/, "")
  const lang = /language-(\w+)/.exec(className ?? "")?.[1]
  return (
    <div className="group/code relative">
      <pre>
        <code className={className}>{text}</code>
      </pre>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5 opacity-0 transition-opacity group-hover/code:opacity-100">
        {lang && <span className="font-mono text-[0.65rem] text-muted-foreground">{lang}</span>}
        {isShellBlock(lang, text) && <TakeToTerminal command={blockCommand(text)} />}
        <button
          type="button"
          aria-label="Copiar"
          className="rounded-md border bg-background p-1 text-muted-foreground hover:text-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "")
    const block = /language-/.test(className ?? "") || text.includes("\n")
    return block ? <CodeBlock className={className}>{children}</CodeBlock> : <InlineCode text={text} />
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  span: ({ node: _node, children, ...props }) => {
    const input = (props as Record<string, unknown>)["data-file-ref"]
    return typeof input === "string" ? <FileRefLink input={input}>{children}</FileRefLink> : <span {...props}>{children}</span>
  },
}

// Lo mínimo del árbol de rehype que hace falta para marcar las rutas del texto suelto.
interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}

/** Envuelve en <span data-file-ref> las rutas a archivos del texto, salvo en links y código. */
function rehypeFileRefs() {
  const walk = (node: HNode) => {
    if (!node.children || (node.type === "element" && ["a", "code", "pre"].includes(node.tagName!))) return
    const out: HNode[] = []
    for (const child of node.children) {
      if (child.type !== "text") {
        walk(child)
        out.push(child)
        continue
      }
      const text = child.value ?? ""
      let pos = 0
      for (const r of textRefs(text)) {
        if (r.start > pos) out.push({ type: "text", value: text.slice(pos, r.start) })
        out.push({ type: "element", tagName: "span", properties: { dataFileRef: r.input }, children: [{ type: "text", value: r.input }] })
        pos = r.end
      }
      out.push(pos ? { type: "text", value: text.slice(pos) } : child)
    }
    node.children = out
  }
  return (tree: HNode) => walk(tree)
}

function InlineCode({ text }: { text: string }) {
  const commands = useContext(InlineCommands)
  // Si todo el código es una ruta, se puede abrir en el editor. Un comando con una ruta adentro
  // (`code -g server/x.ts`) sigue siendo comando.
  const code = codeRef(text) ? (
    <FileRefLink input={text.trim()}>
      <code>{text}</code>
    </FileRefLink>
  ) : (
    <code>{text}</code>
  )
  if (!commands) return code
  // El comando corta adentro del contenedor (ver .md code); el espacio sin corte deja el botón
  // pegado al último pedazo, sin quedar solo en una línea aparte.
  return (
    <>
      {code}
      {"\u00a0"}
      <TakeToTerminal command={text} compact />
    </>
  )
}

const withRefs = [rehypeFileRefs]

export const Markdown = memo(function Markdown({ text, className, inlineCommands = false }: { text: string; className?: string; inlineCommands?: boolean }) {
  const scope = useRefScope()
  return (
    <div className={cn("md", className)}>
      <InlineCommands.Provider value={inlineCommands}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={scope ? withRefs : undefined} components={components}>
          {text}
        </ReactMarkdown>
      </InlineCommands.Provider>
    </div>
  )
})
