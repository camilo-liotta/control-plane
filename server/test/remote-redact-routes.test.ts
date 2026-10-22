import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import type { RoutesDeps } from "../src/routes.ts"
import { emptySnapshot, harness, type Harness } from "./remote-harness.ts"

let h: Harness
afterEach(async () => h?.close())

const BS = String.fromCharCode(92)
const WIN_REPO = ["C:", "Users", "example-user", "code", "proyecto-fixture"].join(BS)
const POSIX_REPO = "/home/example-user/code/proyecto-fixture"
const ABSOLUTE = /[A-Za-z]:(\\|\/)|\/home\/|\/Users\//

const project = (repoPath: string) => ({ id: "p1", name: "Proyecto", repoPath, settings: {}, afk: null, accountId: "a1", createdAt: 0, archivedAt: null, review: {} })
const session = (cwd: string) => ({ id: "s1", projectId: "p1", name: "orq", cwd, archivedAt: 1 })

function deps(repoPath: string): Partial<RoutesDeps> {
  const p = project(repoPath)
  return {
    db: {
      listProjects: () => [p],
      listRecentDrafts: () => [],
      listRecentReports: () => [],
      listArchivedProjects: () => [{ ...p, archivedAt: 1 }],
      getProject: () => p,
      listArchivedSessions: () => [session(repoPath)],
    },
    orchestration: { projectView: (x: unknown) => x, reportView: (r: unknown) => r },
    sessions: { list: () => [session(repoPath)], usageFor: () => null, turns: () => [], meta: emptySnapshot().meta, view: (s: unknown) => s },
    accounts: { list: () => [], view: (a: unknown) => a },
    compaction: { list: () => [] },
    tasks: { list: () => [] },
    environments: { list: () => [] },
    apps: { all: () => [] },
    overview: { get: async () => ({ projectId: "p1", repos: [{ path: repoPath, name: "r", branch: "main" }], sessions: 1 }) },
  } as never
}

const ROUTES = ["/api/snapshot", "/api/projects/archived", "/api/projects/p1/archived", "/api/projects/p1/overview"]

describe("F2: ninguna ruta de lectura remota deja salir rutas absolutas", () => {
  for (const [label, repo] of [["Windows", WIN_REPO], ["POSIX", POSIX_REPO]] as const) {
    for (const route of ROUTES) {
      it(`${label} ${route}: remoto sin ruta absoluta; local igual de siempre`, async () => {
        h = await harness({ deps: deps(repo), snapshot: () => emptySnapshot() })
        await h.enable()
        const { cookie } = await h.pairDevice()
        const remote = await h.remoteRequest("GET", route, { cookie })
        assert.equal(remote.status, 200, remote.body)
        assert.ok(!ABSOLUTE.test(remote.body), `ruta absoluta en ${route}: ${remote.body}`)
        assert.ok(!remote.body.includes("example-user"), remote.body)
        const local = await h.local("GET", route)
        assert.equal(local.status, 200)
        assert.ok(JSON.stringify(JSON.parse(local.body)).includes("example-user"), "el local no cambia")
      })
    }
  }
})
