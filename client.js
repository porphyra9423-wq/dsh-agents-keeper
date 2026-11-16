window.__ModuleLoader__.load({
  id: 'dsh-agents-keeper',
  factory: (require) => {
    const ReactModule = require('react')
    const React = ReactModule && ReactModule.default && ReactModule.default.useState ? ReactModule.default : ReactModule
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const API = '/agents-keeper/api'

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 24px' },
      title: { fontSize: 15, fontWeight: 600 },
      sub: { fontSize: 12.5, opacity: 0.62, lineHeight: 1.55, margin: 0 },
      card: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.24))',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      row: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 },
      label: { opacity: 0.6, minWidth: 96, flex: '0 0 auto' },
      value: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, wordBreak: 'break-all' },
      buttons: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 },
      button: {
        fontSize: 12.5,
        padding: '5px 11px',
        borderRadius: 7,
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: { borderColor: 'var(--dsh-accent, #3b82f6)', color: 'var(--dsh-accent, #3b82f6)' },
      badge: { fontSize: 11.5, padding: '1px 7px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.85 },
      diff: {
        margin: 0,
        maxHeight: 260,
        overflow: 'auto',
        fontSize: 12,
        lineHeight: 1.5,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'var(--dsh-code-bg, rgba(128,128,128,0.10))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
      },
      notice: { fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
      hint: { fontSize: 12, opacity: 0.65, lineHeight: 1.6, margin: 0 },
    }

    async function request(path, init) {
      try {
        const response = await fetch(path, init)
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (body === null || typeof body !== 'object') {
          return { ok: false, message: `HTTP ${response.status}` }
        }
        return { ...body, ok: body.ok === true }
      } catch (error) {
        return { ok: false, message: String(error) }
      }
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '从未'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    function Line({ label, children }) {
      return h('div', { style: S.row }, h('span', { style: S.label }, label), h('span', { style: S.value }, children))
    }

    function Button({ onClick, disabled, tone, children }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        style: { ...S.button, ...(tone === 'primary' ? S.primary : {}), opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' },
      }, children)
    }

    function Section() {
      const [status, setStatus] = useState(null)
      const [diff, setDiff] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')

      const load = useCallback(async () => {
        const next = await request(`${API}/status`)
        setStatus(next)
        if (next.ok && next.pending && next.pending.exists) {
          const pending = await request(`${API}/pending`)
          setDiff(pending.ok && typeof pending.diff === 'string' ? pending.diff : '')
        } else {
          setDiff('')
        }
        return next
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const runApply = useCallback(async () => {
        if (!window.confirm('把待定提案写入 AGENTS.md？写入前会自动备份当前版本。')) return
        setBusy('apply')
        setNotice('')
        const result = await request(`${API}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        setBusy('')
        setNotice(result.ok
          ? (result.applied === false ? '提案与当前文件一致，未写入。' : `已写入 ${formatBytes(result.bytes)}；备份：${result.backup || '（原来没有文件）'}`)
          : `写入失败：${result.message || result.code || '未知错误'}`)
        await load()
      }, [load])

      const runRevert = useCallback(async () => {
        if (!window.confirm('恢复上一版 AGENTS.md？当前版本会先备份。')) return
        setBusy('revert')
        setNotice('')
        const result = await request(`${API}/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 0 }) })
        setBusy('')
        setNotice(result.ok ? `已恢复 ${result.from}` : `恢复失败：${result.message || result.code || '未知错误'}`)
        await load()
      }, [load])

      const runPropose = useCallback(async (mode) => {
        setBusy(mode)
        setNotice('')
        const result = await request(`${API}/propose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
        setBusy('')
        setNotice(result.ok
          ? `已启动子代理（${String(result.childId || '').slice(0, 8)}），完成后回到对话查看。`
          : (result.message || '无法启动：请回到对话使用 /agents-sync'))
      }, [])

      if (status === null) {
        return h('div', { style: S.root }, h('div', { style: S.title }, '工作区指南'), h('p', { style: S.sub }, '正在读取状态…'))
      }

      const header = h('div', { style: S.root },
        h('div', { style: S.title }, '工作区指南 · AGENTS.md'),
        h('p', { style: S.sub }, '官方加载器负责把 AGENTS.md 读进每一轮对话；这个插件只负责另一半：发现项目变了 → 在后台起草新版本 → 你看过 diff 再写入。全程不自动改文件。'))

      if (!status.ok) {
        const noWorkspace = status.code === 'no-workspace'
        return h('div', { style: S.root },
          header,
          h('div', { style: S.card },
            h('div', { style: S.notice }, noWorkspace
              ? '还没有观察到工作目录。打开一个项目会话（或在本项目里发一条消息），再回来刷新。'
              : `读取失败：${status.message || status.code || '未知错误'}`),
            h('div', { style: S.buttons },
              h(Button, { onClick: () => { setBusy('refresh'); void load().then(() => setBusy('')) }, disabled: busy !== '' }, '刷新'))))
      }

      const exists = status.exists === true
      const changed = status.changes || { count: 0, files: [], source: 'git' }
      const pending = status.pending || { exists: false }
      const backups = Array.isArray(status.backups) ? status.backups : []

      return h('div', { style: S.root },
        header,
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.label }, '文件'),
            h('span', { style: S.value }, status.agentsFile),
            exists
              ? h('span', { style: { ...S.badge, color: status.overBudget ? 'var(--dsh-danger, #dc2626)' : 'var(--dsh-ok, #16a34a)' } }, status.overBudget ? '超预算' : '正常')
              : h('span', { style: { ...S.badge, color: 'var(--dsh-warn, #d97706)' } }, '不存在')),
          h(Line, { label: '大小' }, exists ? `${formatBytes(status.bytes)} / ${formatBytes(status.budgetBytes)}` : '—'),
          h(Line, { label: '上次同步' }, formatTime(status.lastSyncAt)),
          h(Line, { label: '工作树变化' }, `${changed.count} 个文件（${changed.source === 'git' ? 'git' : 'mtime'}）`),
          changed.files.length > 0
            ? h('div', { style: { ...S.value, opacity: 0.75 } }, changed.files.slice(0, 6).join(' · ') + (changed.count > 6 ? ' …' : ''))
            : null,
          pending.exists
            ? h('div', { style: S.row },
              h('span', { style: S.label }, '待定提案'),
              h('span', { style: { ...S.badge, color: 'var(--dsh-accent, #3b82f6)' } }, pending.mode === 'compact' ? '精简' : '更新'),
              h('span', { style: { ...S.value, opacity: 0.7 } }, formatTime(pending.createdAt)))
            : null,
          h('div', { style: S.buttons },
            h(Button, { onClick: () => { setBusy('refresh'); setNotice(''); void load().then(() => setBusy('')) }, disabled: busy !== '' }, busy === 'refresh' ? '刷新中…' : '刷新状态'),
            h(Button, { tone: 'primary', onClick: () => runPropose('update'), disabled: busy !== '' || !exists }, busy === 'update' ? '启动中…' : '生成更新预览'),
            h(Button, { onClick: () => runPropose('compact'), disabled: busy !== '' || !exists }, busy === 'compact' ? '启动中…' : '生成精简版'),
            h(Button, { onClick: runApply, disabled: busy !== '' || !pending.exists }, busy === 'apply' ? '写入中…' : '应用提案'),
            backups.length > 0 ? h(Button, { onClick: runRevert, disabled: busy !== '' }, busy === 'revert' ? '恢复中…' : '撤销上次写入') : null),
          notice.length > 0 ? h('div', { style: S.notice }, notice) : null),
        diff.length > 0
          ? h('div', { style: S.card },
            h('div', { style: { ...S.sub, fontSize: 12.5 } }, '待定提案的 diff（+ 新增 / - 删除）'),
            h('pre', { style: S.diff }, diff))
          : null,
        h('p', { style: S.hint },
          '提示：生成预览需要子代理，只能在对话里触发更可靠 —— 发送 /agents-sync（按变更更新）或 /agents-compact（压缩）。',
          '状态、提案与备份都存放在 DSH_HOME/agents-keeper/ 下，不会写进你的仓库；模型也能用 agents_md_status / agents_md_propose / agents_md_apply / agents_md_revert 这四个工具完成同样的事。'))
    }

    function SectionIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M6 3.5h8.5L19 8v12.5H6z' }),
        h('path', { d: 'M14 3.5V8h4.5' }),
        h('path', { d: 'M9 12.5h7M9 16h5' }))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'agents-keeper',
        order: 44,
        label: () => '工作区指南',
        inject: () => ({}),
      }, Section))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: 'agents-keeper',
      }, SectionIcon))
    }

    return { inject: ['slots'], apply }
  },
})
