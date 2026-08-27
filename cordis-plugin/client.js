// Token Observatory — Cordis dynamic plugin (browser half only).
// Sidebar entry → frame-wide overlay embedding the local dashboard server
// (http://127.0.0.1:3180) in an iframe. The host half owns the server's
// lifecycle, so clicking the entry works without any manual `start.sh`.
//
// Written against the cordis-plugin-development skill rules:
//   - plain JS, no import/require/JSX/fetch/native timers
//   - React.createElement only; styles via styles.insert (guarded)
//   - slots through ctx.get('slots') + slots.inject + slots.register
//   - readiness polling through host.call('tok-obs-status') + the timer
//     Service only when both are available (graceful fallback)
// NOTE for the authoring (creation-mode) agent: verify `sidebar.footer.action`
// and `shell.overlay` against the live Slots.listSubTree before running; keep
// this business logic but adjust registration options/keys/props to the exact
// protocol returned.
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const timer = ctx.get('timer') // optional: used only for readiness polling
    const canPoll = typeof host !== 'undefined' && typeof host.call === 'function' && timer !== undefined

    const listeners = new Set()
    let open = false
    const setOpen = (v) => { open = v; listeners.forEach((fn) => fn()) }
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

    if (typeof styles !== 'undefined') {
      styles.insert(`
        .tok-obs-btn { cursor: pointer; }
        .tok-obs-backdrop {
          position: fixed; inset: 0; z-index: 9990;
          background: rgba(19,19,22,.32); backdrop-filter: blur(2px);
          display: flex; align-items: stretch; justify-content: center;
          padding: 28px; pointer-events: auto;
        }
        .tok-obs-panel {
          display: flex; flex-direction: column;
          width: min(1280px, 96vw); background: #FAFAFA;
          border: 1px solid #E8E8EC; border-radius: 14px;
          box-shadow: 0 24px 80px rgba(19,19,22,.25); overflow: hidden;
        }
        .tok-obs-head {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 16px; background: #fff; border-bottom: 1px solid #E8E8EC;
          font: 600 13px "Space Grotesk", "PingFang SC", sans-serif; color: #131316;
        }
        .tok-obs-ext { margin-left: auto; font: 400 11.5px "JetBrains Mono", monospace; color: #55555E; text-decoration: none; }
        .tok-obs-ext:hover { color: #131316; text-decoration: underline; }
        .tok-obs-close {
          font: 500 11.5px "Space Grotesk", "PingFang SC", sans-serif;
          border: 1px solid #E8E8EC; background: #fff; color: #55555E;
          border-radius: 7px; padding: 4px 10px; cursor: pointer;
        }
        .tok-obs-close:hover { color: #131316; border-color: #8E8E98; }
        .tok-obs-hint {
          padding: 5px 16px; font: 400 10.5px "JetBrains Mono", monospace;
          color: #8E8E98; background: #fff; border-bottom: 1px solid #F2F2F5;
        }
        .tok-obs-frame { flex: 1; border: 0; width: 100%; background: #FAFAFA; }
        .tok-obs-wait { flex: 1; display: grid; place-items: center; font: 400 12px "JetBrains Mono", monospace; color: #8E8E98; }
      `)
    }

    function EntryButton() {
      return React.createElement('button', {
        className: 'tok-obs-btn',
        title: 'Token Observatory — dsh/codex/claude token usage',
        onClick: () => setOpen(true),
      }, 'Token Observatory')
    }

    function Overlay() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      const [ready, setReady] = React.useState(!canPoll) // show iframe immediately when polling is impossible
      React.useEffect(() => subscribe(force), [])

      // Poll the host half until the dashboard server answers, then mount the iframe.
      React.useEffect(() => {
        if (!canPoll) return
        let tries = 0
        const unsub = ctx.interval(() => {
          host.call('tok-obs-status', {}).then((r) => {
            if (r && r.up) { unsub(); setReady(true) }
          }).catch(() => {})
          if (++tries >= 30) { unsub(); setReady(true) } // give up waiting: show iframe anyway
        }, 700)
        return unsub
      }, [])

      if (!open) return null
      return React.createElement('div', { className: 'tok-obs-backdrop', onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) } },
        React.createElement('div', { className: 'tok-obs-panel' },
          React.createElement('div', { className: 'tok-obs-head' },
            React.createElement('span', null, 'Token Observatory'),
            React.createElement('a', { className: 'tok-obs-ext', href: 'http://127.0.0.1:3180', target: '_blank', rel: 'noreferrer' }, 'open in new tab'),
            React.createElement('button', { className: 'tok-obs-close', onClick: () => setOpen(false) }, 'close'),
          ),
          React.createElement('div', { className: 'tok-obs-hint' },
            ready ? 'data: http://127.0.0.1:3180 · 服务由插件维护，随 dsh 启停'
                 : '正在拉起本地服务…'),
          ready
            ? React.createElement('iframe', { className: 'tok-obs-frame', src: 'http://127.0.0.1:3180/', title: 'Token Observatory' })
            : React.createElement('div', { className: 'tok-obs-wait' }, 'starting local service…'),
        ),
      )
    }

    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'token-observatory-entry' },
      () => React.createElement(EntryButton),
    ))

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'token-observatory-overlay' },
      () => React.createElement(Overlay),
    ))
  },
}