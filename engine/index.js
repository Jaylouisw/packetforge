'use strict';
// index.js — public engine API.
const net = require('./net');
const { Device, Interface, CAPABILITIES } = require('./device');
const { Link } = require('./link');
const { Topology, expandInterfaces } = require('./topology');
const { Simulator } = require('./simulator');
const { CliSession, runCommands } = require('./cli');

module.exports = {
  net,
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
