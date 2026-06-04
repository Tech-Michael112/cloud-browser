const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const { chromium } = require('playwright')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use(express.static('public'))
app.use(express.json())

const sessions = {}

app.post('/api/session', async (req, res) => {
  try {
    const { url } = req.body

    const fp = {
      width: [360, 375, 390, 412][Math.floor(Math.random() * 4)],
      height: [780, 812, 844, 915][Math.floor(Math.random() * 4)],
      memory: [4, 6, 8][Math.floor(Math.random() * 3)],
      cores: [4, 6, 8][Math.floor(Math.random() * 3)],
      platform: ['Linux aarch64', 'Linux armv8l'][Math.floor(Math.random() * 2)],
      androidVersion: ['11', '12', '13'][Math.floor(Math.random() * 3)],
      chromeVersion: ['118', '119', '120', '121'][Math.floor(Math.random() * 4)],
      timezone: ['America/New_York', 'America/Chicago', 'America/Los_Angeles'][Math.floor(Math.random() * 3)]
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ]
    })

    const context = await browser.newContext({
      userAgent: `Mozilla/5.0 (Linux; Android ${fp.androidVersion}; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.chromeVersion}.0.6099.144 Mobile Safari/537.36`,
      viewport: { width: fp.width, height: fp.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      timezoneId: fp.timezone,
      colorScheme: 'light',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-CH-UA': `"Not_A Brand";v="8", "Chromium";v="${fp.chromeVersion}", "Google Chrome";v="${fp.chromeVersion}"`,
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"Android"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }
    })

    await context.clearCookies()

    const page = await context.newPage()

    await page.addInitScript((fp) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'platform', { get: () => fp.platform })
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.cores })
      Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.memory })
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin' },
            { name: 'Chrome PDF Viewer' },
            { name: 'Native Client' }
          ]
          arr.item = (i) => arr[i]
          return arr
        }
      })
      window.chrome = { runtime: {}, app: { isInstalled: false } }
      const origQuery = navigator.permissions.query.bind(navigator.permissions)
      navigator.permissions.query = (p) =>
        p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p)
    }, fp)

    await page.goto(url || 'https://google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    const sessionId = Date.now().toString()
    sessions[sessionId] = { browser, page, context, active: true }

    res.json({ sessionId })
  } catch (err) {
    console.error('Session error:', err)
    res.status(500).json({ error: err.message })
  }
})

wss.on('connection', (ws) => {
  let sessionId = null

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString())
    } catch { return }

    if (msg.type === 'join') {
      sessionId = msg.sessionId
      const session = sessions[sessionId]
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Session not found' }))
        return
      }
      startStream(ws, sessionId)
      return
    }

    if (!sessionId || !sessions[sessionId]) return
    const { page } = sessions[sessionId]

    try {
      if (msg.type === 'tap') await page.touchscreen.tap(msg.x, msg.y)
      if (msg.type === 'scroll') await page.mouse.wheel(0, msg.delta)
      if (msg.type === 'type') await page.keyboard.type(msg.text, { delay: 0 })
      if (msg.type === 'key') await page.keyboard.press(msg.key)
      if (msg.type === 'navigate') await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (err) {
      console.error('Input error:', err)
    }
  })

  ws.on('close', async () => {
    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].active = false
      try { await sessions[sessionId].browser.close() } catch (e) {}
      delete sessions[sessionId]
    }
  })
})

async function startStream(ws, sessionId) {
  const session = sessions[sessionId]
  if (!session) return
  const { page } = session

  while (session.active && sessions[sessionId]) {
    try {
      if (ws.readyState !== WebSocket.OPEN) break
      const buffer = await page.screenshot({ type: 'jpeg', quality: 50 })
      ws.send(buffer, { binary: true })
      ws.send(JSON.stringify({ type: 'url', url: page.url() }))
    } catch (err) { break }
  }
}

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log('Server running on port ' + PORT))