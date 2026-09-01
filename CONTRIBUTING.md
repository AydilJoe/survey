# Contributing to Duitful

Duitful holds people's financial records on their own devices. That shapes
what a good contribution looks like here more than any style rule, so this
document is short on ceremony and specific about the things that actually
matter.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by` line. Git adds it for you:

```sh
git commit -s -m "your message"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

That line is you certifying the Developer Certificate of Origin below — that
you wrote the change, or otherwise have the right to contribute it under this
project's licence. Use a real name and a real email; a pseudonym you actually
go by is fine, an anonymous one is not.

There is no CLA. You keep the copyright in what you write.

### Inbound equals outbound

Contributions are accepted under the same terms the project ships under:
**GPL-3.0-only**, together with the
[app store distribution exception](LICENSE-EXCEPTION.md). By signing off you
are contributing under those terms, which is what keeps a store build possible
for everyone downstream. Nothing here gives the maintainer a right to
relicense your work under different terms later.

### Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.```

## Before you open a pull request

```sh
npm install
npm run test:e2e      # headless Chromium, blank profile
```

The suite is the review. It is currently 550-odd assertions and it is expected
to pass before and after your change.

**If you change behaviour, add a check for it.** The existing ones are written
as sentences describing what must stay true — grep the file for a few and match
the tone. A check that names the real-world case it came from is worth three
that assert an implementation detail.

## Things that will get a change sent back

These are not style preferences. Each one has broken something here before.

- **Cache-busting.** Touching `app/script.js`, `app/styles.css`, `app/split.js`
  or any other asset means bumping its `?v=` in `app/index.html` *and* in the
  `SHELL` list in `app/sw.js`, plus the service worker's own `VERSION`. Miss
  one and installed users keep the old file forever. A test pins this.
- **Inline scripts.** The app's CSP is `script-src 'self'` with no
  `'unsafe-inline'`. An inline `<script>` is silently refused by the browser —
  it will look like your code simply does nothing. Put it in a file.
- **New network calls.** `connect-src` in the CSP is the enforced allowlist. If
  a change needs a host that is not on it, that is a privacy decision, not a
  plumbing one — open an issue first and say what leaves the device and why.
- **Numbers presented as facts.** Rates, prices, thresholds and accuracy claims
  need a source, and the source belongs in a comment next to the number. The
  receipt parser is tuned against a committed benchmark for this reason; see
  [`tests/fixtures/README.md`](tests/fixtures/README.md).
- **Anything that makes a guess look like a reading.** If a value was inferred
  rather than read, the UI has to say so. This is why the scan screen labels
  fields "read" or "check this".

## Style

There is no linter and no build step, deliberately — the app is plain
HTML/CSS/JS you can open in a browser. Match the surrounding code.

Comments here explain **why**, not what. If a line encodes a decision, a
constraint, or a bug that came back, say so — the existing comments are the
best guide to the expected register.

## Reporting a vulnerability

Not here. [`SECURITY.md`](SECURITY.md) has the private route.

## Licensing, in one line

Code is [GPL-3.0-only](LICENSE) plus the
[app store exception](LICENSE-EXCEPTION.md); the name and marks are reserved
([`TRADEMARK.md`](TRADEMARK.md)); the written guides under `guides/` are not
licensed for republication.
