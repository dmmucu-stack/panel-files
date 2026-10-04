const express = require('express')
const path = require('path')
const fs = require('fs')
const pino = require('pino')

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 3000
const SESSIONS_DIR = path.join(__dirname, 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR)

const ADMIN_PASSWORD = 'changeme123'
const SUBSCRIPTION_PRICE = 15
const SUBSCRIPTION_DAYS = 30
const FREE_NUMBERS = [
  // '254712345678',
]
const ADMIN_MPESA_NUMBER = '254791784448'

const SUBS_FILE = path.join(__dirname, 'subscriptions.json')
function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) } catch { return {} }
}
function saveSubs(subs) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)) } catch {}
}
let subscriptions = loadSubs()

function cleanNum(n) { return String(n || '').replace(/\D/g, '') }
function isFree(number) { return FREE_NUMBERS.map(cleanNum).includes(number) }
function isActive(number) {
  if (isFree(number)) return true
  const s = subscriptions[number]
  return !!(s && s.expiresAt && s.expiresAt > Date.now())
}

const sessions = new Map()

async function createBotForNumber(number) {
  const b = await import('@whiskeysockets/baileys')
  const lib = b.useMultiFileAuthState ? b : b.default
  const makeWASocket = lib.makeWASocket || lib.default
  const sessionPath = path.join(SESSIONS_DIR, number)
  const { state, saveCreds } = await lib.useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false
  })

  sock.ev.on('creds.update', saveCreds)

  const entry = sessions.get(number) || {}
  entry.sock = sock
  entry.status = 'connecting'
  sessions.set(number, entry)

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(number)
        const e = sessions.get(number)
        if (e) { e.code = code; e.status = 'awaiting_pair' }
      } catch (err) {
        const e = sessions.get(number)
        if (e) { e.status = 'error'; e.error = err.message }
      }
    }, 3000)
  }

  sock.ev.on('connection.update', (u) => {
    const e = sessions.get(number)
    if (!e) return
    if (u.connection === 'open') { e.status = 'online'; e.code = null }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      if (code === lib.DisconnectReason.loggedOut) {
        e.status = 'logged_out'
      } else if (isActive(number)) {
        e.status = 'reconnecting'
        setTimeout(() => createBotForNumber(number), 4000)
      } else {
        e.status = 'expired'
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ''
    const jid = m.key.remoteJid
    if (text === '!ping') await sock.sendMessage(jid, { text: 'Pong! This bot was deployed via the panel 🚀' })
    if (text === '!menu' || text === '!help') {
      await sock.sendMessage(jid, { text: 'Deployed Bot Menu:\n!ping\n!menu\n\nMore commands coming soon.' })
    }
  })
}

function deactivateNumber(number) {
  const e = sessions.get(number)
  if (e && e.sock) {
    try { e.sock.logout() } catch {}
    try { e.sock.end() } catch {}
  }
  sessions.delete(number)
}

app.post('/api/deploy', async (req, res) => {
  const number = cleanNum(req.body.number)
  if (!number || number.length < 9) return res.status(400).json({ error: 'Invalid number' })

  if (!isActive(number)) {
    return res.json({ status: 'payment_required', price: SUBSCRIPTION_PRICE, mpesaNumber: ADMIN_MPESA_NUMBER })
  }

  if (sessions.has(number) && ['online', 'connecting', 'awaiting_pair'].includes(sessions.get(number).status)) {
    return res.json({ status: sessions.get(number).status, code: sessions.get(number).code || null })
  }

  sessions.set(number, { status: 'connecting' })
  createBotForNumber(number).catch(err => {
    const e = sessions.get(number)
    if (e) { e.status = 'error'; e.error = err.message }
  })
  res.json({ status: 'connecting' })
})

app.post('/api/request-payment', (req, res) => {
  const number = cleanNum(req.body.number)
  if (!number || number.length < 9) return res.status(400).json({ error: 'Invalid number' })

  subscriptions[number] = subscriptions[number] || {}
  subscriptions[number].status = 'pending_manual'
  subscriptions[number].requestedAt = Date.now()
  saveSubs(subscriptions)

  res.json({ status: 'pending_manual' })
})

app.get('/api/status/:number', (req, res) => {
  const number = cleanNum(req.params.number)
  if (isActive(number)) {
    const e = sessions.get(number)
    if (!e) return res.json({ status: 'not_deployed_yet' })
    return res.json({ status: e.status, code: e.code || null, error: e.error || null })
  }
  const s = subscriptions[number]
  if (s?.status === 'pending_manual') return res.json({ status: 'pending_manual' })
  res.json({ status: 'payment_required', price: SUBSCRIPTION_PRICE, mpesaNumber: ADMIN_MPESA_NUMBER })
})

function checkAdmin(req, res, next) {
  if (req.query.password !== ADMIN_PASSWORD && req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' })
  }
  next()
}

app.get('/api/admin/users', checkAdmin, (req, res) => {
  const numbers = new Set([...Object.keys(subscriptions), ...FREE_NUMBERS.map(cleanNum), ...sessions.keys()])
  const list = Array.from(numbers).map(number => {
    const sub = subscriptions[number]
    const session = sessions.get(number)
    const free = isFree(number)
    const active = isActive(number)
    return {
      number,
      free,
      botStatus: session?.status || 'not_deployed',
      subStatus: free ? 'free_friend' : (active ? 'active' : (sub?.status || 'none')),
      expiresAt: sub?.expiresAt || null,
      daysLeft: sub?.expiresAt ? Math.max(0, Math.ceil((sub.expiresAt - Date.now()) / 86400000)) : (free ? '∞' : 0)
    }
  })
  res.json(list)
})

app.post('/api/admin/deactivate', checkAdmin, (req, res) => {
  const number = cleanNum(req.body.number)
  if (subscriptions[number]) { subscriptions[number].expiresAt = 0; saveSubs(subscriptions) }
  deactivateNumber(number)
  res.json({ ok: true })
})

app.post('/api/admin/extend', checkAdmin, (req, res) => {
  const number = cleanNum(req.body.number)
  const days = Number(req.body.days) || SUBSCRIPTION_DAYS
  subscriptions[number] = subscriptions[number] || {}
  subscriptions[number].status = 'active'
  subscriptions[number].expiresAt = Date.now() + days * 24 * 60 * 60 * 1000
  saveSubs(subscriptions)
  if (!sessions.has(number) || sessions.get(number).status !== 'online') {
    sessions.set(number, { status: 'connecting' })
    createBotForNumber(number).catch(() => {})
  }
  res.json({ ok: true })
})

setInterval(() => {
  for (const [number] of sessions) {
    if (!isActive(number)) {
      const e = sessions.get(number)
      if (e && e.status === 'online') {
        deactivateNumber(number)
      }
    }
  }
}, 60 * 60 * 1000)

app.listen(PORT, () => console.log(`Panel backend running on port ${PORT}`))
