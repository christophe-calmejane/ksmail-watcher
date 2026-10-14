# The rules, and why

Each rule here was paid for once. They are written down so that nobody pays for them twice.

## What deserves a notification

The watcher remembers, per mailbox, the highest UID it has already announced. Everything follows from that.

| Situation | What the watcher does | Why |
| --- | --- | --- |
| First time a mailbox is seen | Takes the current top as its starting point, pushes NOTHING | Otherwise installing it on a Sunday evening sends two hundred notifications for mail already read. |
| `UIDVALIDITY` changed | Forgets everything, starts again from the top, pushes nothing | The UIDs it remembers no longer name the same messages. |
| A message arrived, unread, recent | Pushes | The normal case. |
| Already `\Seen` | Does not push, moves the mark | It was read on another device while the push was on its way. |
| `\Deleted` or `\Draft` | Does not push, moves the mark | |
| `INTERNALDATE` older than 12 hours | Does not push, moves the mark | It was filed into the mailbox by another client, not received now. |
| Back from an outage, 200 messages | Pushes the last 5, logs how many were skipped | Between "nothing" and "two hundred", the honest answer is "the latest". |
| Password refused, or OAuth refresh token dead | Gives the mailbox up until the next restart, sends the "Push notifications stopped" alert to that account's devices, **carries on** with the other accounts | Retrying a wrong password every few seconds gets an account locked; and staying silent is the one failure its owner cannot see. |

The two caps (5 messages, 12 hours) are settings, not constants of the protocol.

**The process stays up whatever happens to its mailboxes.** An earlier version let Node exit cleanly once the last mailbox had given up; Docker read that as an invitation to restart it, and the log filled with the same two lines every ten seconds for a week, with no device any the wiser. Now the `still here` line reports `givenUpMailboxes`, and a dead account says so on the phone.

## What the watcher does not do

- **No badge.** The device knows what its owner has read; the watcher does not. A number pushed from here would fight the app's own count.
- **No rules, no tags, no blocked senders.** They live in the app. A message a rule files elsewhere will still have rung; the app applies its rules as soon as the push makes it fetch the message.
- **No mailbox you did not list.** `INBOX` alone by default.
- **No retraction.** A banner for a message read or deleted elsewhere is taken back by the app at its next pass, not by the watcher.

## Previews

The preview is one line of the part of the message the reader will see, which is not always the `text/plain` part.

- **32 KB, not 2.** A newsletter opens on a style sheet longer than 2 KB, and a short read comes back entirely inside `<head>`, with nothing to say. The number was measured on real templates, one of which puts its `<body>` at 17 KB.
- **A second slice, only when needed.** A `multipart/alternative` carries its text part first, and some are 22 KB of links on their own: the first 32 KB then end before the HTML part says anything. When the first slice did not reach what the reader will see (the HTML part is there but stops in its `<head>`, or the slice ends in the text part with no HTML part in sight), the next 32 KB of the same body are read and glued to it. A slice shorter than asked for is the whole message and needs nothing more. Beyond 64 KB, the preview falls back on the text part.
- **The level is enforced when reading, not when showing.** Below `full`, no `FETCH` mentions a body at all; a test checks the commands the server receives, not the payload.
- **What is shown is cut**: 120 characters of subject, 400 of body, on a word. The bytes it was cut from are never stored.

The rules mirror the ones the ksMail app uses for its own message list, so that a notification and the list say the same thing.

## Memory

On a Raspberry Pi 4 with 1 GB:

| Situation | Resident memory |
| --- | --- |
| At rest, one mailbox in IDLE | about 55 MB |
| After a few hundred messages pushed one by one | about 75 MB |
| Back from a long outage, 2,000 messages waiting | about 80 MB |

Most of that is Node itself; the watcher's heap stays under 10 MB.

It once took a third of the Pi, and never gave it back. Not a leak: the command that discovered what had arrived also asked for every preview:

```
UID FETCH 1234:* (UID FLAGS INTERNALDATE ENVELOPE BODY.PEEK[TEXT]<0.32768>)
```

That command answers for **every** message above the mark, and how many there are depends on how long the watcher was off, not on what it does with them. 2,000 waiting messages meant 64 MB of bodies read and parsed, to push five. Measured: 108 MB for 300 waiting messages, 190 MB for 1,000, 324 MB for 2,000, and Node rarely hands memory back to the system.

**The rule: the command that discovers what arrived never carries a body.** Bodies are asked for afterwards, by UID, for the messages that will be pushed and for no others:

```
UID FETCH 1234:* (UID FLAGS INTERNALDATE ENVELOPE)
UID FETCH 2046,2047,2048,2049,2050 (UID BODY.PEEK[TEXT]<0.32768>)
```

The cost of previews is then proportional to what is pushed, never to what was waiting. A test checks it: "a burst is read for its headers, and only the pushed messages cost a body".

Two smaller fixes of the same family, things that grew with time rather than with work: the untagged lines of an IDLE (which lasts up to 24 minutes) are no longer kept until `DONE`, and the abort listeners of the reconnection waits are removed once used.

And two guards that fix nothing but keep a future slip from taking the machine down: the `still here` line logs `residentMB` every six hours (four a day is a trend, and a trend tells a leak from a busy morning), and both the systemd unit (`MemoryHigh=192M`, `MemoryMax=320M`) and the Compose file (`mem_limit: 256m`) cap it at three times what it needs. Raise them rather than remove them: a cap is what turns "the watcher ate the Pi" into "the watcher restarted".

**When the Pi is full anyway**, `top` misleads: since Node 20, every Node process shows as `MainThread` (Node names its main thread `node-MainThread`, which is what Linux keeps as the command name). Several `MainThread` lines are several Node processes, not several watchers.

```sh
ps -eo pid,rss,etime,cmd --sort=-rss | head -15
docker stats --no-stream
systemctl status ksmail-watcher
```

And do not install it both ways at once: the systemd install and the Docker one would be two watchers on the same mailboxes, and every notification twice.

## What survives a restart

One file, `state.json`:

- the UID mark (`uidValidity` and `lastUid`) of each mailbox;
- the current refresh token of each OAuth account: the one `ksmail-watcher oauth --account` wrote there, and the one Microsoft rotates at every refresh. The state file always wins over the configuration, and a write by the watcher adopts a newer token found on disk rather than overwriting it, because the `oauth` command writes there while the watcher runs.

Losing it breaks nothing: the watcher starts again from the top of each mailbox, at the price of silence about what arrived while it was down.
