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
PART1
