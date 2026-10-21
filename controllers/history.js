'use strict'

const mdkClient = require('../lib/client')
const { listDemoDevices } = require('../lib/devices')

// Recent SQLite samples from demo-worker's `history` telemetry channel
// (params: { limit }). Optional deviceId scopes to one device; otherwise every
// matched demo device is included.
module.exports = async function history (req) {
  const limit = Math.min(Math.max(Number(req.query && req.query.limit) || 10, 1), 500)
  const deviceIdFilter = req.query && req.query.deviceId

  let devices
  try {
    devices = await listDemoDevices(mdkClient)
  } catch (err) {
    if (String(err && err.message).startsWith('ERR_MDK_CLIENT_UNAVAILABLE')) {
      return { ok: true, kernelConnected: false, limit, deviceCount: 0, devices: [] }
    }
    throw err
  }

  if (deviceIdFilter) {
    devices = devices.filter((d) => d.deviceId === deviceIdFilter)
    if (!devices.length) throw Object.assign(new Error('ERR_UNKNOWN_DEVICE_ID'), { statusCode: 404 })
  }

  const rows = await Promise.all(devices.map(async ({ deviceId, workerId }) => {
    const tel = await mdkClient.pullTelemetry(deviceId, { type: 'history', limit }).catch(() => null)
    // Named-channel pull returns { name, value }; metrics-bundle history would
    // sit under metrics.history — accept either so the route stays resilient.
    const samples = Array.isArray(tel && tel.value)
      ? tel.value
      : (tel && tel.metrics && Array.isArray(tel.metrics.history) ? tel.metrics.history : [])
    return { deviceId, workerId, samples }
  }))

  return {
    ok: true,
    kernelConnected: true,
    limit,
    deviceCount: rows.length,
    devices: rows
  }
}
