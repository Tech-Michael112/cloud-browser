// server.js
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { chromium } = require('playwright')

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.static('public'))
app.use(express.json())

const sessions = {} // store active sessions

// Create a new browser session
app.post('/api/session', async (req, res) => {
  const { userAgent, width, height, dpr, touch, url } = req.body

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  const context = await browser.newContext({
    userAgent: userAgent,
    viewport: { width: width || 390, height: height || 844 },
    deviceScaleFactor: dpr || 3,
    isMobile: true,
    hasTouch: touch || true
  })

  const page = await context.newPage()
  await page.goto(url || 'https://google.com')

  const sessionId = Date.now().toString()
  sessions[sessionId] = { browser, page, context }

  res.json({ sessionId })
})

// Handle socket connections
io.on('connection', (socket) => {
  console.log('user connected:', socket.id)

  // User sends their session ID
  socket.on('join', (sessionId) => {
    socket.sessionId = sessionId
    console.log('joined session:', sessionId)

    // Start streaming screenshots to this user
    startStreaming(socket, sessionId)
  })

  // Handle touch/click input
  socket.on('input', async (data) => {
    const session = sessions[socket.sessionId]
    if (!session) return

    const { page } = session

    if (data.type === 'click') {
      await page.mouse.click(data.x, data.y)
    }
    if (data.type === 'touchstart') {
      await page.touchscreen.tap(data.x, data.y)
    }
    if (data.type === 'scroll') {
      await page.mouse.wheel(0, data.delta)
    }
    if (data.type === 'type') {
      await page.keyboard.type(data.key)
    }
    if (data.type === 'navigate') {
      await page.goto(data.url)
    }
  })

  // Cleanup on disconnect
  socket.on('disconnect', async () => {
    const session = sessions[socket.sessionId]
    if (session) {
      await session.browser.close()
      delete sessions[socket.sessionId]
      console.log('session cleaned up:', socket.sessionId)
    }
  })
})

// Stream screenshots back to user
async function startStreaming(socket, sessionId) {
  const session = sessions[sessionId]
  if (!session) return

  const { page } = session

  const streamInterval = setInterval(async () => {
    if (!sessions[sessionId]) {
      clearInterval(streamInterval)
      return
    }

    try {
      // Take screenshot and send as base64
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 70  // balance quality vs speed
      })
      socket.emit('frame', screenshot.toString('base64'))

      // Also send current URL
      socket.emit('url', page.url())
    } catch (err) {
      clearInterval(streamInterval)
    }
  }, 100) // 10 fps — increase for smoother but heavier
}

server.listen(3000, () => {
  console.log('Server running on port 3000')
})