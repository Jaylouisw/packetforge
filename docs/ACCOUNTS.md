# Accounts: who can sign up, and what a new account can do

Anyone can create an account at **<https://git.jayw.uk/user/sign_up>** and use it to open issues and
hardware requests on this instance. No invitation, no approval step.

That is deliberate: the issue tracker is how the catalogue grows, and a login wall with no door in it
turns every request into an email.

## What a new account can do

| | |
|---|---|
| Read every public repository | yes |
| Open issues, comment, react | yes |
| Open a pull request from a fork | yes |
| Create its own repositories | yes (a public forge expects this) |
| Create an organisation | **no** — `DEFAULT_ALLOW_CREATE_ORGANIZATION = false` |
| Read anything private | no |

Anonymous visitors are unchanged: the instance and the repository are readable without an account,
including `git clone`. Forgejo is the gate for writes, and it always was.

## The settings behind it

`/data/gitea/conf/app.ini` in the `forgejo` container:

```ini
[service]
DISABLE_REGISTRATION = false          ; the sign-up form is served
ENABLE_CAPTCHA = true                 ; built-in image captcha, no third-party service
CAPTCHA_TYPE = image
DEFAULT_USER_IS_RESTRICTED = false    ; see below - "true" looks safer and breaks the whole point
DEFAULT_ALLOW_CREATE_ORGANIZATION = false
REQUIRE_SIGNIN_VIEW = false           ; anonymous read stays open

[security]
MIN_PASSWORD_LENGTH = 12              ; a public sign-up form deserves a real floor
```

Apply and reload:

```sh
CONF=/mnt/cache/appdata/forgejo/data/gitea/conf/app.ini
cp -a "$CONF" "$CONF.bak-$(date +%Y%m%dT%H%M%S)"   # always
docker restart forgejo                              # ~2 seconds to a serving instance
```

Verify with `node scripts/check-signup.js --check` — it asks the instance itself and exits non-zero if
the form is not actually being served.

## Why `DEFAULT_USER_IS_RESTRICTED` is false here

It reads like the right knob for a public instance and it is not. Measured on this instance
(Forgejo 11.0.16):

- a new account created with `DEFAULT_USER_IS_RESTRICTED = true` **could not see the public
  repository at all** — `POST /repos/jaylouisw/packetforge/issues` returned `404`, not `403`, because
  the repository was invisible to it. The account existed, the form worked, and filing a request was
  impossible;
- the same account **could still create a repository** (`201`), which is the one thing restricted was
  supposed to prevent.

So it blocked the goal and not the abuse. With it `false`, a brand-new account sees the repository
(`200`), opens an issue (`201`), and is refused an organisation (`403`).

## What actually stops spam

There is no mailer configured on this instance, so email confirmation cannot be used — anyone who
fills in the form gets a working account immediately. The controls that are in place:

- **built-in image captcha** on the sign-up form (`CAPTCHA_TYPE = image`, no external service);
- **12-character minimum password**;
- **no organisation creation**, so the instance cannot be filled with tenant-shaped junk;
- issues from unknown accounts are visible in the ordinary tracker, which is where they get read
  anyway.

If abuse appears, the two levers in order of severity are `ENABLE_CAPTCHA = true` on login as well
(`REQUIRE_CAPTCHA_FOR_LOGIN`), and `REGISTER_MANUAL_CONFIRM = true` — the second needs the mailer
working first, which is a separate job (a Stalwart container already runs on this host).

## Rolling it back

```sh
CONF=/mnt/cache/appdata/forgejo/data/gitea/conf/app.ini
sed -i 's/^DISABLE_REGISTRATION = false$/DISABLE_REGISTRATION = true/' "$CONF"
docker restart forgejo
```

Existing accounts keep working; only the sign-up form closes. Backups from this change are named
`app.ini.bak-signup-*` next to the config.
