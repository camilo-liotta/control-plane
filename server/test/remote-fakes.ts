import type { RoutesDeps } from "../src/routes.ts"

export interface Call {
  fn: string
  args: unknown[]
}

/**
 * Las dependencias falsas de la API para probar las rutas que se abren por nivel (respond y control):
 * guardan cada llamada y devuelven lo mínimo. El permiso pendiente se carga con `pending.set("s1:r1", {...})`.
 */
export function fakeApi() {
  const calls: Call[] = []
  const rec =
    (fn: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ fn, args })
      return ret
    }
  const pending = new Map<string, { toolName: string; input: Record<string, unknown> }>()
  const deps = {
    db: {
      getSession: (id: string) => (id === "s1" ? { id: "s1", archivedAt: null, projectId: "p1", kind: "worker", taskState: "assigned" } : undefined),
      getProject: (id: string) => (id === "p1" ? { id: "p1", archivedAt: null } : undefined),
    },
    sessions: {
      send: rec("sessions.send", { ok: true }),
      interrupt: rec("sessions.interrupt"),
      start: rec("sessions.start"),
      stop: rec("sessions.stop"),
      answerQuestion: rec("sessions.answerQuestion"),
      respondPermission: rec("sessions.respondPermission"),
      requestCancelScheduled: rec("sessions.requestCancelScheduled", { ok: true }),
      pendingPermission: (sid: string, rid: string) => pending.get(`${sid}:${rid}`) ?? null,
    },
    orchestration: {
      sendDraft: rec("orchestration.sendDraft", { id: "d1" }),
      editDraft: rec("orchestration.editDraft", { id: "d1" }),
      discardDraft: rec("orchestration.discardDraft", { id: "d1" }),
      projectView: (p: unknown) => p,
      plans: {
        userPause: rec("plans.userPause", { ok: true }),
        resume: rec("plans.resume", { ok: true }),
        cancel: rec("plans.cancel", { ok: true }),
      },
    },
    afk: { start: rec("afk.start", { id: "p1" }), stop: rec("afk.stop", { id: "p1" }) },
    attachments: { get: () => undefined },
  } as unknown as Partial<RoutesDeps>
  return {
    deps,
    calls,
    pending,
    count: (fn: string) => calls.filter((c) => c.fn === fn).length,
    last: (fn: string) => calls.filter((c) => c.fn === fn).at(-1)?.args,
  }
}
