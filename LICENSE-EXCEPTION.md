# App store distribution exception

*Additional permission under GNU GPL version 3, section 7.*

Copyright © 2026 Aydil (github.com/AydilJoe) &lt;hello@duitful.app&gt;

Duitful's code is licensed under **GPL-3.0-only** — see [`LICENSE`](LICENSE).
As the sole copyright holder I grant everyone the following additional
permission, which supplements that licence and does not replace any part of
it.

## The permission

You may convey the Program, or a work based on the Program, through an
application distribution platform — including but not limited to the Apple
App Store, Google Play, and equivalent services — notwithstanding that the
platform imposes terms on the people who obtain a copy from it which would
otherwise be incompatible with sections 6 and 10 of the GNU General Public
License version 3. Those terms include, without limitation, limits on the
number of devices or accounts a copy may be used on, digital rights
management applied by the platform, and a requirement that the recipient
accept the platform's own agreement.

## What it does not do

This permission is narrow on purpose.

- It covers **only** the restrictions the platform itself imposes as a
  condition of distributing through it. It does not permit you to impose any
  further restrictions of your own.
- It does **not** relieve you of any other obligation under the GPL. In
  particular, **you must still make the Corresponding Source of the version
  you convey available under the GPL**, on the terms of section 6. Shipping a
  build to an app store does not make it closed source.
- It does not grant any right to the Duitful name, wordmark or icons, which
  are reserved — see [`TRADEMARK.md`](TRADEMARK.md). If you publish a build to
  a store, it needs its own name.

Under section 7, paragraph 4 of the GPL you may remove this additional
permission from your own copy if you would rather not rely on it.

## Why it exists

The GPL forbids imposing "further restrictions" on people who receive a copy.
Apple's App Store terms do impose such restrictions on recipients, and the
conflict is not theoretical — VLC was removed from the App Store in 2011 over
exactly this point. Without an explicit exception from the copyright holder, a
GPL-licensed app cannot safely be distributed there at all.

Duitful is meant to reach people on the phone they already own. An app that
cannot be installed protects nobody's privacy. This exception resolves the
conflict while keeping the part that matters: the source of whatever ships
stays open and auditable.

Google Play does not present the same conflict, but the permission is written
platform-neutrally so it does not have to be revisited for the next store.
