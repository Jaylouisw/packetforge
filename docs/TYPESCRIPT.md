# TypeScript, with no build step

The rule, in one line: **every new file is TypeScript, `any` appears nowhere, and a legacy
`.js` file is converted when it is touched** — not in a sweep, not in a separate branch, and
never by a tool that rewrites it unread.

This page is the toolchain that makes that rule enforceable. Nothing here is a proposal: it is
what `package.json`, `tsconfig.json` and the `Typecheck` job already do.

- [What the rule means](#what-the-rule-means)
- [Migrated so far](#migrated-so-far)
- [What is installed](#what-is-installed)
- [Why there is no build step](#why-there-is-no-build-step)
- [The Node floor](#the-node-floor)
- [Running the typecheck](#running-the-typecheck)
- [What a converted module looks like](#what-a-converted-module-looks-like)
- [When you touch a legacy `.js` file](#when-you-touch-a-legacy-js-file)
- [Tests in TypeScript](#tests-in-typescript)
- [The type declarations there are, and are not](#the-type-declarations-there-are-and-are-not)
- [The five traps](#the-five-traps)

## What the rule means

| Subject | Rule |
|---|---|
| New file | `.ts`. A new `.js` file is a review comment, not a style preference |
| Existing `.js` file | Stays as it is until someone changes it. Then it is converted in the same commit as the change, because a file that is being edited is a file that is being read |
| `any` | Appears nowhere — not in an annotation, an assertion, a generic, or a `Record` value. Use the real type, or `unknown` and narrow it |
| Declaration merging, `enum`, `namespace`, parameter properties | Not used. The runtime erases annotations and refuses to transform (see [the traps](#the-five-traps)) |
| `.d.ts` | Allowed, and only in `types/`. It is how the Node surface is declared |

There is no exception for "a quick script". `scripts/check-control-bytes.ts` is 110 lines of
throwaway-shaped guard code and it is typed; that is the point of it being the first one.

## Migrated so far

The ledger. One row per converted file, and the row is added by the commit that does the
conversion — a file that is not in this table has not been converted, whatever its extension says.
Line counts are `wc -l` on the converted file, so they include the annotations.

| File | Lines | Converted by |
|---|---|---|
| `engine/segment.ts` | 236 | `53bee0cf` (#2483) |
| `engine/link.ts` | 243 | `628fc3f5` (#2494) |
| `engine/lag.ts` | 710 | `0eb0ad3e` (#2504) |

The SHA is the commit in the converting branch; the pull request number is the handle that survives
the squash merge onto `main`, so cite the number when the commit id has moved on.

The first row is also the template: `engine/segment.js` went from 130 lines to 236, and the net 106
lines are the interfaces describing the shapes the walk reads. Nothing was left untyped; the
two places a type is written by hand rather than inferred are `engine/lag.ts`'s
`memberSuspension()` - JavaScript when this row was written, and the module row three converts -
and `VlanConfig.mode`, which is `string` because the untyped `Interface` constructor cannot prove
the union `'access' | 'trunk'`.

Row two is the shapes rather than the walk: `engine/link.js` went from 139 lines to 243, and the net
104 are `LinkOptions` (what a saved document is allowed to hand the constructor), `SerializedLink`
(what `serialize()` writes back, with `label?` and `stateSinceMs?` because both are written only when
they mean something) and the two `unknown`s — a cable `label` and a `stateSinceMs`, the only two
values on that boundary a document can put anything into. Both are narrowed by the guards that were
already there (`labelProblem()`, and `Number()` + `isFinite()`), so the annotations describe the
rules #1513 and #1323 put in place rather than restating them more weakly.

Row three is the module the two above were already reaching for. `engine/segment.ts` required `./lag`
without an extension because `lag.js` was still JavaScript, so converting this file would have broken
that one, in a file no conversion edited, for a reason nobody would connect to the diff -
`engine/lag.js` went from 542 lines to 710, and the net 168 are the shapes its three jobs share:
`LagConfig` (what `normalizeLag()` returns and what everything downstream is handed), `MemberPort` and
`KnownMember` (what `validateLag()` is asked to check, every field of it `unknown` because a saved lab
supplies it), `LagProblem` and `LagVerdict` (its answer), `MemberSuspension`, and a `NegotiationVerdict`
that is a discriminated union rather than a boolean beside a maybe-string: a pair that bundles has no
reason to give, and a pair that does not always has one.

Two values on that boundary are genuinely unknown and are narrowed rather than asserted. One is the
frame a hash is taken from - a document's own frame record, read through `isObject()` and stringified
field by field. The other is the channel group `Device.lagFor()` answers with: `engine/device.js` is
still JavaScript, so `groupMode()` reads its `mode` and stringifies it exactly the way `canonicalMode()`
always did, instead of turning a group into a refusal this module has no business inventing. There is
no `as` in the file. The conversion also retires the latent require rather than inheriting it:
`engine/segment.ts` now says `require('./lag.ts')` and imports `MemberSuspension` from the module
instead of restating it, so `node scripts/check-module-paths.ts` no longer names that line. What it
names now is `engine/lag.ts` requiring its own still-JavaScript sibling `./iface-name`, which resolves
today and is the same debt one link further out.

## What is installed

Two packages, and neither is a runtime dependency:

```json
"devDependencies": { "@types/node": "^26.6.6", "typescript": "7.0.2" }
```

- `dependencies` stays empty. The app is zero-dependency, the image has no `node_modules` in it,
  and `.dockerignore` excludes the directory anyway.
- `@types/node` **is** installed, as a dev-only type package: node never loads it, so the running
  program still has no dependencies. Its predecessor here was a hand-written `types/node.d.ts`
  declaring the Node surface the converted files used — which went stale the first time another
  branch imported `node:child_process`. A declaration that has to be kept in step with reality by
  hand is a doc, not a type.
- No linter. `typescript` plus one 507-line scan (`scripts/check-no-any.ts`) is the whole
  toolchain; ESLint would be a dependency, a config file and a plugin tree to enforce one word.

A fresh clone needs one install, once:

```bash
npm ci            # or `npm install`; either one fetches only the two dev packages
```

Nothing else in the repository needs it. `node server/index.js`, `npm test` and every script run
with no `node_modules` at all — the install exists for the checker.

## Why there is no build step

Node runs a `.ts` file directly (type stripping, stable and on by default from **22.18**). So:

```bash
node scripts/check-control-bytes.ts     # this is the build
```

`tsc` is configured with `"noEmit": true` and there is no `dist/`, no `outDir`, no build script
in `package.json`, and no `.ts` file in the image that has been through a compiler. What `tsc`
does here is *check*: the annotations are erased by the runtime at load time, so the only way a
wrong annotation can be caught is a checker that is run on purpose.

That has three consequences worth stating plainly:

1. **The typecheck is a gate, not a step.** Nothing else will notice a type error. It is a CI job
   (`Typecheck`) and a local command (`npm run typecheck`), and a red one blocks a merge.
2. **Annotations cost nothing at runtime and nothing at startup.** They are stripped in the same
   pass that parses the file; there is no transpile, no cache, no map file.
3. **Nothing is downlevelled.** `target` is `es2022` because the floor is 22.18 — syntax the
   runtime has is syntax the source may use. `scripts/check-node-surface.js` still holds the
   stricter Node 18 API surface, so "the runtime has it" and "the repository may use it" are two
   different questions and both have an answer. That scan reads `.js`, `.mjs`, `.cjs` **and**
   `.ts`: a `.ts` file is stripped and then run by the same `node`, so the surface it reaches is
   the surface a `.js` file reaches, and a gate that skipped it would go quiet on exactly the
   files this repository is converting.

## The Node floor

`package.json` says `"engines": { "node": ">=22.18.0" }`, and that number is 22.18 for one
reason: it is the first release where type stripping needs neither a flag nor a loader. 22.6
could do it behind `--experimental-strip-types`; 22.18 is where it became the default.

Not 22.0, not 20, and not "18 with a flag": a floor that needs a flag is a floor nobody sets.
`docs/CI.md` has the matrix, which is Node 22 and 24 — the floor and the current LTS.

## Running the typecheck

```bash
npm run typecheck        # tsc --noEmit && node scripts/check-no-any.ts
npx tsc --noEmit         # just the compiler
npm run check:no-any     # just the scan for `any`
```

`tsconfig.json` is the policy, and every line of it is deliberate:

| Option | Why |
|---|---|
| `strict`, `noImplicitAny`, `strictNullChecks` | The point. `strictNullChecks` is where most of the real bugs are: a `Buffer | undefined` from an index is a crash the type system was told to ignore |
| `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` | A dead binding in a converted file is usually a line the conversion did not update |
| `noEmit: true` | There is no output. `node` is the build |
| `allowJs: false` | 500-odd `.js` files predate the rule. A checker that went red on all of them would be switched off within a week. A file enters the typecheck when it is converted |
| `module: commonjs`, `moduleResolution` defaulted | `package.json` is `"type": "commonjs"`, so a `.ts` file is loaded as CommonJS. The compiler is told the same thing the loader does, which is why `require()` is the right call and `import ... from` is not |
| `types: ["node"]` | Only `@types/node` may declare globals implicitly: a stray ambient `@types` package is how a typecheck starts passing on types that do not exist |
| `erasableSyntaxOnly: true` | The runtime erases; it does not transform. `enum`, `namespace` and parameter properties have no erasure and refuse to load (TS1294 at the typecheck instead). This flag is the reason that failure happens on the author's machine rather than on somebody's first run |
| `verbatimModuleSyntax: false` | CJS output would make `import type` handling stricter than the eraser is; off is the honest setting here |
| `include: engine/**/*.ts`, `scripts/**/*.ts`, `test/**/*.test.ts` | The converted files, by directory. `engine` joined the list when `engine/segment.ts` became the first non-`scripts` conversion: a converted file outside the `include` list is a file `tsc` never reads, and a green typecheck that proves nothing. Widen this as files are converted, never by turning on `allowJs` |

## What a converted module looks like

`scripts/check-control-bytes.ts` is the first file. The shape to copy:

```ts
#!/usr/bin/env node
'use strict';
// A header that says what the file guards against, and since when.

// A `.ts` file with no top-level import is a *script* in the type system: its top-level
// `const`s land in the global scope and collide with the next script's. This empty,
// type-only import is erased by the strip-types runtime and marks the file as a module.
import type {} from 'fs';

const fs = require('fs');
const path = require('path');

const ROOT: string = path.join(__dirname, '..');
const EXTS: readonly string[] = ['.js', '.ts', '.json', '.md'];

/** One control byte, and where in the file it sits. */
interface Hit {
  readonly index: number;
  readonly byte: number;
}

function badBytes(buf: Uint8Array): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b: number = buf[i];
    if (b < 32) hits.push({ index: i, byte: b });
  }
  return hits;
}
```

Every parameter and every return has a type. `interface` for a value shape, `readonly` where the
value is not reassigned, `Uint8Array` for a buffer (that is what `Buffer` is — no invented type),
and `require()` rather than `import` because the file is CommonJS (`[the traps](#the-five-traps)`).

The script is invoked exactly as the `.js` it replaced was:

```bash
node scripts/check-control-bytes.ts
npm run check:bytes
```

and `npm test` runs it as the third command of its chain, unchanged apart from the extension.

## When you touch a legacy `.js` file

1. **Rename it**: `git mv scripts/thing.js scripts/thing.ts`. Keep the name otherwise identical —
   every reference is by path, and `git mv` keeps the history one file.
2. **Update every reference**: `package.json` scripts, `.forgejo/workflows/ci.yml` (steps, log
   names, and the expected-chain strings that name the command), docs, and any `require()` of it.
   `grep -rn 'thing.js' --include='*.js' --include='*.ts' --include='*.yml' --include='*.md' .`
3. **Type it as you go, not after**: annotate every function you touch, every parameter, every
   return. A converted file that is full of untyped locals is a `.js` file with a new extension,
   and it will be the file somebody points at when they argue the rule does not work.
4. **Run the three gates**: `npm run typecheck`, `node scripts/syntax-check.js`, and the script
   itself. A file that no longer runs is not converted, it is broken.
5. **Do not convert on a whitespace-only commit.** The diff should be the change plus the types,
   so a reviewer can see that the behaviour did not move.

What you must not do: turn on `allowJs`, add `// @ts-nocheck`, add `as any` to silence a real
type, or leave a `.js` shim that re-exports the `.ts` (the runtime would need the extension and
the shim would be permanent).

## Tests in TypeScript

`scripts/run-tests.js` discovers **both** `test/*.test.js` and `test/*.test.ts` — one glob, sorted
by file name, so the `.js` suites keep exactly the order and count they had. A `.test.ts` suite is
spawned the same way, in its own process, with the same 300 s bound, the same `"<n> passed, <m>
failed"` convention and the same tally.

```bash
node scripts/run-tests.js --filter=my-suite     # matches test/my-suite.test.ts too
node scripts/run-tests.js --list                # both spellings in the list
```

`test/**/*.test.ts` is in `tsconfig.json`'s `include`, so a typed suite is typechecked like any
other TypeScript — a suite that does not compile is a red `Typecheck`, and a suite that does not
run is a red `Test (Node 22)`.

## The type declarations there are, and are not

The Node surface comes from `@types/node`, pinned in `devDependencies` and named in
`tsconfig.json`'s `types`. Nothing else may declare a global: an ambient package pulled in
transitively is how a typecheck starts passing on types that do not exist at runtime.

When a converted file needs a Node API, it is already typed — use it:

```ts
declare module 'os' {
  function tmpdir(): string;
}
```

and, if it is a module, add the typed `require` overload:

```ts
declare function require(id: 'os'): typeof import('os');
```

That is a two-line cost per API and it keeps the repository at one devDependency. The thing not
to do is `const x = require('os') as any` — `scripts/check-no-any.ts` fails on it, which is the
point of the scan existing.

## The five traps

These are not hypothetical. Each one was hit while this toolchain was built.

1. **`import` at the top of a CommonJS `.ts` file is a runtime error.**
   ```
   (node) Warning: Failed to load the ES module: .../x.ts
   x.ts:1  import * as fs from 'fs';
           ^^^^^^
   ```
   `package.json` is `"type": "commonjs"`, so the file is CJS, and CJS has no import statement.
   Use `const fs = require('fs')`, typed by `@types/node`. `import type ... from` is fine:
   the eraser removes it before the loader sees it.

2. **A `.ts` file with no top-level import is a *script*, not a module.** Its `const`s go into the
   global scope, and the second such file in the same `tsc` program collides with the first
   (`TS2451: Cannot redeclare block-scoped variable 'fs'`). One `import type {} from 'fs';` fixes
   it and costs nothing at runtime.

3. **`node --check` cannot parse a `.ts` file.**
   ```
   SyntaxError: Missing initializer in const declaration
   ```
   It parses annotations as JavaScript. So `scripts/syntax-check.js` covers `.js` only, and
   `tsc --noEmit` is what covers `.ts`. This is also exactly why Node 18 and 20 left the matrix:
   it is the same parser, and the same error.

4. **`enum`, `namespace` and parameter properties are refused** — `TS1294` from
   `erasableSyntaxOnly`, and a hard load failure at runtime. Use a `const` object with
   `as const`, a module, and an explicit field assignment.

5. **Extensions are real.** `require('./sibling.ts')` is the file; `require('./sibling')` will not
   resolve a `.ts` from CommonJS. Name the extension in a relative require of a `.ts` file. So
   converting a module means sweeping its importers, and `node scripts/check-module-paths.ts`
   (`npm run check:module-paths`) is what proves the sweep is complete: it resolves every
   `require()` in `scripts/`, `engine/`, `server/`, `web/` and `test/` the way CommonJS actually
   will, reports the ones that no longer resolve, and names the `.ts` file still requiring a `.js`
   sibling — the latent breakage, in a file no conversion touched.

## Where this is enforced

| Gate | What it catches |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | types, in every file in the `include` list |
| `npm run check:no-any` (`scripts/check-no-any.ts`) | `any` — annotation, assertion, generic or `Record` value |
| `npm run check:module-paths` (`scripts/check-module-paths.ts`) | a `require()` whose specifier CommonJS will not resolve, and a `.ts` file still requiring a `.js` sibling |
| `npm test` → `scripts/run-tests.js` | `.test.ts` suites, discovered beside the `.js` ones |
| `node scripts/syntax-check.js` | a `.js` file that does not parse (`.ts` is `tsc`'s job) |
| `node scripts/check-node-surface.js` | an API newer than Node 18, which is stricter than the 22.18 floor — in every `.js`, `.mjs`, `.cjs` and `.ts` file, because `node` runs all four |
| `Typecheck` in CI | `tsc`, `check:no-any` and `check:module-paths` — three steps, three `::error` titles — on every push and pull request |
