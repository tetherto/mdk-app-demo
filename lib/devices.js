'use strict'

// A device counts when its Worker exposes `hashrate_rt` in TH/s: the shape
// `mdk create worker` scaffolds (packages/cli/templates/worker/mdk-contract.json:
// hashrate_rt, power, temperature, power_mode). Kernel getCapabilities returns
// the capability list only (no brand/provider), so the telemetry entries are the
// filter. A `hashrate_rt` declared in another unit is skipped so the TH/s totals
// stay honest. `history` is optional; only devices that declare it are read by
// /history.

const HASHRATE_CHANNEL = 'hashrate_rt'
const HASHRATE_UNIT = 'TH/s'
const HISTORY_CHANNEL = 'history'

function telemetryEntries (caps) {
  const list =
    (caps && caps.capabilities && caps.capabilities.telemetry) ||
    (caps && caps.telemetry) ||
    []
  return list.filter((t) => t && t.name)
}

function telemetryNames (caps) {
  return new Set(telemetryEntries(caps).map((t) => t.name))
}

function isDemoDevice (caps) {
  const hashrate = telemetryEntries(caps).find((t) => t.name === HASHRATE_CHANNEL)
  return Boolean(hashrate) && (!hashrate.unit || hashrate.unit === HASHRATE_UNIT)
}

function hasHistory (caps) {
  return telemetryNames(caps).has(HISTORY_CHANNEL)
}

async function listDemoDevices (mdkClient) {
  const workersResp = await mdkClient.listWorkers()
  const workers = (workersResp && workersResp.workers) || []

  const devices = []
  await Promise.all(workers.map(async (w) => {
    if (w.state === 'TERMINATED' || w.healthState === 'DEAD') return
    await Promise.all((w.deviceIds || []).map(async (deviceId) => {
      const caps = await mdkClient.getCapabilities(deviceId).catch(() => null)
      if (!isDemoDevice(caps)) return
      devices.push({ deviceId, workerId: w.workerId, state: w.state, hasHistory: hasHistory(caps) })
    }))
  }))

  return devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
}

module.exports = { hasHistory, isDemoDevice, listDemoDevices, telemetryNames }
