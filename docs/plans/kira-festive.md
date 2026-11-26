# Festive Kira: season rules (phase 3 spec)

## Windows (how long each outfit lingers)

The day count is relative to the holiday's first day.

| Season | Shows from | Until | Notes |
|---|---|---|---|
| New Year | 31 Dec | 2 Jan | |
| Thaipusam | −1 | +1 | |
| Chinese New Year | −3 | +14 (Chap Goh Mei) | strongest on days 0–1 |
| Ramadan | 1 Ramadan | the day before Raya | calm look (crescent and pelita only). No food or party jokes during Ramadan |
| Nuzul Al-Quran | that day only | | crescent, inside the Ramadan look |
| Hari Raya Aidilfitri | −1 | +14 (Syawal open houses) | strongest on days 0–2 |
| Labour Day | that day only | | |
| Wesak | −1 | +1 | |
| Kaamatan | 30 May | 31 May | |
| Gawai | 1 Jun | 2 Jun | |
| Agong's Birthday | that day only | | |
| Hari Raya Haji | −1 | +3 | |
| Awal Muharram | that day only | | |
| Merdeka season (Bulan Kebangsaan) | 1 Aug | 16 Sep | flag. Big on 31 Aug and 16 Sep |
| Maulidur Rasul | that day only | | |
| Deepavali | −3 | +3 | |
| Christmas | 20 Dec | 26 Dec | |

## When two seasons overlap

1. **Holiday days beat lingering days.** A season on its own holiday day(s) wins over another season's linger.
2. **Ramadan is never overridden by a party look.**
   - If CNY, Thaipusam or anything else falls inside Ramadan, show that season's own calm props.
   - No party mood, no confetti, no food items while it is Ramadan.
   - The greeting may name both seasons.
3. **Known combined seasons get one combined look and greeting.** They come back in some years:
   - Raya and CNY in the same window: "Kongsi Raya".
   - Raya and Deepavali: "Deepa Raya".
   - Merdeka season and another holiday: the other holiday's look plus a small flag.
4. **National beats state.**
   - Kaamatan (Sabah) and Gawai (Sarawak) show only on days with no national holiday.
   - On a shared day (for example Agong's Birthday on 1 Jun with Gawai), Kira wears a neutral festive look, and the greeting says "Happy holidays" plus each name.
   - The app doesn't know the user's state, so never pick one state's festival over another.
5. **Otherwise, the season whose first day is nearest wins.** On a tie, use the order above.

## Greetings (one line, the app's language)

- **One greeting per season, shown once per device**, on Home. Dismissible. Stored per device, like the other once-only cards.
- **Every greeting has English, Malay and Chinese rows.** Use the customary forms:
  - Raya: "Selamat Hari Raya Aidilfitri, Maaf Zahir Batin" stays in Malay in every language. It is how Malaysians say it.
  - CNY:
    - EN: "Happy Chinese New Year"
    - MS: "Selamat Tahun Baru Cina"
    - ZH: "新年快乐，恭喜发财"
  - Deepavali:
    - EN: "Happy Deepavali"
    - MS: "Selamat Hari Deepavali"
    - ZH: "屠妖节快乐"
  - Christmas:
    - EN: "Merry Christmas"
    - MS: "Selamat Hari Krismas"
    - ZH: "圣诞快乐"
  - Merdeka:
    - EN: "Happy Merdeka"
    - MS: "Selamat Hari Merdeka"
    - ZH: "国庆日快乐"
  - Malaysia Day:
    - EN: "Happy Malaysia Day"
    - MS: "Selamat Hari Malaysia"
    - ZH: "马来西亚日快乐"
  - Wesak:
    - EN: "Happy Wesak Day"
    - MS: "Selamat Hari Wesak"
    - ZH: "卫塞节快乐"
  - Thaipusam:
    - EN: "Happy Thaipusam"
    - MS: "Selamat Hari Thaipusam"
    - ZH: "大宝森节快乐"
  - Haji:
    - EN/MS: "Selamat Hari Raya Aidiladha"
    - ZH: "哈芝节快乐"
  - Awal Muharram: "Salam Maal Hijrah"
  - Ramadan:
    - EN/MS: "Salam Ramadan"
    - ZH: "斋戒月快乐" (check this one)
  - Kaamatan: "Kotobian Tadau Tagazo do Kaamatan"
  - Gawai: "Selamat Hari Gawai, Gayu Guru Gerai Nyamai"
  - Agong: "Daulat Tuanku"
  - Maulidur Rasul: "Salam Maulidur Rasul"
- **Native review before release.** Flag every Chinese line and every festival phrase in the PR for the owner to have a native speaker check. Never machine-guess a religious phrase. When unsure, use the plain "Happy <name>" form.

## Respect

- Props are decorative and sit beside or on top of Kira's head or hand:
  - lantern, ketupat, mandarin orange, ang pao
  - diya, kolam pattern, lotus
  - songkok, crescent and star
  - flag, Santa hat, party hat, beads
- No sacred symbols drawn on Kira's face or body, and no jokes about religion.
- Kira is never shown eating or drinking during Ramadan.
- Haji and Muharram: calm looks only.

## Dates

- `app/kira-seasons.js` holds the table for 2026–2028, from the verified list (scratchpad `my-holidays.json`), marking which are gazetted and which are expected.
- After 2028:
  - Islamic dates come from `Intl.DateTimeFormat` with `islamic-umalqura`.
  - CNY comes from the `chinese` calendar.
  - Fixed dates are computed.
  - Thaipusam, Wesak and Deepavali have no fallback, so those seasons are skipped until the table is updated.
  - An e2e check fails a year before the table runs out.
- Settings: "Festive Kira" switch (on by default; device-only like the theme).
