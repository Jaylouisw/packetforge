'use strict';
// A session printed in docs/CLI.md is a transcript, and a transcript has to be replayable (#1773).
//
// The DHCP-server section showed a pool sub-mode being left half-typed, and the `%` line it printed was one
// the console had stopped saying: `% E_DHCP_BAD_RANGE: DHCP pool lan: …` was the old shape, before the
// message was reworded to say the *pool* is incomplete rather than reading like the `no range` that left it
// that way had failed, and before the code moved to the end in parentheses. The page also omitted the
// `Created DHCP pool lan` answer to the command that starts the block. Either mistake sends an operator
// comparing their own console to the page down a path the console will not follow.
//
// `test/docs-show-commands.test.js` guards the documented *commands* - a spelling the parser no longer knows
// is a failure there. This suite guards the documented *answers*: the fenced session in the DHCP section is
// replayed into a real device, prompt for prompt and line for line, so a message that drifts has to be
// corrected on the page in the same change that moves it in the code.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CLI.md'), 'utf8');

// Fenced blocks, with the fence character and indentation remembered so a nested block closes properly.
function fencedBlocks(text) {
  const blocks = [];
  let open = null, body = [];
  for (const line of text.split('\n')) {
    const fence = line.match(/^\s*(```+)(.*)$/);
    if (!open && fence) { open = fence[1]; body = []; continue; }
    if (open && fence && fence[1] === open) { blocks.push(body); open = null; continue; }
    if (open) body.push(line);
  }
  return blocks;
}

// One line of a transcript: a prompt and the command after it, or an answer with no prompt.
const PROMPT = /^([A-Za-z][\w.-]*(?:\([a-z0-9-]+\))?[#>])(.*)$/;
function transcript(lines) {
  return lines.map(function (l) {
    const m = l.match(PROMPT);
    return m ? { command: m[2], prompt: m[1] } : { output: l };
  });
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const router = catalog.filter(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; })[0];

function session() {
  const t = new Topology();
  const dev = t.addDevice(router, 'r1');
  dev.config.hostname = 'R1';
  const cli = new CliSession(dev, t, new Simulator(t));
  cli.run('enable');
  cli.run('configure terminal');
  return cli;
}

console.log('');
console.log('The DHCP pool session in docs/CLI.md is what this console prints:');
{
  const block = fencedBlocks(doc).filter(function (b) {
    return b.some(function (l) { return /^[A-Za-z][\w.-]*(?:\([a-z0-9-]+\))?#ip dhcp pool /.test(l); });
  })[0];
  ok(!!block, 'the page still holds the DHCP pool session');
  if (block) {
    const steps = transcript(block);
    const cli = session();
    const mismatches = [];
    const pending = [];
    let lines = 0;
    for (const step of steps) {
      if (step.command !== undefined) {
        lines++;
        const here = cli.prompt();
        if (step.prompt !== here) mismatches.push('prompt: page shows ' + step.prompt + ', console says ' + here);
        const out = (cli.run(step.command).output || []).map(String);
        for (const l of out) pending.push(l);
      } else {
        lines++;
        const next = pending.shift();
        if (next === undefined) mismatches.push('page shows "' + step.output + '" but the console printed nothing there');
        else if (next !== step.output) mismatches.push('page shows "' + step.output + '", console says "' + next + '"');
      }
    }
    // A transcript is also incomplete if the console said something the page left out.
    for (const extra of pending) mismatches.push('console printed "' + extra + '", page shows nothing');

    ok(lines > 0, 'and it is a transcript of real prompts', String(lines));
    ok(mismatches.length === 0, 'every line on the page is a line the console prints, in order',
      JSON.stringify(mismatches.slice(0, 4)));
  }
}

console.log('');
console.log('No documented answer uses the retired error-code prefix:');
{
  // The console says `% <sentence> (E_CODE)`. `% E_CODE: <sentence>` was the shape before that, and a line in
  // that shape is a string no code path can produce.
  const retired = doc.split('\n').filter(function (l) { return /^\s*%\s+E_[A-Z_]+:/.test(l); });
  ok(retired.length === 0, 'docs/CLI.md has no `% E_<CODE>: message` line', JSON.stringify(retired.slice(0, 3)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
