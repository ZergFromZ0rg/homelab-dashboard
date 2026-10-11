# DNS and latency/loss history

## DNS (Network → DNS → History)

Pi-hole keeps every query in its long-term database (91 days by default,
`database.maxDBdays`), so nothing is stored by the dashboard: it asks Pi-hole for ten-minute
buckets over the range, folds them into the step the range needs and keeps the answer for a
minute. Ranges: 24 h, 7 d, 30 d, 90 d.

- **Queries per hour** and the **blocked share**, as two charts. A point is always queries per
  hour, so a day and a month are on one scale, and a slot only part-covered (the current one,
  or a gap where Pi-hole was down) is worked out from the buckets it really has, not drawn as a dip.
- Totals for the range, and the **most asked**, **most blocked** and **busiest devices**. Devices
  carry the name you gave them, not Pi-hole's reverse lookup.
- Pi-hole's database only goes back to when it was set up. A range longer than that says how
  much it really has ("Pi-hole has 3 days of history so far") and fills in over time.
- "Most blocked" counts names Pi-hole refuses on purpose (iCloud Private Relay, the Firefox
  canary domain), which is most of a typical household's blocking.

`GET /api/pihole/history?range=` serves it.

## Latency and loss per check

Each check keeps hourly buckets for **90 days** (was 30): uptime, latency (with a histogram for
percentiles), and, for a ping that sends several echoes (`count` above 1), **packet loss** and
**jitter**. Before this, loss and jitter lasted three hours.

- Open a check's history (the chart icon on its row): ranges 3 h, 24 h, 7 d, 30 d, 90 d, with
  latency, loss and jitter charts on a shared time axis. Loss and jitter appear only for checks
  that measure them.
- Loss and jitter history starts from the day this was deployed; latency and uptime already had
  their history, now kept three times as long.
- The check history file is written every 5 minutes instead of every minute (it is a few MB at
  90 days); a normal shutdown still saves it immediately.
