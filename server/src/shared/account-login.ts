/** Un comando para loguear una cuenta de Claude Code desde una terminal (`label` dice de cuál). */
export interface LoginCommand {
  label?: string
  command: string
}

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/

/** `/home/ana/.claude-x` → `~/.claude-x` (solo el home de Linux o macOS). */
function withTilde(p: string): string {
  const home = /^\/(home|Users)\/[^/]+/.exec(p)
  return home ? "~" + p.slice(home[0].length) : p
}

/** Entre comillas simples si hace falta (una `'` adentro se cierra, se escapa y se vuelve a abrir). */
function posixQuote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * Los comandos para loguear una cuenta: abrir `claude` con su `CLAUDE_CONFIG_DIR` y escribir `/login`.
 * La cuenta de siempre es solo `claude`. En Windows depende de la terminal: la barra invertida de una
 * ruta como `C:\Users\Ana\.claude-x` la toma como escape Git Bash (queda `C:Users…` y claude crea una
 * carpeta relativa con otro nombre), así que ahí va con barras normales.
 */
export function loginCommands(configDir: string, isDefault: boolean): LoginCommand[] {
  if (isDefault) return [{ command: "claude" }]
  if (WINDOWS_PATH.test(configDir)) {
    // Una ruta de Windows no puede tener comillas dobles: no se arma nada que se pueda romper.
    if (configDir.includes('"')) return []
    const back = configDir.replace(/\//g, "\\")
    const forward = configDir.replace(/\\/g, "/")
    return [
      { label: "PowerShell", command: `$env:CLAUDE_CONFIG_DIR="${back}"; claude` },
      { label: "Git Bash", command: `CLAUDE_CONFIG_DIR="${forward}" claude` },
      { label: "CMD", command: `set "CLAUDE_CONFIG_DIR=${back}" && claude` },
    ]
  }
  return [{ command: `CLAUDE_CONFIG_DIR=${posixQuote(withTilde(configDir))} claude` }]
}
