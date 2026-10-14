//
//  mailboxname.js
//  ksmail-watcher
//
//  Mailbox names do NOT travel as UTF-8. IMAP carries them in modified UTF-7 (RFC 3501 5.1.3), which is why Free.fr spells its junk folder "INBOX.Ind&AOk-sirables" on the wire. A watcher configured to watch "INBOX.Indésirables" and sending that name raw gets a NO from most servers and watches nothing, so the name is encoded here.
//
//  Encoding only: the watcher never displays a mailbox name, it only puts the ones from its configuration on the wire. The app has both directions (the ksMail app's IMAPMailboxName.swift).
//
//  The rule here is one line and it is deliberate: a name that is already pure ASCII goes through UNTOUCHED, ampersands included. Both spellings therefore work in the configuration, the readable one ("INBOX.Indésirables") and the one copied from a server listing ("INBOX.Ind&AOk-sirables"), and the second cannot be mangled by an encoder that would take its "&" for a literal one. The price is a mailbox whose real name contains an ampersand and nothing else unusual: it has to be written the way the server spells it, "Recus &- envoyes".
//

/// base64 of the UTF-16BE bytes, with "/" spelled "," and no padding.
function encodeRun(text) {
  const bytes = Buffer.from(text, "utf16le");
  // Node has no utf16be, so the pairs are swapped after the fact.
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const first = bytes[index];
    bytes[index] = bytes[index + 1];
    bytes[index + 1] = first;
  }
  return bytes.toString("base64").replace(/=+$/, "").replace(/\//g, ",");
}

export function encodeMailboxName(name) {
  if (!/[^\x20-\x7e]/.test(name)) {
    return name;
  }

  let result = "";
  let run = "";

  const flush = () => {
    if (run !== "") {
      result += `&${encodeRun(run)}-`;
      run = "";
    }
  };

  for (const character of name) {
    const code = character.codePointAt(0);
    if (code === 0x26) {
      // An ampersand is the shift character, so a literal one is "&-".
      flush();
      result += "&-";
    } else if (code >= 0x20 && code <= 0x7e) {
      flush();
      result += character;
    } else {
      run += character;
    }
  }
  flush();
  return result;
}
