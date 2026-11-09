'use strict';
// `scripts/check-signup.js` is the only thing that can tell whether people can actually create an
// account, because that answer lives in app.ini on the host and nowhere in this repository.
//
// Its failure mode is the reason it exists: a Forgejo with registration disabled still serves
// `/user/sign_up` with `200 OK`, and the words "Registration is disabled" are printed *inside* that
// page. A status-code check would report a healthy instance while nobody can get in. So the script
// reads the form, and this file holds it to the three shapes that matter.
const fs = require('fs');
const path = require('path');
const { assessSignup } = require('../scripts/check-signup');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const OPEN_FORM = `<!DOCTYPE html><html><body>
<form action="/user/sign_up" method="post">
  <input type="hidden" name="_csrf" value="abc123">
  <input name="user_name" value="">
  <input name="email" value="">
  <input name="password" type="password">
  <img style="transform: scaleX(-1)" onclick="this.src='/captcha/rcjnLwE7hysaF4qEdZOJ.png?reload=1'">
  <button type="submit">Register Account</button>
</form></body></html>`;

const DISABLED = `<!DOCTYPE html><html><body>
<div class="ui warning message"><p>Registration is disabled. Please contact the site administrator.</p></div>
</body></html>`;

const LOGIN_PAGE = `<!DOCTYPE html><html><body>
<form action="/user/login" method="post"><input name="user_name"><input name="password"></form>
</body></html>`;

console.log('');
console.log('The three shapes a sign-up page can have:');
{
  const open = assessSignup(OPEN_FORM);
  ok(open.open === true, 'a real form is reported open');
  ok(open.captcha === true, 'with its captcha noticed');
  ok(open.fields.join(',') === 'user_name,email,password', 'and the fields it asks for', open.fields.join(','));

  const shut = assessSignup(DISABLED);
  ok(shut.open === false, 'a disabled page is reported shut');
  ok(/registration is disabled/i.test(shut.reason), 'and says why', shut.reason);
  ok(shut.fields.length === 0, 'with no fields invented', shut.fields.join(','));

  const login = assessSignup(LOGIN_PAGE);
  ok(login.open === false, 'a login page is not mistaken for a sign-up page');
  ok(/missing fields/.test(login.reason), 'because it lacks the fields a sign-up asks for', login.reason);
}

console.log('');
console.log('Degenerate input does not pass for a working form:');
{
  ok(assessSignup('').open === false, 'an empty body is not open');
  ok(assessSignup(null).open === false, 'null is not open');
  ok(assessSignup('<html></html>').open === false, 'an empty page is not open');
  const noCaptcha = assessSignup(OPEN_FORM.replace(/<img[^>]*captcha[^>]*>/, ''));
  ok(noCaptcha.open === true && noCaptcha.captcha === false, 'a form without a captcha is open but flagged', JSON.stringify({ open: noCaptcha.open, captcha: noCaptcha.captcha }));
  const thirdParty = assessSignup(OPEN_FORM.replace(/<img[^>]*captcha[^>]*>/, '<div class="h-captcha" data-sitekey="x"></div>'));
  ok(thirdParty.captcha === true, 'a third-party captcha widget counts as a captcha');
}

console.log('');
console.log('The script is wired into the repository, not just sitting in it:');
{
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ACCOUNTS.md'), 'utf8');
  ok(/check-signup\.js/.test(doc), 'ACCOUNTS.md tells people to run the check');
  ok(/DISABLE_REGISTRATION = false/.test(doc), 'and shows the setting that opens the form');
  ok(/DEFAULT_USER_IS_RESTRICTED/.test(doc), 'and warns about the knob that looks safer and is not');

  // The one instruction a person with no account actually needs, where they need it.
  const requesting = fs.readFileSync(path.join(__dirname, '..', 'docs', 'REQUESTING-HARDWARE.md'), 'utf8');
  ok(/user\/sign_up/.test(requesting), 'REQUESTING-HARDWARE.md links the sign-up page for people without an account');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
