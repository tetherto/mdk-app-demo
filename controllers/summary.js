'use strict'

const mdkClient = require('../lib/client')
const { listDemoDevices } = require('../lib/devices')

// Live fleet rollup for demo-worker devices: fans out metrics pulls and sums
// hashrate_rt / power (units from the contract: TH/s, W). Temperature is
// averaged across reporting devices; power_mode stays per-device.
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

  const rows = await Promise.all(devices.map(async ({ deviceId, workerId, state }) => {
    const tel = await mdkClient.pullTelemetry(deviceId, 'metrics').catch(() => null)
    const m = (tel && tel.metrics) || {}
    return {
      deviceId,
      workerId,
      state,
      hashrateThs: Number(m.hashrate_rt) || 0,
      powerW: Number(m.power) || 0,
      temperatureC: Number(m.temperature) || 0,
      powerMode: m.power_mode || null
    }
  }))

  let totalHashrateThs = 0
  let totalPowerW = 0
  let tempSum = 0
  for (const row of rows) {
    totalHashrateThs += row.hashrateThs
    totalPowerW += row.powerW
    tempSum += row.temperatureC
  }

  return {
    ok: true,
    kernelConnected: true,
    ts: Date.now(),
    deviceCount: rows.length,
    totals: {
      hashrateThs: totalHashrateThs,
      powerW: totalPowerW,
      avgTemperatureC: rows.length ? tempSum / rows.length : null
    },
    devices: rows
  }
}
