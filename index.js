/**
 * healthylife — Host half.
 *
 * Per-weekday curfew schedule, Windows side effects (shutdown / logon hours /
 * autostart), the native desktop popup, and the JSON state the browser half renders.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'healthylife'
export const inject = ['webServer']

/** Exposed for tests: the exact `/times:` payload the plugin sends to `net user`. */
export { logonHoursSpec, guardScriptText }

const DAY = 86400000
const MINUTE = 60000
const API_PREFIX = '/healthylife/api'
/**
 * 插件状态目录（state.json / popup.json / guard 脚本与日志）。
 * 默认 `%LOCALAPPDATA%\healthylife`；`DSH_HEALTHYLIFE_HOME` 可整体挪走，
 * 给"数据不落系统盘"的场景用。
 */
const STATE_DIR = (() => {
  const override = process.env.DSH_HEALTHYLIFE_HOME
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'healthylife')
})()
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const POPUP_FILE = path.join(STATE_DIR, 'popup.json')
const POPUP_EXE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'dist', 'HealthyLife.Popup.exe')
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_FILE = path.join(PLUGIN_DIR, 'package.json')
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'HealthyLife'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_NAMES = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa']
const GUARD_MINUTES = 60
const UNSAVED_EXTENSION_SECONDS = 30

function defaultDays() {
  return Array.from({ length: 7 }, () => ({ enabled: true, start: '01:00', end: '05:00' }))
}

const DEFAULT_CONFIG = {
  autoStart: false,
  curfewEnabled: false,
  days: defaultDays(),
  warnMinutes: 5,
  countdownSeconds: 30,
  nightQuota: 1,
  weekQuota: 3,
  loginBlock: true
}

/** Fixed exemption scenarios: detected automatically, never user-editable. */
const EXEMPTIONS = [
  { id: 'battery', label: '电量低于 20%' },
  { id: 'meeting', label: '会议软件运行中' },
  { id: 'backup', label: '备份 / 迁移任务进行中' }
]

const MEETING_PROCESS = 'zoom|teams|ms-teams|wemeet|voov|dingtalk|feishu|webex|tencentmeeting'
const BACKUP_PROCESS = 'acronis|veeam|backup|robocopy|ghost|diskshadow|wbadmin'
const APP_NAMES = {
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  wps: 'WPS 文字',
  et: 'WPS 表格',
  wpp: 'WPS 演示',
  onenote: 'OneNote',
  notepad: '记事本',
  notepadpp: 'Notepad++',
  code: 'VS Code',
  typora: 'Typora',
  sublime_text: 'Sublime Text',
  photoshop: 'Photoshop',
  illustrator: 'Illustrator',
  indesign: 'InDesign',
  acrobat: 'Acrobat',
  autocad: 'AutoCAD'
}

function run(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    const failure = (error) => finish({
      ok: false,
      code: 1,
      stdout: '',
      stderr: (error && error.message) ? String(error.message) : String(error || 'spawn failed')
    })
    try {
      const child = execFile(file, args, { windowsHide: true, timeout, encoding: 'buffer' }, (error, stdoutBuf, stderrBuf) => {
        finish({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: decodeOutput(stdoutBuf),
          stderr: decodeOutput(stderrBuf) || (error && error.message ? String(error.message) : '')
        })
      })
      child.on('error', failure)
    } catch (error) {
      failure(error)
    }
  })
}

/** Windows console tools emit GBK on a zh-CN system; decode so errors stay readable. */
function decodeOutput(buffer) {
  if (!buffer) return ''
  try {
    return new TextDecoder('gbk').decode(buffer).trim()
  } catch {
    return String(buffer).trim()
  }
}

function describeNetError(result) {
  const text = `${result.stdout || ''} ${result.stderr || ''}`.trim()
  if (/3764|not exactly on the hour|时间不正确/.test(text)) return '登录时段格式无效：net user 只接受整点'
  if (/3768|illegal day range|日期范围/.test(text)) return '登录时段格式无效：星期缩写错误'
  if (/拒绝访问|Access is denied|系统错误 5/.test(text)) return '需要管理员权限'
  return text.slice(0, 160) || `net user 退出码 ${result.code}`
}

const pad = (n) => String(n).padStart(2, '0')

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function weekKey(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return dayKey(d.getTime())
}

function parseHHMM(text, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''))
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour > 23 || minute > 59 ? fallback : hour * 60 + minute
}

const formatMinute = (total) => `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`
const hhmm = (ts) => `${pad(new Date(ts).getHours())}:${pad(new Date(ts).getMinutes())}`

/** All curfew intervals that could touch `now`, including yesterday's cross-midnight tail. */
function dayIntervals(now, days, span = 1) {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const base = midnight.getTime()
  const list = []
  for (let offset = -1; offset <= span; offset += 1) {
    const dayStart = base + offset * DAY
    const index = new Date(dayStart).getDay()
    const entry = days[index]
    if (!entry || !entry.enabled) continue
    const startMinute = parseHHMM(entry.start, 60)
    const endMinute = parseHHMM(entry.end, 300)
    if (startMinute === endMinute) continue
    const start = dayStart + startMinute * MINUTE
    let end = dayStart + endMinute * MINUTE
    if (end <= start) end += DAY
    list.push({ start, end, dayIdx: index, offset })
  }
  return list
}

function intervalAt(now, days) {
  return dayIntervals(now, days).find((item) => now >= item.start && now < item.end) || null
}

function nextInterval(now, days) {
  return dayIntervals(now, days, 8)
    .filter((item) => item.start > now)
    .sort((a, b) => a.start - b.start)[0] || null
}

/** Merge blocked ranges and return the allowed complement inside [0, 24). */
function complement(ranges) {
  const merged = []
  for (const [from, to] of ranges.slice().sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (!last || from > last[1]) merged.push([from, to])
    else last[1] = Math.max(last[1], to)
  }
  const out = []
  let cursor = 0
  for (const [from, to] of merged) {
    if (from > cursor) out.push([cursor, from])
    cursor = Math.max(cursor, to)
  }
  if (cursor < 24) out.push([cursor, 24])
  return out
}

const hourLabel = (hour) => `${pad(hour)}:00`

/** Allowed logon hours per weekday, hour-aligned; cross-midnight windows spill to the next day. */
function logonHoursSpec(config) {
  const days = Array.isArray(config.days) ? config.days : defaultDays()
  const blocked = Array.from({ length: 7 }, () => [])
  days.forEach((entry, index) => {
    if (!entry || !entry.enabled) return
    const startMinute = parseHHMM(entry.start, 60)
    const endMinute = parseHHMM(entry.end, 300)
    if (startMinute === endMinute) return
    const startHour = Math.floor(startMinute / 60)
    const endHour = Math.ceil(endMinute / 60)
    if (startHour === endHour) return
    if (endHour > startHour) {
      blocked[index].push([startHour, endHour])
    } else {
      blocked[index].push([startHour, 24])
      blocked[(index + 1) % 7].push([0, endHour])
    }
  })
  const groups = []
  for (let index = 0; index < 7; index += 1) {
    const segments = complement(blocked[index])
    if (segments.length === 0) return null
    const text = segments.map(([from, to]) => `${hourLabel(from)}-${hourLabel(to)}`).join(',')
    groups.push(`${DAY_NAMES[index]},${text}`)
  }
  return groups.join(';')
}

function defaultState() {
  return {
    config: { ...DEFAULT_CONFIG, days: defaultDays() },
    phase: 'idle',
    reason: '',
    quota: { nightKey: dayKey(Date.now()), nightUsed: 0, weekKey: weekKey(Date.now()), weekUsed: 0 },
    exemptTonight: null,
    nights: {},
    recentExits: [],
    unsaved: null,
    history: [],
    login: { applied: false, error: '', checkedAt: 0 },
    dismissed: '',
    health: null,
    lastDshVersion: '',
    platform: { user: process.env.USERNAME || '', host: os.hostname(), elevated: null, dark: true }
  }
}

let state = defaultState()
let loaded = false
let saveTimer = null
let tickTimer = null
let shutdownIssued = false
let shutdownFired = false
let loginAttemptKey = ''
let night = { key: '', resolved: '', reason: '', deadline: 0, extended: false }
let guardedNight = ''
let preview = { phase: '', from: 0, until: 0 }
let previewing = false
let popupProc = null
let popupKey = ''
let warningShown = ''
let hostCtx = null
let apiOrigin = 'http://127.0.0.1:0'
const detection = { key: '', result: null }

function sanitizeDays(input) {
  const source = Array.isArray(input) ? input : []
  return Array.from({ length: 7 }, (_, index) => {
    const entry = source[index] || {}
    const start = formatMinute(parseHHMM(entry.start, 60))
    let end = formatMinute(parseHHMM(entry.end, 300))
    if (start === end) end = formatMinute((parseHHMM(start, 60) + 240) % 1440)
    return { enabled: entry.enabled !== false, start, end }
  })
}

async function loadState() {
  if (loaded) return
  loaded = true
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    const merged = { ...DEFAULT_CONFIG, ...(saved.config || {}) }
    if (!Array.isArray(merged.days)) {
      const legacyStart = (saved.config && saved.config.windowStart) || '01:00'
      const legacyEnd = (saved.config && saved.config.windowEnd) || '05:00'
      merged.days = Array.from({ length: 7 }, () => ({ enabled: true, start: legacyStart, end: legacyEnd }))
    }
    merged.days = sanitizeDays(merged.days)
    state = {
      ...defaultState(),
      ...saved,
      config: merged,
      quota: { ...defaultState().quota, ...(saved.quota || {}) },
      login: { ...defaultState().login, ...(saved.login || {}) },
      platform: { ...defaultState().platform, ...(saved.platform || {}) }
    }
    rollQuota(Date.now())
  } catch {
    /* first run */
  }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await mkdir(STATE_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await rename(tmp, STATE_FILE)
    } catch {
      /* storage unavailable: state stays in memory */
    }
  }, 400)
}

function remember(type, detail) {
  state.history.unshift({ at: Date.now(), type, detail })
  if (state.history.length > 40) state.history.length = 40
  scheduleSave()
}

function rollQuota(now) {
  // A curfew "night" belongs to the window it guards, not to the calendar day of `now`:
  // a cancel at 03:00 on Tuesday must not be shown as "tonight" all Tuesday afternoon,
  // and a spent quota from last night must not leak into the upcoming window.
  const reference = intervalAt(now, state.config.days) || nextInterval(now, state.config.days)
  const nightKeyValue = dayKey(reference ? reference.start : now)
  const weekKeyValue = weekKey(now)
  if (state.quota.nightKey !== nightKeyValue) {
    state.quota.nightKey = nightKeyValue
    state.quota.nightUsed = 0
    state.exemptTonight = null
  }
  if (state.quota.weekKey !== weekKeyValue) {
    state.quota.weekKey = weekKeyValue
    state.quota.weekUsed = 0
  }
}

function quotaLeft() {
  return Math.min(
    Math.max(0, Number(state.config.nightQuota) - state.quota.nightUsed),
    Math.max(0, Number(state.config.weekQuota) - state.quota.weekUsed)
  )
}

// 宵禁前最后一小时冻结窗口设置：这一小时里改配置等于绕过今晚的宵禁。
const LOCKED_CONFIG_KEYS = ['days', 'curfewEnabled', 'nightQuota', 'weekQuota']

function configLock(now = Date.now()) {
  if (state.config.curfewEnabled !== true) return null
  const target = intervalAt(now, state.config.days) || nextInterval(now, state.config.days)
  if (!target) return null
  const from = target.start - GUARD_MINUTES * MINUTE
  if (now < from || now >= target.end) return null
  return { from, until: target.end, start: target.start, end: target.end, minutes: GUARD_MINUTES }
}

function useQuota(type, detail) {
  state.quota.nightUsed += 1
  state.quota.weekUsed += 1
  remember(type, detail)
}

async function detectExemption(now, target) {
  const key = String(target.start)
  if (detection.key === key) return detection.result
  detection.key = key
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$b=(Get-CimInstance Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining',
    `$p=(Get-Process | Where-Object { $_.ProcessName -match '${MEETING_PROCESS}' } | Select-Object -First 1 -ExpandProperty ProcessName)`,
    `$q=(Get-Process | Where-Object { $_.ProcessName -match '${BACKUP_PROCESS}' } | Select-Object -First 1 -ExpandProperty ProcessName)`,
    '[pscustomobject]@{battery=[int]$b;meeting=[string]$p;backup=[string]$q} | ConvertTo-Json -Compress'
  ].join('; ')
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 12000)
  const info = { battery: -1, meeting: '', backup: '' }
  try {
    if (out.ok && out.stdout) Object.assign(info, JSON.parse(out.stdout))
  } catch {
    /* malformed output: treat as no exemption */
  }
  let result = null
  if (Number(info.battery) > 0 && Number(info.battery) < 20) result = EXEMPTIONS[0]
  else if (info.meeting) result = EXEMPTIONS[1]
  else if (info.backup) result = EXEMPTIONS[2]
  detection.result = result
  return result
}

async function detectUnsaved() {
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    "$d=@(Get-Process | Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle -match '[*●•]') } | Select-Object -First 6 -ExpandProperty ProcessName)",
    "$k=@(Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match '^(winword|excel|powerpnt|wps|et|wpp|typora|sublime_text|notepad\\+\\+|onenote)$') } | Select-Object -First 6 -ExpandProperty ProcessName)",
    '[pscustomobject]@{dirty=[string[]]$d;office=[string[]]$k} | ConvertTo-Json -Compress -Depth 3'
  ].join('; ')
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 12000)
  const info = { dirty: [], office: [] }
  const toArray = (value) => Array.isArray(value) ? value : (value ? [value] : [])
  try {
    if (out.ok && out.stdout) {
      const parsed = JSON.parse(out.stdout)
      info.dirty = toArray(parsed.dirty)
      info.office = toArray(parsed.office)
    }
  } catch {
    /* malformed output: report nothing */
  }
  const names = []
  for (const raw of [...info.dirty, ...info.office]) {
    const key = String(raw || '').toLowerCase()
    const label = APP_NAMES[key] || raw
    if (label && !names.includes(label)) names.push(label)
  }
  return names.slice(0, 4)
}

const GUARD_TASK = 'HealthLife\\Guard'
const LAUNCH_TASK = 'HealthLife\\Launch'
const HIDE_TASK = 'HealthLife\\Hide'
const GUARD_SCRIPT = path.join(STATE_DIR, 'guard.ps1')
const HIDE_SCRIPT = path.join(STATE_DIR, 'hide-window.ps1')

/** The watchdog body, run by a scheduled task so it survives DSH being killed. */
function guardScriptText(until) {
  const q = (value) => String(value).replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = '${q(process.execPath)}'`,
    `$until = ${Math.round(until)}`,
    `$dshPid = ${process.pid}`,
    `$log = '${q(path.join(STATE_DIR, 'guard.log'))}'`,
    `$lock = '${q(path.join(STATE_DIR, 'guard.lock'))}'`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null',
    'Set-Content -LiteralPath $lock -Value $PID',
    'Add-Content -LiteralPath $lock -Value $until',
    'Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " guard-start pid=" + $PID)',
    'function Start-HiddenDsh {',
    `  Add-Type -Namespace HL -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);'`,
    '  $script:didLaunch = $false',
    '  $waitUntil = [DateTime]::Now.AddSeconds(15)',
    '  while ([DateTime]::Now -lt $waitUntil) {',
    '    $existing = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue',
    '    if (-not $existing) { break }',
    '    Start-Sleep -Milliseconds 300',
    '  }',
    '  $existing = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue',
    '  if ($existing) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " relaunch skipped: instance already running"); return }',
    '  schtasks.exe /run /tn "HealthLife\\Launch" | Out-Null',
    '  $p = $null',
    '  for ($i = 0; $i -lt 120; $i++) {',
    '    Start-Sleep -Milliseconds 200',
    '    $p = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1',
    '    if ($p) { break }',
    '  }',
    '  if (-not $p) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " relaunch failed: no process after launch task"); return }',
    '  $script:didLaunch = $true',
    '  $handle = [IntPtr]::Zero',
    '  $watchUntil = [DateTime]::Now.AddSeconds(12)',
    '  while ([DateTime]::Now -lt $watchUntil) {',
    '    Start-Sleep -Milliseconds 15',
    '    if ($p.HasExited) { break }',
    '    $p.Refresh()',
    '    $h = $p.MainWindowHandle',
    '    if ($h -eq [IntPtr]::Zero) { continue }',
    '    if ($handle -eq [IntPtr]::Zero) { $handle = $h }',
    '    if ([HL.Win]::IsWindowVisible($h)) { [HL.Win]::ShowWindow($h, 0) | Out-Null }',
    '  }',
    '  $state = "running"',
    '  if ($p.HasExited) { $state = "exited code=" + [string]$p.ExitCode }',
    '  Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " relaunch hidden=" + [string]($handle -ne [IntPtr]::Zero) + " " + $state)',
    '}',
    '$restarts = 0',
    '$beats = 0',
    'while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $until) {',
    '  Start-Sleep -Seconds 3',
    '  $owner = Get-Content -LiteralPath $lock -ErrorAction SilentlyContinue',
    '  if ($owner.Count -ge 1 -and [int]$owner[0] -ne $PID) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " superseded by " + $owner[0]); break }',
    '  $beats++',
    '  if ($beats % 5 -eq 0) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " heartbeat") }',
    '  if (-not (Get-Process -Id $dshPid)) {',
    '    Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " exit-restart " + ($restarts + 1))',
    '    Start-HiddenDsh',
    '    if ($script:didLaunch) { $restarts++; if ($restarts -ge 3) { break } }',
    '  }',
    '}',
    '$owner = Get-Content -LiteralPath $lock -ErrorAction SilentlyContinue',
    'if ($owner.Count -ge 1 -and [int]$owner[0] -eq $PID) { Remove-Item -LiteralPath $lock -Force }',
    'Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " guard-end")'
  ].join('\r\n')
}

async function spawnGuard(until) {
  if (process.platform !== 'win32') return
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(GUARD_SCRIPT, guardScriptText(until), 'utf8')
  } catch (error) {
    remember('error', `守卫脚本写入失败：${error instanceof Error ? error.message : error}`)
    return
  }

  // Do NOT stop the previous watchdog task: the DSH it relaunched is its child, so
  // ending the task would kill the very instance we just started. The running
  // watchdog notices the lock owner change on its next tick and exits by itself.

  // A task launched by the Scheduler lives outside DSH's process tree, so quitting
  // DSH cannot take the watchdog down with it.
  // The DSH we relaunch is started through its own task, so it is NOT a child of the
  // watchdog: stopping or replacing the watchdog can never kill the app.
  await ensureLaunchTask()

  const created = await run('schtasks.exe', [
    '/create', '/tn', GUARD_TASK,
    '/tr', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${GUARD_SCRIPT}`,
    '/sc', 'once', '/st', '00:00',
    '/ru', process.env.USERNAME || '', '/it', '/rl', 'highest', '/f'
  ], 20000)
  if (created.ok) {
    const started = await run('schtasks.exe', ['/run', '/tn', GUARD_TASK], 20000)
    if (started.ok) {
      remember('guard', `已通过计划任务启动退出守护（宵禁前 ${GUARD_MINUTES} 分钟）`)
      return
    }
    remember('error', `退出守护任务启动失败：${started.stderr || started.stdout}`)
  } else {
    remember('error', `退出守护任务创建失败：${created.stderr || created.stdout}`)
  }

  // Fallback: a direct child process. It may die together with DSH, but it is
  // better than having no watchdog at all when task creation is blocked.
  try {
    const encoded = Buffer.from(guardScriptText(until), 'utf16le').toString('base64')
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => remember('error', `退出守护启动失败：${error instanceof Error ? error.message : error}`))
    child.on('spawn', () => remember('guard', `已启动退出守护（宵禁前 ${GUARD_MINUTES} 分钟，子进程模式）`))
    child.unref()
  } catch (error) {
    remember('error', `退出守护启动失败：${error instanceof Error ? error.message : error}`)
  }
}

// guard.log 只增不减（守护每小时都在写），过一段时间就截断，保留尾部最近一段。
const GUARD_LOG_LIMIT = 200 * 1024
const GUARD_LOG_KEEP = 32 * 1024
let lastGuardLogRotate = 0

async function rotateGuardLog(now = Date.now()) {
  if (now - lastGuardLogRotate < 60 * 1000) return
  lastGuardLogRotate = now
  const file = path.join(STATE_DIR, 'guard.log')
  try {
    const info = await stat(file)
    if (info.size <= GUARD_LOG_LIMIT) return
    const raw = await readFile(file, 'utf8')
    let tail = raw.slice(-GUARD_LOG_KEEP)
    const newline = tail.indexOf('\n')
    if (newline >= 0) tail = tail.slice(newline + 1)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, tail, 'utf8')
    await rename(tmp, file)
    remember('cleanup', `守护日志已截断（保留最近 ${Math.round(tail.length / 1024)} KB）`)
  } catch {
    /* 轮转失败不能影响调度；下一分钟再试 */
  }
}

// 守护前一小时每 5 秒刷新一次「最近退出」，只读文件尾部：整份 guard.log 会越写越大，
// 而这里只需要最后 20 行。文件没变化时直接跳过（靠 size+mtime 判断）。
const EXIT_TAIL_BYTES = 8 * 1024
let exitLogSignature = ''

async function refreshExitLog() {
  const file = path.join(STATE_DIR, 'guard.log')
  try {
    const info = await stat(file)
    const signature = `${info.size}:${info.mtimeMs}`
    if (signature === exitLogSignature) return
    const length = Math.min(info.size, EXIT_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    if (length > 0) {
      const handle = await open(file, 'r')
      try {
        await handle.read(buffer, 0, length, info.size - length)
      } finally {
        await handle.close()
      }
    }
    const lines = buffer.toString('utf8').split(/\r?\n/)
    if (info.size > length) lines.shift()
    state.recentExits = lines.filter((line) => line && !line.includes('heartbeat')).slice(-20)
    exitLogSignature = signature
  } catch {
    state.recentExits = []
    exitLogSignature = ''
  }
}

function buildReport(now) {
  const days = []
  const totals = { shutdown: 0, cancel: 0, exempt: 0, none: 0 }
  for (let index = 6; index >= 0; index -= 1) {
    const key = dayKey(now - index * DAY)
    const outcome = state.nights[key] || 'none'
    totals[outcome] = (totals[outcome] || 0) + 1
    days.push({ day: key, outcome })
  }
  return { days, totals, restarts: state.recentExits.filter((line) => line.includes('exit-restart')).length }
}

async function issueShutdown(seconds) {
  const result = await run('shutdown.exe', ['/s', '/t', String(Math.max(0, Math.round(seconds))), '/c', '健康生活宵禁：到点休息'])
  if (result.ok || result.code === 1190) {
    shutdownIssued = true
    return { ok: true }
  }
  return { ok: false, error: result.stderr || `shutdown exit ${result.code}` }
}

async function abortShutdown() {
  const result = await run('shutdown.exe', ['/a'])
  shutdownIssued = false
  return result
}

function hidePopup() {
  if (popupProc) {
    try { popupProc.kill() } catch { /* already gone */ }
  }
  popupProc = null
  popupKey = ''
}

async function launchPopup(payload, key) {
  hidePopup()
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(POPUP_FILE, JSON.stringify(payload, null, 2), 'utf8')
    const child = spawn(POPUP_EXE, ['--file', POPUP_FILE], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => { popupProc = null; popupKey = '' })
    child.on('exit', () => {
      // The user dismissed the warning: remember it so a DSH restart does not re-show it.
      if (String(key).startsWith('warning:') && state.phase === 'warning') {
        state.dismissed = night.key || ''
        scheduleSave()
      }
      if (String(key).startsWith('preview:')) previewing = false
      if (popupProc === child) { popupProc = null; popupKey = '' }
    })
    child.unref()
    popupProc = child
    popupKey = key
  } catch (error) {
    remember('error', `桌面弹窗启动失败：${error instanceof Error ? error.message : error}`)
    popupProc = null
    popupKey = ''
  }
}

async function showPopup(phase, target) {
  const key = `${phase}:${night.deadline}:${quotaLeft()}`
  if (popupKey === key && popupProc) return
  await launchPopup({
    api: `${apiOrigin}${API_PREFIX}`,
    phase,
    deadline: night.deadline,
    targetAt: target.start,
    windowDay: dayLabel(target.start),
    preview: false,
    countdownSeconds: Math.max(5, Number(state.config.countdownSeconds) || 30),
    minutesLeft: Math.max(1, Math.ceil((target.start - Date.now()) / MINUTE)),
    quotaLeft: quotaLeft(),
    windowStart: hhmm(target.start),
    windowEnd: hhmm(target.end),
    dark: state.platform.dark !== false
  }, key)
}

async function showPreviewPopup(phase, seconds) {
  const now = Date.now()
  const upcoming = nextInterval(now, state.config.days)
  if (!upcoming) return false
  await launchPopup({
    api: `${apiOrigin}${API_PREFIX}`,
    phase,
    deadline: phase === 'countdown' ? now + seconds * 1000 : 0,
    // 预览必须是真实窗口：假倒计时会让人以为宵禁 1 分钟后就到。
    targetAt: upcoming.start,
    windowDay: dayLabel(upcoming.start),
    preview: true,
    countdownSeconds: seconds,
    minutesLeft: Math.max(1, Math.ceil((upcoming.start - now) / MINUTE)),
    quotaLeft: quotaLeft(),
    windowStart: hhmm(upcoming.start),
    windowEnd: hhmm(upcoming.end),
    dark: state.platform.dark !== false
  }, `preview:${phase}:${now}`)
  return true
}

async function detectElevation() {
  try {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], 10000)
    return out.ok && /true/i.test(out.stdout)
  } catch {
    return null
  }
}

async function detectDark() {
  const out = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'])
  const match = /AppsUseLightTheme\s+REG_DWORD\s+0x(\d+)/i.exec(out.stdout)
  return match ? Number(match[1]) === 0 : true
}

async function readDshVersion() {
  const candidates = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app.asar', 'package.json'))
  candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'package.json'))
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed && typeof parsed.version === 'string') return parsed.version
    } catch {
      /* try the next location */
    }
  }
  return ''
}

/** Compatibility self-check: report a broken API instead of failing silently. */
async function runSelfCheck(host) {
  const warnings = []
  const api = {
    webServer: typeof host?.webServer?.register === 'function',
    getOrigin: typeof host?.webServer?.getOrigin === 'function'
  }
  if (!api.webServer) warnings.push('webServer.register 不可用：插件接口没有注册')
  if (!api.getOrigin) warnings.push('webServer.getOrigin 不可用：桌面弹窗无法回调插件')
  let popup = false
  try {
    popup = (await stat(POPUP_EXE)).isFile()
  } catch {
    popup = false
  }
  if (!popup) warnings.push(`桌面弹窗程序缺失：${POPUP_EXE}`)
  const dshVersion = await readDshVersion()
  if (!dshVersion) warnings.push('未能读取 DSH 版本（升级后请确认 API 是否变化）')
  return { checkedAt: Date.now(), dshVersion, api, popup, warnings }
}

/**
 * DSH 升级后：版本变了就重跑自检。接口都在时把新版本写进兼容声明，
 * 否则留一条告警让人看见——自动改代码做不到，能自动的是「发现 + 声明 + 上报」。
 */
async function guardDshVersion(previousHealth) {
  const current = state.health && state.health.dshVersion
  if (!current) return
  const previous = (previousHealth && previousHealth.dshVersion) || state.lastDshVersion || ''
  if (previous === current) return
  state.lastDshVersion = current
  if (!previous) {
    remember('health', `首次记录 DSH 版本：${current}`)
    scheduleSave()
    return
  }
  const warnings = (state.health && state.health.warnings) || []
  if (warnings.length === 0) {
    const declared = await declareCompatibility(current)
    remember(declared ? 'version' : 'error', declared
      ? `DSH 已更新到 ${current}：自检通过，兼容声明已更新`
      : `DSH 已更新到 ${current}：自检通过，但兼容声明写入失败`)
  } else {
    remember('version', `DSH 已更新到 ${current}：自检发现 ${warnings.length} 个问题（${warnings[0]}）`)
  }
  scheduleSave()
}

/** 版本不在兼容表里时 DSH 可能拒绝加载插件，所以自检通过就自动补一行。 */
async function declareCompatibility(version) {
  try {
    const raw = await readFile(PACKAGE_FILE, 'utf8')
    const pkg = JSON.parse(raw)
    const compatibility = { ...((pkg.dsh && pkg.dsh.compatibility) || {}) }
    const releases = { ...(compatibility.dshReleases || {}) }
    if (releases[version] === 'compatible') return true
    releases[version] = 'compatible'
    pkg.dsh = { ...(pkg.dsh || {}), compatibility: { ...compatibility, dshReleases: releases } }
    await writeFile(PACKAGE_FILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 一键发布：插件目录的改动由宿主进程提交并推送（不经过工具沙箱）。 */
/** git 可能来自 MinGit、niubash 或 Program Files，逐个探测可用的那个。 */
async function resolveGit() {
  const candidates = ['git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe']
  for (const bin of candidates) {
    const probe = await run(bin, ['--version'], 10000)
    if (probe.ok) return bin
  }
  return ''
}

async function publishToGithub() {
  const dir = PLUGIN_DIR
  const bin = await resolveGit()
  if (!bin) return { ok: false, error: '找不到 git，请先安装 Git for Windows' }
  const git = (args, timeout = 30000) => run(bin, ['-C', dir, ...args], timeout)
  const probe = await git(['rev-parse', '--is-inside-work-tree'], 10000)
  if (!probe.ok || !/true/.test(probe.stdout)) return { ok: false, error: '插件目录不是 git 仓库' }
  const status = await git(['status', '--porcelain'], 15000)
  if (!status.ok) return { ok: false, error: `git status 失败：${status.stderr || status.stdout}` }
  const dirty = status.stdout.trim().length > 0
  const ahead = await git(['rev-list', '--count', '@{u}..HEAD'], 15000)
  const aheadCount = ahead.ok ? Number((ahead.stdout || '0').trim()) || 0 : 0
  if (!dirty && aheadCount === 0) return { ok: false, error: '没有需要发布的改动' }
  if (dirty) {
    const added = await git(['add', '-A'], 30000)
    if (!added.ok) return { ok: false, error: `git add 失败：${added.stderr || added.stdout}` }
    const version = state.health && state.health.dshVersion ? `（DSH ${state.health.dshVersion}）` : ''
    const message = `chore: 同步插件更新${version}`
    const committed = await git(['commit', '-m', message], 30000)
    if (!committed.ok && !/nothing to commit/i.test(String(committed.stdout) + String(committed.stderr))) {
      return { ok: false, error: `git commit 失败：${committed.stderr || committed.stdout}` }
    }
  }
  const pushed = await git(['push'], 90000)
  if (!pushed.ok) return { ok: false, error: `git push 失败：${(pushed.stderr || pushed.stdout || '').slice(-400)}` }
  const head = await git(['rev-parse', '--short', 'HEAD'], 10000)
  const commit = (head.stdout || '').trim()
  remember('publish', `已发布到 GitHub：${commit}`)
  return { ok: true, commit }
}

async function applyLogonBlock() {
  const spec = logonHoursSpec(state.config)
  if (!spec) {
    state.login = { applied: false, error: '某天的宵禁窗口覆盖全天，拒绝设置登录限制', needsAdmin: false, checkedAt: Date.now() }
    scheduleSave()
    return { ok: false, error: state.login.error }
  }
  if (state.platform.elevated === false) {
    state.login = { applied: false, error: '需要管理员权限：请以管理员身份运行 DSH', needsAdmin: true, checkedAt: Date.now() }
    scheduleSave()
    remember('error', `登录限制未生效：${state.login.error}`)
    return { ok: false, error: state.login.error, needsAdmin: true }
  }
  const user = process.env.USERNAME || ''
  const result = await run('net.exe', ['user', user, `/times:${spec}`])
  const needsAdmin = !result.ok && /管理员/.test(describeNetError(result))
  state.login = result.ok
    ? { applied: true, error: '', needsAdmin: false, checkedAt: Date.now() }
    : { applied: false, error: describeNetError(result), needsAdmin, checkedAt: Date.now() }
  scheduleSave()
  if (!result.ok) remember('error', `登录限制设置失败：${state.login.error}`)
  return { ok: result.ok, error: state.login.error, needsAdmin }
}

async function restoreLogon() {
  const user = process.env.USERNAME || ''
  const result = await run('net.exe', ['user', user, '/times:all'])
  state.login = result.ok
    ? { applied: false, error: '', needsAdmin: false, checkedAt: Date.now() }
    : { ...state.login, error: describeNetError(result), checkedAt: Date.now() }
  scheduleSave()
  if (result.ok) remember('config', '登录限制已恢复为全天可用')
  return { ok: result.ok, error: state.login.error }
}

/** Runs at logon next to the launcher: hides the window as soon as it appears. */
function hideScriptText() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Add-Type -Namespace HL -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);'`,
    '$deadline = (Get-Date).AddSeconds(90)',
    'while ((Get-Date) -lt $deadline) {',
    '  $p = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1',
    '  if ($p) {',
    '    $p.Refresh()',
    '    $h = $p.MainWindowHandle',
    '    if ($h -ne [IntPtr]::Zero -and [HL.Win]::IsWindowVisible($h)) {',
    '      [HL.Win]::ShowWindow($h, 0) | Out-Null',
    '      Start-Sleep -Seconds 3',
    '      [HL.Win]::ShowWindow($h, 0) | Out-Null',
    '      break',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 20',
    '}'
  ].join('\r\n')
}

/** Keep the launcher task in sync: logon trigger when auto-start is on, otherwise idle. */
async function ensureLaunchTask() {
  const user = process.env.USERNAME || ''
  const trigger = state.config.autoStart
    ? `(New-ScheduledTaskTrigger -AtLogOn -User '${user}')`
    : '(New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10))'
  const script = `Register-ScheduledTask -TaskName '${LAUNCH_TASK}' -Action (New-ScheduledTaskAction -Execute '${process.execPath}') -Trigger ${trigger} -RunLevel Highest -Force | Out-Null`
  const launch = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 30000)

  if (state.config.autoStart) {
    try {
      await mkdir(STATE_DIR, { recursive: true })
      await writeFile(HIDE_SCRIPT, hideScriptText(), 'utf8')
    } catch {
      /* the hide task is best effort */
    }
    const hide = `Register-ScheduledTask -TaskName '${HIDE_TASK}' -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${HIDE_SCRIPT}') -Trigger (New-ScheduledTaskTrigger -AtLogOn -User '${user}') -RunLevel Highest -Force | Out-Null`
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', hide], 30000)
  } else {
    await run('schtasks.exe', ['/delete', '/tn', HIDE_TASK, '/f'], 10000)
  }

  return launch
}

/** Remove leftovers from earlier curfew experiments that point at deleted scripts. */
async function cleanupLegacyTasks() {
  for (const name of ['AutoPowerOn0930', 'AutoShutdownPrompt', 'CurfewResumeGuard']) {
    const query = await run('schtasks.exe', ['/query', '/tn', name], 10000)
    if (!query.ok) continue
    const deleted = await run('schtasks.exe', ['/delete', '/tn', name, '/f'], 10000)
    remember('cleanup', deleted.ok ? `已清理残留任务 ${name}` : `清理任务 ${name} 失败：${deleted.stderr || deleted.stdout}`)
  }
}

async function applyAutoStart(enabled) {
  // The HKCU Run entry launches the exe through the shell, and because the exe carries
  // the RUNASADMIN compatibility flag that means a UAC prompt at logon. Drive the
  // elevated launcher task instead and drop the Run entry.
  await run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
  const result = await ensureLaunchTask()
  return { ok: result.ok, error: result.ok ? '' : (result.stderr || result.stdout) }
}

function setPhase(phase, reason = '') {
  if (state.phase === phase && state.reason === reason) return
  state.phase = phase
  state.reason = reason
  scheduleSave()
}

function resetNightIfNeeded(key, start, countdownMs) {
  if (night.key === key) return
  night = { key, resolved: '', reason: '', deadline: start + countdownMs, extended: false }
  shutdownIssued = false
  shutdownFired = false
  guardedNight = ''
  warningShown = ''
  state.unsaved = null
}

async function tickInner() {
  await loadState()
  const now = Date.now()
  rollQuota(now)
  await rotateGuardLog(now)

  if (preview.phase && now < preview.until) {
    setPhase(preview.phase, '预览')
    return
  }
  preview = { phase: '', from: 0, until: 0 }
  previewing = false

  if (!state.config.curfewEnabled) {
    setPhase('idle')
    hidePopup()
    return
  }

  const warnMs = Math.max(1, Number(state.config.warnMinutes) || 5) * MINUTE
  const guardMs = GUARD_MINUTES * MINUTE
  const countdownMs = Math.max(5, Number(state.config.countdownSeconds) || 30) * 1000
  const current = intervalAt(now, state.config.days)
  const upcoming = nextInterval(now, state.config.days)
  const horizon = Math.max(warnMs, guardMs)
  const target = current || (upcoming && now >= upcoming.start - horizon ? upcoming : null)

  if (!target) {
    setPhase('idle')
    hidePopup()
    return
  }

  resetNightIfNeeded(dayKey(target.start), target.start, countdownMs)

  const guardFrom = target.start - guardMs
  if (now >= guardFrom && now < target.end && guardedNight !== night.key) {
    guardedNight = night.key
    await spawnGuard(target.start + countdownMs + UNSAVED_EXTENSION_SECONDS * 1000 + 60000)
  }

  if (now < guardFrom) {
    setPhase('idle')
    hidePopup()
    return
  }

  if (now < target.start) {
    await refreshExitLog()
    if (now >= target.start - warnMs) {
      setPhase('warning')
      if (warningShown !== night.key && state.dismissed !== night.key) {
        warningShown = night.key
        await showPopup('warning', target)
      }
    } else {
      setPhase('idle')
    }
    return
  }

  if (night.resolved === 'cancel') {
    setPhase('skipped')
    hidePopup()
    return
  }
  if (night.resolved === 'exempt') {
    setPhase('exempt', night.reason)
    hidePopup()
    return
  }

  if (now < night.deadline) {
    if (!shutdownIssued) {
      const exemption = await detectExemption(now, target)
      if (exemption && quotaLeft() > 0) {
        state.exemptTonight = exemption
        state.nights[night.key] = 'exempt'
        useQuota('exempt', `自动豁免：${exemption.label}`)
        night = { ...night, resolved: 'exempt', reason: exemption.label }
        if (state.login.applied) await restoreLogon()
        setPhase('exempt', exemption.label)
        hidePopup()
        return
      }
      if (exemption) remember('blocked', `检测到${exemption.label}，但取消配额已用完`)
      if (state.config.loginBlock && loginAttemptKey !== night.key) {
        loginAttemptKey = night.key
        await applyLogonBlock()
      }
      state.nights[night.key] = 'shutdown'
      shutdownIssued = true
      remember('shutdown', `倒计时结束将关机（${hhmm(night.deadline)}）`)
    }

    if (!night.extended && now >= night.deadline - 4000) {
      const apps = await detectUnsaved()
      if (apps.length > 0) {
        state.unsaved = { apps, at: now }
        night = { ...night, extended: true, deadline: now + UNSAVED_EXTENSION_SECONDS * 1000 }
        remember('extend', `检测到未保存内容（${apps.join('、')}），额外给 ${UNSAVED_EXTENSION_SECONDS} 秒保存`)
        setPhase('extended')
        hidePopup()
        await showPopup('countdown', target)
        return
      }
    }

    setPhase(night.extended ? 'extended' : 'countdown')
    await showPopup('countdown', target)
    return
  }

  if (!shutdownFired) {
    shutdownFired = true
    await run('shutdown.exe', ['/s', '/t', '0', '/f'])
    remember('shutdown', '立即关机')
  }
  setPhase('shutdown')
  hidePopup()
}

let ticking = false

/** Serialized scheduler tick: a slow PowerShell probe must never overlap the next one. */
async function tick() {
  if (ticking) return
  ticking = true
  try {
    await tickInner()
  } catch {
    /* a scheduler failure must not stop the interval */
  } finally {
    ticking = false
  }
}

// 弹窗里说“周六 00:00”不如说“明天 00:00”：跨过午夜的那一晚，用户想的是“今晚几点”。
function dayLabel(ts, now = Date.now()) {
  const startOf = (value) => {
    const d = new Date(value)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diff = Math.round((startOf(ts) - startOf(now)) / DAY)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  return WEEKDAYS[new Date(ts).getDay()]
}
function publicState(now = Date.now()) {
  const current = intervalAt(now, state.config.days)
  const upcoming = nextInterval(now, state.config.days)
  const shown = current || upcoming
  return {
    ok: true,
    serverNow: now,
    config: state.config,
    phase: state.phase,
    reason: state.reason,
    quota: {
      nightUsed: state.quota.nightUsed,
      weekUsed: state.quota.weekUsed,
      nightQuota: state.config.nightQuota,
      weekQuota: state.config.weekQuota,
      left: quotaLeft()
    },
    window: shown ? { start: shown.start, end: shown.end, dayIdx: shown.dayIdx } : null,
    active: Boolean(current),
    configLock: configLock(now),
    deadline: night.deadline,
    extended: night.extended,
    unsaved: state.unsaved,
    guard: shown ? {
      minutes: GUARD_MINUTES,
      from: shown.start - GUARD_MINUTES * MINUTE,
      until: shown.start + Math.max(5, Number(state.config.countdownSeconds) || 30) * 1000 + UNSAVED_EXTENSION_SECONDS * 1000 + 60000,
      active: now >= shown.start - GUARD_MINUTES * MINUTE && now < shown.start + Math.max(5, Number(state.config.countdownSeconds) || 30) * 1000 + UNSAVED_EXTENSION_SECONDS * 1000 + 60000,
      spawned: guardedNight === dayKey(shown.start)
    } : null,
    report: buildReport(now),
    recentExits: state.recentExits.slice(-5),
    exemptTonight: state.exemptTonight,
    previewFrom: preview.from,
    previewUntil: preview.until,
    exemptions: EXEMPTIONS,
    weekdays: WEEKDAYS,
    health: state.health,
    history: state.history,
    login: state.login,
    platform: state.platform
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 200000) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function sanitizeConfig(patch) {
  const next = { ...state.config, ...(patch || {}) }
  next.days = sanitizeDays(next.days)
  next.warnMinutes = Math.min(30, Math.max(1, Number(next.warnMinutes) || 5))
  next.countdownSeconds = Math.min(120, Math.max(5, Number(next.countdownSeconds) || 30))
  next.nightQuota = Math.min(10, Math.max(0, Number(next.nightQuota) || 0))
  next.weekQuota = Math.min(30, Math.max(0, Number(next.weekQuota) || 0))
  next.autoStart = next.autoStart === true
  next.curfewEnabled = next.curfewEnabled === true
  next.loginBlock = next.loginBlock === true
  return next
}

let rejectRequest = () => false

/** Same-origin gate for the plugin's own routes (DSH does not gate plugin prefixes). */
function gateRequest(req) {
  try {
    const site = req.headers?.['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return true
    const origin = req.headers?.origin
    const host = req.headers?.host
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) return true
      } catch {
        return true
      }
    }
    if (req.method === 'POST') {
      const type = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (type && type !== 'application/json' && type !== 'text/plain') return true
    }
    return false
  } catch {
    return true
  }
}

function makeHandler() {
  return async (req, res) => {
    if (rejectRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
    try {
      if (route === '/state' || route === '/state/') {
        sendJson(res, 200, publicState())
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const raw = await readBody(req)
      const body = raw ? JSON.parse(raw) : {}

      if (route === '/config' || route === '/config/') {
        const previousAutoStart = state.config.autoStart
        const previousCurfew = state.config.curfewEnabled
        const nextConfig = sanitizeConfig(body.patch)
        const lock = configLock()
        const lockedChange = lock
          ? LOCKED_CONFIG_KEYS.some((key) => JSON.stringify(nextConfig[key]) !== JSON.stringify(state.config[key]))
          : false
        if (lockedChange) {
          sendJson(res, 409, {
            ok: false,
            error: `距宵禁不足 ${GUARD_MINUTES} 分钟，窗口设置已锁定，${hhmm(lock.until)} 后解禁`,
            state: publicState()
          })
          return
        }
        state.config = nextConfig
        if (previousCurfew !== state.config.curfewEnabled && !state.config.curfewEnabled && state.login.applied) {
          await restoreLogon()
        }
        if (state.config.autoStart !== previousAutoStart) {
          const applied = await applyAutoStart(state.config.autoStart)
          remember('config', applied.ok
            ? (state.config.autoStart ? '已开启开机自启动' : '已关闭开机自启动')
            : `自启动设置失败：${applied.error}`)
        }
        if (body.patch && Object.prototype.hasOwnProperty.call(body.patch, 'curfewEnabled')) {
          remember('config', state.config.curfewEnabled ? '宵禁已开启' : '宵禁已关闭')
        }
        scheduleSave()
        await tick()
        sendJson(res, 200, publicState())
        return
      }

      if (route === '/cancel' || route === '/cancel/') {
        const now = Date.now()
        if (previewing) {
          previewing = false
          hidePopup()
          sendJson(res, 200, { ok: true, preview: true, state: publicState(now) })
          return
        }
        if (quotaLeft() <= 0) {
          sendJson(res, 200, { ok: false, error: '取消配额已用完', state: publicState(now) })
          return
        }
        useQuota('cancel', '本次关机已取消')
        night = { ...night, resolved: 'cancel', reason: '' }
        state.nights[night.key || dayKey(now)] = 'cancel'
        if (state.login.applied) await restoreLogon()
        setPhase('skipped')
        hidePopup()
        sendJson(res, 200, { ok: true, state: publicState(now) })
        return
      }

      if (route === '/shutdown' || route === '/shutdown/') {
        if (previewing) {
          previewing = false
          hidePopup()
          sendJson(res, 200, { ok: true, preview: true, state: publicState() })
          return
        }
        const result = await run('shutdown.exe', ['/s', '/t', '0', '/f', '/c', '健康生活宵禁：立即关机'])
        remember('shutdown', '用户选择立即关机')
        sendJson(res, 200, { ok: result.ok, error: result.ok ? '' : result.stderr, state: publicState() })
        return
      }

      if (route === '/login-block' || route === '/login-block/') {
        const result = body.enabled === false ? await restoreLogon() : await applyLogonBlock()
        sendJson(res, 200, { ok: result.ok, error: result.error || '', state: publicState() })
        return
      }

      if (route === '/reset-quota' || route === '/reset-quota/') {
        state.quota.nightUsed = 0
        state.quota.weekUsed = 0
        state.exemptTonight = null
        remember('config', '取消配额已重置')
        sendJson(res, 200, publicState())
        return
      }

      if (route === '/dismiss' || route === '/dismiss/') {
        state.dismissed = night.key || ''
        scheduleSave()
        remember('dismiss', '已关闭今晚的提前提醒')
        hidePopup()
        sendJson(res, 200, { ok: true, state: publicState() })
        return
      }

      if (route === '/publish' || route === '/publish/') {
        const result = await publishToGithub()
        sendJson(res, result.ok ? 200 : 500, { ...result, state: publicState() })
        return
      }

      if (route === '/selfcheck' || route === '/selfcheck/') {
        state.health = await runSelfCheck(hostCtx)
        remember('health', state.health.warnings.length
          ? `自检发现 ${state.health.warnings.length} 个问题`
          : '自检通过')
        scheduleSave()
        sendJson(res, 200, publicState())
        return
      }

      if (route === '/test' || route === '/test/') {
        const phase = body.phase === 'countdown' ? 'countdown' : 'warning'
        const seconds = phase === 'countdown' ? Math.max(5, Number(state.config.countdownSeconds) || 30) : 15
        if (!nextInterval(Date.now(), state.config.days)) {
          sendJson(res, 409, {
            ok: false,
            error: '当前没有可预览的宵禁窗口（宵禁已关闭，或所有日期都未启用）',
            state: publicState()
          })
          return
        }
        preview = { phase, from: Date.now(), until: Date.now() + seconds * 1000 }
        previewing = true
        setPhase(phase, '预览')
        remember('test', phase === 'countdown' ? '预览倒计时弹窗' : '预览提前提醒')
        await showPreviewPopup(phase, seconds)
        sendJson(res, 200, publicState())
        return
      }

      sendJson(res, 404, { ok: false, error: 'unknown route' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function apply(ctx) {
  hostCtx = ctx
  rejectRequest = gateRequest
  try {
    apiOrigin = typeof ctx.webServer?.getOrigin === 'function' ? ctx.webServer.getOrigin() : 'http://127.0.0.1:0'
  } catch {
    apiOrigin = 'http://127.0.0.1:0'
  }

  try {
    if (typeof ctx.webServer?.register === 'function') {
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: makeHandler() }), 'healthylife: api routes')
    }
  } catch (error) {
    // A renamed or changed webServer API must not take the whole plugin down.
    remember('error', `接口注册失败：${error instanceof Error ? error.message : error}`)
  }

  void loadState().then(async () => {
    state.platform.elevated = await detectElevation()
    state.platform.dark = await detectDark()
    const previousHealth = state.health
    state.health = await runSelfCheck(ctx)
    await guardDshVersion(previousHealth)
    await cleanupLegacyTasks()
    if (state.config.autoStart) await ensureLaunchTask()
    await run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
    if (state.login.error && state.login.error.includes('\uFFFD')) {
      state.login = { applied: false, error: '', needsAdmin: state.platform.elevated === false, checkedAt: Date.now() }
    }
    if (state.health.warnings.length) {
      for (const warning of state.health.warnings) remember('health', warning)
    }
    scheduleSave()
    void tick().catch(() => {})
    tickTimer = setInterval(() => {
      void tick().catch(() => {})
    }, 5000)
  }).catch(() => {})

  ctx.effect(() => () => {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    hidePopup()
    scheduleSave()
  }, 'healthylife: scheduler')
}
