window.__ModuleLoader__.load({
  id: '@local/healthylife',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = 'healthylife/api'

    function apiUrl(route) {
      try {
        return new URL(`${API}/${route}`, document.baseURI).href
      } catch {
        return `/${API}/${route}`
      }
    }

    async function call(route, body) {
      const init = body === undefined
        ? { method: 'GET', cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
      const response = await fetch(apiUrl(route), init)
      return response.json()
    }

    function useHealth(intervalMs) {
      const [data, setData] = useState(null)
      const [failure, setFailure] = useState('')
      const refresh = useCallback(async () => {
        try {
          const next = await call('state')
          if (next && next.ok) {
            setData({ ...next, _clientAt: Date.now() })
            setFailure('')
          } else {
            setFailure((next && next.error) || '状态读取失败')
          }
        } catch (error) {
          setFailure(String((error && error.message) || error))
        }
      }, [])
      useEffect(() => {
        let alive = true
        const tick = () => {
          if (!alive) return
          void refresh()
        }
        tick()
        const timer = setInterval(tick, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [intervalMs, refresh])
      return { data, failure, refresh, setData }
    }

    const pad = (n) => String(n).padStart(2, '0')

    function clockText(ts) {
      const d = new Date(ts)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** Logon hours are only meaningful inside the curfew window — outside it "not applied" is normal, not a failure. */
    function loginText(data) {
      if (!data) return '—'
      const config = data.config || {}
      if (!config.loginBlock) return '已关闭'
      const login = data.login || {}
      if (login.error) return '失败'
      if (login.applied) return data.active ? '已生效' : '仍限制中'
      const start = data.window ? clockText(data.window.start) : ''
      return start ? `待 ${start} 应用` : '未到时段'
    }

    function humanGap(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '已到点'
      const total = Math.round(ms / 60000)
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      return `${Math.max(1, minutes)} 分钟`
    }

    const PHASE_TEXT = {
      idle: '空闲中',
      warning: '即将进入宵禁',
      countdown: '宵禁倒计时中',
      skipped: '本次已取消',
      exempt: '本次已豁免',
      shutdown: '已下发关机'
    }

    const CSS = `
.hl-page { max-width: 780px; padding: 6px 2px 48px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.65; }
.hl-page *, .hl-page *::before, .hl-page *::after { box-sizing: border-box; }
.hl-head { margin-bottom: 18px; }
.hl-title { font-size: 19px; font-weight: 600; margin: 0 0 4px; letter-spacing: .2px; }
.hl-sub { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.hl-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 14px; padding: 4px 18px; margin-bottom: 14px; }
.hl-card-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 0 6px; }
.hl-card-title { font-size: 12px; font-weight: 600; letter-spacing: .6px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; }
.hl-row { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.hl-row:last-child { border-bottom: none; }
.hl-row-main { flex: 1; min-width: 0; }
.hl-row-title { font-size: 13px; font-weight: 500; }
.hl-row-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.hl-row-ctl { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.hl-switch { position: relative; width: 40px; height: 22px; border-radius: 999px; border: none; padding: 0; cursor: pointer; background: var(--dsw-alias-border-l2); transition: background .18s ease; }
.hl-switch.is-on { background: var(--dsw-alias-brand-primary); }
.hl-switch:disabled { opacity: .45; cursor: not-allowed; }
.hl-switch-knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s ease; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.hl-switch.is-on .hl-switch-knob { transform: translateX(18px); }
.hl-select, .hl-input { height: 30px; min-width: 78px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 0 8px; font-size: 12.5px; outline: none; }
.hl-select:focus, .hl-input:focus { border-color: var(--dsw-alias-brand-primary); }
.hl-btn { height: 32px; padding: 0 14px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12.5px; cursor: pointer; transition: border-color .15s ease, opacity .15s ease; }
.hl-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.hl-btn:disabled { opacity: .45; cursor: not-allowed; }
.hl-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.hl-btn-primary:hover { opacity: .9; }
.hl-btn-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; }
.hl-btn-ghost { background: transparent; }
.hl-status { display: flex; align-items: center; gap: 14px; padding: 14px 0 16px; }
.hl-status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex-shrink: 0; }
.hl-status-dot.is-warning { background: var(--dsw-alias-state-warn-primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); }
.hl-status-dot.is-countdown { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent); }
.hl-status-dot.is-ok { background: var(--dsw-alias-state-success-primary); }
.hl-status-main { flex: 1; }
.hl-status-title { font-size: 14px; font-weight: 600; }
.hl-status-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.hl-metrics { display: flex; gap: 26px; padding: 12px 0 16px; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.hl-metric-label { font-size: 11.5px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary)); }
.hl-metric-value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hl-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px dashed var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 0 8px 8px 0; }
.hl-chip strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
.hl-log { list-style: none; margin: 0; padding: 0; }
.hl-log li { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); font-size: 12.5px; }
.hl-log li:last-child { border-bottom: none; }
.hl-log-time { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.hl-empty { padding: 14px 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.hl-error { margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 12.5px; }
.hl-warn { margin: 2px 0 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); font-size: 12.5px; }
.hl-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 4px 0 12px; }
.hl-actions { display: flex; gap: 10px; padding: 12px 0 14px; flex-wrap: wrap; }

.hl-report { display: flex; gap: 10px; padding: 12px 0 6px; }
.hl-report-day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.hl-report-dot { display: block; width: 20px; height: 20px; border-radius: 7px; }
.hl-report-date { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.hl-day { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.hl-day:last-child { border-bottom: none; }
.hl-day-name { width: 44px; flex-shrink: 0; font-size: 13px; font-weight: 500; }
.hl-day-sep { color: var(--dsw-alias-label-secondary); }
`

    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'hl-switch' + (checked ? ' is-on' : ''),
        disabled,
        onClick: () => onChange(!checked)
      }, h('span', { className: 'hl-switch-knob' }))
    }

    function Select({ value, onChange, options, ariaLabel, disabled }) {
      return h('select', {
        className: 'hl-select',
        value,
        'aria-label': ariaLabel,
        disabled,
        onChange: (event) => onChange(event.target.value)
      }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    const hourOptions = Array.from({ length: 24 }, (_, hour) => ({ value: `${String(hour).padStart(2, '0')}:00`, label: `${String(hour).padStart(2, '0')}:00` }))
    const numberOptions = (max) => Array.from({ length: max + 1 }, (_, n) => ({ value: String(n), label: `${n} 次` }))

    function Row({ title, desc, children }) {
      return h('div', { className: 'hl-row' },
        h('div', { className: 'hl-row-main' },
          h('div', { className: 'hl-row-title' }, title),
          desc ? h('div', { className: 'hl-row-desc' }, desc) : null),
        h('div', { className: 'hl-row-ctl' }, children))
    }

    function Card({ title, children }) {
      return h('section', { className: 'hl-card' },
        title ? h('div', { className: 'hl-card-head' }, h('span', { className: 'hl-card-title' }, title)) : null,
        children)
    }

    function phaseTone(phase) {
      if (phase === 'countdown' || phase === 'shutdown') return 'is-countdown'
      if (phase === 'warning') return 'is-warning'
      if (phase === 'skipped' || phase === 'exempt') return 'is-ok'
      return ''
    }

    function statusLine(data) {
      if (!data) return { title: '读取中…', desc: '' }
      const { phase, window, serverNow } = data
      if (!data.config.curfewEnabled) return { title: '宵禁未开启', desc: '打开「宵禁模式」后按下面的星期与时间生效' }
      if (!window) return { title: '没有生效日', desc: '至少勾选一天并设置时间窗' }
      const start = clockText(window.start)
      const end = clockText(window.end)
      if (phase === 'idle') return { title: '空闲中', desc: `下一轮宵禁 ${start} – ${end}，还有 ${humanGap(window.start - serverNow)}` }
      if (phase === 'warning') return { title: '即将进入宵禁', desc: `${start} 开始，剩余 ${Math.max(0, Math.ceil((window.start - serverNow) / 60000))} 分钟` }
      if (phase === 'countdown' || phase === 'extended') return { title: '宵禁倒计时中', desc: '桌面弹窗正在等待你的选择，未操作将在倒计时结束后关机' }
      if (phase === 'skipped') return { title: '本次已取消', desc: `今晚剩余 ${data.quota.left} 次取消机会` }
      if (phase === 'exempt') return { title: `本次已豁免：${data.reason || '自动场景'}`, desc: '豁免已占用一次取消次数' }
      if (phase === 'shutdown') return { title: '已下发关机指令', desc: `电脑即将关闭，${end} 后恢复可用` }
      return { title: PHASE_TEXT[phase] || phase, desc: '' }
    }

    const OUTCOME_META = {
      shutdown: { label: '关机', color: 'var(--dsw-alias-state-error-primary)' },
      cancel: { label: '取消', color: 'var(--dsw-alias-state-warn-primary)' },
      exempt: { label: '豁免', color: 'var(--dsw-alias-state-success-primary)' },
      none: { label: '未触发', color: 'var(--dsw-alias-border-l2)' }
    }
    const outcomeMeta = (key) => OUTCOME_META[key] || OUTCOME_META.none

    function guardActiveText(data) {
      if (!data) return '—'
      if (!data.config.curfewEnabled) return '未开启'
      if (!data.guard) return '没有生效日'
      if (data.guard.active) return '守护中'
      if (data.serverNow < data.guard.from) return '待生效'
      return '已结束'
    }

    function SettingsPage() {
      const { data, failure, refresh, setData } = useHealth(3000)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const locked = Boolean(data && data.configLock)

      const patch = useCallback(async (partial, tag) => {
        setBusy(tag || 'config')
        setNotice('')
        try {
          const next = await call('config', { patch: partial })
          if (next && next.ok) setData(next)
          else setNotice((next && next.error) || '保存失败')
        } catch (error) {
          setNotice(String((error && error.message) || error))
        } finally {
          setBusy('')
        }
      }, [setData])

      const action = useCallback(async (route, body, tag) => {
        setBusy(tag)
        setNotice('')
        try {
          const next = await call(route, body || {})
          if (next && next.state) setData({ ...next.state, _clientAt: Date.now() })
          else if (next && next.ok) setData({ ...next, _clientAt: Date.now() })
          if (next && next.ok === false) setNotice(next.error || '操作失败')
          else if (route === 'login-block') setNotice(body && body.enabled === false ? '已恢复全天登录' : '登录限制已应用')
        } catch (error) {
          setNotice(String((error && error.message) || error))
        } finally {
          setBusy('')
        }
      }, [setData])

      const config = data ? data.config : null
      const line = statusLine(data)
      const report = (data && data.report) || { days: [], totals: { shutdown: 0, cancel: 0, exempt: 0, none: 0 }, restarts: 0 }

      const patchDays = useCallback((index, partial) => {
        if (!config) return
        const days = config.days.map((entry, i) => (i === index ? { ...entry, ...partial } : entry))
        void patch({ days }, 'days')
      }, [config, patch])

      return h('div', { className: 'hl-page' },
        h('style', null, CSS),
        h('header', { className: 'hl-head' },
          h('h2', { className: 'hl-title' }, '健康生活'),
          h('p', { className: 'hl-sub' }, '宵禁与作息守护：到点提醒、倒计时关机、取消配额与自动豁免。')),

        failure ? h('p', { className: 'hl-error' }, `无法连接插件内核：${failure}`) : null,
        notice ? h('p', { className: 'hl-error' }, notice) : null,
        data && data.health && data.health.warnings && data.health.warnings.length
          ? h('p', { className: 'hl-error' }, `接口告警：${data.health.warnings.join('；')}`)
          : null,

        h(Card, { title: '当前状态' },
          h('div', { className: 'hl-status' },
            h('span', { className: 'hl-status-dot ' + phaseTone(data && data.phase) }),
            h('div', { className: 'hl-status-main' },
              h('div', { className: 'hl-status-title' }, line.title),
              h('div', { className: 'hl-status-desc' }, line.desc)),
            h('button', { type: 'button', className: 'hl-btn hl-btn-ghost', onClick: () => void refresh() }, '刷新')),
          h('div', { className: 'hl-metrics' },
            h('div', null,
              h('div', { className: 'hl-metric-label' }, '下次窗口'),
              h('div', { className: 'hl-metric-value' }, data && data.window ? `${clockText(data.window.start)} – ${clockText(data.window.end)}` : '—')),
            h('div', null,
              h('div', { className: 'hl-metric-label' }, '今晚剩余取消'),
              h('div', { className: 'hl-metric-value' }, data ? `${data.quota.left} / ${data.quota.nightQuota}` : '—')),
            h('div', null,
              h('div', { className: 'hl-metric-label' }, '本周剩余取消'),
              h('div', { className: 'hl-metric-value' }, data ? `${Math.max(0, data.quota.weekQuota - data.quota.weekUsed)} / ${data.quota.weekQuota}` : '—')),
            h('div', null,
              h('div', { className: 'hl-metric-label' }, '登录限制'),
              h('div', { className: 'hl-metric-value' }, loginText(data))))),

        h(Card, { title: '基础' },
          h(Row, { title: '开机自启动', desc: '写入当前用户的启动项，重启后随系统拉起' },
            h(Switch, { checked: Boolean(config && config.autoStart), disabled: !config || busy !== '', label: '开机自启动', onChange: (value) => void patch({ autoStart: value }, 'autoStart') })),
          h(Row, { title: '宵禁模式', desc: '每天在设定时段弹出提醒并执行关机流程' },
            h(Switch, { checked: Boolean(config && config.curfewEnabled), disabled: !config || busy !== '' || locked, label: '宵禁模式', onChange: (value) => void patch({ curfewEnabled: value }, 'curfew') }))),

        h(Card, { title: '生效日与时间' },
          h('p', { className: 'hl-hint' }, '每天可单独开关并设置时间窗。跨零点的窗口严格按原区间执行：例如周一 23:00–06:00 会一直挡到周二 06:00，周二白天的设置不影响它。'),
          data && data.configLock
            ? h('p', { className: 'hl-hint', style: { fontWeight: 600 } },
              `已冻结：距宵禁不足 ${data.configLock.minutes} 分钟，${clockText(data.configLock.until)} 前不可修改窗口、开关与取消配额`)
            : null,
          (config ? config.days : []).map((entry, index) => h('div', { className: 'hl-day', key: index },
            h('span', { className: 'hl-day-name' }, data && data.weekdays ? data.weekdays[index] : `D${index}`),
            h(Switch, {
              checked: entry.enabled,
              disabled: busy !== '' || locked,
              label: '启用',
              onChange: (value) => void patchDays(index, { enabled: value })
            }),
            h(Select, { value: entry.start, options: hourOptions, ariaLabel: '开始', disabled: locked, onChange: (value) => void patchDays(index, { start: value }) }),
            h('span', { className: 'hl-day-sep' }, '–'),
            h(Select, { value: entry.end, options: hourOptions, ariaLabel: '结束', disabled: locked, onChange: (value) => void patchDays(index, { end: value }) })))),

        h(Card, { title: '提醒与倒计时' },
          h(Row, { title: '提前提醒', desc: '在宵禁开始前弹出桌面提醒，留出保存时间' },
            h(Select, {
              value: config ? String(config.warnMinutes) : '5',
              ariaLabel: '提前提醒',
              options: [1, 5, 10, 15, 30].map((n) => ({ value: String(n), label: `${n} 分钟` })),
              onChange: (value) => void patch({ warnMinutes: Number(value) }, 'warn')
            })),
          h(Row, { title: '倒计时时长', desc: '桌面弹窗内不操作即在此时间后关机' },
            h(Select, {
              value: config ? String(config.countdownSeconds) : '30',
              ariaLabel: '倒计时时长',
              options: [15, 30, 60, 120].map((n) => ({ value: String(n), label: `${n} 秒` })),
              onChange: (value) => void patch({ countdownSeconds: Number(value) }, 'countdown')
            }))),

        h(Card, { title: '取消配额' },
          h(Row, { title: '每晚可取消', desc: '同一晚最多取消几次，用完只能关机' },
            h(Select, { value: config ? String(config.nightQuota) : '1', options: numberOptions(3), ariaLabel: '每晚可取消', disabled: locked, onChange: (value) => void patch({ nightQuota: Number(value) }, 'nightQuota') })),
          h(Row, { title: '每周可取消', desc: '跨天累计上限，豁免同样计入' },
            h(Select, { value: config ? String(config.weekQuota) : '3', options: numberOptions(10), ariaLabel: '每周可取消', disabled: locked, onChange: (value) => void patch({ weekQuota: Number(value) }, 'weekQuota') })),
          h(Row, { title: '重置配额', desc: '手动把今晚与本周的已用次数清零' },
            h('button', { type: 'button', className: 'hl-btn', disabled: busy === 'reset', onClick: () => void action('reset-quota', {}, 'reset') }, '重置'))),

        h(Card, { title: '登录限制' },
          h('p', { className: 'hl-hint' }, '宵禁时段内禁止进入桌面：开机后停在锁屏界面，输入密码会提示账户有时间限制。'),
          data && data.platform && data.platform.elevated === false
            ? h('p', { className: 'hl-warn' }, '当前 DSH 未以管理员身份运行，登录限制不会生效。右键 DSH 快捷方式 → 属性 → 兼容性 → 勾选「以管理员身份运行此程序」，重启 DSH 后自动生效。')
            : null,
          h(Row, { title: '宵禁时段禁止登录', desc: data && data.login && data.login.error ? `最近错误：${data.login.error}` : '使用 Windows 账户登录时段（整点）' },
            h(Switch, { checked: Boolean(config && config.loginBlock), disabled: !config || busy === 'loginBlock', label: '宵禁时段禁止登录', onChange: (value) => void patch({ loginBlock: value }, 'loginBlock') })),
          h('div', { className: 'hl-actions' },
            h('button', { type: 'button', className: 'hl-btn hl-btn-primary', disabled: busy === 'apply', onClick: () => void action('login-block', { enabled: true }, 'apply') }, '应用登录限制'),
            h('button', { type: 'button', className: 'hl-btn', disabled: busy === 'restore', onClick: () => void action('login-block', { enabled: false }, 'restore') }, '恢复正常登录'))),

        h(Card, { title: '自动豁免（不可手动配置）' },
          h('p', { className: 'hl-hint' }, '命中以下任一场景时自动取消当晚关机，但会占用一次取消次数；配额用完后不再豁免。'),
          h('div', null, (data ? data.exemptions : []).map((item) => h('span', { key: item.id, className: 'hl-chip' }, h('strong', null, item.label))))),

        h(Card, { title: '退出守护' },
          h('p', { className: 'hl-hint' }, `宵禁开始前 ${data && data.guard ? data.guard.minutes : 60} 分钟起拉起看守进程：期间 DSH 被关闭会被自动拉起（最多 3 次），直到倒计时结束。注意：强制结束看守进程无法被拦截。`),
          h(Row, { title: '今晚守护状态', desc: data && data.guard ? `${clockText(data.guard.from)} 起生效` : '—' },
            h('span', { className: 'hl-metric-value' }, guardActiveText(data))),
          data && data.recentExits && data.recentExits.length
            ? h('ul', { className: 'hl-log' }, data.recentExits.slice(-3).map((entry, index) => h('li', { key: index },
                h('span', { className: 'hl-log-time' }, '退出'),
                h('span', null, entry))))
            : h('div', { className: 'hl-empty' }, '近期没有检测到退出。')),

        h(Card, { title: '未保存保护' },
          h('p', { className: 'hl-hint' }, '倒计时结束前 4 秒检查一次带未保存标记的窗口：命中则中止关机、再给 30 秒，每晚只延长一次。'),
          h(Row, {
            title: '最近一次检测',
            desc: data && data.unsaved ? `检测时间 ${new Date(data.unsaved.at).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未触发'
          }, h('span', { className: 'hl-metric-value' }, data && data.unsaved ? data.unsaved.apps.join('、') : '—'))),

        h(Card, { title: '本周报告' },
          h('div', { className: 'hl-report' }, report.days.map((day) => h('div', { key: day.day, className: 'hl-report-day', title: outcomeMeta(day.outcome).label },
            h('span', { className: 'hl-report-dot', style: { background: outcomeMeta(day.outcome).color } }),
            h('span', { className: 'hl-report-date' }, day.day.slice(5))))),
          h('p', { className: 'hl-hint' }, `关机 ${report.totals.shutdown} 次 · 取消 ${report.totals.cancel} 次 · 豁免 ${report.totals.exempt} 次 · 未触发 ${report.totals.none} 次${report.restarts ? ` · 退出并拉起 ${report.restarts} 次` : ''}`)),

        h(Card, { title: '预览与调试' },
          h('div', { className: 'hl-actions' },
            h('button', { type: 'button', className: 'hl-btn', disabled: busy === 'preview-warn', onClick: () => void action('test', { phase: 'warning' }, 'preview-warn') }, '预览提前提醒'),
            h('button', { type: 'button', className: 'hl-btn', disabled: busy === 'preview-count', onClick: () => void action('test', { phase: 'countdown' }, 'preview-count') }, '预览倒计时弹窗'))),

        h(Card, { title: '兼容性自检' },
          h('p', { className: 'hl-hint' }, 'DSH 升级后接口可能改名或改签名。这里显示插件依赖的关键能力是否还在，出现 ✗ 就说明需要适配。'),
          data && data.health
            ? h('div', null,
                h(Row, { title: 'DSH 版本', desc: data.health.dshVersion ? '读取自 app.asar/package.json' : '读取失败，升级后请手动确认' },
                  h('span', { className: 'hl-metric-value' }, data.health.dshVersion || '未知')),
                h(Row, { title: '插件接口', desc: 'webServer.register / getOrigin' },
                  h('span', { className: 'hl-metric-value' }, `${data.health.api && data.health.api.webServer ? '✓' : '✗'} / ${data.health.api && data.health.api.getOrigin ? '✓' : '✗'}`)),
                h(Row, { title: '桌面弹窗程序', desc: data.health.popup ? '已就绪' : '缺失，将退回系统关机提示' },
                  h('span', { className: 'hl-metric-value' }, data.health.popup ? '✓' : '✗')),
                h(Row, { title: '上次自检', desc: data.health.warnings && data.health.warnings.length ? data.health.warnings.join('；') : '一切正常' },
                  h('span', { className: 'hl-metric-value' }, new Date(data.health.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }))))
            : h('div', { className: 'hl-empty' }, '尚未自检'),
          h('div', { className: 'hl-actions' },
            h('button', { type: 'button', className: 'hl-btn', disabled: busy === 'selfcheck', onClick: () => void action('selfcheck', {}, 'selfcheck') }, '重新自检'))),

        h(Card, { title: '发布到 GitHub' },
          h('p', { className: 'hl-hint' }, '把插件目录的改动提交并推送到 github.com/jiboda394-glitch/dsh-healthylife。由宿主进程执行，不需要开终端。'),
          h('div', { className: 'hl-actions' },
            h('button', { type: 'button', className: 'hl-btn hl-btn-primary', disabled: busy === 'publish', onClick: () => void action('publish', {}, 'publish') }, '提交并推送'))),

        h(Card, { title: '最近记录' },
          data && data.history && data.history.length
            ? h('ul', { className: 'hl-log' }, data.history.slice(0, 10).map((entry, index) => h('li', { key: `${entry.at}-${index}` },
                h('span', { className: 'hl-log-time' }, new Date(entry.at).toLocaleString('zh-CN', { hour12: false })),
                h('span', null, entry.detail))))
            : h('div', { className: 'hl-empty' }, '还没有记录。')))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'healthylife',
            order: 35,
            label: '健康生活'
          }, SettingsPage))
        } catch (error) {
          // A changed slot API must not blank the whole client plugin.
        }
      }
    }
  }
})
