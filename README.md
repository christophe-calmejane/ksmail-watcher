# ksmail-watcher

Instant push notifications for [ksMail](https://kikisoft.com/ksMail/), the mail app for iPhone, iPad and Mac, from a small machine of yours that stays on.

ksMail talks to your mail servers directly, with no server of its own in between. That is good for your privacy, and it means nothing can wake your iPhone the moment a message arrives: iOS lets the app check for new mail now and then, never instantly. The watcher fills that gap. It keeps an **IMAP IDLE** connection open to each mailbox you choose, and as soon as a message lands it sends your devices a notification, **end-to-end encrypted**, through the ksMail push broker.

It is built for a Raspberry Pi, and runs anywhere Node.js 20 or later runs.

```
 your mail server ──IMAP IDLE──► ksmail-watcher ──HTTPS, sealed──► ksMail broker ──► Apple ──► iPhone, iPad, Mac
                                  (your machine)                     (no key to read it)         └ ksMail opens the seal
```

## Privacy, in short

- **It runs on your hardware.** Your mail passwords and OAuth tokens stay in its configuration file, on your machine. Never give your credentials to someone else's watcher, including the author's.
- **Every notification is sealed for each device** (AES-256-GCM) with a key that only that device and your watcher hold. The broker that relays it and Apple that delivers it see a generic "New Message", the time and the size; the sender, the subject and the preview are opened on your device.
- **The broker is the publisher's, and holds no mail.** It is run by the publisher of ksMail, on Cloudflare, at `https://ksmail-broker.kikisoft.com`, because it alone holds Apple's push key for the app. It knows each device by its push token and installation secret, and relays sealed notifications it cannot open. What it keeps is in [ksMail's privacy policy](https://kikisoft.com/ksMail/privacy-policy.html).
- **It reads almost nothing.** The envelope of a new message (sender, subject, date) and, for the preview, the first 32 KB of its text (64 KB for a newsletter whose first 32 KB never reach the part you would read). No attachment, no image, nothing else. With `"preview": "subject"` it does not even ask the server for the text.
- **It changes nothing.** Mailboxes are opened read-only (`EXAMINE`) and text is fetched with `BODY.PEEK`: nothing is marked as read, ever.
- **It stores nothing private.** One state file with UID marks and OAuth refresh tokens. No subject, no sender, no body, on disk or in its logs.
- **No inbound port.** Every connection is outgoing: IMAP to your servers, HTTPS to the broker. There is nothing to open on your router.
- **No dependency.** Node.js alone, not one npm package. Nothing to compile on ARM, nothing to patch when a dependency has a hole, and the whole code base reads in an evening.

What travels, field by field, is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## What you need

- A machine that stays on: a Raspberry Pi 3, 4 or 5 (Raspberry Pi OS 64-bit recommended), or any Linux box, with Node.js 20 or later or Docker.
- [ksMail](https://kikisoft.com/ksMail/) on each device that should ring, with **Settings › Push Notifications › Receive Notifications from a Watcher** turned on.
- For each mail account: its password (an app password for iCloud, and for Gmail if you prefer it to OAuth), or an OAuth client for Gmail and Outlook ([below](#gmail-and-outlook-oauth)).

## Install on a Raspberry Pi

```sh
sudo apt install -y git
git clone https://github.com/christophe-calmejane/ksmail-watcher.git
cd ksmail-watcher
sudo ./scripts/install.sh --install-node
```

`--install-node` installs Node.js 22 from nodejs.org (checksum verified) when the system has no Node.js 20 or later, which is the case of a fresh Raspberry Pi OS. Without it the script uses the Node.js already there.

The script installs the watcher as a systemd service:

| Where | What |
| --- | --- |
| `/opt/ksmail-watcher` | The code, replaced at every update. |
| `/etc/ksmail-watcher/config.json` | Your configuration, created from [config.example.json](config.example.json) the first time and never touched again. Readable by the service user only. |
| `/var/lib/ksmail-watcher` | The state file. |
| `ksmail` | A system user with no shell and no password; the service runs as it. |
| `ksmail-watcher` | A command in `/usr/local/bin` that runs the watcher as that user, with that configuration. |

It does not start the service while the configuration still holds the example's placeholders. Next:

1. **Link your devices** (next section): one `ksmail-watcher add-device` per device, nothing to type.
2. **Add your mail accounts**: `sudo nano /etc/ksmail-watcher/config.json`, the `accounts` section ([reference](#accounts)).
3. Check everything: `ksmail-watcher doctor`.
4. Start: `sudo systemctl start ksmail-watcher`, and watch it with `journalctl -u ksmail-watcher -f`.
5. Send yourself a test: `ksmail-watcher test-push`.

Update later with `./scripts/update.sh` (pulls, reinstalls, restarts; your configuration and state are kept). Remove it with `sudo ./scripts/uninstall.sh`, or `--purge` to delete the configuration, the state and the user too.

## Link your devices

Nothing is typed by hand: ksMail hands the watcher one line, and one command puts it in the configuration.

1. On the device, in ksMail: **Settings › Push Notifications › Receive Notifications from a Watcher**. The app registers with the broker.
2. Still there, get the line to the machine that runs the watcher, whichever way is easiest:
   - **Send to the Watcher…** opens the share sheet: mail it to yourself, AirDrop it to your Mac, send it by Messages, put it in Notes. Works from any computer, Windows and Linux included.
   - **Copy the Watcher Command** copies it, and on a Mac signed in to the same Apple Account, Universal Clipboard lets you paste it straight into the terminal where you are connected to the Pi.
3. On the watcher's machine, run the line as it came (with Docker, once the command is installed: [Running with Docker](#running-with-docker)):

   ```sh
   ksmail-watcher add-device ksmw1.eyJicm9rZXIiOiJodHRwczovL2tz…
   ```

   or run `ksmail-watcher add-device` alone and paste when it asks: the whole message ksMail sent can be pasted, the code is found in it.

The configuration already names the broker of the App Store ksMail, so there is no address to find. The command adds the device under its model's name (`iPhone`, `iPad`, `Mac`; `--name "Dad's iPhone"` for another), replaces the example's placeholders, asks the broker whether it knows the device, and tells you to restart the watcher. Sharing the same device again updates its entry. A second device of the same model gets a question: replace the first (ksMail was reinstalled on it) or keep both.

What it writes, should you prefer to edit by hand (ksMail shows the three values too, each copied with one tap):

```json
"broker": {
  "url": "https://ksmail-broker.kikisoft.com",
  "devices": {
    "iPhone": {
      "installationSecret": "Q1PXY-R6HAV-ANVEE-83269-J4ZZ2",
      "encryptionKey": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    }
  }
}
```

The name is yours: the log and `doctor` use it, the broker never sees it. A device that never turns the option on sends nothing to the broker and leaves no trace anywhere. Turning it off, or reinstalling ksMail, makes a new secret and a new key: share the line again.

**The line is a secret.** Its installation secret lets a watcher ask the broker for notifications on that device (it cannot move the device's registration elsewhere), and its encryption key reads what a watcher sends. AirDrop and Universal Clipboard leave no copy behind; a mail or a message does, so delete it once the device is added. In the configuration, it sits next to your mail passwords, in a file only the service user can read.

### One watcher for a household

Each account says which devices it goes to; without a list, it goes to all of them:

```json
{
  "broker": {
    "url": "https://ksmail-broker.kikisoft.com",
    "devices": {
      "dad-iphone": { "installationSecret": "…", "encryptionKey": "…" },
      "dad-mac":    { "installationSecret": "…", "encryptionKey": "…" },
      "mum-iphone": { "installationSecret": "…", "encryptionKey": "…" }
    }
  },
  "accounts": [
    { "id": "dad",    "address": "dad@…",  "devices": ["dad-iphone", "dad-mac"], … },
    { "id": "mum",    "address": "mum@…",  "devices": ["mum-iphone"], … },
    { "id": "shared", "address": "home@…", … }
  ]
}
```

`shared` rings everywhere, and everyone else gets their own mail only. A device name that `broker.devices` does not list stops the watcher at startup, naming it.

## Configuration

One JSON file: `/etc/ksmail-watcher/config.json` with the installer, or `$KSMAIL_WATCHER_CONFIG`, or `--config <path>`. Relative paths in it are resolved against the file's own folder. The watcher validates it at startup and refuses to start with a sentence naming the field, rather than run for a month without ever delivering anything.

### `broker`

| Field | Default | Meaning |
| --- | --- | --- |
| `url` | `https://ksmail-broker.kikisoft.com` | The broker of the App Store ksMail. Change it only for a build of ksMail that registers with a broker of its own: `add-device` then sets it from the first device. `https://` only, except to this very machine (`http://127.0.0.1:8787`, a broker under development). |
| `devices` | required | `{ "name": { "installationSecret", "encryptionKey" } }`, at least one, as ksMail copies them. Dashes and case in the secret do not matter. Two names with the same secret are refused (the device would get everything twice). |

### `notifications`

Optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `preview` | `full` | What the lock screen shows, and so what the watcher reads on the server. `full`: sender, subject and a line of the message. `subject`: sender and subject; the text is never fetched. `senderOnly`: the sender alone. |
| `expirationSeconds` | `3600` | How long Apple keeps trying to deliver. A mail alert six hours late is noise. The broker caps it at a day. |
| `sound` | `default` | |

### `accounts`

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Short and stable: the key in the state file, and what groups the notifications of one account. |
| `address` | required | **The account's address. This is how ksMail finds the account a notification is about**, compared without case. |
| `displayName` | `id` | Used in the log, and in the alert that says the watcher gave up on this account. |
| `host`, `port`, `tls` | `993`, `true` | The IMAP server. |
| `username` | `address` | When the login is not the address. |
| `auth` | required | `{ "type": "password", "password": "…" }`, or `{ "type": "oauth", "provider": "google" \| "microsoft", "clientId": "…", "clientSecret": "…" }`. The refresh token does not go here: `ksmail-watcher oauth --account <id>` stores it in the state file. |
| `mailboxes` | `["INBOX"]` | One IDLE connection per mailbox. An accented name can be written plainly (`INBOX.Indésirables`) or as the server spells it (`INBOX.Ind&AOk-sirables`). |
| `devices` | all | The names, in `broker.devices`, of the devices this account goes to. An empty list is refused: to stop an account, set `enabled` to `false`. |
| `enabled` | `true` | `false` sets the account aside without deleting it. |

### Safeguards

| Field | Default | Meaning |
| --- | --- | --- |
| `maxCatchUpPerMailbox` | `5` | Back from an outage, at most this many notifications per mailbox: the latest ones. |
| `catchUpMaxAgeHours` | `12` | A message older than this was filed, not received: it wakes nobody. |
| `pollSeconds` | `120` | Fallback period for a server without IDLE (none of the usual ones). |
| `stateFile` | `state/state.json` | UID marks and OAuth refresh tokens. The installer sets it to `/var/lib/ksmail-watcher/state.json`. |
| `logLevel` | `info` | `debug` adds every IMAP command, never any content. |

## Commands

```sh
ksmail-watcher run                 # the service
ksmail-watcher add-device [code]   # adds a device from the line ksMail shares (asks for it when not given)
ksmail-watcher doctor              # checks the broker, every device and every mailbox, then exits
ksmail-watcher test-push           # sends a notification that looks like a real one
ksmail-watcher oauth --account gmail --manual    # a new refresh token for a configured account
ksmail-watcher oauth google --client-id … --client-secret …   # day one, before the account exists
```

`doctor` is the first thing to run when nothing arrives: it tells which leg is broken. Does the broker answer; does it know each device in `broker.devices` (asked as a dry run, nothing shows on any screen); and can each mailbox be opened. `test-push` then sends a real, sealed notification to the devices of an account (`--account <id>`, the first one otherwise).

## Gmail and Outlook (OAuth)

The watcher signs in to IMAP on its own, so it needs its own OAuth client, **in a project of yours**, never the one of the published ksMail app.

| Provider | What to create |
| --- | --- |
| Gmail | In the Google Cloud console: enable the Gmail API, create an OAuth client of type **Desktop app**, put its id and secret in `auth`. Then **publish the consent screen** (APIs & Services › OAuth consent screen › Publish app): a project left in *Testing* gets refresh tokens that expire after **seven days**. The "unverified app" warning shown at consent is normal for a personal project and does not affect the token. Or skip OAuth entirely with an **app password** (needs 2-step verification on the account) and `"type": "password"`: paste it as Google shows it, the spaces are dropped. |
| Outlook / Microsoft 365 | In Azure (Microsoft Entra), register an application of type **Mobile and desktop applications** with the redirect URI `http://localhost:8765/`, and put its id in `auth` (no secret). Microsoft rotates the refresh token at every refresh: the watcher keeps the new one in its state file, which must therefore survive restarts. |
| iCloud | No OAuth: an **app-specific password** from [account.apple.com](https://account.apple.com). |

Then, once the account is in the configuration:

```sh
ksmail-watcher oauth --account gmail --manual
sudo systemctl restart ksmail-watcher
```

The token goes to the state file, not to the configuration. Without `--manual`, the command listens on `127.0.0.1:8765` for the browser's redirect, which works when you run it on a machine with a browser, or through `ssh -L 8765:127.0.0.1:8765 pi`. With `--manual`, nothing listens: after authorizing, the browser lands on `http://127.0.0.1:8765/?state=…&code=…` and says it **cannot connect**. That is expected; copy that whole URL from the address bar and paste it into the terminal. It is the only form that works in a Docker container.

## Running with Docker

```sh
git clone https://github.com/christophe-calmejane/ksmail-watcher.git
cd ksmail-watcher
docker compose build
sudo ./scripts/install-docker-command.sh   # the ksmail-watcher command, as with a systemd install
ksmail-watcher add-device                  # once per device: paste what ksMail sent
sudo nano config/config.json               # your mail accounts
ksmail-watcher doctor
docker compose up -d
docker compose logs -f
```

`install-docker-command.sh` creates `config/config.json` from the example when there is none, gives `config/` and `state/` to uid 1000 (the user the container runs as, and the cause of a "permission denied" otherwise), and installs `/usr/local/bin/ksmail-watcher`. That command runs `add-device`, `doctor`, `test-push` and `oauth` in a throwaway container, with the configuration folder mounted writable: the line ksMail shares works as it is, and nothing has to be typed around it. The service itself only ever mounts the configuration read only, which is why `docker compose run --rm ksmail-watcher add-device` alone answers that the file is read only. `sudo ./scripts/install-docker-command.sh --remove` takes the command away.

The container publishes no port, runs as the unprivileged `node` user, mounts `config/` read-only and writes only to `state/`. After a `git pull`, run `docker compose build` first: `run` and `restart` use the image as it is. After a change to the configuration, `docker compose restart`.

## When something goes wrong

| The log says | It means |
| --- | --- |
| `session ended, reconnecting in=Ns` | An ordinary disconnection. The delay doubles up to five minutes, with some randomness. |
| `the server refused this account for good` | Wrong password. The account is set aside until the service restarts (retrying a wrong password every few seconds gets accounts locked); the others carry on, and that account's devices receive a "Push notifications stopped" notification. |
| `the refresh token is dead` | Run `ksmail-watcher oauth --account <id>` and restart. If it happens a week after the last `oauth` on Gmail, your consent screen is still in *Testing* (see above). |
| `the OAuth client of this account is refused` (`deleted_client`, `invalid_client`) | The client in `auth` was deleted or its secret changed: a new token from the same client will not help. Create a new client ([above](#gmail-and-outlook-oauth)), put its id and secret in `auth`, run `ksmail-watcher oauth --account <id>` and restart; or, for Gmail, switch the account to an app password. |
| `add-device`: `is mounted read only` or `cannot be written` | With Docker: run it through the `ksmail-watcher` command ([Running with Docker](#running-with-docker)), which mounts the configuration writable and gives it to the container's user. |
| `the broker knows no device under this secret` | The broker answered 401: a secret mistyped, the option turned off in ksMail, or ksMail reinstalled (new secret). Compare with what the app shows. Said once an hour per device. |
| `device dropped` | Apple says ksMail is gone from that device; the broker forgot it. Nothing to do: it registers again the next time ksMail opens there. |
| `the broker refused: too many notifications` | More than the broker's hourly limit for one device (60 by default), which protects a device whose secret leaked. That notification is lost, not delayed. |
| `the broker does not answer` | At startup, the broker is unreachable. The watcher starts anyway and tries again with every message. |
| `more mail than one screen holds` | Back from an outage: only the latest messages were pushed. |

A notification that arrives saying only **"New Message"** was sealed with a key the device does not have (an encryption key from a previous install of ksMail: copy the entry again), or reached a phone that has not been unlocked since it restarted (normal: unlock it, and a tap opens the message).

Nothing private is written to the log: no subject, no sender, no password, no secret. A message is named by its account and UID, a device by its name in `broker.devices`.

## Footprint

About **55 MB of RAM** at rest, never more than 80 MB, including the return from a long outage with thousands of messages waiting. The `still here` log line reports `residentMB` every six hours. The systemd unit and the Compose file put a ceiling well above that (320 MB), so that a runaway becomes a restart rather than a frozen Pi. Why the watcher is careful about memory is in [docs/DESIGN.md](docs/DESIGN.md#memory).

## Development

```sh
npm test        # Node 20 or later, no network, no real account
```

The tests run a fake IMAP server (with IDLE and literals) and a fake broker, and check the whole chain: a message delivered to the fake server comes out as a sealed notification at the fake broker, with the right secret, and opens into the right payload.

| Folder | Contents |
| --- | --- |
| `src/imap/` | Stream reading (literals included), response parsing, the connection, and `monitor.js`, which holds every rule about what deserves a notification. |
| `src/push/` | The payload, the seal, the broker client, and the notifier that sends each message to the devices of its account. |
| `src/commands/` | The five commands. |
| `docs/` | [PROTOCOL.md](docs/PROTOCOL.md): what goes over the wire. [DESIGN.md](docs/DESIGN.md): the rules and why. |
| `scripts/` | Install, update and uninstall on a systemd machine, and the `ksmail-watcher` command for a Docker one. |

The payload and the seal are a contract with the ksMail app: changing a key or the sealing format breaks notifications on devices already installed. [docs/PROTOCOL.md](docs/PROTOCOL.md) says which parts are pinned by test vectors on both sides.

## License

[MIT](LICENSE). The app itself, its privacy policy and its support page are at [kikisoft.com/ksMail](https://kikisoft.com/ksMail/). "ksMail" is the name of the app this watcher serves; a fork is welcome to the code, and should pick a name of its own.
