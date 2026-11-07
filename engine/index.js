'use strict';
// index.js — public engine API.
const net = require('./net');
const { Device, Interface, CAPABILITIES } = require('./device');
const { Link } = require('./link');
const { Topology, expandInterfaces } = require('./topology');
const { Simulator } = require('./simulator');
const { CliSession, runCommands } = require('./cli');
const media = require('./media');
const optical = require('./optical');
const validation = require('./validation');
const vlan = require('./vlan');
const lag = require('./lag');
const stp = require('./stp');
const dhcp = require('./dhcp');
const nat = require('./nat');
const acl = require('./acl');
const vrrp = require('./vrrp');
const ospf = require('./ospf');
const bgp = require('./bgp');
const dns = require('./dns');
const scion = require('./scion');
const ipv6 = require('./ipv6');
const ra = require('./ra');

module.exports = {
  net,
  media,
  optical,
  validation,
  vlan,
  lag,
  stp,
  dhcp,
  nat,
  acl,
  vrrp,
  ospf,
  bgp,
  dns,
  scion,
  ipv6,
  ra,
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
