'use strict';
/**
 * A physical link (cable / optic / DAC) between two interfaces.
 *
 * The Link carries the *physical* description of the connection: which medium was chosen, the
 * negotiated line rate, duplex and the operational state. L2 configuration (VLANs) lives on the
 * Interface, not here.
 *
 * TypeScript (docs/TYPESCRIPT.md). Every parameter, every return and every exported value is
 * typed, and the class's fields are declared where they used to be assembled by assignment. The
 * two values on this boundary that are genuinely unknown are declared `unknown` and narrowed
 * here: a cable `label`, narrowed by `labelProblem()`, and a `stateSinceMs`, narrowed by the
 * `Number()`/`isFinite` pair. That is the whole reason both guards exist - a link's field is
 * either saved or refused, never accepted and then dropped (#1513, #1323). Nothing is imported:
 * `engine/topology.js` and `engine/simulator.js` are still JavaScript, so the shapes below are
 * written rather than inferred from them.
 *
 * A caller requires this file by its extension - `require('./link.ts')` - because CommonJS does
 * not invent a `.ts` from an extensionless relative require (trap 5 in docs/TYPESCRIPT.md).
 */

// A `.ts` file with no top-level import is a *script* in the type system: its top-level names land
// in one global scope shared with every other such file. This empty, type-only import is erased by
// the strip-types runtime and is what marks the file as a module.
import type {} from 'fs';

/**
 * One end of a cable: a device and the port name on it, exactly as `serialize()` writes it.
 * Read-only, because nothing in the engine moves a cable end - re-cabling is a new Link.
 */
interface LinkEndpoint {
  readonly deviceId: string;
  readonly iface: string;
}

/** Why a value is not a cable label: the code the caller is answered with, and the sentence naming the fix. */
interface LabelProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * What the constructor accepts as its sixth argument.
 *
 * Every field is optional and takes the default the constructor gives it, because this is the
 * shape a caller fills in from a *saved document*: `engine/topology.js` assembles it out of the
 * bytes of a JSON file, so what is in it is not knowable here. `label` and `stateSinceMs` are the
 * two fields where that matters, so they are `unknown` and are narrowed below; the rest are the
 * types the loader's own cable validation has already established by the time a Link is built
 * (`engine/topology.js` `linkProblem()`).
 */
interface LinkOptions {
  readonly type?: string | null;
  readonly mediaId?: string | null;
  readonly speedMbps?: number | null;
  readonly duplex?: string | null;
  readonly lengthM?: number | null;
  readonly lagId?: string | null;
  readonly patchCord?: string | null;
  readonly label?: unknown;
  readonly state?: string | null;
  readonly stateSinceMs?: unknown;
}

/**
 * The stored form, as `serialize()` writes it. `label` and `stateSinceMs` are optional because
 * both are written only when they mean something: an unlabelled, up cable at t=0 is the default,
 * and a field that is always present is noise in every document and every diff.
 */
interface SerializedLink {
  id: string;
  a: LinkEndpoint;
  b: LinkEndpoint;
  type: string;
  mediaId: string | null;
  speedMbps: number | null;
  duplex: string;
  lengthM: number | null;
  lagId: string | null;
  patchCord: string | null;
  state: string;
  label?: string;
  stateSinceMs?: number;
}

// What a cable label can be, in one place.
//
// A label is the annotation a person writes on a cable: "via 0-LR-FP1 keystone 2", "USB Ethernet adapter", "DOWN -
// host decommissioned". It is text or it is nothing (null/undefined/'' all mean "this cable has no label").
//
// It was not a field of the Link at all. Setting one on the live cable worked - JavaScript lets you write any
// property - and read back, so it looked as though the annotation had been recorded; `serialize()` then wrote the
// link without it, and the whole cabling record was gone the moment the board was saved (#1513). The failure mode
// that costs a user their notes is not "the field is missing", it is "the field accepts a value and keeps it
// nowhere", so the value is either a string that is saved or it is refused where it is set.
//
// The rule lives here so the constructor, `connect()`, the API door and the document loader cannot disagree about
// what a label is.
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number') return 'the number ' + v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return 'an object';
  return 'a ' + typeof v;
}

// null when `label` is a usable label (including "no label"), or { code, message } saying why it is not.
function labelProblem(label: unknown): LabelProblem | null {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string') {
    return {
      code: 'E_BAD_LABEL',
      message: 'a cable label is text you write on the cable (a string), not ' + describeValue(label) + '.'
    };
  }
  return null;
}

// The stored form: text, or null for "no label". An empty label is no label - a save must not grow a `label: ""`
// that draws a blank caption and means nothing.
function normaliseLabel(label: unknown): string | null {
  return (typeof label === 'string' && label !== '') ? label : null;
}

class Link {
  id: string;
  a: LinkEndpoint;
  b: LinkEndpoint;
  // Legacy label, kept for old topologies. Every field below is written by somebody other than the
  // constructor - `engine/topology.js` re-rates a cable, `engine/simulator.js` changes its state -
  // so none of them is readonly: a physical record is edited, not rebuilt.
  type: string;
  mediaId: string | null;
  speedMbps: number | null;
  duplex: string;
  lengthM: number | null;
  lagId: string | null;
  patchCord: string | null;
  label: string | null;
  state: string;
  stateSinceMs: number;

  constructor(
    id: string,
    aDeviceId: string,
    aIface: string,
    bDeviceId: string,
    bIface: string,
    opts?: string | LinkOptions | null
  ) {
    this.id = id;
    this.a = { deviceId: aDeviceId, iface: aIface };
    this.b = { deviceId: bDeviceId, iface: bIface };

    // Backwards compatibility: callers used to pass a bare type string
    // ('copper'); they may now pass an options object.
    let o: LinkOptions;
    if (typeof opts === 'string' || opts === undefined || opts === null) {
      o = { type: opts || 'copper' };
    } else {
      o = opts;
    }

    this.type = o.type || 'media';        // legacy label, kept for old topologies
    this.mediaId = o.mediaId || null;     // e.g. '1000base-t', '10gbase-sr', 'dac-10g'
    this.speedMbps = (o.speedMbps === undefined) ? null : o.speedMbps;
    this.duplex = o.duplex || 'full';
    this.lengthM = (o.lengthM === undefined) ? null : o.lengthM;
    this.lagId = o.lagId || null;
    // The patch cord actually installed, by catalogue part number (e.g. the FS
    // SMSCSX hybrid SC/UPC-to-SC/APC lead). null means ordinary fibre: a saved
    // topology that predates this field loads as plain cable, and a link that
    // never mentions a cord is not charged one.
    this.patchCord = o.patchCord || null;
    // The annotation written on this cable, if any. A field of the link, restored from the document, so a note such
    // as "via 0-LR-FP1 keystone 2" is part of the lab rather than part of the session that typed it (#1513).
    const labelBad: LabelProblem | null = labelProblem(o.label);
    if (labelBad) {
      // `Error` has no `code` field and a call site that catches this reads one, so the error is
      // declared as the shape it actually is rather than widened to one thing or the other.
      const err: Error & { code?: string } = new Error(labelBad.message);
      err.code = labelBad.code;
      throw err;
    }
    this.label = normaliseLabel(o.label);
    this.state = o.state || 'up';         // 'up' | 'down' | 'blocked' (STP)
    // When this state last changed. A cable that was pulled at t=10 s is still pulled at t=41 s,
    // and every later question has to know when it happened to say whether the network has
    // finished reacting to it.
    // A timestamp that is not a number is not a time. `Number('soon')` is NaN, which serialises as null and
    // compares false against everything, so a cable would claim it changed "not at any known time" (#1323).
    const since: number = (o.stateSinceMs === undefined || o.stateSinceMs === null) ? 0 : Number(o.stateSinceMs);
    this.stateSinceMs = isFinite(since) ? since : 0;
  }

  // The endpoint record matching (deviceId, iface), or null.
  endpoint(deviceId: string, iface: string): LinkEndpoint | null {
    if (this.a.deviceId === deviceId && this.a.iface === iface) return this.a;
    if (this.b.deviceId === deviceId && this.b.iface === iface) return this.b;
    return null;
  }

  otherEndpoint(deviceId: string, iface: string): LinkEndpoint | null {
    if (this.a.deviceId === deviceId && this.a.iface === iface) return this.b;
    if (this.b.deviceId === deviceId && this.b.iface === iface) return this.a;
    return null;
  }

  touches(deviceId: string): boolean {
    return this.a.deviceId === deviceId || this.b.deviceId === deviceId;
  }

  isUp(): boolean { return this.state === 'up'; }

  serialize(): SerializedLink {
    const out: SerializedLink = {
      id: this.id,
      // Copies, not the live endpoint records. `serialize()` is what the API hands out and what the UI, the
      // example builder and every test fixture receives; a caller that adjusts the document it was given must not
      // be adjusting the board (#1323).
      a: { deviceId: this.a.deviceId, iface: this.a.iface },
      b: { deviceId: this.b.deviceId, iface: this.b.iface },
      type: this.type,
      mediaId: this.mediaId,
      speedMbps: this.speedMbps,
      duplex: this.duplex,
      lengthM: this.lengthM,
      lagId: this.lagId,
      patchCord: this.patchCord,
      state: this.state
    };
    // Written only when a cable has one, for the same reason `stateSinceMs` is: an unlabelled cable is the default,
    // and adding `label: null` to every cable of every saved lab would be noise in every document and every diff.
    if (this.label) out.label = this.label;
    // Only for a cable that is not up: an up link at t=0 is the default and does not need a field,
    // and adding one to every saved lab would be noise in every diff.
    if (this.state !== 'up' || this.stateSinceMs) out.stateSinceMs = this.stateSinceMs;
    return out;
  }
}

module.exports = { Link, labelProblem, normaliseLabel };
