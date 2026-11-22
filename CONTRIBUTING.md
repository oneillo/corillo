# Contributing to Corillo

Corillo is for people who write documents with AI agents and aren't developers. Keep that in mind for every change: what they see should read plainly and never need a terminal.

## Build and test

You need macOS and Node.js 24.

```sh
npm ci                  # install
npm run fetch-pandoc    # download Pandoc into vendor/, before the tests (Word export needs it)
npm test                # type check, build, unit tests, licence check, end-to-end tests
```

While you work, run just the tests you need:

```sh
npx vitest run tests/unit/markdown.test.ts
npm run build && npx playwright test tests/e2e/comments.spec.ts
```

The end-to-end tests drive the real app with its window hidden, on throwaway folders for its data and for agent tools' settings, so they never touch your own Corillo or agent tools. Each run keeps what it makes in one folder of its own and removes it when it ends.

Some tests have time limits (`tests/e2e/quick.spec.ts`, `tests/e2e/leaks.spec.ts`, and a few unit tests), set for a recent Apple silicon Mac. On a slower or busy Mac one may fail: run it alone before calling it a failure.

## Every change comes with a test

- A fix starts with a test that fails without it.
- A new feature comes with tests that show it working, unit tests in `tests/unit` (Vitest) and end-to-end tests in `tests/e2e` (Playwright).
- Anything that holds memory, a listener, a timer, a file watcher or a process comes with a test that it lets go again (see `tests/e2e/leaks.spec.ts`).
- Don't loosen or delete a test to get a change through. If a test is wrong, say why in your pull request.

## Licences

Corillo uses only permissively licensed open source, dependencies of dependencies included: MIT, BSD (2- or 3-clause), Apache-2.0, ISC, zlib, 0BSD, Unlicense, CC0 and BlueOak-1.0.0. The few exceptions, such as Pandoc, which ships as a separate program, are listed with their reasons in `dependencies.md`.

`npm test` checks the licence of everything the app ships (`npm run licences` on its own). Add each new direct dependency and its licence to `dependencies.md`, and ask in an issue before adding anything under another licence.

## What must stay true

- **The window opens only what it was given.** A document opens by its path only when the person chose it: File > Open, Open Recent, a card on the start screen, a file dropped on the window, Finder, or a link in the document. The window's page can't make Corillo do more than the person could.
- **Nothing listens on the network.** Agents reach Corillo through a local socket that only the person's own user account can open. No change opens a network port.
- **Nothing of the person's leaves the Mac.** No analytics, no crash reports, no update checks. Corillo goes online only to fetch a picture from the web that a document shows or the person pastes, and opens a link in the browser when it's clicked.

## Words people read

The window, Help (`src/renderer/help.html`) and the messages agents read: plain, short, sentence case, no jargon. When what the person sees changes, Help changes with it.

## Notes in the code

Some comments cite a finding or a batch, such as "B12-8", "W-6" or "roadmap Batch 10", or a decision by its date. These refer to the author's working notes, which aren't published. The code and its tests say what Corillo does; the ids only say where a decision was recorded. "The trial" (a round with a real agent) and "the lead" (the session that ran a batch of work) are the author's own checks and roles, and their scripts aren't published either.

## Reporting

Open an issue for a bug or an idea. For a security problem, don't open an issue: see [SECURITY.md](SECURITY.md).
