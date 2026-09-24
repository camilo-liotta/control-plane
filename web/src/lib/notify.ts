import { useEffect, useState } from "react"
import { toast } from "sonner"
import { navigate } from "wouter/use-browser-location"

import type { ServerMessage } from "@shared/types"

import { useUi } from "./ui"

type ToastMessage = Extract<ServerMessage, { type: "toast" }>

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

function hrefFor(msg: { projectId?: string; sessionId?: string }) {
  if (msg.projectId && msg.sessionId) return `/p/${msg.projectId}/s/${msg.sessionId}`
  if (msg.projectId) return `/p/${msg.projectId}`
  return null
}

function open(msg: ToastMessage) {
  const href = hrefFor(msg)
  if (href) navigate(href)
  if (msg.open === "compaction" && msg.sessionId) useUi.getState().set({ compactFor: msg.sessionId })
}

/** Muestra una notificación del sistema operativo. Devuelve false si el navegador no la dejó salir. */
export function systemNotification(title: string, body: string | undefined, onClick?: () => void, tag?: string): boolean {
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
  const href = hrefFor(msg)
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

  // Si no estás mirando el dashboard (otra pestaña, otra ventana, otra app), avisa el sistema.
  const away = document.hidden || !document.hasFocus()
  if (away && osNotificationsEnabled()) systemNotification(msg.title, msg.body, () => open(msg), msg.sessionId ?? msg.projectId)
}
