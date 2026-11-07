'use strict';
// index.js — public engine API.
const net = require('./net');
const { Device, Interface, CAPABILITIES } = require('./device');
const { Link } = require('./link');
const { Topology, expandInterfaces } = require('./topology');
const { Simulator } = require('./simulator');
const { CliSession, runCommands } = require('./cli');
const media = require('./media');
const validation = require('./validation');
const vlan = require('./vlan');
const lag = require('./lag');
const stp = require('./stp');

module.exports = {
  net,
  media,
  validation,
  vlan,
  lag,
  stp,
  Device,
  Interface,
  Link,
  Topology,
  expandInterfaces,
  Simulator,
  CliSession,
  runCommands,
  CAPABILITIES
};
