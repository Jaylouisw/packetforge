'use strict';
// One-shot merge of swarm-researched homelab gear into the device registry.
// Run: node scripts/merge-research.js
const fs = require('fs');
const path = require('path');

const DEVICES_DIR = path.join(__dirname, '..', 'devices');

const devices = [
  // ===================== MikroTik =====================
  { vendor: 'mikrotik', model: 'RB5009UG', label: 'RB5009UG+S+IN', category: 'router',
    description: 'Heavy-duty homelab router: quad-core ARM64, one 2.5G port, seven 1G ports and a 10G SFP+ cage.',
    capabilities: ['l3-forward','cli','nat','firewall','dhcp-server','dhcp-client','http-server'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '2.5G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'ether6', type: 'ethernet', speed: '1G' },
      { name: 'ether7', type: 'ethernet', speed: '1G' }, { name: 'ether8', type: 'ethernet', speed: '1G' },
      { name: 'sfp-sfpplus1', type: 'ethernet', speed: '10G' }
    ], icon: 'router', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'RB760iGS', label: 'hEX S (RB760iGS)', category: 'router',
    description: 'Compact five-port Gigabit router with an SFP cage, USB, microSD and PoE-out on the last port.',
    capabilities: ['l3-forward','cli','nat','firewall','dhcp-server','dhcp-client','http-server'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'sfp1', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'RB750Gr3', label: 'hEX (RB750Gr3)', category: 'router',
    description: 'Cheap five-port Gigabit router, dual-core 880MHz, the classic starter RouterOS box.',
    capabilities: ['l3-forward','cli','nat','firewall','dhcp-server','dhcp-client','http-server'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'RB4011iGS', label: 'RB4011iGS+RM', category: 'router',
    description: 'Rackmount router with ten Gigabit ports, one 10G SFP+, PoE-out on ether10 and strong IPSec throughput.',
    capabilities: ['l3-forward','cli','nat','firewall','dhcp-server','dhcp-client','http-server'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'ether6', type: 'ethernet', speed: '1G' },
      { name: 'ether7', type: 'ethernet', speed: '1G' }, { name: 'ether8', type: 'ethernet', speed: '1G' },
      { name: 'ether9', type: 'ethernet', speed: '1G' }, { name: 'ether10', type: 'ethernet', speed: '1G' },
      { name: 'sfp-sfpplus1', type: 'ethernet', speed: '10G' }
    ], icon: 'router', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'C52iG-5HaxD2HaxD', label: 'hAP ax2', category: 'wireless',
    description: 'Wi-Fi 6 dual-band AP with five Gigabit ports, IPQ-6010 CPU and PoE-in/PoE-out on ether1.',
    capabilities: ['l2-forward','l3-forward','wireless','cli','nat','dhcp-server','firewall'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'wlan1', type: 'wireless', speed: '1200M' }
    ], icon: 'ap', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'RBD53iG-5HacD2HnD', label: 'hAP ac3', category: 'wireless',
    description: 'Dual-band 802.11ac AP with five Gigabit ports and high-gain external antennas for whole-home coverage.',
    capabilities: ['l2-forward','l3-forward','wireless','cli','nat','dhcp-server','firewall'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'wlan1', type: 'wireless', speed: '866M' }
    ], icon: 'ap', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'CRS112-8P-4S', label: 'CRS112-8P-4S-IN', category: 'switch',
    description: 'Eight-port Gigabit PoE switch with 802.3af/at and passive PoE plus four SFP fiber cages.',
    capabilities: ['l2-forward','cli','http-server'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'ether6', type: 'ethernet', speed: '1G' },
      { name: 'ether7', type: 'ethernet', speed: '1G' }, { name: 'ether8', type: 'ethernet', speed: '1G' },
      { name: 'sfp1', type: 'ethernet', speed: '1G' }, { name: 'sfp2', type: 'ethernet', speed: '1G' },
      { name: 'sfp3', type: 'ethernet', speed: '1G' }, { name: 'sfp4', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#14b8a6' },

  { vendor: 'mikrotik', model: 'CSS610-8G-2S+', label: 'CSS610-8G-2S+IN', category: 'switch',
    description: 'Cheap fanless eight-port Gigabit switch with two SFP+ 10G uplinks, SwOS Lite and PoE-in.',
    capabilities: ['l2-forward','cli'],
    interfaces: [
      { name: 'ether1', type: 'ethernet', speed: '1G' }, { name: 'ether2', type: 'ethernet', speed: '1G' },
      { name: 'ether3', type: 'ethernet', speed: '1G' }, { name: 'ether4', type: 'ethernet', speed: '1G' },
      { name: 'ether5', type: 'ethernet', speed: '1G' }, { name: 'ether6', type: 'ethernet', speed: '1G' },
      { name: 'ether7', type: 'ethernet', speed: '1G' }, { name: 'ether8', type: 'ethernet', speed: '1G' },
      { name: 'sfp-sfpplus1', type: 'ethernet', speed: '10G' }, { name: 'sfp-sfpplus2', type: 'ethernet', speed: '10G' }
    ], icon: 'switch', color: '#14b8a6' },

  // ===================== Ubiquiti =====================
  { vendor: 'ubiquiti', model: 'UDM-Pro', label: 'UniFi Dream Machine Pro', category: 'firewall',
    description: 'Rackmount UniFi gateway/firewall/NVR appliance with 8-port GbE switch and dual 10G SFP+ uplinks.',
    capabilities: ['l3-forward','firewall','nat','dhcp-server','dhcp-client','cli','http-server'],
    interfaces: [
      { name: 'wan1', type: 'ethernet', speed: '1G' }, { name: 'wan2', type: 'ethernet', speed: '10G' },
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' },
      { name: 'sfp1', type: 'ethernet', speed: '10G' }
    ], icon: 'firewall', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'UCG-Ultra', label: 'UniFi Cloud Gateway Ultra', category: 'router',
    description: 'Compact fanless UniFi gateway with 2.5G WAN and a 4-port GbE LAN switch.',
    capabilities: ['l3-forward','firewall','nat','dhcp-server','dhcp-client','cli','http-server'],
    interfaces: [
      { name: 'wan1', type: 'ethernet', speed: '2.5G' },
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'ER-X', label: 'EdgeRouter X', category: 'router',
    description: 'Five-port Gigabit EdgeOS router with passive PoE passthrough on port 5, popular budget edge device.',
    capabilities: ['l3-forward','firewall','nat','dhcp-server','dhcp-client','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'ER-X-SFP', label: 'EdgeRouter X SFP', category: 'router',
    description: 'EdgeRouter X variant adding a Gigabit SFP uplink to five GbE ports with PoE passthrough.',
    capabilities: ['l3-forward','firewall','nat','dhcp-server','dhcp-client','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'sfp1', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'USW-Lite-8-PoE', label: 'UniFi Switch Lite 8 PoE', category: 'switch',
    description: 'Fanless 8-port GbE Layer 2 switch with four PoE+ ports and a 52W power budget.',
    capabilities: ['l2-forward','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'USW-24', label: 'UniFi Switch 24', category: 'switch',
    description: '24-port GbE Layer 2 UniFi switch with two Gigabit SFP uplinks, non-PoE.',
    capabilities: ['l2-forward','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' },
      { name: 'port9', type: 'ethernet', speed: '1G' }, { name: 'port10', type: 'ethernet', speed: '1G' },
      { name: 'port11', type: 'ethernet', speed: '1G' }, { name: 'port12', type: 'ethernet', speed: '1G' },
      { name: 'port13', type: 'ethernet', speed: '1G' }, { name: 'port14', type: 'ethernet', speed: '1G' },
      { name: 'port15', type: 'ethernet', speed: '1G' }, { name: 'port16', type: 'ethernet', speed: '1G' },
      { name: 'port17', type: 'ethernet', speed: '1G' }, { name: 'port18', type: 'ethernet', speed: '1G' },
      { name: 'port19', type: 'ethernet', speed: '1G' }, { name: 'port20', type: 'ethernet', speed: '1G' },
      { name: 'port21', type: 'ethernet', speed: '1G' }, { name: 'port22', type: 'ethernet', speed: '1G' },
      { name: 'port23', type: 'ethernet', speed: '1G' }, { name: 'port24', type: 'ethernet', speed: '1G' },
      { name: 'sfp1', type: 'ethernet', speed: '1G' }, { name: 'sfp2', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'USW-Pro-Max-16-PoE', label: 'UniFi Switch Pro Max 16 PoE', category: 'l3-switch',
    description: 'Layer 3 PoE switch with 12 GbE PoE+ and 4 2.5GbE PoE++ ports plus dual 10G SFP+ uplinks.',
    capabilities: ['l2-forward','l3-forward','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' },
      { name: 'port9', type: 'ethernet', speed: '1G' }, { name: 'port10', type: 'ethernet', speed: '1G' },
      { name: 'port11', type: 'ethernet', speed: '1G' }, { name: 'port12', type: 'ethernet', speed: '1G' },
      { name: 'port13', type: 'ethernet', speed: '2.5G' }, { name: 'port14', type: 'ethernet', speed: '2.5G' },
      { name: 'port15', type: 'ethernet', speed: '2.5G' }, { name: 'port16', type: 'ethernet', speed: '2.5G' },
      { name: 'sfp1', type: 'ethernet', speed: '10G' }, { name: 'sfp2', type: 'ethernet', speed: '10G' }
    ], icon: 'switch', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'USW-Aggregation', label: 'UniFi Switch Aggregation', category: 'switch',
    description: 'Compact Layer 2 aggregation switch with eight 10G SFP+ ports for small 10G backbones.',
    capabilities: ['l2-forward','cli','http-server'],
    interfaces: [
      { name: 'sfp1', type: 'ethernet', speed: '10G' }, { name: 'sfp2', type: 'ethernet', speed: '10G' },
      { name: 'sfp3', type: 'ethernet', speed: '10G' }, { name: 'sfp4', type: 'ethernet', speed: '10G' },
      { name: 'sfp5', type: 'ethernet', speed: '10G' }, { name: 'sfp6', type: 'ethernet', speed: '10G' },
      { name: 'sfp7', type: 'ethernet', speed: '10G' }, { name: 'sfp8', type: 'ethernet', speed: '10G' }
    ], icon: 'switch', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'USW-Pro-Aggregation', label: 'UniFi Switch Pro Aggregation', category: 'l3-switch',
    description: 'Layer 3 aggregation switch with 28 10G SFP+ ports and four 25G SFP28 uplinks, 760 Gbps capacity.',
    capabilities: ['l2-forward','l3-forward','cli','http-server'],
    interfaces: [
      { name: 'sfp1', type: 'ethernet', speed: '10G' }, { name: 'sfp2', type: 'ethernet', speed: '10G' },
      { name: 'sfp3', type: 'ethernet', speed: '10G' }, { name: 'sfp4', type: 'ethernet', speed: '10G' },
      { name: 'sfp5', type: 'ethernet', speed: '10G' }, { name: 'sfp6', type: 'ethernet', speed: '10G' },
      { name: 'sfp7', type: 'ethernet', speed: '10G' }, { name: 'sfp8', type: 'ethernet', speed: '10G' },
      { name: 'sfp9', type: 'ethernet', speed: '10G' }, { name: 'sfp10', type: 'ethernet', speed: '10G' },
      { name: 'sfp11', type: 'ethernet', speed: '10G' }, { name: 'sfp12', type: 'ethernet', speed: '10G' },
      { name: 'sfp13', type: 'ethernet', speed: '10G' }, { name: 'sfp14', type: 'ethernet', speed: '10G' },
      { name: 'sfp15', type: 'ethernet', speed: '10G' }, { name: 'sfp16', type: 'ethernet', speed: '10G' },
      { name: 'sfp17', type: 'ethernet', speed: '10G' }, { name: 'sfp18', type: 'ethernet', speed: '10G' },
      { name: 'sfp19', type: 'ethernet', speed: '10G' }, { name: 'sfp20', type: 'ethernet', speed: '10G' },
      { name: 'sfp21', type: 'ethernet', speed: '10G' }, { name: 'sfp22', type: 'ethernet', speed: '10G' },
      { name: 'sfp23', type: 'ethernet', speed: '10G' }, { name: 'sfp24', type: 'ethernet', speed: '10G' },
      { name: 'sfp25', type: 'ethernet', speed: '10G' }, { name: 'sfp26', type: 'ethernet', speed: '10G' },
      { name: 'sfp27', type: 'ethernet', speed: '10G' }, { name: 'sfp28', type: 'ethernet', speed: '10G' },
      { name: 'up1', type: 'ethernet', speed: '25G' }, { name: 'up2', type: 'ethernet', speed: '25G' },
      { name: 'up3', type: 'ethernet', speed: '25G' }, { name: 'up4', type: 'ethernet', speed: '25G' }
    ], icon: 'switch', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'U6-Lite', label: 'UniFi 6 Lite', category: 'wireless',
    description: 'WiFi 6 ceiling access point, 2x2 dual-band with a single GbE PoE-powered uplink.',
    capabilities: ['l2-forward','wireless','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' },
      { name: 'radio0', type: 'wireless', speed: '1.2G' }, { name: 'radio1', type: 'wireless', speed: '574M' }
    ], icon: 'ap', color: '#3b82f6' },

  { vendor: 'ubiquiti', model: 'U7-Pro', label: 'UniFi 7 Pro', category: 'wireless',
    description: 'Tri-band WiFi 7 access point with a 2.5G PoE+ uplink and 6 GHz support.',
    capabilities: ['l2-forward','wireless','cli','http-server'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '2.5G' },
      { name: 'radio0', type: 'wireless', speed: '5.8G' }, { name: 'radio1', type: 'wireless', speed: '2.9G' },
      { name: 'radio2', type: 'wireless', speed: '688M' }
    ], icon: 'ap', color: '#3b82f6' },

  // ===================== TP-Link =====================
  { vendor: 'tp-link', model: 'ER605', label: 'TP-Link Omada ER605', category: 'router',
    description: 'Fanless 5-port Gigabit multi-WAN VPN gateway for small Omada sites.',
    capabilities: ['l3-forward','cli','nat','dhcp-server','firewall'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#22c55e' },

  { vendor: 'tp-link', model: 'ER7206', label: 'TP-Link Omada ER7206', category: 'router',
    description: 'Gigabit VPN gateway with SFP uplink and up to four WAN ports.',
    capabilities: ['l3-forward','cli','nat','dhcp-server','firewall'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'sfp1', type: 'ethernet', speed: '1G' }
    ], icon: 'router', color: '#22c55e' },

  { vendor: 'tp-link', model: 'SG2008P', label: 'TP-Link Omada SG2008P', category: 'switch',
    description: 'Fanless 8-port Gigabit smart switch with 4 PoE+ ports and 62 W power budget.',
    capabilities: ['l2-forward','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#22c55e' },

  { vendor: 'tp-link', model: 'SG2210P', label: 'TP-Link Omada SG2210P', category: 'switch',
    description: '10-port Gigabit smart switch with 8 PoE+ RJ45 ports and 2 SFP uplinks.',
    capabilities: ['l2-forward','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' },
      { name: 'sfp1', type: 'ethernet', speed: '1G' }, { name: 'sfp2', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#22c55e' },

  { vendor: 'tp-link', model: 'EAP610', label: 'TP-Link Omada EAP610', category: 'wireless',
    description: 'AX1800 ceiling-mount WiFi 6 access point with a single PoE Gigabit uplink.',
    capabilities: ['l2-forward','wireless','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'radio0', type: 'wireless', speed: '1.2G' }
    ], icon: 'ap', color: '#22c55e' },

  { vendor: 'tp-link', model: 'EAP650', label: 'TP-Link Omada EAP650', category: 'wireless',
    description: 'AX3000 ceiling-mount WiFi 6 access point, PoE-powered over one Gigabit port.',
    capabilities: ['l2-forward','wireless','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'radio0', type: 'wireless', speed: '2.4G' }
    ], icon: 'ap', color: '#22c55e' },

  // ===================== Netgear =====================
  { vendor: 'netgear', model: 'GS308', label: 'Netgear GS308', category: 'switch',
    description: 'Unmanaged 8-port Gigabit desktop switch in a metal case.',
    capabilities: ['l2-forward'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#64748b' },

  { vendor: 'netgear', model: 'GS308E', label: 'Netgear GS308E', category: 'switch',
    description: '8-port Gigabit Easy Smart managed switch with VLANs and QoS.',
    capabilities: ['l2-forward','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#64748b' },

  { vendor: 'netgear', model: 'GS724T', label: 'Netgear GS724T', category: 'l3-switch',
    description: '24-port Gigabit Smart Cloud switch with 2 dedicated SFP slots and L3-lite routing.',
    capabilities: ['l2-forward','l3-forward','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' },
      { name: 'port9', type: 'ethernet', speed: '1G' }, { name: 'port10', type: 'ethernet', speed: '1G' },
      { name: 'port11', type: 'ethernet', speed: '1G' }, { name: 'port12', type: 'ethernet', speed: '1G' },
      { name: 'port13', type: 'ethernet', speed: '1G' }, { name: 'port14', type: 'ethernet', speed: '1G' },
      { name: 'port15', type: 'ethernet', speed: '1G' }, { name: 'port16', type: 'ethernet', speed: '1G' },
      { name: 'port17', type: 'ethernet', speed: '1G' }, { name: 'port18', type: 'ethernet', speed: '1G' },
      { name: 'port19', type: 'ethernet', speed: '1G' }, { name: 'port20', type: 'ethernet', speed: '1G' },
      { name: 'port21', type: 'ethernet', speed: '1G' }, { name: 'port22', type: 'ethernet', speed: '1G' },
      { name: 'port23', type: 'ethernet', speed: '1G' }, { name: 'port24', type: 'ethernet', speed: '1G' },
      { name: 'sfp1', type: 'ethernet', speed: '1G' }, { name: 'sfp2', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#64748b' },

  // ===================== Zyxel =====================
  { vendor: 'zyxel', model: 'GS1200-8', label: 'Zyxel GS1200-8', category: 'switch',
    description: '8-port Gigabit web-managed switch with VLANs, QoS and loop prevention.',
    capabilities: ['l2-forward','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' }
    ], icon: 'switch', color: '#f97316' },

  { vendor: 'zyxel', model: 'NWA50AX', label: 'Zyxel NWA50AX', category: 'wireless',
    description: 'AX1800 dual-radio WiFi 6 NebulaFlex access point with one PoE Gigabit port.',
    capabilities: ['l2-forward','wireless','cli'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'radio0', type: 'wireless', speed: '1.2G' }
    ], icon: 'ap', color: '#f97316' },

  // ===================== GL.iNet =====================
  { vendor: 'gl-inet', model: 'GL-MT300N-V2', label: 'GL.iNet Mango (GL-MT300N-V2)', category: 'router',
    description: 'Pocket-sized OpenWrt travel router with dual 100M ports and 2.4GHz N300 Wi-Fi.',
    capabilities: ['l3-forward','cli','nat','dhcp-server','wireless'],
    interfaces: [
      { name: 'wan', type: 'ethernet', speed: '100M' }, { name: 'lan1', type: 'ethernet', speed: '100M' },
      { name: 'radio0', type: 'wireless', speed: '300M' }
    ], icon: 'router', color: '#22c55e' },

  { vendor: 'gl-inet', model: 'GL-AXT1800', label: 'GL.iNet Slate AX (GL-AXT1800)', category: 'router',
    description: 'Wi-Fi 6 AX1800 travel router with three gigabit ports, USB 3.0 and WireGuard/OpenVPN.',
    capabilities: ['l3-forward','cli','nat','dhcp-server','wireless'],
    interfaces: [
      { name: 'wan', type: 'ethernet', speed: '1G' }, { name: 'lan1', type: 'ethernet', speed: '1G' },
      { name: 'lan2', type: 'ethernet', speed: '1G' }, { name: 'radio0', type: 'wireless', speed: '1.2G' }
    ], icon: 'router', color: '#16a34a' },

  { vendor: 'gl-inet', model: 'GL-MT6000', label: 'GL.iNet Flint 2 (GL-MT6000)', category: 'router',
    description: 'Wi-Fi 6 AX6000 home router with two 2.5G ports, four 1G LAN ports and USB 3.0.',
    capabilities: ['l3-forward','cli','nat','dhcp-server','wireless'],
    interfaces: [
      { name: 'wan', type: 'ethernet', speed: '2.5G' }, { name: 'lan1', type: 'ethernet', speed: '2.5G' },
      { name: 'lan2', type: 'ethernet', speed: '1G' }, { name: 'lan3', type: 'ethernet', speed: '1G' },
      { name: 'lan4', type: 'ethernet', speed: '1G' }, { name: 'lan5', type: 'ethernet', speed: '1G' },
      { name: 'radio0', type: 'wireless', speed: '4.8G' }
    ], icon: 'router', color: '#0ea5e9' },

  { vendor: 'gl-inet', model: 'GL-MT2500', label: 'GL.iNet Brume 2 (GL-MT2500)', category: 'firewall',
    description: 'Fanless OpenWrt VPN gateway/security appliance with one 2.5G WAN and one 1G LAN port.',
    capabilities: ['l3-forward','firewall','cli','nat','dhcp-server'],
    interfaces: [
      { name: 'wan', type: 'ethernet', speed: '2.5G' }, { name: 'lan1', type: 'ethernet', speed: '1G' }
    ], icon: 'firewall', color: '#64748b' },

  // ===================== Protectli =====================
  { vendor: 'protectli', model: 'VP2410', label: 'Protectli Vault VP2410', category: 'firewall',
    description: 'Fanless Intel Celeron J4125 firewall appliance with four 1GbE Intel i210/i211 NICs.',
    capabilities: ['l3-forward','firewall','cli','nat','dhcp-server'],
    interfaces: [
      { name: 'eth0', type: 'ethernet', speed: '1G' }, { name: 'eth1', type: 'ethernet', speed: '1G' },
      { name: 'eth2', type: 'ethernet', speed: '1G' }, { name: 'eth3', type: 'ethernet', speed: '1G' }
    ], icon: 'firewall', color: '#475569' },

  { vendor: 'protectli', model: 'VP2420', label: 'Protectli Vault Pro VP2420', category: 'firewall',
    description: 'Fanless Intel Celeron J6412 firewall with four 2.5GbE Intel i225-V/i226-V ports.',
    capabilities: ['l3-forward','firewall','cli','nat','dhcp-server'],
    interfaces: [
      { name: 'eth0', type: 'ethernet', speed: '2.5G' }, { name: 'eth1', type: 'ethernet', speed: '2.5G' },
      { name: 'eth2', type: 'ethernet', speed: '2.5G' }, { name: 'eth3', type: 'ethernet', speed: '2.5G' }
    ], icon: 'firewall', color: '#334155' },

  // ===================== Qotom =====================
  { vendor: 'qotom', model: 'Q750G5', label: 'Qotom Q750G5', category: 'firewall',
    description: 'Compact Celeron J4125 mini-PC firewall with five Intel i225-V 2.5G LAN ports.',
    capabilities: ['l3-forward','firewall','cli','nat','dhcp-server'],
    interfaces: [
      { name: 'eth0', type: 'ethernet', speed: '2.5G' }, { name: 'eth1', type: 'ethernet', speed: '2.5G' },
      { name: 'eth2', type: 'ethernet', speed: '2.5G' }, { name: 'eth3', type: 'ethernet', speed: '2.5G' },
      { name: 'eth4', type: 'ethernet', speed: '2.5G' }
    ], icon: 'firewall', color: '#7c3aed' },

  // ===================== Raspberry Pi =====================
  { vendor: 'raspberrypi', model: 'RaspberryPi5', label: 'Raspberry Pi 5', category: 'host',
    description: 'Single-board computer with one gigabit Ethernet port, used as a lightweight homelab host.',
    capabilities: ['host','cli','dhcp-client'],
    interfaces: [ { name: 'eth0', type: 'ethernet', speed: '1G' } ],
    icon: 'host', color: '#c51a4a' },

  // ===================== QNAP =====================
  { vendor: 'qnap', model: 'QSW-2104-2T', label: 'QNAP QSW-2104-2T', category: 'switch',
    description: 'Fanless unmanaged switch with four 2.5GbE and two 10GbE 10GBASE-T RJ45 ports.',
    capabilities: ['l2-forward'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '2.5G' }, { name: 'port2', type: 'ethernet', speed: '2.5G' },
      { name: 'port3', type: 'ethernet', speed: '2.5G' }, { name: 'port4', type: 'ethernet', speed: '2.5G' },
      { name: 'port5', type: 'ethernet', speed: '10G' }, { name: 'port6', type: 'ethernet', speed: '10G' }
    ], icon: 'switch', color: '#1d4ed8' },

  { vendor: 'qnap', model: 'QSW-308S', label: 'QNAP QSW-308S', category: 'switch',
    description: 'Unmanaged hybrid switch with eight 1GbE RJ45 ports and three 10GbE SFP+ cages.',
    capabilities: ['l2-forward'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' },
      { name: 'port3', type: 'ethernet', speed: '1G' }, { name: 'port4', type: 'ethernet', speed: '1G' },
      { name: 'port5', type: 'ethernet', speed: '1G' }, { name: 'port6', type: 'ethernet', speed: '1G' },
      { name: 'port7', type: 'ethernet', speed: '1G' }, { name: 'port8', type: 'ethernet', speed: '1G' },
      { name: 'sfp1', type: 'ethernet', speed: '10G' }, { name: 'sfp2', type: 'ethernet', speed: '10G' },
      { name: 'sfp3', type: 'ethernet', speed: '10G' }
    ], icon: 'switch', color: '#2563eb' },

  // ===================== Trendnet =====================
  { vendor: 'trendnet', model: 'TEG-S350', label: 'TRENDnet TEG-S350', category: 'switch',
    description: 'Fanless unmanaged 5-port 2.5GBASE-T switch with 25Gbps switching capacity.',
    capabilities: ['l2-forward'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '2.5G' }, { name: 'port2', type: 'ethernet', speed: '2.5G' },
      { name: 'port3', type: 'ethernet', speed: '2.5G' }, { name: 'port4', type: 'ethernet', speed: '2.5G' },
      { name: 'port5', type: 'ethernet', speed: '2.5G' }
    ], icon: 'switch', color: '#0891b2' },

  // ===================== Generic =====================
  { vendor: 'generic', model: '2.5G-8P', label: 'Generic 8-Port 2.5GbE Switch', category: 'switch',
    description: 'Cheap fanless unmanaged 8-port 2.5GBASE-T switch for homelab backbone links.',
    capabilities: ['l2-forward'],
    interfaces: [
      { name: 'port1', type: 'ethernet', speed: '2.5G' }, { name: 'port2', type: 'ethernet', speed: '2.5G' },
      { name: 'port3', type: 'ethernet', speed: '2.5G' }, { name: 'port4', type: 'ethernet', speed: '2.5G' },
      { name: 'port5', type: 'ethernet', speed: '2.5G' }, { name: 'port6', type: 'ethernet', speed: '2.5G' },
      { name: 'port7', type: 'ethernet', speed: '2.5G' }, { name: 'port8', type: 'ethernet', speed: '2.5G' }
    ], icon: 'switch', color: '#94a3b8' }
];

let added = 0, skipped = 0;
for (const d of devices) {
  const dir = path.join(DEVICES_DIR, d.vendor);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, d.model + '.json');
  if (fs.existsSync(file)) { skipped++; console.log('SKIP (exists): ' + d.vendor + '/' + d.model); continue; }
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  added++;
}
console.log('\nadded ' + added + ' devices, skipped ' + skipped + ' (already present).');
