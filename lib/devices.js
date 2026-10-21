'use strict'

// Demo-worker fingerprint. Kernel getCapabilities
// returns the capability list only (no brand/provider), so matching the
// telemetry name set is the reliable filter. `history` is the distinctive
// channel that separates this sample worker from other hashrate_rt miners.

function telemetryNames (caps) {
  const list =
    (caps && caps.capabilities && caps.capabilities.telemetry) ||
    (caps && caps.telemetry) ||
    []
  return new Set(list.map((t) => t && t.name).filter(Boolean))
}

function isDemoDevice (caps) {
  const names = telemetryNames(caps)
  return names.has('hashrate_rt') && names.has('history')
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
      devices.push({ deviceId, workerId: w.workerId, state: w.state })
    }))
  }))

  return devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
}

module.exports = { isDemoDevice, listDemoDevices, telemetryNames }
