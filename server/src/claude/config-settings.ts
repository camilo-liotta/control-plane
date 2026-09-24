import fs from "node:fs"
import path from "node:path"

import type { ClaudeSetting, ClaudeSettingValue, ModelOption } from "../shared/types.ts"

/**
 * Las opciones del menú /config de Claude Code (versión 2.1.x), con la clave y los valores que usa
 * el propio CLI. La mayoría se guardan en el settings.json de la cuenta; las de IDE y copiado, en su
 * config global (.claude.json).
 */

type Opt = { value: string; label: string }

interface Def {
  key: string
  label: string
  description: string
  group: string
  type: "boolean" | "enum"
  options?: Opt[]
  file: "user" | "global"
  defaultValue: ClaudeSettingValue
  /** Valor del menú que significa "no definido" (se borra la clave). */
  unsetValue?: string
  /** Para opciones cuyo valor guardado es booleano aunque se elijan como lista. */
  booleanEnum?: boolean
  terminalOnly?: boolean
}

const o = (value: string, label: string): Opt => ({ value, label })

const GROUPS = {
  ui: "Terminal",
  sessions: "Sesiones",
  notifications: "Notificaciones",
  multi: "Varias sesiones y Remote Control",
  ide: "IDE y copiado",
}

export const SETTING_DEFS: Def[] = [
  // Terminal
  { key: "theme", label: "Tema", description: "Colores de la interfaz de Claude Code en la terminal.", group: GROUPS.ui, type: "enum", file: "user", defaultValue: "dark", terminalOnly: true,
    options: [o("dark", "Oscuro"), o("light", "Claro"), o("dark-daltonized", "Oscuro (daltónico)"), o("light-daltonized", "Claro (daltónico)"), o("dark-ansi", "Oscuro (ANSI)"), o("light-ansi", "Claro (ANSI)")] },
  { key: "editorMode", label: "Modo del editor", description: "Atajos del cuadro de texto: normales o de vim.", group: GROUPS.ui, type: "enum", file: "user", defaultValue: "normal", terminalOnly: true,
    options: [o("normal", "Normal"), o("vim", "Vim")] },
  { key: "timeFormat", label: "Formato de hora", description: "Cómo se muestran las horas.", group: GROUPS.ui, type: "enum", file: "user", defaultValue: "auto",
    options: [o("auto", "Automático"), o("12-hour", "12 horas"), o("24-hour", "24 horas"), o("24-hour-utc", "24 horas (UTC)")] },
  { key: "defaultView", label: "Vista por defecto", description: "Cómo se muestra la conversación al abrir una sesión.", group: GROUPS.ui, type: "enum", file: "user", defaultValue: "default", unsetValue: "default", terminalOnly: true,
    options: [o("default", "La de siempre"), o("transcript", "Transcripción"), o("chat", "Chat")] },
  { key: "showMessageTimestamps", label: "Mostrar la hora de cada mensaje", description: "Agrega la hora a los mensajes de la conversación.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: false, terminalOnly: true },
  { key: "showTurnDuration", label: "Mostrar cuánto tardó cada turno", description: "Indica la duración al terminar cada respuesta.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: false, terminalOnly: true },
  { key: "terminalProgressBarEnabled", label: "Barra de progreso en la terminal", description: "Muestra el progreso en la pestaña o el dock de la terminal.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: true, terminalOnly: true },
  { key: "showStatusInTerminalTab", label: "Estado en el título de la pestaña", description: "Muestra si la sesión está trabajando o esperando en el título de la terminal.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: false, terminalOnly: true },
  { key: "spinnerTipsEnabled", label: "Mostrar tips", description: "Consejos de una línea mientras Claude trabaja.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: true, terminalOnly: true },
  { key: "prefersReducedMotion", label: "Reducir animaciones", description: "Menos movimiento en la interfaz de la terminal.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: false, terminalOnly: true },
  { key: "copyFullResponse", label: "Saltear el selector de /copy", description: "/copy copia la respuesta entera sin preguntar qué parte.", group: GROUPS.ui, type: "boolean", file: "user", defaultValue: false, terminalOnly: true },

  // Sesiones
  { key: "model", label: "Modelo por defecto", description: "El que usan las sesiones nuevas si no elegís otro.", group: GROUPS.sessions, type: "enum", file: "user", defaultValue: "default", unsetValue: "default", options: [] },
  { key: "autoCompactEnabled", label: "Compactar el contexto automáticamente", description: "Resume la conversación cuando el contexto se está por llenar.", group: GROUPS.sessions, type: "boolean", file: "user", defaultValue: true },
  { key: "precomputeCompactionEnabled", label: "Precalcular la compactación", description: "Prepara el resumen de antemano para que compactar sea instantáneo.", group: GROUPS.sessions, type: "boolean", file: "user", defaultValue: true },
  { key: "fileCheckpointingEnabled", label: "Checkpoints para rebobinar el código", description: "Guarda el estado de los archivos para poder volver atrás con /rewind.", group: GROUPS.sessions, type: "boolean", file: "user", defaultValue: true },
  { key: "respectGitignore", label: "Respetar .gitignore al buscar archivos", description: "El selector de archivos (@) ignora lo que está en .gitignore.", group: GROUPS.sessions, type: "boolean", file: "user", defaultValue: true },
  { key: "autoContinueAtUsageLimit", label: "Seguir solo al renovarse el límite de uso", description: "Si se llega al límite del plan, la sesión retoma sola cuando se renueva.", group: GROUPS.sessions, type: "boolean", file: "user", defaultValue: true },
  { key: "useAutoModeDuringPlan", label: "Modo auto durante el plan", description: "En modo plan, usa el modo auto para las aprobaciones.", group: GROUPS.sessions, type: "boolean", file: "user", defaultValue: true },
  { key: "askUserQuestionTimeout", label: "Si no respondés una pregunta", description: "Cuánto espera Claude antes de seguir sin tu respuesta.", group: GROUPS.sessions, type: "enum", file: "user", defaultValue: "never",
    options: [o("never", "Espera siempre"), o("60s", "Sigue al minuto"), o("5m", "Sigue a los 5 minutos"), o("10m", "Sigue a los 10 minutos")] },
  { key: "modelProposedGoals", label: "Objetivos propuestos por Claude", description: "Si Claude puede proponer objetivos de sesión.", group: GROUPS.sessions, type: "enum", file: "user", defaultValue: "auto",
    options: [o("auto", "Automático"), o("alwaysAsk", "Preguntar siempre"), o("disabled", "Desactivado")] },
  { key: "feedbackDrafts", label: "Borradores de feedback", description: "Cuando algo sale mal, Claude puede redactar un reporte para Anthropic.", group: GROUPS.sessions, type: "enum", file: "user", defaultValue: "notify",
    options: [o("notify", "Avisar"), o("quiet", "Sin avisar"), o("off", "Desactivado")] },
  { key: "worktree.baseRef", label: "Base de los worktrees", description: "Desde dónde se crea la rama de un worktree nuevo.", group: GROUPS.sessions, type: "enum", file: "user", defaultValue: "fresh",
    options: [o("fresh", "Rama principal actualizada"), o("head", "El commit actual")] },

  // Notificaciones
  { key: "preferredNotifChannel", label: "Notificaciones locales", description: "Cómo te avisa la terminal cuando Claude termina o te necesita.", group: GROUPS.notifications, type: "enum", file: "user", defaultValue: "auto", terminalOnly: true,
    options: [o("auto", "Automático"), o("iterm2", "iTerm2"), o("terminal_bell", "Campana de la terminal"), o("iterm2_with_bell", "iTerm2 con campana"), o("kitty", "Kitty"), o("ghostty", "Ghostty"), o("notifications_disabled", "Desactivadas")] },
  { key: "agentPushNotifEnabled", label: "Push cuando Claude lo decide", description: "Notificaciones al celular (Remote Control) cuando Claude cree que tenés que enterarte.", group: GROUPS.notifications, type: "boolean", file: "user", defaultValue: false },
  { key: "inputNeededNotifEnabled", label: "Push cuando hace falta una acción tuya", description: "Notificación al celular cuando una sesión espera una respuesta o un permiso.", group: GROUPS.notifications, type: "boolean", file: "user", defaultValue: false },

  // Varias sesiones y Remote Control
  { key: "crossSessionInbound", label: "Mensajes de tus otras sesiones", description: "Qué hacer con los mensajes que llegan de otras sesiones. Las del dashboard siempre los aceptan.", group: GROUPS.multi, type: "enum", file: "user", defaultValue: "default", unsetValue: "default",
    options: [o("default", "Según el modo de permisos"), o("accept", "Aceptar"), o("hold", "Retener hasta aprobarlos"), o("refuse", "Rechazar")] },
  { key: "dialogExpiry", label: "Vencimiento de los diálogos", description: "Cuánto espera un diálogo de aprobación antes de cerrarse solo.", group: GROUPS.multi, type: "enum", file: "user", defaultValue: "default", unsetValue: "default",
    options: [o("default", "Por defecto (5 minutos)"), o("60s", "1 minuto"), o("5m", "5 minutos"), o("10m", "10 minutos"), o("never", "Nunca")] },
  { key: "remoteControlAtStartup", label: "Remote Control en todas las sesiones", description: "Conecta cada sesión a claude.ai y a la app del celular al arrancar.", group: GROUPS.multi, type: "enum", file: "user", defaultValue: "default", unsetValue: "default", booleanEnum: true,
    options: [o("default", "Por defecto"), o("true", "Activado"), o("false", "Desactivado")] },

  // IDE y copiado (config global)
  { key: "autoConnectIde", label: "Conectar al IDE automáticamente", description: "Desde una terminal externa, se conecta al VS Code o JetBrains que esté abierto.", group: GROUPS.ide, type: "boolean", file: "global", defaultValue: false, terminalOnly: true },
  { key: "autoInstallIdeExtension", label: "Instalar la extensión del IDE", description: "Instala la extensión de Claude Code al abrirlo desde la terminal del IDE.", group: GROUPS.ide, type: "boolean", file: "global", defaultValue: true, terminalOnly: true },
  { key: "copyOnSelect", label: "Copiar al seleccionar", description: "Copia automáticamente el texto que seleccionás en la vista completa.", group: GROUPS.ide, type: "boolean", file: "global", defaultValue: true, terminalOnly: true },
  { key: "diffTool", label: "Dónde abrir los cambios", description: "Si los diffs se abren en el IDE conectado o quedan en la terminal.", group: GROUPS.ide, type: "enum", file: "global", defaultValue: "auto", terminalOnly: true,
    options: [o("auto", "Automático (IDE si hay)"), o("terminal", "En la terminal")] },
]

function readJson(file: string): Record<string, unknown> {
  try {
    return readJsonForWrite(file)
  } catch {
    return {}
  }
}

/**
 * Para escribir, un archivo que existe pero no se puede leer no se toca: tratarlo como vacío
 * borraría todo lo demás que tiene (hooks, permisos, servidores MCP…).
 */
function readJsonForWrite(file: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} no es JSON válido. Corregilo a mano; no lo modifiqué.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} no tiene un objeto JSON. Corregilo a mano; no lo modifiqué.`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Escritura atómica que conserva el resto del archivo y sus permisos (.claude.json suele ser privado).
 * Si es un symlink (dotfiles), se escribe el archivo al que apunta y el enlace queda como estaba.
 */
function writeJson(file: string, data: Record<string, unknown>) {
  let target = file
  let mode = 0o600
  try {
    target = fs.realpathSync(file)
    mode = fs.statSync(target).mode & 0o777
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  const tmp = `${target}.control-plane-${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode })
  fs.renameSync(tmp, target)
}

/** Lee un settings.json (vacío si no existe) sin fallar: para mostrar. */
export function readSettingsFile(file: string): Record<string, unknown> {
  return readJson(file)
}

/**
 * Cambia un archivo de settings con las mismas garantías que /config: si no es JSON válido no se
 * toca, se escribe de forma atómica, conserva permisos y symlinks.
 */
export function updateSettingsFile(file: string, mutate: (data: Record<string, unknown>) => void) {
  const data = readJsonForWrite(file)
  mutate(data)
  writeJson(file, data)
}

function getPath(obj: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj)
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split(".")
  let cur = obj
  for (const k of parts.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  const last = parts.at(-1)!
  if (value === undefined) delete cur[last]
  else cur[last] = value
}

export interface SettingsFiles {
  user: string
  global: string
}

function modelOptions(models: ModelOption[]): Opt[] {
  return [o("default", "El recomendado"), ...models.filter((m) => m.value !== "default").map((m) => o(m.value, m.label))]
}

function toView(def: Def, stored: unknown, models: ModelOption[]): ClaudeSetting {
  const isSet = stored !== undefined
  let value: ClaudeSettingValue
  if (!isSet) value = def.defaultValue
  else if (def.booleanEnum) value = String(stored)
  else value = typeof stored === "boolean" || typeof stored === "string" ? stored : String(stored)
  let options = def.key === "model" ? modelOptions(models) : def.options
  // Si el valor guardado no está en la lista (una versión más nueva de Claude Code), se muestra igual.
  if (options && typeof value === "string" && !options.some((x) => x.value === value)) options = [...options, o(value, value)]
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    group: def.group,
    type: def.type,
    options,
    file: def.file,
    value,
    defaultValue: def.defaultValue,
    isSet,
    ...(def.terminalOnly ? { terminalOnly: true } : {}),
  }
}

export function readSettings(files: SettingsFiles, models: ModelOption[]): ClaudeSetting[] {
  const user = readJson(files.user)
  const global = readJson(files.global)
  return SETTING_DEFS.map((def) => toView(def, getPath(def.file === "user" ? user : global, def.key), models))
}

/** Cambia una opción como lo haría /config. Claude Code relee settings.json solo en las sesiones abiertas. */
export function writeSetting(files: SettingsFiles, key: string, value: ClaudeSettingValue, models: ModelOption[]): ClaudeSetting {
  const def = SETTING_DEFS.find((d) => d.key === key)
  if (!def) throw new Error(`No conozco la opción ${key}`)
  let stored: unknown
  if (def.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("Tiene que ser verdadero o falso")
    stored = value
  } else {
    if (typeof value !== "string") throw new Error("Valor inválido")
    const options = def.key === "model" ? modelOptions(models) : (def.options ?? [])
    if (!options.some((x) => x.value === value) && def.key !== "model") throw new Error(`Valor inválido para ${def.label}`)
    if (value === def.unsetValue) stored = undefined
    else if (def.booleanEnum) stored = value === "true"
    else stored = value
  }
  const file = def.file === "user" ? files.user : files.global
  const data = readJsonForWrite(file)
  setPath(data, def.key, stored)
  writeJson(file, data)
  return toView(def, getPath(data, def.key), models)
}
