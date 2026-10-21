'use strict'

const test = require('brittle')
const path = require('path')
const { loadPlugin } = require('@tetherto/mdk-gateway/workers/lib/plugin-loader')
const { isDemoDevice, listDemoDevices, telemetryNames } = require('../lib/devices')

const PLUGIN_DIR = path.resolve(__dirname, '..')

const DEMO_CAPS = {
  capabilities: {
    telemetry: [
      { name: 'hashrate_rt' },
      { name: 'power' },
      { name: 'temperature' },
      { name: 'power_mode' },
      { name: 'history' }
    ]
  }
}

const OTHER_CAPS = {
  capabilities: {
    telemetry: [{ name: 'hashrate_rt' }, { name: 'power' }]
  }
}

/** Flat Kernel-style shape: capabilities.telemetry omitted, telemetry at top level. */
const DEMO_CAPS_FLAT = {
  telemetry: [
    { name: 'hashrate_rt' },
    { name: 'history' },
    { name: 'power' }
  ]
}

function mockClient ({ workers, metrics, history, historyViaMetrics, failList, failListErr, failCaps, failPull } = {}) {
  return {
    async listWorkers () {
      if (failList) throw new Error(failListErr || 'ERR_MDK_CLIENT_UNAVAILABLE')
      return { workers: workers || [] }
    },
    async getCapabilities (deviceId) {
      if (failCaps && failCaps.has(deviceId)) throw new Error('caps failed')
      if (deviceId.startsWith('flat-')) return DEMO_CAPS_FLAT
      if (deviceId.startsWith('other-')) return OTHER_CAPS
      return DEMO_CAPS
    },
    async pullTelemetry (deviceId, query) {
      if (failPull && failPull.has(deviceId)) throw new Error('pull failed')
      const type = typeof query === 'string' ? query : (query && query.type) || 'metrics'
      if (type === 'metrics') {
        return { metrics: (metrics && metrics[deviceId]) || null }
      }
      if (type === 'history') {
        if (historyViaMetrics && historyViaMetrics[deviceId]) {
          return { metrics: { history: historyViaMetrics[deviceId] } }
        }
        return { name: 'history', value: (history && history[deviceId]) || [] }
      }
      return null
    }
  }
}

function loadDemoPlugin (mdkClient) {
  const context = Object.freeze({
    config: Object.freeze(mdkClient ? { mdkClient } : {}),
    dataProxy: {}
  })
  const plugin = loadPlugin(PLUGIN_DIR, context)
  const byId = Object.fromEntries(plugin.routes.map((r) => [r.id, r._handler]))
  return { summary: byId['demo.summary'], history: byId['demo.history'], plugin }
}

function emptyReq (query = {}) {
  return { params: {}, query, body: {}, headers: {} }
}

test('demo plugin - summary aggregates hashrate and power across demo devices', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({
    workers: [
      { workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0', 'other-1'] },
      { workerId: 'demo-b', state: 'READY', deviceIds: ['demo-1'] }
    ],
    metrics: {
      'demo-0': { hashrate_rt: 100, power: 3000, temperature: 64, power_mode: 'normal' },
      'demo-1': { hashrate_rt: 140, power: 3200, temperature: 66, power_mode: 'eco' },
      'other-1': { hashrate_rt: 999, power: 9999, temperature: 99, power_mode: 'high' }
    }
  }))

  const out = await summary(emptyReq())

  t.is(out.ok, true)
  t.is(out.kernelConnected, true)
  t.is(out.deviceCount, 2, 'non-demo fingerprint skipped')
  t.is(out.totals.hashrateThs, 240)
  t.is(out.totals.powerW, 6200)
  t.is(out.totals.avgTemperatureC, 65)
  t.alike(out.devices.map((d) => d.deviceId), ['demo-0', 'demo-1'])
  t.is(out.devices[1].powerMode, 'eco')
})

test('demo plugin - summary empty fleet averages temperature as null', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({ workers: [] }))
  const out = await summary(emptyReq())
  t.is(out.kernelConnected, true)
  t.is(out.deviceCount, 0)
  t.is(out.totals.hashrateThs, 0)
  t.is(out.totals.powerW, 0)
  t.is(out.totals.avgTemperatureC, null)
  t.alike(out.devices, [])
})

test('demo plugin - summary degrades when Kernel client is unavailable', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({ failList: true }))
  const out = await summary(emptyReq())
  t.is(out.kernelConnected, false)
  t.is(out.deviceCount, 0)
  t.is(out.totals.hashrateThs, 0)
  t.is(out.totals.avgTemperatureC, null)
})

test('demo plugin - summary rethrows non-unavailable Kernel errors', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({
    failList: true,
    failListErr: 'ERR_MDK_TIMEOUT'
  }))
  try {
    await summary(emptyReq())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MDK_TIMEOUT')
  }
})

test('demo plugin - summary tolerates missing telemetry and pull failures', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({
    workers: [{ workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0', 'demo-1'] }],
    metrics: {
      'demo-0': {} // present but empty fields
    },
    failPull: new Set(['demo-1'])
  }))

  const out = await summary(emptyReq())
  t.is(out.deviceCount, 2)
  t.is(out.totals.hashrateThs, 0)
  t.is(out.totals.powerW, 0)
  t.is(out.totals.avgTemperatureC, 0)
  t.is(out.devices[0].powerMode, null)
  t.is(out.devices[1].hashrateThs, 0)
})

test('demo plugin - summary skips dead workers and failed capability lookups', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({
    workers: [
      { workerId: 'dead', state: 'READY', healthState: 'DEAD', deviceIds: ['demo-dead'] },
      { workerId: 'gone', state: 'TERMINATED', deviceIds: ['demo-term'] },
      { workerId: 'live', state: 'READY', deviceIds: ['demo-0', 'demo-fail-caps'] }
    ],
    metrics: {
      'demo-0': { hashrate_rt: 50, power: 1000, temperature: 60, power_mode: 'normal' }
    },
    failCaps: new Set(['demo-fail-caps'])
  }))

  const out = await summary(emptyReq())
  t.is(out.deviceCount, 1)
  t.alike(out.devices.map((d) => d.deviceId), ['demo-0'])
})

test('demo plugin - summary matches flat telemetry capability shape', async (t) => {
  const { summary } = loadDemoPlugin(mockClient({
    workers: [{ workerId: 'demo-a', state: 'READY', deviceIds: ['flat-0'] }],
    metrics: {
      'flat-0': { hashrate_rt: 10, power: 100, temperature: 40, power_mode: 'eco' }
    }
  }))

  const out = await summary(emptyReq())
  t.is(out.deviceCount, 1)
  t.is(out.devices[0].deviceId, 'flat-0')
  t.is(out.totals.hashrateThs, 10)
})

test('demo plugin - history returns per-device SQLite samples', async (t) => {
  const samples0 = [{ ts: 1, hashrate_ths: 100, power_w: 3000, board_temp_c: 64 }]
  const samples1 = [{ ts: 2, hashrate_ths: 140, power_w: 3200, board_temp_c: 66 }]
  const { history } = loadDemoPlugin(mockClient({
    workers: [
      { workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0', 'demo-1'] }
    ],
    history: { 'demo-0': samples0, 'demo-1': samples1 }
  }))

  const out = await history(emptyReq({ limit: '5' }))
  t.is(out.limit, 5)
  t.is(out.deviceCount, 2)
  t.alike(out.devices[0].samples, samples0)
  t.alike(out.devices[1].samples, samples1)
})

test('demo plugin - history defaults and clamps limit', async (t) => {
  const { history } = loadDemoPlugin(mockClient({
    workers: [{ workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0'] }],
    history: { 'demo-0': [{ ts: 1 }] }
  }))

  t.is((await history(emptyReq())).limit, 10, 'default')
  // Number('0') is falsy, so `|| 10` applies before Math.max floor
  t.is((await history(emptyReq({ limit: '0' }))).limit, 10, 'zero treated as missing')
  t.is((await history(emptyReq({ limit: '-3' }))).limit, 1, 'floor at 1')
  t.is((await history(emptyReq({ limit: '9999' }))).limit, 500, 'cap at 500')
  t.is((await history(emptyReq({ limit: 'not-a-number' }))).limit, 10)
})

test('demo plugin - history deviceId filter returns a single device', async (t) => {
  const samples = [{ ts: 9, hashrate_ths: 1 }]
  const { history } = loadDemoPlugin(mockClient({
    workers: [{ workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0', 'demo-1'] }],
    history: { 'demo-0': samples, 'demo-1': [{ ts: 1 }] }
  }))

  const out = await history(emptyReq({ deviceId: 'demo-0' }))
  t.is(out.deviceCount, 1)
  t.is(out.devices[0].deviceId, 'demo-0')
  t.alike(out.devices[0].samples, samples)
})

test('demo plugin - history deviceId filter rejects unknown devices', async (t) => {
  const { history } = loadDemoPlugin(mockClient({
    workers: [{ workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0'] }]
  }))

  try {
    await history(emptyReq({ deviceId: 'missing' }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_UNKNOWN_DEVICE_ID')
    t.is(err.statusCode, 404)
  }
})

test('demo plugin - history degrades when Kernel client is unavailable', async (t) => {
  const { history } = loadDemoPlugin(mockClient({ failList: true }))
  const out = await history(emptyReq({ limit: '20' }))
  t.is(out.ok, true)
  t.is(out.kernelConnected, false)
  t.is(out.limit, 20)
  t.is(out.deviceCount, 0)
  t.alike(out.devices, [])
})

test('demo plugin - history rethrows non-unavailable Kernel errors', async (t) => {
  const { history } = loadDemoPlugin(mockClient({
    failList: true,
    failListErr: 'ERR_MDK_BOOM'
  }))
  try {
    await history(emptyReq())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MDK_BOOM')
  }
})

test('demo plugin - history accepts metrics.history fallback and empty pulls', async (t) => {
  const viaMetrics = [{ ts: 3, hashrate_ths: 11 }]
  const { history } = loadDemoPlugin(mockClient({
    workers: [{ workerId: 'demo-a', state: 'READY', deviceIds: ['demo-0', 'demo-1'] }],
    historyViaMetrics: { 'demo-0': viaMetrics },
    failPull: new Set(['demo-1'])
  }))

  const out = await history(emptyReq())
  t.is(out.deviceCount, 2)
  t.alike(out.devices[0].samples, viaMetrics)
  t.alike(out.devices[1].samples, [])
})

test('demo plugin - history empty fleet returns zero devices', async (t) => {
  const { history } = loadDemoPlugin(mockClient({ workers: [] }))
  const out = await history(emptyReq())
  t.is(out.kernelConnected, true)
  t.is(out.deviceCount, 0)
  t.alike(out.devices, [])
})

test('demo plugin - ambient client falls back to createMdkClient without injection', (t) => {
  // Production path: no config.mdkClient — lib/client.js calls createMdkClient(config).
  const { plugin } = loadDemoPlugin(null)
  t.is(plugin.routes.length, 2)
})

test('demo plugin - manifest declares summary and history routes', (t) => {
  const { plugin } = loadDemoPlugin(mockClient({ workers: [] }))
  t.alike(plugin.routes.map((r) => r.id), ['demo.summary', 'demo.history'])
  t.is(plugin.routes[0].method, 'GET')
  t.is(plugin.routes[0].path, '/api/demo/summary')
  t.is(plugin.routes[1].path, '/api/demo/history')
})

test('devices helpers - telemetryNames and isDemoDevice edge cases', (t) => {
  t.alike([...telemetryNames(null)], [])
  t.alike([...telemetryNames({})], [])
  t.alike([...telemetryNames({ telemetry: [{ name: 'a' }, { name: null }, null] })].sort(), ['a'])
  t.alike([...telemetryNames({ capabilities: { telemetry: [{ name: 'history' }] } })], ['history'])

  t.is(isDemoDevice(null), false)
  t.is(isDemoDevice(OTHER_CAPS), false)
  t.is(isDemoDevice(DEMO_CAPS), true)
  t.is(isDemoDevice(DEMO_CAPS_FLAT), true)
})

test('devices helpers - listDemoDevices skips dead workers and null workers list', async (t) => {
  const empty = await listDemoDevices({
    async listWorkers () { return null }
  })
  t.alike(empty, [])

  const noDevices = await listDemoDevices({
    async listWorkers () {
      return { workers: [{ workerId: 'w', state: 'READY' }] } // missing deviceIds
    }
  })
  t.alike(noDevices, [])

  const filtered = await listDemoDevices(mockClient({
    workers: [
      { workerId: 'dead', state: 'READY', healthState: 'DEAD', deviceIds: ['demo-x'] },
      { workerId: 'ok', state: 'READY', deviceIds: ['demo-0', 'other-1'] }
    ]
  }))
  t.alike(filtered.map((d) => d.deviceId), ['demo-0'])
})
