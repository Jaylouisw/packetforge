'use strict';
// Unambiguous keyword abbreviation - the IOS rule.
//
// Every kid who has used a Cisco box types `sh ip int br`. This console refused it:
//
//   R1#sh ip int br
//   % Unrecognized command: sh ip int br
//
// and the only reason `conf t` and `en` worked is that they were hand-coded aliases, which is a list
// that can never be complete. IOS's rule is better and simple: a keyword may be abbreviated to any
// prefix that identifies exactly one command at that point in the tree, and a prefix that identifies
// two is refused by name rather than guessed at.
//
// The forms come from *help*, not from a second hand-kept list: `helpRows()` is the documented
// command surface, and the docs/help sweeps already keep it honest against the parser. One source,
// so an abbreviation can never reach a command that does not exist, and a new command is
// abbreviatable the moment it is documented.
//
// Four rules, all of them IOS's:
//   * a prefix that matches exactly one continuation is expanded (`sh` -> `show`);
//   * a prefix that matches several is refused with the candidates named (`% Ambiguous command`);
//   * a prefix that matches nothing leaves the line untouched, so the caller's own "unrecognized"
//     message still means what it says - abbreviation must never turn a typo into a different
//     command;
//   * an exact match wins over a longer word that starts with it (`int` is the alias `int`, not a
//     prefix of `interface`), because that is what the operator typed and the tree agrees.
//
// Placeholders (`<dst>`, `<n>`) accept whatever the operator typed and are passed through untouched:
// abbreviation is about keywords, never about values. A value that happens to start with a keyword
// stays a value.

const PLACEHOLDER = /^<(.+)>$/;

// Split a help synopsis into the alternative keyword sequences it documents.
//
// The shapes that appear in the help output, all of which have to be read correctly or the expansion
// silently loses commands:
//   `show ip route [<dest>|connected|static] [at <ms>|converged]`   optional groups, alternatives
//   `enable / en`                                                    a form and its alias
//   `ipv6 nd ra enable|disable`                                      a bare alternation, shared prefix
//   `ping <dst> [count <n>]`                                         placeholder then keywords
//   `show flows [<id> | counters]`                                   spaces around the bar
//   `show ip route <dest> …`                                         "and the rest"
// The synopsis grammar, which is small but has to be read exactly or commands silently vanish from
// the tree. Everything in the help output is one of:
//
//   `show ip route [<dest>|connected|static] [at <ms>|converged]`   optional groups, alternatives
//   `enable / en`                                                    a form and its alias
//   `ipv6 nd ra enable|disable`                                      a bare alternation
//   `ping <dst> [count <n>]`                                         a placeholder, then keywords
//   `show flows [<id> | counters]`                                   spaces around the bar
//   `description <text>`                                             a placeholder that eats a word
//   `ip route <dest> <mask> <gw> [iface] …`                          "and the rest"
//
// The first version of this read a group as a *single* value slot, so `[<dest>|connected|static]`
// became "any word here" - which made `show ip route summ` an invalid destination instead of a
// request for the summary. A group is a set of alternative *sequences*, not one opaque value.
const WORD = /[^\s\[\]|]+/g;

function lex(text) {
  const out = [];
  const s = String(text).replace(/\u2026/g, ' … ');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[' || c === ']') { out.push(c); i++; continue; }
    if (c === '|') {
      // The spacing carries the meaning, and the help output uses both readings:
      //   `ipv6 nd ra enable|disable`   tight  -> one command with two endings (`nd ra disable`)
      //   `interface <name> | int <name>` spaced -> two complete commands, alias style
      //   `show flows [<id> | counters]`  spaced but bracketed -> alternatives inside a group
      const spaced = /\s/.test(s[i - 1] || ' ') && /\s/.test(s[i + 1] || ' ');
      out.push(spaced ? '|A' : '|');
      i++;
      continue;
    }
    if (c === '/') { out.push('|'); i++; continue; } // `a / b` is an alias = two alternatives
    if (s.startsWith('…', i)) { out.push('…'); i += 1; continue; }
    WORD.lastIndex = i;
    const m = WORD.exec(s);
    if (!m) { i++; continue; }
    out.push(m[0]);
    i = m.index + m[0].length;
  }
  return out;
}

// A token is a keyword, a placeholder, or the "and the rest" marker.
function tokenOf(word) {
  if (word === '…') return { rest: true };
  const m = PLACEHOLDER.exec(word);
  if (m) return { placeholder: m[1] };
  return word;
}

// alternatives(tokens, i, endChar) -> { alts: [ [token…], … ], next }
//
// Every branch is a *sequence*, because one alternative can be several tokens long
// (`at <ms>` vs `converged`) and an optional group contributes an empty branch.
function alternatives(tokens, i, endChar) {
  // `set` is the collection of sequences still being built in parallel (a group multiplies it);
  // `done` holds the ones a `|` finished. The first version pushed an empty branch onto `set` at a
  // `|` and then appended the following words to *every* branch, so `[<dest>|connected|summary]`
  // came out as one branch reading `dest connected summary` - which is how `show ip route summ`
  // became "invalid destination" instead of the summary request.
  let set = [[]];
  const done = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (endChar && t === endChar) { i++; break; }
    if (t === '|' || t === '|A') {
      done.push.apply(done, set);
      set = [[]];
      i++;
      continue;
    }
    if (t === '[') {
      const group = alternatives(tokens, i + 1, ']');
      const inner = group.seqs.concat([[]]); // an optional group may be absent
      const next = [];
      for (const seq of set) for (const alt of inner) next.push(seq.concat(alt));
      set = next;
      i = group.next;
      continue;
    }
    set = set.map(function (seq) { return seq.concat([tokenOf(t)]); });
    i++;
  }
  done.push.apply(done, set);
  return { seqs: done, next: i };
}

// `a b c x|y` means `a b c x` or `a b c y`: a one-word alternative at the *top level* inherits the
// literal prefix in front of it. Inside brackets it does not - `[at <ms>|converged]` is `at <ms>` or
// `converged`, not `at <ms>` or `at converged`. Both readings are in the help output, and getting
// the wrong one silently invents a command or loses one.
function splitTopLevel(tokens) {
  const segments = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t === '[') depth++;
    if (t === ']') depth--;
    if (t === '|' && depth === 0) { segments.push([]); continue; }
    segments[segments.length - 1].push(t);
  }
  return segments;
}

// The first `|` at the top level, with what sits either side of it. `a b c x|y z` is
// `a b c x z` and `a b c y z`: the tokens before the alternation and after it are shared by both
// readings. This is why the shape is parsed rather than split - splitting loses the shared tail, and
// `link up|down <id> [at <ms>]` came out as `link up` with no cable id at all.
function findTopLevelBar(tokens) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '[') depth++;
    else if (tokens[i] === ']') depth--;
    else if ((tokens[i] === '|' || tokens[i] === '|A') && depth === 0) return i;
  }
  return -1;
}

function commonPrefix(segments) {
  const first = segments[0] || [];
  let n = 0;
  while (n < first.length) {
    const tok = first[n];
    if (typeof tok !== 'string') break;
    const same = segments.every(function (seg) { return seg[n] === tok; });
    if (!same) break;
    n++;
  }
  return first.slice(0, n);
}

function expandSynopsis(synopsis) {
  return expandTokens(lex(synopsis));
}

function expandTokens(tokens) {
  const bar = findTopLevelBar(tokens);
  if (bar > 0 && bar < tokens.length - 1) {
    if (tokens[bar] === '|A') {
      // Alias style: the bar separates two complete commands, so each side stands alone.
      return expandTokens(tokens.slice(0, bar)).concat(expandTokens(tokens.slice(bar + 1)));
    }
    const pre = tokens.slice(0, bar - 1);
    const a = tokens[bar - 1];
    const b = tokens[bar + 1];
    const post = tokens.slice(bar + 2);
    return expandTokens(pre.concat([a], post)).concat(expandTokens(pre.concat([b], post)));
  }
  const parsed = alternatives(tokens, 0, null);
  return parsed.seqs.filter(function (seq) { return seq.length; });
}

// `helpRows()` lines -> { tokens, desc } per documented command. The description is what makes
// `?` useful rather than a wall of words: `sh ip ?` should say what `route` and `ospf` *are*, not
// only that they exist. A row too long for one line keeps its description on the next line, indented
// to the description column, so that line is picked up here.
function parseFormsWithDesc(lines) {
  const rows = [];
  for (let n = 0; n < lines.length; n++) {
    const line = String(lines[n]);
    if (!/^ {2}\S/.test(line)) continue;
    if (/:\s*$/.test(line)) continue;
    const body = line.slice(2);
    const gap = /\s{2,}/.exec(body);
    const synopsis = (gap ? body.slice(0, gap.index) : body).trim();
    if (!synopsis) continue;
    let desc = gap ? body.slice(gap.index).trim() : '';
    if (!desc) {
      // The wrapped case: the description sits on the following line, indented past the synopsis.
      const next = lines[n + 1] === undefined ? '' : String(lines[n + 1]);
      if (/^ {40,}\S/.test(next)) desc = next.trim();
    }
    for (const tokens of expandSynopsis(synopsis)) {
      if (tokens.length) rows.push({ tokens: tokens, desc: desc, synopsis: synopsis });
    }
  }
  return rows;
}

// `helpRows()` lines -> the keyword sequences they document.
function parseForms(lines) {
  const forms = [];
  for (const raw of lines) {
    const line = String(raw);
    // A command line is exactly two spaces then a non-space. Deeper indentation is a continuation of
    // a description, and a line ending in `:` is a section heading.
    if (!/^ {2}\S/.test(line)) continue;
    if (/:\s*$/.test(line)) continue;
    // Where the synopsis ends and the description begins: the first run of two or more spaces,
    // because a synopsis never contains one and the description is padded away from it. Column
    // positions are not a safe test - a synopsis longer than the padding column runs past it and has
    // its description on the next line, which is how `show ip route [<dest>|…|summary]` was being
    // truncated to `show ip route os` (and `show ip route summ` then turned into "invalid
    // destination" rather than the summary that help documents).
    const body = line.slice(2);
    const gap = /\s{2,}/.exec(body);
    const synopsis = (gap ? body.slice(0, gap.index) : body).trim();
    if (!synopsis) continue;
    for (const tokens of expandSynopsis(synopsis)) {
      if (tokens.length) forms.push(tokens);
    }
  }
  return forms;
}

// Does this form token accept the typed token?
function accepts(token, typed) {
  if (token === undefined) return false;
  if (typeof token === 'object') return true; // placeholder: anything
  return token.toLowerCase().indexOf(String(typed).toLowerCase()) === 0;
}

// What this form token resolves the typed token to.
function resolve(token, typed) {
  if (typeof token === 'object') return typed; // a value is passed through, never abbreviated
  return token;
}

// Expand `typed` against `forms`.
//
// Returns:
//   { tokens }               - the expanded line (possibly identical to the input)
//   { ambiguous, candidates } - a prefix that identifies more than one command
//   null                      - nothing to do; the caller keeps its own error message
function expand(typed, forms) {
  if (!typed.length || !forms.length) return null;
  let current = forms;
  const out = [];
  for (let i = 0; i < typed.length; i++) {
    const want = String(typed[i]);
    let cands = current.filter(function (f) {
      const tok = f[i];
      if (tok === undefined) return false;
      return accepts(tok, want) || typeof tok === 'object';
    });
    if (!cands.length) {
      // Nothing at this position: either the line is a typo (leave it alone) or a form ran out. If
      // we had already expanded something, keep it - IOS expands what it can.
      return out.length ? { tokens: out.concat(typed.slice(i)) } : null;
    }
    // A keyword beats a value slot. IOS only uses a placeholder when no keyword matches, which is why
    // `show ip route summ` means `summary` and not "a destination called summ" - without this the
    // two readings tie and an operator gets "% Ambiguous" for a command that has one obvious meaning.
    const keywords = cands.filter(function (f) { return typeof f[i] !== 'object'; });
    if (keywords.length) cands = keywords;
    // An exact match beats a longer keyword that merely starts with it, so the alias `int` stays
    // `int` instead of being read as a prefix of `interface`.
    const exact = cands.filter(function (f) { return f[i] === want; });
    if (exact.length) cands = exact;
    const values = [];
    for (const f of cands) {
      const value = resolve(f[i], want);
      if (values.indexOf(value) === -1) values.push(value);
    }
    if (values.length > 1) {
      return { ambiguous: want, candidates: values.slice().sort() };
    }
    out.push(values[0]);
    current = cands;
  }
  return { tokens: out };
}

module.exports = { parseForms, parseFormsWithDesc, expand, expandSynopsis };
