const test = require('node:test')
const assert = require('node:assert')

let __autoRotateIfCurrentDeadForTest

test.before(() => {
  const mod = require('../index')
  __autoRotateIfCurrentDeadForTest = mod.__autoRotateIfCurrentDeadForTest
})

test('A1 currentNode alive=false 触发 fire-and-forget rotate', async () => {
  const calls = []
  const probeResults = new Map([['dead-node', { alive: false, delayMs: null }]])
  __autoRotateIfCurrentDeadForTest('dead-node', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, ['rotate-called'])
})

test('A2 currentNode alive=true 不触发 rotate', async () => {
  const calls = []
  const probeResults = new Map([['alive-node', { alive: true, delayMs: 100 }]])
  __autoRotateIfCurrentDeadForTest('alive-node', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, [], 'alive 节点不应触发 rotate')
})

test('A3 currentNode 没在 probeResults（未探过）不触发 rotate', async () => {
  const calls = []
  const probeResults = new Map()
  __autoRotateIfCurrentDeadForTest('unprobed-node', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, [], '未探过的节点不应被判死')
})

test('A4 currentNode 为空串不触发 rotate', async () => {
  const calls = []
  const probeResults = new Map([['anything', { alive: false }]])
  __autoRotateIfCurrentDeadForTest('', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, [], '无 currentNode 时跳过')
})
