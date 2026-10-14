//
//  payload.js
//  ksmail-watcher
//
//  What one new message becomes on a lock screen, and what the app gets to act on. The shape is a CONTRACT with every ksMail client and is written down in docs/PROTOCOL.md; changing a key here without changing it there breaks the notification actions on a device that is already installed.
//
//  The alert is laid out the way Mail and Gmail lay theirs out, and the order is not decoration: sender, then subject, then a line of the message. The account name is deliberately NOT in it. It used to take the subtitle, which is the second bold line, and it was the one thing on that lock screen the reader already knew; the notifications are still grouped per account by thread-id, and a tap still opens that account's mailbox.
//
//  How much of that is sent is a configuration choice, notifications.preview:
//    full       sender, subject, and a preview of the text (default)
//    subject    sender and subject
//    senderOnly sender alone
//  Anything below "full" is enforced where the body is FETCHED, not here (see ../imap/monitor.js): the watcher does not ask a server for a body it has been told not to show.
//
//  The payload also carries content-available, which asks the system to wake the APP as well as show the banner: the message is then in the list before the reader taps, and a notification button acts on a row that is already there. It is a request, never a promise.
//
//  What used to be the APNs headers (how long the alert is worth showing, which earlier alert it replaces) is now a pair of fields the broker turns into those headers: newMailDelivery and watcherAlertDelivery below. The broker adds the rest, which is not the watcher's to choose (docs/PROTOCOL.md, "The broker").
//
//  Two deliberate absences:
//  - no badge. The device knows what its owner has already read, the Pi does not, and a badge from here would fight the app's own count.
//  - no localized text. Every string in the payload comes from the message or from the configuration, so the watcher never has to know which language the phone is in. The one alert that has to say something of its own (buildWatcherAlertPayload) says it with loc-key, and the phone does the translating.
//

export const PAYLOAD_VERSION = 1;
export const NOTIFICATION_CATEGORY = "NEW_MAIL";

// Why the watcher stopped watching an account, when it has to say so on the account's own devices (buildWatcherAlertPayload). The code is what a client acts on; the sentence is what the SYSTEM shows, through loc-key, so the phone's own language wins on a phone that knows the sentence and English is what an older client shows instead of nothing.
export const WATCHER_ALERT_REASONS = {
  oauthExpired: {
    locKey: "ksMail watcher can no longer access this account: its authorization has expired. Run “ksmail-watcher oauth” again for it, then restart the watcher.",
  },
  loginRefused: {
    locKey: "ksMail watcher can no longer sign in to this account: the server refused its password. Fix the watcher configuration, then restart it.",
  },
};
const WATCHER_ALERT_TITLE_LOC_KEY = "Push notifications stopped";
// A broken account stays broken until someone acts: this alert is worth showing a day later, where a mail alert is not.
const WATCHER_ALERT_EXPIRATION_SECONDS = 24 * 3600;

// APNs refuses a payload over 4 KB, and so does the broker, before it gets that far. Nothing here comes close once the two texts are cut, and cutting them is what keeps that true for a subject written by someone else.
const MAX_TITLE = 120;
const MAX_BODY = 400;
const MAX_COLLAPSE_ID = 64;

function truncate(value, limit) {
  if (!value) {
    return "";
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/// How a sender is named on the lock screen: the display name when there is one, the address otherwise. Never both, there is no room.
export function senderTitle(from) {
  if (!from) {
    return "";
  }
  return truncate(from.name || from.address || "", MAX_TITLE);
}

/// See the header for what each preview level puts on the lock screen.
export function buildNewMailPayload({ account, message, sound = "default", preview = "full" }) {
  const title = senderTitle(message.from);

  const alert = { title: title || account.displayName };
  const subject = preview === "senderOnly" ? "" : truncate(message.subject, MAX_TITLE);
  if (subject) {
    alert.subtitle = subject;
  }
  const body = preview === "full" ? truncate(message.preview, MAX_BODY) : "";
  if (body) {
    alert.body = body;
  }

  const payload = {
    aps: {
      alert,
      sound,
      // One notification stack per account, like Mail does.
      "thread-id": account.id,
      category: NOTIFICATION_CATEGORY,
      // Lets a future notification service extension in the app enrich the alert (a sender picture, a localized "no subject") without the watcher ever having to change.
      "mutable-content": 1,
      // Asks the system to hand this push to the APP as well as to the reader, so ksMail can fetch the message while the banner is still on screen. Without it the app hears of the message only when the notification is tapped, and the tap then waits on an IMAP connection before it can show anything.
      //
      // The system grants that wake-up at its own discretion (never when Background App Refresh is off), so it is an improvement and never a guarantee: the app pulls for itself on the tap.
      "content-available": 1,
    },
    ksmail: {
      v: PAYLOAD_VERSION,
      kind: "newMessage",
      account: { id: account.id, address: account.address },
      mailbox: message.mailbox,
      uid: message.uid,
      uidValidity: message.uidValidity,
      messageId: message.messageId ?? null,
      date: message.date ? message.date.toISOString() : null,
      from: message.from
        ? { name: message.from.name ?? null, address: message.from.address ?? null }
        : null,
    },
  };
  return payload;
}

/// Cut to a number of BYTES, which is how Apple counts a collapse id: an account id with an accent in it is longer than it looks.
function truncateBytes(text, limit) {
  const encoder = new TextEncoder();
  let result = text;
  while (encoder.encode(result).length > limit) {
    result = result.slice(0, -1);
  }
  return result;
}

/// How the broker is to deliver a new mail alert.
export function newMailDelivery({ account, message, expirationSeconds }) {
  return {
    // The same message pushed twice (a retry, a reconnection that replayed one UID) replaces the first notification instead of stacking a second one.
    collapseId: truncateBytes(`${account.id}.${message.uid}`, MAX_COLLAPSE_ID),
    // A mail alert that shows up six hours late is noise, not information.
    expiresIn: expirationSeconds,
  };
}

/// The payload of "ksmail-watcher test-push": everything the real one carries, so a device that shows this one will show a real message.
export function buildTestPayload({ account, text = "ksmail-watcher test" }) {
  return {
    aps: {
      alert: { title: account.displayName, body: text },
      sound: "default",
      "thread-id": account.id,
      category: NOTIFICATION_CATEGORY,
      "mutable-content": 1,
    },
    ksmail: {
      v: PAYLOAD_VERSION,
      kind: "test",
      account: { id: account.id, address: account.address },
      mailbox: "INBOX",
      uid: 0,
      uidValidity: 0,
      messageId: null,
      date: new Date().toISOString(),
      from: null,
    },
  };
}

/// What the owner sees when the watcher has given up on one of their accounts: an alert on the devices paired for THAT account, and on no other. Without it, a dead refresh token is a silence that looks exactly like a quiet week, which is how it went unnoticed once.
///
/// No category, so no mail buttons on it; no content-available, there is no message to fetch. The text goes as loc-key rather than body: the watcher does not know which language the phone is in, and the key is a full English sentence so a client without the translation still shows something readable.
export function buildWatcherAlertPayload({ account, reason }) {
  const definition = WATCHER_ALERT_REASONS[reason];
  if (!definition) {
    throw new Error(`unknown watcher alert reason ${reason}`);
  }
  return {
    aps: {
      alert: {
        "title-loc-key": WATCHER_ALERT_TITLE_LOC_KEY,
        subtitle: truncate(account.displayName, MAX_TITLE),
        "loc-key": definition.locKey,
      },
      sound: "default",
      "thread-id": account.id,
    },
    ksmail: {
      v: PAYLOAD_VERSION,
      kind: "watcherAlert",
      account: { id: account.id, address: account.address },
      reason,
    },
  };
}

export function watcherAlertDelivery({ account }) {
  return {
    // One alert per account on the lock screen, however many times the watcher restarts into the same broken account.
    collapseId: truncateBytes(`${account.id}.watcher-alert`, MAX_COLLAPSE_ID),
    expiresIn: WATCHER_ALERT_EXPIRATION_SECONDS,
  };
}
