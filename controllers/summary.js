'use strict'

const mdkClient = require('../lib/client')
const { listDemoDevices } = require('../lib/devices')

const CHANNELS = ['hashrate_rt', 'power', 'temperature', 'power_mode']

// Live fleet rollup across every matched device (see lib/devices.js): sums
// hashrate_rt / power (units from the contract: TH/s, W), averages
// temperature across reporting devices; power_mode stays per-device.
//
// The fleet is read in one Kernel call, `pullSnapshot`, answered from the
// stores of Workers that poll their devices (`telemetryPollIntervalMs`), so
// the route never starts a polling loop of its own. A device the snapshot
// does not hold — its Worker does not poll, or has no point yet — is read
// live with `pullTelemetry`, so the app works against any Worker.
module.exports = async function summary (req) {
  let devices
  try {
    devices = await listDemoDevices(mdkClient)
  } catch (err) {
    if (String(err && err.message).startsWith('ERR_MDK_CLIENT_UNAVAILABLE')) {
      return {
        ok: true,
        kernelConnected: false,
        ts: Date.now(),
        deviceCount: 0,
        totals: { hashrateThs: 0, powerW: 0, avgTemperatureC: null },
        devices: []
      }
    }
    throw err
  }

  const snap = await pullSnapshot(devices)

  const temperatures = []
  const rows = await Promise.all(devices.map(async ({ deviceId, workerId, state }) => {
    const stored = snap.devices[deviceId]
    const m = stored ? storedMetrics(stored) : await liveMetrics(deviceId)
    if (Number.isFinite(m.temperature)) temperatures.push(m.temperature)
    return {
      deviceId,
      workerId,
      state,
      source: stored ? 'snapshot' : 'live',
      ts: stored ? stored.ts : null,
      hashrateThs: Number(m.hashrate_rt) || 0,
      powerW: Number(m.power) || 0,
      temperatureC: Number(m.temperature) || 0,
      powerMode: m.power_mode || null
    }
  }))

  let totalHashrateThs = 0
  let totalPowerW = 0
  for (const row of rows) {
    totalHashrateThs += row.hashrateThs
    totalPowerW += row.powerW
  }

  return {
    ok: true,
    kernelConnected: true,
    ts: Date.now(),
    snapshotTs: snap.snapshotTs || null,
    deviceCount: rows.length,
    totals: {
      hashrateThs: totalHashrateThs,
      powerW: totalPowerW,
      avgTemperatureC: temperatures.length ? temperatures.reduce((sum, c) => sum + c, 0) / temperatures.length : null
    },
    devices: rows
  }
}

// One read over the matched devices' Workers. A Worker that does not poll is
// reported under `errors` and its devices are absent from `devices`, which
// is all the caller needs to fall back to a live pull. A stack without the
// read at all leaves every device to the live path: a 0.13.0 client answers
// any unknown method with ERR_MDK_CLIENT_NO_SUCH_METHOD (its method surface
// is a Proxy, so a typeof check cannot tell), and a 0.13.0 Kernel answers
// the query with an `{ error }` reply.
async function pullSnapshot (devices) {
  const workers = [...new Set(devices.map((d) => d.workerId))]
  if (!workers.length || typeof mdkClient.pullSnapshot !== 'function') return { devices: {} }
  const snap = await mdkClient.pullSnapshot({ workers, metrics: CHANNELS }).catch(() => null)
  if (!snap || snap.error || !snap.devices) return { devices: {} }
  return { devices: snap.devices, snapshotTs: snap.snapshotTs }
}

// A stored point holds `{ value }` per metric, or `{ error }` when the handler
// failed at that sweep; an errored metric counts as missing.
function storedMetrics (stored) {
  const metrics = {}
  for (const [name, reading] of Object.entries(stored.metrics || {})) {
    if (reading && typeof reading === 'object' && 'value' in reading) metrics[name] = reading.value
  }
  return metrics
}

async function liveMetrics (deviceId) {
  const tel = await mdkClient.pullTelemetry(deviceId, 'metrics').catch(() => null)
  return (tel && tel.metrics) || {}
}
