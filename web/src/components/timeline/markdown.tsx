import { Check, Copy } from "lucide-react"
import { createContext, memo, useContext, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { blockCommand, isShellBlock } from "@shared/command-values"

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
}

function InlineCode({ text }: { text: string }) {
  const commands = useContext(InlineCommands)
  if (!commands) return <code>{text}</code>
  return (
    <span className="whitespace-nowrap">
      <code>{text}</code> <TakeToTerminal command={text} compact />
    </span>
  )
}

export const Markdown = memo(function Markdown({ text, className, inlineCommands = false }: { text: string; className?: string; inlineCommands?: boolean }) {
  return (
    <div className={cn("md", className)}>
      <InlineCommands.Provider value={inlineCommands}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </InlineCommands.Provider>
    </div>
  )
})
