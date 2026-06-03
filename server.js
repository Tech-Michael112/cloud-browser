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
    const { userAgent, width, height, dpr, touch, url } = req.body

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    })

    const context = await browser.newContext({
      userAgent: userAgent || 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
      viewport: { width: width || 390, height: height || 844 },
      deviceScaleFactor: dpr || 3,
      isMobile: true,
      hasTouch: true
    })

    const page = await context.newPage()
    await page.goto(url || 'https://google.com')

    const sessionId = Date.now().toString()
    sessions[sessionId] = { browser, page, context }

    res.json({ sessionId })
  } catch (err) {
    console.error('Session error:', err)
    res.status(500).json({ error: err.message })
  }
})

io.on('connection', (socket) => {
  console.log('user connected:', socket.id)

  socket.on('join', (sessionId) => {
    socket.sessionId = sessionId
    console.log('joined session:', sessionId)
    startStreaming(socket, sessionId)
  })

  socket.on('input', async (data) => {
    const session = sessions[socket.sessionId]
    if (!session) return

    const { page } = session

    try {
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
    } catch (err) {
      console.error('Input error:', err)
    }
  })

  socket.on('disconnect', async () => {
    const session = sessions[socket.sessionId]
    if (session) {
      await session.browser.close()
      delete sessions[socket.sessionId]
      console.log('session cleaned up:', socket.sessionId)
    }
  })
})

async function startStreaming(socket, sessionId) {
  const session = sessions[sessionId]
  if (!session) {
    socket.emit('error', 'Session not found')
    return
  }

  const { page } = session

  const streamInterval = setInterval(async () => {
    if (!sessions[sessionId]) {
      clearInterval(streamInterval)
      return
    }

    try {
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 70
      })
      socket.emit('frame', screenshot.toString('base64'))
      socket.emit('url', page.url())
    } catch (err) {
      console.error('Stream error:', err)
      clearInterval(streamInterval)
    }
  }, 100)
}

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT)
})