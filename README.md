# @tetherto/mdk-app-demo

## Overview

An MDK app that aggregates live telemetry and SQLite history from every registered demo device through
[`@tetherto/mdk-client`][mdk-client]: a fleet summary and a history read, both read-only. It runs in its own app runtime process,
and the Gateway forwards its routes to it.

## Run it

Add the app to an MDK project, then start the stack with `mdk run`:

```bash
mdk add app github:tetherto/mdk-app-demo#main
```

`mdk add` writes this entry under `spec.apps` in `mdk.yaml`:

```yaml
spec:
  apps:
    - name: demo
      package: "@tetherto/mdk-app-demo"
```

The Gateway serves an app's routes under `/apps/<name>` unless `mount` is set, so this entry serves
`GET /apps/demo/api/demo/summary`. Add `mount: /` to serve the paths in [Routes](#routes) at the Gateway root.

## Device matching

A device counts as a demo device when its `getCapabilities` telemetry list carries both `hashrate_rt` and `history`
([`lib/devices.js`](lib/devices.js)). The `history` channel is what separates a demo device from other `hashrate_rt` miners, since
Kernel capability responses carry no brand or provider field to match on instead. A Worker in state `TERMINATED`, or with
`healthState: 'DEAD'`, is skipped.

## Routes

| Route          | Method + path           | Notes                                                  |
| -------------- | ----------------------- | ------------------------------------------------------ |
| `demo.summary` | `GET /api/demo/summary` | Fleet totals (`hashrateThs`, `powerW`, `avgTemperatureC`) plus a per-device breakdown |
| `demo.history` | `GET /api/demo/history` | Recent `history` telemetry samples; `limit` (default `10`, capped at `500`) and optional `deviceId` narrow the read |

`demo.summary` sums `hashrate_rt` and `power` across every matched device and averages `temperature`; `power_mode` stays
per-device. `demo.history` reads the Worker's own SQLite store rather than contacting the device, and 404s with
`ERR_UNKNOWN_DEVICE_ID` when a `deviceId` filter matches nothing.

## Errors

| Code                         | Fires when                              | Fix                      |
| ---------------------------- | --------------------------------------- | ------------------------ |
| `ERR_MDK_CLIENT_UNAVAILABLE` | Thrown by [`@tetherto/mdk-client`][mdk-client] when it has no connected Kernel | Not exposed to the caller. Both routes catch it and answer `200` with `kernelConnected: false`. `demo.summary` also zeroes its `totals`; `demo.history` has no `totals` field to zero. Both answer an empty `devices`. |
| `ERR_UNKNOWN_DEVICE_ID`      | `demo.history`'s optional `deviceId` query param doesn't match any registered demo device (`404`) | Pass a `deviceId` that matches a registered demo device, or omit it |

[`tests/plugin.test.js`](tests/plugin.test.js) is the executable spec for both routes, including the Kernel-unavailable and
unknown-device paths.

## Develop

Node 24 or later. Install, lint and test:

```bash
npm install
npm run lint
npm test
```

> [!NOTE]
> The `@tetherto/mdk-*` dependencies resolve from npm. Until they are published, run the tests against an MDK checkout that has
> run `npm ci`:
>
> ```bash
> MDK=/path/to/mdk
> NODE_ENV=test NODE_PATH=$MDK/node_modules $MDK/node_modules/.bin/brittle tests/*.test.js
> ```

## Directory layout

```text
mdk-app-demo/
├── mdk-app.yaml            # App manifest: id, version, display name, permissions
├── mdk-plugin.json         # Route table with request and response schemas
├── controllers/
│   ├── summary.js          # demo.summary: fleet totals and per-device metrics
│   └── history.js          # demo.history: recent samples from each Worker's history channel
├── lib/
│   ├── client.js           # This app's MDK client, built from its Gateway plugin context
│   └── devices.js          # Lists the Kernel's devices and keeps the demo ones
└── tests/
    └── plugin.test.js      # Both routes, loaded through the Gateway's plugin loader
```

## Next steps

- [Understand the underlying client][mdk-client]: how `createMdkClient` reaches a Kernel
- [Build a Worker][build-a-worker]: what a device needs to expose to be aggregated by an app like this one
- [Add routes with the plugin system][gateway-plugins]: route tables, controllers, and how a stack runs an app

[mdk-client]: https://github.com/tetherto/mdk/blob/main/backend/core/client/README.md
[build-a-worker]: https://docs.mdk.tether.io/guides/workers/build-a-worker
[gateway-plugins]: https://docs.mdk.tether.io/guides/gateway/plugins
