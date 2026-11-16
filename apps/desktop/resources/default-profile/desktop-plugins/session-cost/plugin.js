/**
 * session-cost — live spend readout for the focused chat, in the desktop status bar.
 *
 * Prices come from DeepSeek's official CNY list (yuan per 1M tokens) with the
 * peak / off-peak windows DeepSeek bills on. MagPie serves this session through
 * a subscription (its own cost field reads 0), so this is the "what it would
 * have cost at list price" figure, not an invoice.
 *
 * RESTART CAVEAT — `host.state.focusedUsage` is the LIVE RUNTIME's counter.
 * Resuming a session builds a new runtime whose counters start at zero, so the
 * chip would silently under-report everything spent before the restart. This
 * plugin keeps a per-session high-water mark in ctx.storage (localStorage, so it
 * survives restarts) and shows the larger of the two. When the mark is the one
 * being shown the tooltip says 累计 — that number includes pre-restart spend.
 *
 * Hot reload: save the file and the chip updates within a second.
 *
 * DeepSeek V4.1 Flash (deepseek-flash), CNY / 1M:
 *              cache hit  cache miss  output
 *   off-peak     0.02        1.00      4.00
 *   peak         0.04        2.00      8.00
 * Peak = 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri (= 09:00-12:00 / 14:00-18:00
 * Beijing). Everything else, weekends included, is off-peak.
 *
 * Token accounting matches the gateway: `input` excludes cache reads, and
 * `cache_hit_pct` = cache_read / (input + cache_read + cache_write), so cache
 * reads are recovered as pct x prompt_total.
 */

import { cn, haptic, host, Tip, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const ID = 'session-cost'

// Captured in register() so components can reach the clipboard door.
let CTX = null

const V41_FLASH = {
  offpeak: { input: 1, cacheRead: 0.02, output: 4 },
  peak: { input: 2, cacheRead: 0.04, output: 8 }
}

const V4_PRO = {
  offpeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
  peak: { input: 9, cacheRead: 0.3, output: 27 }
}

// Keyed by the model id Hermes reports; every MagPie alias of one model shares
// a row. Add a `*` row to price anything unlisted.
const RATES = {
  'group/deepseek': V41_FLASH,
  'auto/deepseek-v4.1-flash': V41_FLASH,
  'workbuddy/deepseek-v4.1-flash': V41_FLASH,
  'workbuddy-ai/deepseek-v4.1-flash': V41_FLASH,
  'deepseek-v4.1-flash': V41_FLASH,
  'workbuddy/deepseek-v4-pro': V4_PRO,
  'deepseek-v4-pro': V4_PRO
}

function isPeak(d = new Date()) {
  const dow = d.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const h = d.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

function rateFor(model, d) {
  const table = RATES[model] || RATES['*']
  if (!table) return null
  return isPeak(d) ? table.peak : table.offpeak
}

/** Split a UsageStats snapshot into the three billable buckets. */
export function buckets(u) {
  const out = u.output || 0
  const promptTotal = Math.max(0, (u.total || 0) - out)
  const cached = Math.round(((u.cache_hit_pct || 0) / 100) * promptTotal)
  return { fresh: u.input || 0, cached, out }
}

export function costOf(u, rate) {
  if (!rate || !u) return null
  const { fresh, cached, out } = buckets(u)
  const cacheRate = typeof rate.cacheRead === 'number' ? rate.cacheRead : (rate.input || 0)
  return (
    (fresh / 1e6) * (rate.input || 0) +
    (cached / 1e6) * cacheRate +
    (out / 1e6) * (rate.output || 0)
  )
}

function money(v) {
  if (v == null) return null
  if (v > 0 && v < 0.01) return `¥${v.toFixed(4)}`
  if (v < 1) return `¥${v.toFixed(3)}`
  return `¥${v.toFixed(2)}`
}

function tok(n) {
  const v = n || 0
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`
  return String(v)
}

const snapshotOf = u => ({
  input: u.input || 0,
  output: u.output || 0,
  total: u.total || 0,
  cache_hit_pct: u.cache_hit_pct || 0,
  calls: u.calls || 0,
  cost_usd: u.cost_usd || 0
})

/**
 * Cross-restart accumulates, as a pure reducer so it is testable.
 *
 * `focusedUsage` is the LIVE runtime's counter: resuming a session builds a new
 * runtime starting at zero, which is why the chip used to drop to pennies after
 * a restart. We carry a base plus an anchor:
 *
 *   display = base + (live − anchor)
 *
 * `anchor` is the live reading when the current runtime started; when a restart
 * makes `live` smaller than the last reading we folded everything observed so
 * far (last − anchor) into `base` and re-anchored at the new zero.
 */
export function advance(prev, live, calls) {
  const total = live.fresh + live.cached + live.out
  if (!prev) {
    // First sight: the runtime's counter already IS the session total, so the
    // anchor is zero — anchoring at `live` would throw that reading away.
    return {
      bf: 0, bc: 0, bo: 0, bcall: 0,
      af: 0, ac: 0, ao: 0, acall: 0,
      lf: live.fresh, lc: live.cached, lo: live.out, lcall: calls
    }
  }
  const s = { ...prev }
  const lastTotal = (s.lf || 0) + (s.lc || 0) + (s.lo || 0)
  if (total < lastTotal || calls < (s.lcall || 0)) {
    // Restart (or a runtime swap): bank what this runtime contributed, re-anchor.
    s.bf += Math.max(0, (s.lf || 0) - (s.af || 0))
    s.bc += Math.max(0, (s.lc || 0) - (s.ac || 0))
    s.bo += Math.max(0, (s.lo || 0) - (s.ao || 0))
    s.bcall += Math.max(0, (s.lcall || 0) - (s.acall || 0))
    s.af = live.fresh
    s.ac = live.cached
    s.ao = live.out
    s.acall = calls
  }
  s.lf = live.fresh
  s.lc = live.cached
  s.lo = live.out
  s.lcall = calls
  return s
}

/** Buckets for the whole session: banked base + this runtime's delta. */
export function displayOf(prev, live) {
  if (!prev) return live
  return {
    fresh: Math.max(0, prev.bf || 0) + Math.max(0, live.fresh - (prev.af || 0)),
    cached: Math.max(0, prev.bc || 0) + Math.max(0, live.cached - (prev.ac || 0)),
    out: Math.max(0, prev.bo || 0) + Math.max(0, live.out - (prev.ao || 0))
  }
}

function costOfBuckets(b, rate) {
  if (!rate || !b) return null
  const cacheRate = typeof rate.cacheRead === 'number' ? rate.cacheRead : (rate.input || 0)
  return (
    (b.fresh / 1e6) * (rate.input || 0) +
    (b.cached / 1e6) * cacheRate +
    (b.out / 1e6) * (rate.output || 0)
  )
}

function SessionCostChip() {
  const usage = useValue(host.state.focusedUsage)
  const busy = useValue(host.state.busy)
  const model = useValue(host.state.model)
  const storedId = useValue(host.state.focusedStoredSessionId)
  const runtimeId = useValue(host.state.focusedSessionId)

  // Per-session ledger: banked base + the anchor this runtime started from.
  const stateKey = storedId ? `ledger:${storedId}` : null
  const [ledger, setLedger] = useState(() => (stateKey && CTX?.storage?.get(stateKey, null)) || null)

  // Follow the focused session: a different chat gets its own ledger.
  useEffect(() => {
    setLedger((stateKey && CTX?.storage?.get(stateKey, null)) || null)
  }, [stateKey])

  // The streamed snapshot can be missing two ways: a cold session, or a client
  // whose gateway ticket path is broken (then NO usage ever arrives and the
  // chip silently reads n/a). Ask the backend directly in that case, and name
  // the failure instead of implying "unpriced".
  const [rpcUsage, setRpcUsage] = useState(null)
  const [rpcError, setRpcError] = useState(null)

  useEffect(() => {
    setRpcUsage(null)
    setRpcError(null)
    if (!runtimeId || usage) return
    let alive = true
    let attempts = 0
    let timer = null
    const poll = async () => {
      attempts += 1
      try {
        const u = await host.request('session.usage', { session_id: runtimeId })
        if (!alive) return
        if (u && ((u.total || 0) > 0 || (u.calls || 0) > 0)) {
          setRpcUsage(u)
          setRpcError(null)
          return
        }
        setRpcError(null)
      } catch (error) {
        if (alive) setRpcError(String((error && error.message) || error))
      }
      if (alive && attempts < 12) timer = setTimeout(poll, 5000)
    }
    timer = setTimeout(poll, 600)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [runtimeId, usage])

  const snapshot = usage || rpcUsage
  const live = snapshot ? buckets(snapshot) : null
  const liveCalls = snapshot?.calls || 0

  // Fold every reading into the ledger; a restart re-anchors instead of resetting.
  useEffect(() => {
    if (!stateKey || !live) return
    setLedger(prev => {
      const next = advance(prev, live, liveCalls)
      if (prev && JSON.stringify(next) === JSON.stringify(prev)) return prev
      CTX?.storage?.set(stateKey, next)
      return next
    })
  }, [stateKey, usage])

  // Re-render on the peak/off-peak boundary even when no token moves.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Snapshot at the start of the running turn. Cost is linear in tokens, so the
  // turn's spend is cost(now) - cost(then) — no delta bookkeeping needed.
  const base = useRef(null)
  const wasBusy = useRef(false)
  useEffect(() => {
    if (busy && !wasBusy.current && usage) base.current = usage
    wasBusy.current = busy
  }, [busy, usage])

  // Whole-session buckets = banked base + this runtime's delta.
  const total = live ? displayOf(ledger, live) : null

  const peak = isPeak(now)
  const rate = rateFor(model || snapshot?.model, now)
  const sessionCost = usage?.cost_usd > 0 && !ledger?.bf ? usage.cost_usd : costOfBuckets(total, rate)
  const baseCost = base.current ? costOf(base.current, rate) : null
  const liveCost = usage ? costOf(usage, rate) : null
  const turnCost = liveCost != null && baseCost != null ? liveCost - baseCost : null

  const totalTokens = total ? total.fresh + total.cached + total.out : 0
  const totalCalls = live ? Math.max(0, (ledger?.bcall || 0) + (liveCalls - (ledger?.acall || 0))) : 0
  const label = sessionCost != null ? money(sessionCost) : totalTokens ? `${tok(totalTokens)} tok` : rpcError ? '未连接' : '—'

  const tip = total
    ? [
        `本会话 ${sessionCost != null ? money(sessionCost) : '未定价'}`,
        turnCost != null ? `本轮 ${money(turnCost)}` : null,
        rate ? (peak ? '高峰价' : '空闲价') : null,
        `↑${tok(total.fresh + total.cached)} ↓${tok(total.out)}`,
        total.fresh + total.cached > 0 ? `缓存 ${Math.round((total.cached / (total.fresh + total.cached)) * 100)}%` : null,
        `${totalCalls} 次调用`,
        ledger?.bf ? '含重启前的量' : null,
        '按 DeepSeek 官方标价估算'
      ]
        .filter(Boolean)
        .join(' · ')
    : rpcError
      ? `未收到用量：${rpcError.slice(0, 90)}`
      : '暂无用量数据'

  const copy = () => {
    haptic('tap')
    const text = [
      `session cost · ${model || snapshot?.model || 'unknown model'}${rate ? (peak ? ' · 高峰价' : ' · 空闲价') : ''}`,
      `session: ${sessionCost != null ? money(sessionCost) : 'unpriced'}${turnCost != null ? `  turn: ${money(turnCost)}` : ''}`,
      total ? `fresh ${total.fresh.toLocaleString()}  cached ${total.cached.toLocaleString()}  output ${total.out.toLocaleString()}  calls ${totalCalls}` : rpcError ? `no usage · ${rpcError.slice(0, 120)}` : 'no usage',
      rate ? `rate/1M (¥): in ${rate.input}  cache ${rate.cacheRead}  out ${rate.output}` : null
    ]
      .filter(Boolean)
      .join('\n')
    void CTX?.os?.writeClipboard?.(text)
    host.notify({ kind: 'info', message: text.split('\n').slice(0, 2).join(' · ') })
  }

  return jsx(Tip, {
    label: tip,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: copy,
      children: label
    })
  })
}

/** `12s` / `1m12s` / `1h03m` — short enough for the status bar. */
function dur(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * Turn clock. The built-in 回合计时 disappears when the turn ends; this one
 * holds the finished duration so the last turn's time stays readable.
 */
function TurnClockChip() {
  const busy = useValue(host.state.busy)
  const [now, setNow] = useState(() => Date.now())
  const startRef = useRef(null)
  const lastRef = useRef(null)
  const mountedAt = useRef(Date.now())

  useEffect(() => {
    if (busy && startRef.current == null) startRef.current = Date.now()
    if (!busy && startRef.current != null) {
      lastRef.current = Date.now() - startRef.current
      startRef.current = null
    }
  }, [busy])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const turnMs = busy && startRef.current ? now - startRef.current : lastRef.current
  const runMs = now - mountedAt.current
  const label = `⏱ ${dur(turnMs)}`
  const tip = [
    `本轮 ${dur(turnMs)}`,
    `本次运行 ${dur(runMs)}`,
    busy ? null : '空闲时保留上一轮用时'
  ]
    .filter(Boolean)
    .join(' · ')

  return jsx(Tip, {
    label: tip,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: tip })
      },
      children: label
    })
  })
}

/** 余额：MagPie 的 workbuddy credits，由本地 127.0.0.1:8925 转发（带 CORS）。 */
function BalanceChip() {
  const [prov, setProv] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('http://127.0.0.1:8925/quota', { cache: 'no-store' })
        const d = await r.json()
        if (!alive) return
        const list = d.providers || []
        setProv(list.find((p) => p && p.amount != null) || null)
        setErr(false)
      } catch (e) {
        if (alive) setErr(true)
      }
    }
    load()
    const id = setInterval(load, 60000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'))
  const label = err ? '余 —' : prov ? `余 ${fmt(prov.amount)}` : '余 —'
  const usedPct =
    prov && prov.limit ? Math.round((1 - prov.amount / prov.limit) * 100) : null
  const tip = err
    ? '余额服务没起来：launchctl list | grep magpie.quota'
    : prov
      ? `${prov.name} ${prov.plan} · 余额 ${fmt(prov.amount)} / ${fmt(prov.limit)} ${prov.unit}` +
        (usedPct != null ? `（已用 ${usedPct}%）` : '') +
        (prov.resetsAt ? `\n重置 ${new Date(prov.resetsAt).toLocaleString('zh-CN')}` : '')
      : '余额：暂无数据'

  return jsx(Tip, {
    label: tip,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        prov && prov.limit && prov.amount / prov.limit < 0.15
          ? 'text-amber-500 hover:text-amber-400'
          : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: tip })
      },
      children: label
    })
  })
}

export default {
  id: ID,
  name: 'Session Cost',
  register(ctx) {
    CTX = ctx
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(SessionCostChip, {})
    })
    ctx.register({
      id: 'clock',
      area: 'statusBar.right',
      order: 121,
      render: () => jsx(TurnClockChip, {})
    })
    ctx.register({
      id: 'balance',
      area: 'statusBar.right',
      order: 122,
      render: () => jsx(BalanceChip, {})
    })
  }
}
