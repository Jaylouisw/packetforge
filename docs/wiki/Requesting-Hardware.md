# Requesting hardware

The catalogue is the project. If a device is missing, that is a bug and we want it filed.

## How to ask

Open a **[device request](https://github.com/Jaylouisw/packetforge/issues/new?template=device_request.yml)**
with:

- **vendor and exact model number** - the string printed on the box, e.g. `CRS326-24G-2S+RM`
- **a link to the vendor's own documentation** - the datasheet or hardware guide, not a shop page
- **which ports you actually care about**, if not all of them

That is enough. You do not need to write JSON.

## What happens next

1. The request is checked against the vendor's documentation: port counts, connector per
   port, speed ladder, PoE budget, and anything the box claims that a simulator must respect.
2. A spec is written as `devices/<vendor>/<model>.json`. Tests check it: every port must
   resolve to a cage, no port may claim a line rate its cage cannot carry, and a device may
   not describe two identical ports differently.
3. The spec lands with the documentation URL recorded inside it, so a later reader can check
   the claim rather than trust it.

## What "accurate" means here

A device is modelled port by port, not by marketing category:

- the **connector** each port really has (RJ45, SFP, SFP+, SFP28, QSFP28, SC/APC, coax, ...)
- the **speeds** it really negotiates, including the ones the datasheet omits
- **shared and combo ports** - an RJ45/SFP pair is one port position, not two ports
- **PoE**: which ports are PSE, the per-port limit and the total budget

Where a datasheet genuinely does not say something, the spec records that it is unknown
rather than filling the gap with a plausible number. A simulator that guesses teaches the
guess.

## If it is not in the catalogue at all

Some things are out of scope on purpose: anything that cannot be described by ports and
links. Everything else - printers, cameras, TVs, phones, smart meters, EV chargers - is fair
game, and increasingly already there.
