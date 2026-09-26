import { useEffect, useState } from "react"
import { toast } from "sonner"
import { navigate } from "wouter/use-browser-location"

import { noticeHref, noticeOpen } from "@shared/notice"
import type { NoticeOpen, ServerMessage } from "@shared/types"

import { playNotice } from "./sounds"
import { useStore } from "./store"
import { useUi } from "./ui"

type ToastMessage = Extract<ServerMessage, { type: "toast" }>

/** A dónde lleva la app de escritorio: un href o los campos del toast tal cual. */
export type DesktopTarget = string | { projectId?: string; sessionId?: string; open?: NoticeOpen }

declare global {
  interface Window {
    /** Lo define la app de escritorio antes de cargar la página. */
    __CONTROL_PLANE_DESKTOP__?: { version: string }
    /** Lo que llama la app de escritorio (desde Rust, con eval) para mover la ventana. */
    __cpDesktop?: {
      open: (target: DesktopTarget) => boolean
      inbox: () => void
    }
  }
}

/** Si la web corre dentro de la app de escritorio. */
export function inDesktop() {
  return typeof window !== "undefined" && typeof window.__CONTROL_PLANE_DESKTOP__ === "object" && window.__CONTROL_PLANE_DESKTOP__ !== null
}

export type NotifyPermission = NotificationPermission | "unsupported"

const PREF_KEY = "control-plane:os-notifications"

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window
}

function currentPermission(): NotifyPermission {
  return notificationsSupported() ? Notification.permission : "unsupported"
}

/** Tu preferencia en este navegador (independiente del permiso): por defecto, prendidos. */
export function osNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off"
  } catch {
    return true
  }
}

const listeners = new Set<() => void>()
const changed = () => listeners.forEach((fn) => fn())

export function setOsNotificationsEnabled(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off")
  } catch {
    // sin almacenamiento local: vale para esta pestaña
  }
  changed()
}

export async function requestNotifications(): Promise<NotifyPermission> {
  if (!notificationsSupported()) return "unsupported"
  if (Notification.permission === "default") await Notification.requestPermission()
  changed()
  return Notification.permission
}

/** Permiso y preferencia, actualizados si cambian (también si los cambiás desde el navegador). */
export function useNotifications() {
  const [state, setState] = useState(() => ({ permission: currentPermission(), enabled: osNotificationsEnabled() }))
  useEffect(() => {
    const refresh = () => setState({ permission: currentPermission(), enabled: osNotificationsEnabled() })
    listeners.add(refresh)
    let status: PermissionStatus | null = null
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((s) => {
        status = s
        s.onchange = refresh
      })
      .catch(() => {})
    window.addEventListener("focus", refresh)
    return () => {
      listeners.delete(refresh)
      if (status) status.onchange = null
      window.removeEventListener("focus", refresh)
    }
  }, [])
  return state
}

/** Lo que hace tocar un aviso (el "Ver" del toast, la notificación del sistema o la app de escritorio). */
function open(msg: Pick<ToastMessage, "projectId" | "sessionId" | "open">) {
  const href = noticeHref(msg)
  if (href) navigate(href)
  const set = useUi.getState().set
  if (msg.open === "compaction" && msg.sessionId) set({ compactFor: msg.sessionId })
  // La página de destino baja hasta lo que hay que mirar (ver `reveal` en ui.ts).
  if (msg.open === "proposals" && msg.sessionId) set({ reveal: { kind: "proposals", id: msg.sessionId, at: Date.now() } })
  if (msg.open === "tasks" && msg.projectId) set({ reveal: { kind: "tasks", id: msg.projectId, at: Date.now() } })
}

/**
 * Muestra una notificación del sistema operativo. Devuelve false si el navegador no la dejó salir.
 * Con la app de escritorio (adentro o conectada al server) no hace nada: los avisos los manda ella.
 */
export function systemNotification(title: string, body: string | undefined, onClick?: () => void, tag?: string): boolean {
  if (inDesktop() || useStore.getState().desktopConnected) return false
  if (!notificationsSupported() || Notification.permission !== "granted") return false
  try {
    const n = new Notification(title, { body, tag, icon: "/favicon.svg" })
    n.onclick = () => {
      window.focus()
      onClick?.()
      n.close()
    }
    return true
  } catch {
    return false
  }
}

export function notify(msg: ToastMessage) {
  const href = noticeHref(msg)
  const options = {
    description: msg.body,
    action: href || msg.open ? { label: msg.open === "compaction" ? "Elegir" : "Ver", onClick: () => open(msg) } : undefined,
    // Los que piden una decisión tuya quedan más tiempo en pantalla.
    duration: msg.open || msg.level === "warn" ? 30_000 : undefined,
  }
  if (msg.level === "success") toast.success(msg.title, options)
  else if (msg.level === "warn") toast.warning(msg.title, options)
  else if (msg.level === "error") toast.error(msg.title, options)
  else toast.info(msg.title, options)

  // El sonido va aparte de las notificaciones del sistema (se configura en el parlante de la barra).
  const event = msg.event ?? (msg.level === "error" ? "error" : msg.level === "warn" ? "needs_you" : null)
  if (event) playNotice(event)

  // Si no estás mirando el dashboard (otra pestaña, otra ventana, otra app), avisa el sistema.
  const away = document.hidden || !document.hasFocus()
  if (away && osNotificationsEnabled()) systemNotification(msg.title, msg.body, () => open(msg), msg.sessionId ?? msg.projectId)
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

/** Para la app de escritorio: lleva la ventana a un href o a lo que abre el "Ver" de un toast. Ignora lo inválido. */
function openFromDesktop(target: unknown): boolean {
  try {
    if (typeof target === "string") {
      // Solo rutas de la propia web.
      if (!target.startsWith("/") || target.startsWith("//")) return false
      navigate(target)
      return true
    }
    if (!target || typeof target !== "object") return false
    const t = target as Record<string, unknown>
    const sessionId = str(t.sessionId)
    const projectId = str(t.projectId) ?? (sessionId ? useStore.getState().sessions[sessionId]?.projectId : undefined)
    if (!projectId && !sessionId) return false
    open({ projectId, sessionId, open: noticeOpen(t.open) })
    return true
  } catch {
    return false
  }
}

/** Registra window.__cpDesktop, solo dentro de la app de escritorio. */
export function installDesktopApi() {
  if (!inDesktop()) return
  window.__cpDesktop = {
    open: openFromDesktop,
    inbox: () => useUi.getState().set({ inbox: true }),
  }
}
