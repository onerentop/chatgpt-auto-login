const test = require('node:test')
const assert = require('node:assert')

let isAddPhonePage

test.before(() => {
  isAddPhonePage = require('../../utils').isAddPhonePage
})

test('IAP1 URL 含 /add-phone 时直接返回 true', async () => {
  const page = {
    url: () => 'https://auth.openai.com/add-phone?continue=...',
    waitForSelector: () => Promise.reject(new Error('should not be called')),
  }
  const r = await isAddPhonePage(page)
  assert.strictEqual(r, true)
})

test('IAP2 URL 不匹配但 DOM 含 input[type=tel] 返回 true', async () => {
  const page = {
    url: () => 'https://auth.openai.com/oauth/authorize',
    waitForSelector: async (sel, opts) => {
      assert.match(sel, /tel/)
      return { fake: 'element' }
    },
  }
  const r = await isAddPhonePage(page)
  assert.strictEqual(r, true)
})

test('IAP3 URL 不匹配 + 无 phone input 返回 false', async () => {
  const page = {
    url: () => 'https://auth.openai.com/oauth/authorize',
    waitForSelector: async () => { throw new Error('Timeout') },
  }
  const r = await isAddPhonePage(page)
  assert.strictEqual(r, false)
})
