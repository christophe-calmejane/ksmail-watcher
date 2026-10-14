# Security

The watcher holds mail credentials, so a flaw in it matters. If you find one, please report it privately through GitHub's **Report a vulnerability** button (Security tab of this repository) rather than in a public issue. You will get an answer, and credit if you want it.

Worth knowing before you report:

- The configuration file holds your mail passwords or OAuth refresh tokens, and your devices' installation secrets and encryption keys. Its protection is the file system's: the installer makes it readable by the service user only.
- An installation secret lets its holder ask the broker for notifications on that device, within the broker's hourly limit. It cannot move the device's registration, nor read anything.
- An encryption key reads what the watcher sends to that device. It never leaves the device and this configuration.
- The broker and Apple see a generic alert, its time and its size, and the device it is for; never the sender, the subject or the text.
