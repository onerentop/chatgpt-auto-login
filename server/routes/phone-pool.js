const express = require('express')
const fs = require('fs')
const path = require('path')
const router = express.Router()
const phonePool = require('../phone-pool')
const { getRawDb, save } = require('../db')

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json')

function readMaxBindings() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON.parse(raw)
    return Number(cfg?.phonePool?.maxBindingsPerPhone) || 5
  } catch { return 5 }
}

router.get('/', (req, res) => {
  try {
    const db = getRawDb()
    const list = phonePool.listPhones(db)
    res.json({ items: list, maxBindingsPerPhone: readMaxBindings() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/import', (req, res) => {
  const text = String(req.body?.text || '')
  if (!text) return res.status(400).json({ error: 'text required' })
  try {
    const db = getRawDb()
    const r = phonePool.importPhones(db, text)
    save()
    res.json({ ok: true, ...r })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/export', (req, res) => {
  try {
    const db = getRawDb()
    const text = phonePool.exportPhones(db)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="phone-pool-${Date.now()}.txt"`)
    res.send(text)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/:phone', (req, res) => {
  const phone = req.params.phone
  if (!phone) return res.status(400).json({ error: 'phone required' })
  try {
    const db = getRawDb()
    phonePool.deletePhone(db, phone)
    save()
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
