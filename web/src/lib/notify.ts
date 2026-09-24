import { toast } from "sonner"
import { navigate } from "wouter/use-browser-location"

import type { ServerMessage } from "@shared/types"

type ToastMessage = Extract<ServerMessage, { type: "toast" }>

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window
}

export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false
  if (Notification.permission === "granted") return true
  return (await Notification.requestPermission()) === "granted"
}

function target(msg: ToastMessage) {
  if (msg.projectId && msg.sessionId) return `/p/${msg.projectId}/s/${msg.sessionId}`
  if (msg.projectId) return `/p/${msg.projectId}`
  return null
}

export function notify(msg: ToastMessage) {
  const href = target(msg)
  const options = {
    description: msg.body,
    action: href ? { label: "Ver", onClick: () => navigate(href) } : undefined,
  }
  if (msg.level === "success") toast.success(msg.title, options)
  else if (msg.level === "warn") toast.warning(msg.title, options)
  else if (msg.level === "error") toast.error(msg.title, options)
  else toast.info(msg.title, options)

  // Si estás en otra pestaña o ventana, avisa el sistema operativo.
  if (document.hidden && notificationsSupported() && Notification.permission === "granted") {
    const n = new Notification(msg.title, { body: msg.body, tag: msg.sessionId ?? msg.projectId })
    n.onclick = () => {
      window.focus()
      if (href) navigate(href)
      n.close()
    }
  }
}
