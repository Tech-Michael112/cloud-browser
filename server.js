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
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
      viewport: { width: 360, height: 780 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"Android"',
      }
    })

    const page = await context.newPage()

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      Object.defineProperty(navigator, 'platform', { get: () => 'Linux aarch64' })
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 })
      window.chrome = { runtime: {} }
    })

    await page.goto(url || 'https://google.com', { waitUntil: 'domcontentloaded' })

    const sessionId = Date.now().toString()
    sessions[sessionId] = { browser, page, context, active: true, ws: null }

    res.json({ sessionId })
  } catch (err) {
    console.error('Session error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Raw WebSocket — faster than socket.io
wss.on('connection', (ws) => {
  let sessionId = null
  let streamLoop = null

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'join') {
      sessionId = msg.sessionId
      const session = sessions[sessionId]
      if (!session) { ws.send(JSON.stringify({ type: 'error', msg: 'Session not found' })); return }
      session.ws = ws
      startStream(ws, sessionId)
    }

    if (!sessionId || !sessions[sessionId]) return
    const { page } = sessions[sessionId]

    try {
      if (msg.type === 'tap') await page.touchscreen.tap(msg.x, msg.y)
      if (msg.type === 'scroll') await page.mouse.wheel(0, msg.delta)
      if (msg.type === 'type') await page.keyboard.type(msg.text, { delay: 0 })
      if (msg.type === 'key') await page.keyboard.press(msg.key)
      if (msg.type === 'navigate') await page.goto(msg.url, { waitUntil: 'domcontentloaded' })
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

  // Stream as fast as possible using raw WebSocket binary frames
  while (session.active && sessions[sessionId]) {
    try {
      if (ws.readyState !== WebSocket.OPEN) break

      // Take screenshot as raw buffer — no base64 encoding overhead
      const buffer = await page.screenshot({ type: 'jpeg', quality: 50 })

      // Send as binary — much faster than base64
      ws.send(buffer, { binary: true })

      // Send URL as text
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'url', url: page.url() }))
      }

    } catch (err) { break }
  }
}

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log('Server running on port ' + PORT))