'use strict'

// Plugin-owned MDK client, built from the ambient gateway context. The loader
// overrides `require('@tetherto/mdk-gateway/plugin')` per plugin so `config`
// carries this plugin's merged settings including kernelKey / kernelBootstrap.
// Controllers import this module — they never take mdkClient from a services bag.
//
// `config.mdkClient` is a test-only injection seam (JSON gateway configs never
// carry a client instance).
const { config } = require('@tetherto/mdk-gateway/plugin')
const { createMdkClient } = require('@tetherto/mdk-client')

module.exports = config.mdkClient || createMdkClient(config)
