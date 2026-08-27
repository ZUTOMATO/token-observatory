// Token Observatory — Cordis dynamic plugin (host half).
// Owns the dashboard server's lifecycle while this plugin is running:
//   - on apply: if http://127.0.0.1:3180 does not answer, spawn the server
//   - exposes harness.handle('tok-obs-status') so the client can poll readiness
//   - on stop: kills only the child it started (ctx.effect disposer)
// No boot autostart, no manual `start.sh`: the server lives as long as the
// dsh process + this plugin, and the GUI entry point lives in the same window.
//
// RECONCILIATION (creation-mode agent, before cordis_run):
//   - Query Service.listService for 'subprocess' / 'bash' / 'web' and confirm
//     the EXACT spawn & fetch method names and argument shapes; adjust
//     startServer() / isUp() call sites only, keep the business flow intact.
//   - `harness` is a Builtin; confirm it with Builtin.listBuiltins.
return {
  apply(ctx) {
    const serverPath = '/home/zutomato/token-dashboard'
    const portUrl = 'http://127.0.0.1:3180/api/stats'
    let child = null

    const sub = ctx.get('subprocess')   // may be undefined — see reconciliation
    const bash = ctx.get('bash')
    const web = ctx.get('web')

    const isUp = async () => {
      if (!web) return false
      try {
        // Reconcile: exact method/args of the web Service (e.g. web.fetch(url)).
        const res = await web.fetch(portUrl)
        return !!res && res.status !== undefined ? res.status < 500 : true
      } catch {
        return false
      }
    }

    const startServer = () => {
      if (child) return true
      if (!sub && !bash) return false // no spawn capability — client shows hint
      // Reconcile: exact spawn call of the resolved Service.
      if (sub) {
        // Expected shape (confirm): sub.spawn('node', [serverPath + '/server.js'], { stdio: 'ignore' })
        child = sub.spawn('node', [serverPath + '/server.js'], { stdio: 'ignore' })
      } else {
        child = bash.run(`cd ${serverPath} && nohup node server.js >/dev/null 2>&1 &`)
      }
      return true
    }

    // Ensure the server is up; keep the child tied to this plugin fiber.
    ctx.effect(async () => {
      const up = await isUp()
      if (!up) startServer()
      return () => {
        if (child && typeof child.kill === 'function') { try { child.kill() } catch {} child = null }
      }
    })

    if (typeof harness !== 'undefined' && typeof harness.handle === 'function') {
      harness.handle('tok-obs-status', async () => ({ up: await isUp(), port: 3180, ts: Date.now() }))
    }
  },
}