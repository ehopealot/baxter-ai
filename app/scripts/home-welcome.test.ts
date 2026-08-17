// Tests for home-welcome: the member-welcome command path (shape guard, template rendering,
// subject split, phone formatting) and sendMemberWelcome's gate/render/send with a fake transport.
// No network, no fs dependency in the unit tests (templates are injected); one test exercises the
// real shipped template via loadWelcomeTemplates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMemberWelcomeCommand, renderTemplate, parseSubjectAndBody, formatPhoneDisplay,
  sendMemberWelcome, loadWelcomeTemplates, loadMemberWelcomeTemplates,
  titleCaseHousehold, formatNameList, prettyMemberName,
} from "./home-welcome.ts";
import type { WelcomeContext, WelcomeSender } from "./home-welcome.ts";

// ---- shape guard ----

test("isMemberWelcomeCommand accepts email+optional name, rejects wrong kind / non-string email", () => {
  assert.equal(isMemberWelcomeCommand({ kind: "member-welcome", email: "a@b.com", name: "Sam" }), true);
  assert.equal(isMemberWelcomeCommand({ kind: "member-welcome", email: "a@b.com" }), true); // name absent -> ok
  assert.equal(isMemberWelcomeCommand({ kind: "member-welcome", email: "a@b.com", name: 5 }), false); // name non-string
  assert.equal(isMemberWelcomeCommand({ kind: "sort-list", email: "a@b.com" }), false); // wrong kind
  assert.equal(isMemberWelcomeCommand({ kind: "member-welcome", email: 5 }), false); // email non-string
  assert.equal(isMemberWelcomeCommand(null), false);
});

// ---- rendering ----

test("renderTemplate substitutes, HTML-escapes when asked, and blanks unknown placeholders", () => {
  const tpl = "Hi {{name}} at {{home_url}} — {{missing}}";
  assert.equal(renderTemplate(tpl, { name: "Sam", home_url: "https://h" }, false), "Hi Sam at https://h — ");
  // A member nickname is free-form family input; the html render must escape it.
  assert.equal(
    renderTemplate("<b>{{name}}</b>", { name: `a<b>&"'` }, true),
    "<b>a&lt;b&gt;&amp;&quot;&#39;</b>",
  );
  // The raw (text) render leaves it untouched.
  assert.equal(renderTemplate("{{name}}", { name: "a<b>" }, false), "a<b>");
});

test("parseSubjectAndBody splits the leading Subject: line and trims the blank lines after it", () => {
  const { subject, body } = parseSubjectAndBody("Subject: I'm all set up\n\n\nHi {{name}},\n");
  assert.equal(subject, "I'm all set up");
  assert.equal(body, "Hi {{name}},\n");
  // No Subject line -> a sane default and the body verbatim.
  const none = parseSubjectAndBody("Hi there\n");
  assert.equal(none.subject, "Baxter is set up");
  assert.equal(none.body, "Hi there\n");
});

test("formatPhoneDisplay groups a US E.164 and passes anything else through", () => {
  assert.equal(formatPhoneDisplay("+15551234567"), "+1 (555) 123-4567");
  assert.equal(formatPhoneDisplay("+442079460000"), "+442079460000"); // non-US -> verbatim
  assert.equal(formatPhoneDisplay(""), "");
});

test("titleCaseHousehold title-cases the address slug", () => {
  assert.equal(titleCaseHousehold("hope-family"), "Hope Family");
  assert.equal(titleCaseHousehold("smiths"), "Smiths");
  assert.equal(titleCaseHousehold("the_rivera_household"), "The Rivera Household");
  assert.equal(titleCaseHousehold(""), ""); // nothing to case
});

test("formatNameList joins with an Oxford comma and drops blanks", () => {
  assert.equal(formatNameList([]), "");
  assert.equal(formatNameList(["Erik"]), "Erik");
  assert.equal(formatNameList(["Erik", "Jane"]), "Erik and Jane");
  assert.equal(formatNameList(["Erik", "Jane", "Sam"]), "Erik, Jane, and Sam");
  assert.equal(formatNameList(["", "Jane"]), "Jane");
});

test("prettyMemberName derives a readable name from an email local-part", () => {
  assert.equal(prettyMemberName("erik.hope@x.com"), "Erik Hope");
  assert.equal(prettyMemberName("jane_doe@x.com"), "Jane Doe");
  assert.equal(prettyMemberName("jsmith@x.com"), "Jsmith");
});

// ---- sendMemberWelcome ----

function capturingSender(): { sender: WelcomeSender; sent: Array<{ from: string; to: string; subject: string; html: string; text: string }> } {
  const sent: Array<{ from: string; to: string; subject: string; html: string; text: string }> = [];
  return { sender: async (msg) => { sent.push(msg); }, sent };
}

const TEMPLATES = {
  html: `<p>Hi {{name}}</p><a href="mailto:{{assistant_email}}">{{assistant_email}}</a> household {{household}} <a href="sms:{{assistant_phone_e164}}">{{assistant_phone}}</a><a href="{{home_url}}">home</a> <span>{{household_members}}</span>`,
  text: `Subject: I'm all set up\n\nHi {{name}}, household {{household}}, email {{assistant_email}}, text {{assistant_phone}} ({{assistant_phone_e164}}), {{home_url}} -- {{household_members}}\n`,
};

function ctx(over: Partial<WelcomeContext> = {}): WelcomeContext {
  return {
    from: "smiths@assistant.bax.bot",
    phoneE164: "+15551234567",
    homeUrl: "https://home.bax.bot",
    isAllowedRecipient: () => true,
    loadTemplates: () => TEMPLATES,
    ...over,
  };
}

const noLog = (_m: string) => {};

test("sendMemberWelcome renders from the household address and substitutes every var", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome({ kind: "member-welcome", email: "sam@ex.com", name: "Sam" }, ctx(), sender, noLog, noLog);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.from, "Baxter <smiths@assistant.bax.bot>");
  assert.equal(m.to, "sam@ex.com");
  assert.equal(m.subject, "I'm all set up");
  // household from the local-part of BAXTER_EMAIL; the mailto is the FULL send address; phone; url.
  assert.match(m.html, /Hi Sam/);
  assert.match(m.html, /mailto:smiths@assistant\.bax\.bot/);
  assert.match(m.html, /sms:\+15551234567/);
  assert.match(m.html, /\+1 \(555\) 123-4567/);
  assert.match(m.html, /href="https:\/\/home\.bax\.bot"/);
  assert.match(m.text, /household Smiths, email smiths@assistant\.bax\.bot, text \+1 \(555\) 123-4567 \(\+15551234567\), https:\/\/home\.bax\.bot/);
  assert.doesNotMatch(m.text, /Subject:/); // subject line stripped from the text body
});

test("sendMemberWelcome renders the REAL send domain, not a hardcoded one", async () => {
  const { sender, sent } = capturingSender();
  // A tenant whose RESEND_DOMAIN isn't assistant.bax.bot -- the mailto/display must follow `from`.
  await sendMemberWelcome({ kind: "member-welcome", email: "sam@ex.com", name: "Sam" }, ctx({ from: "acme@mail.example.com" }), sender, noLog, noLog);
  assert.equal(sent[0].from, "Baxter <acme@mail.example.com>");
  assert.match(sent[0].html, /mailto:acme@mail\.example\.com/);
  assert.doesNotMatch(sent[0].html, /assistant\.bax\.bot/);
});

test("sendMemberWelcome greets 'there' when no name is supplied", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome({ kind: "member-welcome", email: "sam@ex.com" }, ctx(), sender, noLog, noLog);
  assert.match(sent[0].html, /Hi there/);
});

test("sendMemberWelcome drops a non-member recipient (containment) without sending", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "stranger@ex.com" },
    ctx({ isAllowedRecipient: () => false }), sender, noLog, noLog,
  );
  assert.equal(sent.length, 0);
});

test("sendMemberWelcome skips (no throw) a malformed payload or a missing BAXTER_EMAIL", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome({ kind: "sort-list" }, ctx(), sender, noLog, noLog); // wrong kind
  await sendMemberWelcome({ kind: "member-welcome", email: "sam@ex.com" }, ctx({ from: "" }), sender, noLog, noLog);
  assert.equal(sent.length, 0);
});

test("sendMemberWelcome swallows and logs a transport failure", async () => {
  const errs: string[] = [];
  const throwing: WelcomeSender = async () => { throw new Error("HTTP 500"); };
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com", name: "Sam" }, ctx(), throwing, noLog, (m) => errs.push(m),
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /member-welcome command failed: HTTP 500/);
});

test("the shipped welcome template renders with no leftover {{placeholders}} and an escaped name", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com", name: `Sam & "Mimi"` },
    ctx({ loadTemplates: () => loadWelcomeTemplates() }), sender, noLog, noLog,
  );
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].html, /\{\{\w+\}\}/); // every placeholder substituted
  assert.doesNotMatch(sent[0].text, /\{\{\w+\}\}/);
  assert.match(sent[0].html, /Sam &amp; &quot;Mimi&quot;/); // free-form name escaped in the html
  assert.match(sent[0].html, /mailto:smiths@assistant\.bax\.bot/); // real send address, not a hardcoded one
  assert.equal(sent[0].subject, "I'm all set up");
});

test("sendMemberWelcome lists the other members by name and excludes the new recipient", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com", name: "Sam" },
    ctx({ roster: () => ({
      recipients: ["erik@x.com", "jane@x.com", "sam@ex.com"],
      names: { "erik@x.com": "Erik", "jane@x.com": "Jane", "sam@ex.com": "Sam" },
    }) }),
    sender, noLog, noLog,
  );
  // household_members is the OTHER two, Oxford-comma-joined; the new recipient (Sam) is never in it
  // (if he were, it would read "Erik, Jane, and Sam").
  assert.match(sent[0].text, /-- Erik and Jane\n/);
});

test("sendMemberWelcome falls back to an email-derived name for an unnamed member", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com" },
    ctx({ roster: () => ({ recipients: ["erik.hope@x.com", "sam@ex.com"], names: {} }) }),
    sender, noLog, noLog,
  );
  assert.match(sent[0].text, /-- Erik Hope\n/); // unnamed member -> prettified local-part
});

test("sendMemberWelcome skips phone entries in the roster (emails only, never bare digits)", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com", name: "Sam" },
    ctx({ roster: () => ({ recipients: ["+15559990000", "erik@x.com", "sam@ex.com"], names: { "erik@x.com": "Erik" } }) }),
    sender, noLog, noLog,
  );
  assert.match(sent[0].text, /-- Erik\n/);         // only the email member
  assert.doesNotMatch(sent[0].text, /5559990000/); // the phone recipient is never in the roster line
});

test("sendMemberWelcome falls back to 'the family' when there is no other member (no dangling 'joining .')", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com", name: "Sam" },
    ctx({ roster: () => ({ recipients: ["sam@ex.com"], names: {} }) }), // only the new member
    sender, noLog, noLog,
  );
  assert.match(sent[0].text, /-- the family\n/); // grammatical fallback, not "-- \n"
});

test("the shipped member-welcome template: added-you framing, roster line, real address, no leftover placeholders", async () => {
  const { sender, sent } = capturingSender();
  await sendMemberWelcome(
    { kind: "member-welcome", email: "sam@ex.com", name: `Sam & "Mimi"` },
    ctx({
      loadTemplates: () => loadMemberWelcomeTemplates(),
      roster: () => ({ recipients: ["erik@x.com", "sam@ex.com"], names: { "erik@x.com": "Erik" } }),
    }),
    sender, noLog, noLog,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "You've been added");
  assert.doesNotMatch(sent[0].html, /\{\{\w+\}\}/); // every placeholder substituted
  assert.doesNotMatch(sent[0].text, /\{\{\w+\}\}/);
  assert.match(sent[0].html, /You've been added to the/); // member framing...
  assert.doesNotMatch(sent[0].html, /set up as|ready whenever you are/); // ...not the owner copy
  assert.match(sent[0].text, /You're joining Erik\./); // the roster line (new member excluded)
  assert.match(sent[0].html, /Sam &amp; &quot;Mimi&quot;/); // free-form name escaped in the html
  assert.match(sent[0].html, /mailto:smiths@assistant\.bax\.bot/); // real send address
  assert.match(sent[0].html, /were added to a Baxter household/); // member footer, not "you set up"
});
