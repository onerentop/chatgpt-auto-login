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

// v2.39.0: zhusms 余额查询（Config 页「测试余额」按钮调）
router.post('/zhusms/balance', async (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON.parse(raw)
    const z = cfg?.phonePool?.zhusms
    if (!z?.cardKey) return res.status(400).json({ error: 'cardKey not configured' })
    let proxyUrl = null
    try {
      const state = require('../proxy').getState?.()
      if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890'
    } catch {}
    const zhusms = require('../zhusms-provider')
    const balance = await zhusms.getBalance(z.cardKey, z.baseUrl || 'https://zhusms.com', proxyUrl)
    res.json({ ok: true, balance })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// v2.44.0: smscloud 余额查询（Config 页"测试余额"按钮调）
router.post('/smscloud/balance', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const s = cfg?.phonePool?.smscloud;
    if (!s?.apiKey) return res.status(400).json({ error: 'smscloud apiKey not configured' });
    const smscloud = require('../smscloud-provider');
    const balance = await smscloud.getBalance(s.apiKey, s.baseUrl || 'https://smscloud.sbs/api/system');
    res.json({ balance });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});

router.post('/smscloud/services', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const smscloud = require('../smscloud-provider');
    const services = await smscloud.listServices(apiKey, baseUrl);
    res.json({ services });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});

router.post('/smscloud/countries', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const smscloud = require('../smscloud-provider');
    const countries = await smscloud.listCountries(apiKey, baseUrl);
    res.json({ countries });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});

router.post('/smscloud/inventory', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    const serviceCode = req.body?.serviceCode;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    if (!serviceCode) return res.status(400).json({ error: 'serviceCode required' });
    const smscloud = require('../smscloud-provider');
    const inventory = await smscloud.getInventory(apiKey, baseUrl, serviceCode);
    res.json({ inventory });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});

// v2.50.0 oapi CDK 池管理
router.post('/oapi/import', (req, res) => {
  try {
    const text = String(req.body?.text || '');
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const baseUrl = cfg?.phonePool?.oapi?.baseUrl || 'https://sms.oapi.vip/api.php';
    const oapiPool = require('../oapi-pool');
    const r = oapiPool.importCdks(getRawDb(), text, baseUrl);
    save();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/oapi/list', (req, res) => {
  try {
    const oapiPool = require('../oapi-pool');
    res.json({ items: oapiPool.listCdks(getRawDb()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/oapi/:cdk', (req, res) => {
  try {
    const oapiPool = require('../oapi-pool');
    oapiPool.deleteCdk(getRawDb(), req.params.cdk);
    save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/oapi/test', async (req, res) => {
  try {
    const cdk = String(req.body?.cdk || '');
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const baseUrl = cfg?.phonePool?.oapi?.baseUrl || 'https://sms.oapi.vip/api.php';
    if (!cdk) return res.status(400).json({ error: 'cdk required' });
    const oapi = require('../oapi-provider');
    const order = await oapi.takeOrder(cdk, baseUrl);
    res.json({ ok: true, phone: order.phone, remaining: order.remaining });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e), code: e?._oapiCode });
  }
});

module.exports = router
