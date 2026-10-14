//
//  snippet.test.js
//  ksmail-watcher
//
//  The preview is built from a TRUNCATED slice of somebody else's MIME, and every way it can go wrong is visible on a lock screen: a body that previews as base64, as a stylesheet, as "=E9", or as the sender's "Sent from my iPhone". None of that would fail a test that only checked "some text came out", so each of those is one here.
//
//  What is NOT tested here, because it is not this file's promise: that the preview matches the app's to the character. The app has the whole part and a real MIME parser; this has a prefix.
//

import assert from "node:assert/strict";
import test from "node:test";

import {
  abridge,
  bodyPreview,
  wantsLongerRead,
  DEEP_PREFIX_BYTES,
  MAX_SNIPPET,
  PREFIX_BYTES,
} from "../src/imap/snippet.js";

const crlf = (text) => text.replace(/\n/g, "\r\n");

test("a plain body with no part headers reads as itself", () => {
  const preview = bodyPreview(Buffer.from(crlf("Bonjour,\nvoici la facture.\n"), "utf8"));
  assert.equal(preview, "Bonjour, voici la facture.");
});

test("nothing to read gives nothing, not a broken preview", () => {
  assert.equal(bodyPreview(Buffer.alloc(0)), "");
  assert.equal(bodyPreview(null), "");
});

test("a base64 body is decoded rather than shown as its encoding", () => {
  const encoded = Buffer.from("Le dimanche, c'est la flemme.", "utf8").toString("base64");
  // Wrapped at 76 like a real transfer, and with no headers of its own: that is what BODY[TEXT] gives for a message that is not multipart.
  const preview = bodyPreview(Buffer.from(crlf(`${encoded}\n`), "utf8"));
  assert.equal(preview, "Le dimanche, c'est la flemme.");
});

/// Wrapped at 76, the LAST line holds what was left over, and it can be one group of four. The shape is a reply from an Android phone (text/html, base64, not multipart) whose tail line was 24 characters long: the preview came out as the encoding itself.
test("a wrapped base64 body is decoded whatever its last line's length", () => {
  const html =
    "<div dir='auto'>Bonsoir Thierry,<div dir=\"auto\">Y aura-t-il un lien " +
    "pour la visio ?</div><div dir=\"auto\">Je ne pourrai pas être là.</div>" +
    "<div dir=\"auto\">Loïc&nbsp;</div></div>";
  const encoded = Buffer.from(html, "utf8").toString("base64");
  const lines = encoded.match(/.{1,76}/g);
  assert.ok(lines.length > 1 && lines.at(-1).length < 40, lines.at(-1));
  const preview = bodyPreview(Buffer.from(crlf(`${lines.join("\n")}\n`), "utf8"));
  assert.equal(
    preview,
    "Bonsoir Thierry, Y aura-t-il un lien pour la visio ? Je ne pourrai pas être là. Loïc",
  );
});

/// Same body, but the slice stopped a few characters into a line.
test("a wrapped base64 body cut early in a line is still decoded", () => {
  const encoded = Buffer.from(
    "Votre commande numero 4218 est expediee. Elle arrivera jeudi, avant midi.",
    "utf8",
  ).toString("base64");
  const lines = encoded.match(/.{1,76}/g);
  const cut = `${lines[0]}\n${lines[1].slice(0, 6)}`;
  const preview = bodyPreview(Buffer.from(crlf(cut), "utf8"));
  assert.ok(preview.startsWith("Votre commande numero 4218"), preview);
});

/// The prefix stops mid stream, so the last quantum is incomplete. A naive decode returns garbage for the WHOLE body, not just the tail.
test("a base64 body cut mid quantum still decodes what came before", () => {
  const full = Buffer.from(
    "Votre commande numero 4218 est expediee. Elle arrivera jeudi.",
    "utf8",
  ).toString("base64");
  const cut = full.slice(0, full.length - 3);
  const preview = bodyPreview(Buffer.from(crlf(`${cut}\n`), "utf8"));
  assert.ok(preview.startsWith("Votre commande numero 4218"), preview);
});

test("a quoted-printable body comes back with its accents", () => {
  const body = crlf(
    "Content-Type: text/plain; charset=utf-8\n" +
      "Content-Transfer-Encoding: quoted-printable\n" +
      "\n" +
      "R=C3=A9union d=C3=A9cal=C3=A9e =C3=A0 10h.\n",
  );
  const message = crlf("--frontier\n") + body + crlf("--frontier--\n");
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "Réunion décalée à 10h.");
});

test("a body in iso-8859-1 is not mistaken for utf-8", () => {
  const head = crlf(
    "--frontier\nContent-Type: text/plain; charset=iso-8859-1\n\n",
  );
  const message = Buffer.concat([
    Buffer.from(head, "latin1"),
    Buffer.from("Facture réglée", "latin1"),
    Buffer.from(crlf("\n--frontier--\n"), "latin1"),
  ]);
  assert.equal(bodyPreview(message), "Facture réglée");
});

/// The prefix cuts where it lands, and one time in three that is INSIDE a UTF-8 character: the escape is whole, the character it starts is not. A strict decode then fails the whole part and Latin-1, which never fails, reads every accent before the cut as mojibake. The shape is a HoYoverse verification code (text/html, quoted-printable, not multipart, so no part headers and a guessed charset), whose slice ended on "=C3=A9t=C3" and was announced as "vÃ©rification".
test("a body cut inside a character keeps every accent before the cut", () => {
  const body = crlf(
    "<html><body><div>[HoYoverse]Code de v=C3=A9rification</div>\n" +
      "<div>Cher utilisateur/Ch=C3=A8re utilisatrice,</div>\n" +
      "<div>Cet e-mail a =C3=A9t=C3",
  );
  assert.equal(
    bodyPreview(Buffer.from(body, "latin1")),
    "[HoYoverse]Code de vérification Cher utilisateur/Chère utilisatrice, Cet e-mail a ét",
  );
});

/// Same cut with nothing to undo first: raw UTF-8 bytes, the charset guess on its own.
test("an eight bit body cut inside a character keeps its accents too", () => {
  const message = Buffer.concat([
    Buffer.from("Bonjour, la réunion est décalée à 10h. Merci d'être ", "utf8"),
    // The first byte of "à"; the slice ends before the second one.
    Buffer.from([0xc3]),
  ]);
  assert.equal(bodyPreview(message), "Bonjour, la réunion est décalée à 10h. Merci d'être");
});

/// The rendition the READER will be shown is the html one, so that is what the preview quotes. On an ordinary message the two say the same thing, which is what this holds; where they differ, see the courtesy line test below.
test("the preview quotes the rendition the reader will be shown", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "La reunion est a 10h.\n" +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><body><p>La reunion est a 10h.</p></body></html>\n" +
      "--alt--\n",
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "La reunion est a 10h.");
});

/// An html only message previews as its own stylesheet unless the markup is taken out, which is most commercial mail.
test("an html only message previews as words, not as markup", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><head><style>.a{color:red}</style></head><body>" +
      "<div>Mon identifiant&nbsp;: C8EST9845</div><br><p>Mes couronnes : 185</p>" +
      "</body></html>\n" +
      "--alt--\n",
  );
  const preview = bodyPreview(Buffer.from(message, "utf8"));
  assert.equal(preview, "Mon identifiant : C8EST9845 Mes couronnes : 185");
});

/// The bug this file was written for and still missed: the prefix ends INSIDE the stylesheet, so </style> never arrives, and a stripper that waits for it hands the lock screen "@font-face { ...".
test("a stylesheet the prefix cuts through is still not the preview", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><head><style>\n" +
      "/** Google webfonts. Recommended to include the .woff version. */\n" +
      "@media screen { @font-face { font-family: 'Sans'; src: url(a.woff);",
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "");
});

test("a comment the prefix cuts through is not the preview either", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><body><div>Bonjour</div><!--[if mso]><table><tr><td>",
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "Bonjour");
});

/// What the bigger prefix buys: the text of a template whose head is longer than the two kilobytes this used to read.
test("the read is long enough to get past a template's stylesheet", () => {
  const filler = "  .row-inner { padding: 0 16px; border: 0 none; }\n".repeat(120);
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      `<html><head><style>\n${filler}</style></head><body>` +
      "<div>4 nouveaux styles d'image a essayer</div></body></html>\n",
  );
  assert.ok(message.length > 2048 && message.length < PREFIX_BYTES, message.length);
  assert.equal(
    bodyPreview(Buffer.from(message, "utf8")),
    "4 nouveaux styles d'image a essayer",
  );
});

/// The real Journal du Net newsletter, which is what this rule was written for: its text/plain part is two courtesy lines and nothing else, so previewing it announced "if you cannot read this message" over an article. Gmail showed the headline for the same message.
test("a courtesy line is not a body, so the html says what the message is", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Si vous ne parvenez pas a lire ce message ==> https://exemple.fr/nl/1\n" +
      "Pour ne plus recevoir nos messages ==> https://exemple.fr/nl/unsub\n" +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><body><div>AI Act : les 7 regles a respecter</div></body></html>\n" +
      "--alt--\n",
  );
  assert.equal(
    bodyPreview(Buffer.from(message, "utf8")),
    "AI Act : les 7 regles a respecter",
  );
});

/// The other half of the same rule: with no html to fall back on, the links ARE the message and dropping them would leave nothing.
test("a message that is only links keeps them when nothing else is offered", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "https://exemple.fr/photos/1\n" +
      "--alt--\n",
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "https://exemple.fr/photos/1");
});

/// The second sender to arrive, Cdiscount, escaped the rule that was written for the first: its note is a rule of dashes, a sentence and ONE link on a line of its own. Which is why nothing tries to recognize these notes any more.
test("a note made of dashes and one link is not the preview either", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "--------------------------------------------------\n" +
      "Pour visualiser ce message au format html, cliquez ici :\n" +
      " http://exemple.fr/r/?id=t54da6c21\n" +
      "ou copiez le lien dans votre navigateur Web\n" +
      "--------------------------------------------------\n" +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><body><div>Top depart des French Days</div></body></html>\n" +
      "--alt--\n",
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "Top depart des French Days");
});

/// When the html cannot be rendered from what was read, the text part is all there is, whatever it says, and a courtesy line beats an empty notification body. It must not STAY, though: this is exactly the slice that asks for the second read, like the app's (deepTextPrefixBytes), and the question is asked of the parts, not of the preview, which is not empty.
test("an unreadable html part falls back to the text part, and asks for more", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Version en ligne ==> https://exemple.fr/nl/1\n" +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><head><style>.a{color:red}",
  );
  assert.equal(
    bodyPreview(Buffer.from(message, "utf8")),
    "Version en ligne ==> https://exemple.fr/nl/1",
  );
  assert.equal(wantsLongerRead(Buffer.from(message, "utf8")), true);
});

/// The real Journal du Geek newsletter (Mailchimp), and the case the second read was written for. Its text part is not a courtesy line, it is 22 KB of articles and tracking links, and it comes FIRST: the html part's <body> lands at 34 KB of TEXT, past the slice, so the notification announced "Voir cet email dans votre navigateur (https://...)" and two URLs where Gmail showed the headline. The slice holds the html part, stopped in its <head>, which is what says a longer read would do better; glued to the next slice, the same extraction gives the headline.
test("a long text part pushes the html past the slice, and the second read reaches it", () => {
  const articles = "Lire l'article -> https://exemple.fr/track/click?u=5d1996e209836e7d96d01e9a4&id=4f26e8d072\n".repeat(230);
  const stylesheet = "  .mcnTextContent { padding: 0 18px; line-height: 150%; }\n".repeat(220);
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Voir cet email dans votre navigateur (https://exemple.fr/archive?e=22e63494aa)\n" +
      `${articles}` +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      `<html><head><style>\n${stylesheet}</style></head><body>` +
      "<span>Les dernieres infos sur le Journal du Geek</span>" +
      "<h1>Oubliez l'iPhone Duo, Apple pourrait creer l'iPhone Duo Max</h1></body></html>\n" +
      "--alt--\n",
  );
  const bytes = Buffer.from(message, "utf8");
  const bodyAt = bytes.indexOf("<body>");
  assert.ok(bodyAt > PREFIX_BYTES && bytes.length < DEEP_PREFIX_BYTES, `${bodyAt} ${bytes.length}`);

  const first = bytes.subarray(0, PREFIX_BYTES);
  assert.ok(bodyPreview(first).startsWith("Voir cet email dans votre navigateur"), bodyPreview(first));
  assert.equal(wantsLongerRead(first), true);

  const glued = Buffer.concat([first, bytes.subarray(PREFIX_BYTES, DEEP_PREFIX_BYTES)]);
  assert.equal(wantsLongerRead(glued), false);
  assert.equal(
    bodyPreview(glued),
    "Les dernieres infos sur le Journal du Geek Oubliez l'iPhone Duo, Apple pourrait creer l'iPhone Duo Max",
  );
});

/// The same newsletter, seen from a slice that stops INSIDE its text part: no html part in sight yet, and no way to tell from the text whether one follows. It costs one read to find out, and that is the right side to be wrong on.
test("a slice that ends inside the text part of a multipart asks for more", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Voir cet email dans votre navigateur (https://exemple.fr/archive?e=22e63494aa)\n" +
      "Lire l'article -> https://exemple.fr/track/click?id=4f26e8d0",
  );
  assert.equal(wantsLongerRead(Buffer.from(message, "utf8")), true);

  // Nested the way a newsletter with an attachment comes: the text part is one level down, and the slice ends inside it all the same.
  const nested = crlf(
    "--mixed\n" +
      'Content-Type: multipart/alternative; boundary="alt"\n\n' +
      "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Voir cet email dans votre navigateur (https://exemple.fr/archive?e=22e63494aa)\n" +
      "Lire l'article -> https://exemple.fr/track/click?id=4f26e8d0",
  );
  assert.equal(wantsLongerRead(Buffer.from(nested, "utf8")), true);
});

/// What must NOT ask for a second read, because each of these is the common case and the read would be paid for nothing: a message whose html rendered, a text message the slice holds entirely, a text message followed by an attachment the slice cut through, and a plain body that is not multipart at all. The one shape that is not multipart and still asks is html stopped in its <head>.
test("a slice that already holds what the reader will see asks for nothing more", () => {
  const rendered = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Version en ligne ==> https://exemple.fr/nl/1\n" +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><body><div>AI Act : les 7 regles a respecter</div></body></html>\n" +
      "--alt--\n",
  );
  assert.equal(wantsLongerRead(Buffer.from(rendered, "utf8")), false);

  const whole = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "On se voit demain.\n" +
      "--alt--\n",
  );
  assert.equal(wantsLongerRead(Buffer.from(whole, "utf8")), false);

  const attached = crlf(
    "--mixed\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Voici la photo.\n" +
      "--mixed\n" +
      "Content-Type: image/jpeg; name=\"photo.jpg\"\n" +
      "Content-Transfer-Encoding: base64\n\n" +
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8Q",
  );
  assert.equal(wantsLongerRead(Buffer.from(attached, "utf8")), false);

  assert.equal(wantsLongerRead(Buffer.from(crlf("Bonjour,\nvoici la facture.\n"), "utf8")), false);
  assert.equal(wantsLongerRead(Buffer.alloc(0)), false);
  assert.equal(
    wantsLongerRead(Buffer.from("<html><head><style>.a{color:red}", "utf8")),
    true,
  );
});

/// "15&euro; offerts d&egrave;s 129&euro;" is not a preview. The latin-1 set is what commercial mail writes its accents with.
test("named entities are read as the letters they stand for", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      "<html><body><div>15&euro; offerts d&egrave;s 129&euro; &agrave; No&Euml;l" +
      " &mdash; caf&eacute; &times; 2 &foo;</div></body></html>\n",
  );
  assert.equal(
    bodyPreview(Buffer.from(message, "utf8")),
    "15€ offerts dès 129€ à NoËl — café × 2 &foo;",
  );
});

/// A preheader is padded with hundreds of invisible characters so that the line a client shows stops at the offer. Kept, they ARE the preview: one sentence, then two hundred blanks.
test("the invisible padding of a preheader is not the preview", () => {
  const padding = "\u034f \u200b \u00ad ".repeat(80);
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      `<html><body><div>15 euros offerts${padding}</div><div>Les promos</div>` +
      "</body></html>\n",
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "15 euros offerts Les promos");
});

/// What the bigger read buys, measured on a real Cdiscount template: its <body> sits at 17 KB, behind conditional comments, web fonts and inline CSS. Sixteen kilobytes came back all <head>.
test("the read clears a head of seventeen kilobytes", () => {
  const filler = "  .row { padding: 0 16px; border: 0 none; font-size: 13px; }\n".repeat(
    290,
  );
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      `<html><head><style>\n${filler}</style></head><body>` +
      "<div>15 euros offerts des 129 euros</div></body></html>\n",
  );
  assert.ok(message.length > 17000 && message.length < PREFIX_BYTES, message.length);
  assert.equal(
    bodyPreview(Buffer.from(message.slice(0, PREFIX_BYTES), "utf8")),
    "15 euros offerts des 129 euros",
  );
});

/// A prefix can stop anywhere, tag included. Without the trailing tag rule the preview ended on a raw '<a href="https://...'.
test("a prefix that stops inside a tag shows words, not the tag", () => {
  const message = crlf(
    "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      '<html><body><div>Edition du jour</div><a href="https://exemple.fr/nl/link?c=2vjbq',
  );
  assert.equal(bodyPreview(Buffer.from(message, "utf8")), "Edition du jour");
});

test("the preview stops at the signature", () => {
  const withDelimiter = bodyPreview(
    Buffer.from(crlf("On se voit demain.\n\n-- \nJean Dupont\n06 12 34 56 78\n"), "utf8"),
  );
  assert.equal(withDelimiter, "On se voit demain.");

  const withOpener = bodyPreview(
    Buffer.from(crlf("Merci !\n\nEnvoyé de mon iPhone\n"), "utf8"),
  );
  assert.equal(withOpener, "Merci !");
});

/// A message that is nothing but a signature still deserves a preview: better its signature than an empty line under the subject.
test("a message that is only a signature keeps it", () => {
  const preview = bodyPreview(Buffer.from(crlf("Envoyé de mon iPhone\n"), "utf8"));
  assert.equal(preview, "Envoyé de mon iPhone");
});

test("a long body is cut on a word and says that it was cut", () => {
  const body = "Le dimanche c'est la flemme et ".repeat(40);
  const preview = bodyPreview(Buffer.from(body, "utf8"));
  assert.ok(preview.length <= MAX_SNIPPET, preview.length);
  assert.ok(preview.endsWith("…"), preview);
  assert.ok(!preview.slice(0, -1).endsWith(" "), preview);
});

test("abridging never leaves punctuation hanging in front of the ellipsis", () => {
  assert.equal(abridge("un deux, trois", 11), "un deux…");
  assert.equal(abridge("court", 20), "court");
});

/// One word longer than the cap is better cut through than reduced to whatever came before it (a URL, a blob no parser caught).
test("a single very long word is cut through rather than dropped", () => {
  const preview = abridge(`voir ${"a".repeat(60)}`, 20);
  assert.equal(preview.length, 20);
  assert.ok(preview.startsWith("voir aaa"), preview);
});
