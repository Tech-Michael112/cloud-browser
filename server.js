const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { chromium } = require('playwright')

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.static('public'))
app.use(express.json())

const sessions = {}

app.post('/api/session', async (req, res) => {
  try {
    const { url, userAgent, width, height } = req.body

    const w = parseInt(width) || 360
    const h = parseInt(height) || 780

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    })

    const context = await browser.newContext({
      userAgent: userAgent,
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    })

    const page = await context.newPage()

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    })

    await page.goto(url || 'https://accounts.google.com')

    const sessionId = Date.now().toString()
    sessions[sessionId] = { browser, page, context, width: w, height: h, active: true }

    res.json({ sessionId, width: w, height: h })
  } catch (err) {
    console.error('Session error:', err)
    res.status(500).json({ error: err.message })
  }
})

io.on('connection', (socket) => {
  socket.on('join', (sessionId) => {
    socket.sessionId = sessionId
    startStreaming(socket, sessionId)
  })

  socket.on('input', async (data) => {
    const session = sessions[socket.sessionId]
    if (!session) return
    const { page } = session

    try {
      if (data.type === 'tap') {
        await page.touchscreen.tap(data.x, data.y)
      }
      if (data.type === 'scroll') {
        await page.mouse.wheel(0, data.delta)
      }
      if (data.type === 'type') {
        await page.keyboard.type(data.text, { delay: 0 })
      }
      if (data.type === 'key') {
        await page.keyboard.press(data.key)
      }
      if (data.type === 'navigate') {
        await page.goto(data.url)
      }
    } catch (err) {
      console.error('Input error:', err)
    }
  })

  socket.on('disconnect', async () => {
    const session = sessions[socket.sessionId]
    if (session) {
      session.active = false
      await session.browser.close()
      delete sessions[socket.sessionId]
    }
  })
})

async function startStreaming(socket, sessionId) {
  const session = sessions[sessionId]
  if (!session) { socket.emit('error', 'Session not found'); return }

  const { page } = session

  const loop = async () => {
    while (session.active && sessions[sessionId]) {
      try {
        const screenshot = await page.screenshot({
          type: 'jpeg',
          quality: 55
        })
        if (socket.connected) {
          socket.volatile.emit('frame', screenshot.toString('base64'))
          socket.volatile.emit('url', page.url())
        } else {
          break
        }
      } catch (err) {
        break
      }
    }
  }

  loop()
}

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log('Server running on port ' + PORT))