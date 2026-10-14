# What goes over the wire

Everything the watcher sends, to whom, and what each party can read. The payload and the seal are a **contract with the ksMail app**: a change here breaks notifications on devices already installed, so the parts that fail silently are pinned by test vectors on both sides.

```
watcher ──POST /notify──► ksMail broker ──HTTP/2──► Apple (APNs) ──► device
   │       { installationSecret,               │                        │
   │         payload (sealed),                 │                        └ ksMail's notification
   │         collapseId (hashed),              │                          service extension
   │         expiresIn }                       │                          opens the seal
   │                                           └ the only holder of the APNs key
   └ holds your mail credentials and, per device, a secret and a key
```

## 1. The notification, as the device shows it

The watcher builds one of two payloads, then seals it (section 2). This is what the device ends up with once the seal is open.

### A new message

```json
{
  "aps": {
    "alert": {
      "title": "Jean Dupont",
      "subtitle": "Monday's meeting",
      "body": "Hello, the meeting moves to 10am, room Vézère."
    },
    "sound": "default",
    "thread-id": "perso",
    "category": "NEW_MAIL",
    "mutable-content": 1,
    "content-available": 1
  },
  "ksmail": {
    "v": 1,
    "kind": "newMessage",
    "account": { "id": "perso", "address": "me@example.com" },
    "mailbox": "INBOX",
    "uid": 4567,
    "uidValidity": 42,
    "messageId": "<abc@example.org>",
    "date": "2026-09-05T10:34:56.000Z",
    "from": { "name": "Jean Dupont", "address": "jean@example.org" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `alert.title` | The sender's display name, or their address. Never both. |
| `alert.subtitle` | The subject, cut at 120 characters. Absent when there is none, and below the `subject` preview level. |
| `alert.body` | A line of the message, cut at 400 characters on a word. Only at the `full` level, and absent when nothing readable came out (an image-only message). Taken from the part the reader will see, not necessarily the text/plain one ([DESIGN.md](DESIGN.md#previews)). |
| `thread-id` | The account's `id`: one notification stack per account. |
| `category` | `NEW_MAIL`, which the app ties to its buttons (archive, delete, mark read, reply). |
| `content-available` | Asks the system to wake the app too, so the message is fetched while the banner is on screen. A request, never a promise. |
| `ksmail.account.address` | **The key the app finds its account by**, compared without case. Never `account.id`, which is a name chosen in this configuration. |
| `ksmail.uid` + `uidValidity` | The message in its mailbox. A different `uidValidity` means the server renumbered it. |
| `ksmail.messageId` | Matched first by the app: the one identifier that survives a renumbering, and the same under every Gmail label. |
| `ksmail.v` | Version of this block. An app that does not know it shows the notification and ignores the block. |

The account name is deliberately not in the alert: notifications are already grouped by account, and it took the second bold line to say what the reader knew.

### "Push notifications stopped"

When the watcher gives up on an account for good (password refused, OAuth refresh token dead), it tells that account's devices, once per account and per run:

```json
{
  "aps": {
    "alert": {
      "title-loc-key": "Push notifications stopped",
      "subtitle": "Personal",
      "loc-key": "ksMail watcher can no longer access this account: its authorization has expired. Run “ksmail-watcher oauth” again for it, then restart the watcher."
    },
    "sound": "default",
    "thread-id": "perso"
  },
  "ksmail": {
    "v": 1,
    "kind": "watcherAlert",
    "account": { "id": "perso", "address": "me@example.com" },
    "reason": "oauthExpired"
  }
}
```

The text travels as localization keys, which the device translates with the app's own catalog; the key is the full English sentence, so a device without the translation still shows something readable. `reason` is `oauthExpired` or `loginRefused` (`ksMail watcher can no longer sign in to this account: the server refused its password. Fix the watcher configuration, then restart it.`). No category and no `content-available`: there is no message to act on.

### Delivery

Two fields go with each payload, which the broker turns into APNs headers:

| Field | New message | Watcher alert |
| --- | --- | --- |
| `collapseId` | `<accountId>.<uid>`, cut to 64 bytes, then hashed (section 2) | `<accountId>.watcher-alert`, hashed |
| `expiresIn` | `notifications.expirationSeconds` (3600) | 86400 |

The same message pushed twice (a retry, a reconnection that replayed a UID) replaces its own banner instead of stacking a second one.

## 2. The seal

What names a message never travels in clear. For each device, the watcher seals it with that device's **encryption key**, and sends only what says nothing about anyone:

```json
{
  "aps": {
    "alert": { "title-loc-key": "New Message" },
    "sound": "default",
    "category": "NEW_MAIL",
    "mutable-content": 1,
    "content-available": 1
  },
  "ksmail": { "v": 2, "sealed": "<base64>" }
}
```

| In clear | Sealed |
| --- | --- |
| The alert's localization keys (`title-loc-key`, `loc-key`, …), or `"title-loc-key": "New Message"` when it has none; `sound`, `category`, `content-available`; `mutable-content: 1` always, which is what makes the device run the extension that opens the seal | The alert's texts (`title`, `subtitle`, `body`), `thread-id`, and the whole `ksmail` block, version 1, as in section 1 |

```
plain    = UTF-8 JSON { "alert": { texts }, "thread-id": …, "ksmail": { v1 block } }
sealed   = base64( nonce (12 random bytes) || ciphertext || tag (16 bytes) )
           AES-256-GCM, key = the device's 32-byte encryption key,
           additional data = UTF-8 "ksmail-sealed-notification:v2"
ksmail   = { "v": 2, "sealed": sealed }
collapse = the first 32 hex characters of HMAC-SHA256(key, "collapse:" + collapseId)
```

**Test vector**, asserted by [test/seal.test.js](../test/seal.test.js) and by the app: key = the bytes 0 to 31, nonce = the bytes 0 to 11, plain = `{"alert":{"title":"Jean Dupont","body":"Réunion à 10h"},"ksmail":{"v":1,"kind":"newMessage"}}` gives

```
AAECAwQFBgcICQoLPCC3d6CXtjm3OrX/2J0UCKHspX6VGjFcfBKV6nMdIp4jcsGY1uMouiZn1pjm7kdWzprArWvmy/hCuwhya46Uh5we/AHxpwRbLXiIBYbhasoCqKcHAS42G46c+alajcQ9Eq2LWoFBgbvnHjZckeO9
```

and `HMAC(key, "collapse:perso.4567")` gives `87aff8a720e6221fcd6773ff9891e54d`.

- **Size.** Sealing costs a third (base64) plus 28 bytes, and APNs refuses more than 4 KB. The watcher checks the sealed payload and, when it is too big, shortens the texts and seals again: the body first, then the subject, then the sender. The `ksmail` block is never cut; it is what the device acts on.
- **When the device cannot open it** (restarted and not unlocked yet, so its Keychain is closed; or a key from a previous install in this configuration), the banner is the generic title, translated by the system. A tap opens the app, which opens the seal itself once unlocked.
- **There is no clear mode.** A device without a key in the configuration is refused at startup.

## 3. The broker

The broker is a small service hosted once by the publisher of the app: the only holder of the APNs key, shared by every watcher. The App Store ksMail registers its devices with `https://ksmail-broker.kikisoft.com`, which is the watcher's default `broker.url`. The watcher uses two of its calls.

### `POST /notify`

```json
{
  "installationSecret": "Q1PXY-R6HAV-ANVEE-83269-J4ZZ2",
  "payload": { "aps": { … }, "ksmail": { "v": 2, "sealed": "…" } },
  "collapseId": "87aff8a720e6221fcd6773ff9891e54d",
  "expiresIn": 3600
}
```

| Answer | Meaning |
| --- | --- |
| `200` | Handed to Apple. |
| `400` | Malformed, or not the shape of a ksMail alert: only `aps` and `ksmail` at the top, only `alert` (required), `sound`, `thread-id`, `category`, `mutable-content` and `content-available` in `aps`, only Apple's text keys in `alert`. No badge, no silent push. |
| `401` | No device registered under this secret. |
| `410` | Apple says the app is gone from that device; the broker forgot it. The app registers again at its next launch, under the same secret. |
| `413` | The payload is over 4 KB. |
| `429` | A limit was reached: per IP address per minute, or per device per hour (60 by default). The notification is lost, not delayed. |
| `502` | Apple refused for another reason, given in `reason`. |

With `"dryRun": true` and no payload, it answers `200` (with the device's APNs environment and its last registration) or `401`, and sends nothing: that is what `doctor` asks.

The broker sets every APNs header itself: an alert at priority 10, an expiration capped at a day, the app's topic, and the collapse id given.

### `GET /health`

`{ "ok": true, "service": "ksmail-broker", "version": "1" }`.

### Device credentials

Both come from the app, which shows them under Settings › Push Notifications.

| Value | Format | What it can do |
| --- | --- | --- |
| `installationSecret` | 25 characters of Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), shown in five groups of five. Read upper-cased, anything but letters and digits dropped, `I` and `L` as `1`, `O` as `0`. | Ask the broker for a notification on that device. It is derived (SHA-256) from a registration secret the device keeps for itself, which is the only thing that can move the device's registration: a copy of this configuration cannot redirect your notifications to another phone. |
| `encryptionKey` | 32 bytes in base64url without padding (43 characters); plain base64 is accepted too. Never sent to the broker. | Seal notifications for that device. |

### The device code

So that nobody types a secret or a key, ksMail hands both over in one line, with the broker's address, through the share sheet or the clipboard:

```
ksmail-watcher add-device ksmw1.<base64url, no padding, of UTF-8 JSON>

{"broker":"https://…","encryptionKey":"<43 characters>","installationSecret":"<25 characters>","name":"iPhone"}
```

The app writes the keys sorted, slashes unescaped; the watcher reads any order, and finds the code (`ksmw1.` then letters, digits, `-` and `_`) anywhere in what is pasted. Nothing in it is a character a mail client, a messaging app or a shell would rewrite.

**Test vector**, asserted by [test/devicecode.test.js](../test/devicecode.test.js) and by the app: broker `https://ksmail-broker.example.workers.dev`, key = the bytes 0 to 31, secret `Q1PXYR6HAVANVEE83269J4ZZ2`, name `iPhone` give

```
ksmw1.eyJicm9rZXIiOiJodHRwczovL2tzbWFpbC1icm9rZXIuZXhhbXBsZS53b3JrZXJzLmRldiIsImVuY3J5cHRpb25LZXkiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4IiwiaW5zdGFsbGF0aW9uU2VjcmV0IjoiUTFQWFlSNkhBVkFOVkVFODMyNjlKNFpaMiIsIm5hbWUiOiJpUGhvbmUifQ
```

## 4. Who sees what

| | Your mail server | The watcher | The broker | Apple | Your device |
| --- | --- | --- | --- | --- | --- |
| Mail credentials | yes | yes | — | — | yes |
| Sender, subject, preview, address, Message-ID | yes | yes | — | — | yes |
| A generic "New Message" | — | — | yes | yes | yes |
| When, how big, for which device | — | yes | yes | yes | yes |
| The device's push token | — | — | yes | yes | yes |
| The device's encryption key | — | yes | — | — | yes |

The rhythm of your mail can be seen by the broker and by Apple; its content cannot.
