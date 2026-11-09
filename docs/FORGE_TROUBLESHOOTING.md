# When the forge stops answering

PacketForge lives on one Forgejo instance (`git.jayw.uk`, `odin:3000` on the lab
network). When it wedges, **every** normal repair path stops at once: no push, no
pull request, no issue comment, no workflow dispatch. This page is the ladder to
climb before assuming anything, because the failure looks different depending on
which layer is stuck and the wrong guess wastes an hour.

Everything below is a read-only probe. None of it changes state, so it is safe to
run against production while someone is using it.

## The ladder

Run these in order and stop at the first one that fails. Each rung answers a
different question.

```bash
# 1. Is the host up and the port open?        -> network / process
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 10 \
  http://odin:3000/api/v1/version

# 2. Does an authenticated, database-backed call answer?  -> database / sessions
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 15 \
  -H "Authorization: token $FORGEJO_TOKEN" \
  http://odin:3000/api/v1/repos/jaylouisw/packetforge

# 3. Does the git smart-HTTP endpoint answer?  -> internal git service
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 15 \
  'http://odin:3000/jaylouisw/packetforge.git/info/refs?service=git-upload-pack'

# 4. Does git agree, over both transports?     -> what a developer actually hits
timeout 60 git fetch origin
timeout 30 git ls-remote http://odin:3000/jaylouisw/packetforge.git
```

## Reading the results

| 1 version | 2 repo API | 3 git endpoint | 4 fetch | What it means |
|---|---|---|---|---|
| 200, ~10 ms | 200 | 200 | works | Healthy. The problem is your token, branch or remote. |
| 200, ~10 ms | **timeout** | **timeout** | fails | **Backend wedged.** HTTP is fine; anything that needs the database or the internal git service hangs. This is the dangerous one — see below. |
| 200 | 200 | 200 | fails | Your remote or credentials. Check `git remote -v`; `origin` is SSH (`forgejo` → `10.0.10.20:2222`), not HTTP. |
| timeout | timeout | timeout | fails | Host down, firewall, or the process is gone. Check the box. |
| 200 | 401 | 200 | works | Your token is wrong or expired. Nothing is broken. |

### The wedged-backend signature

This is the failure that costs time, because the instance *looks* alive:

- the TCP connection is accepted in single-digit milliseconds;
- `/api/v1/version` answers `200` — it touches neither the database nor git;
- **every** other endpoint hangs until the client gives up (`000`, `timeout`);
- `/packetforge.git/info/refs` hangs the same way, so `git fetch` and `git push` fail;
- SSH is worse than it looks: the connection **authenticates**, the shell request is
  **accepted**, and only then does the session die with
  `Forgejo: Internal Server Connection Error` — which reads like a permissions
  problem and is not one.

The combination means the application is running but its storage is not answering:
a stuck write transaction (SQLite holding a lock on a long write, or an exhausted
pool), or an internal git process holding a repository lock. It does not clear on
its own within the hour; two consecutive checks twenty minutes apart both hanging
is enough to call it.

## What to do about it

On the host, in this order:

```bash
# Is a child process holding the lock?
ps aux | grep -E 'forgejo|git-upload-pack|git-receive-pack|git-http-backend'

# Disk full is the most common cause of a stalled write, and it is silent.
df -h; df -i

# Forgejo's own checks.
forgejo doctor check --all

# Which files is it holding, and is a lock held rather than just an open handle?
# `u` is an ordinary read/write open; `r`, `w` and `ur` mean a lock is being held.
lsof /path/to/forgejo.db
```

That `lsof` line is worth running **before** the restart, because the restart destroys it.

Then restart the service (`systemctl restart forgejo`, or the container's
`docker restart`), and confirm with rung 1 **and** rung 2 — rung 1 alone will say
`200` while the instance is still unusable.

If the instance is up but slow rather than hung, read [`CI.md`](CI.md) instead:
that is usually the runner queue, not the forge.

## When a restart fixes it for ten minutes and then it happens again

A restart that buys minutes is not a fix, and the second outage is the one that repeats. On this
instance it happened fifteen times over three days.

The database was SQLite, living at `/mnt/user/appdata/forgejo/data/gitea/forgejo.db` on an Unraid
host - and `/mnt/user` is **shfs, a FUSE filesystem**. Same bytes as the array, different locking:
POSIX locks taken through FUSE can stay held after the holder has finished with them.

The measurement that identifies it, taken before and after moving the file to the pool's real path:

```
before  gitea  12ur  /mnt/user/appdata/forgejo/data/gitea/forgejo.db    <- read+write lock HELD
after   gitea  12u   /mnt/cache/appdata/forgejo/data/gitea/forgejo.db    <- open, no lock
```

With the lock held, every query stacked up behind it:

- a single-row `SELECT ... FROM user WHERE lower_name=?` took **2 minutes 5 seconds**;
- the container's CPU sat at **0.25%** - it was blocked, not busy, which is why load average and a
  CPU graph both looked innocent while the forge was unusable;
- a goroutine dump (`kill -QUIT <gitea pid>`) showed goroutines queued in
  `database/sql.(*Rows).close` waiting on an `RWMutex`: the connection pool had starved, so requests
  never reached the logging that would have shown them;
- after the move, the same request answered in **30-60 ms**, ten concurrent requests all answered in
  **130 ms**, and the issues list in **64 ms**.

### Diagnosing which path the database is actually on

```bash
docker inspect forgejo --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
# bind /mnt/user/appdata/forgejo/data -> /data      <- the FUSE view

df -h /mnt/user/appdata            # shfs: says nothing about the real disk
ls -l /mnt/cache/appdata/forgejo/  # the pool path the FUSE view stands in front of
```

A bind that reads `/mnt/user/...` on Unraid is a FUSE path. The same directory seen through
`/mnt/cache/...` (or `/mnt/disk<N>/...`) is a normal filesystem.

### The fix

Point the container at the pool's own path. The files do not move, so there is nothing to copy:

```bash
docker stop forgejo
docker rename forgejo forgejo-fuse-bak          # rollback, free of charge
docker run -d --name forgejo --restart unless-stopped \
  -p 3000:3000 -p 2222:22 \
  -e USER_UID=1000 -e USER_GID=1000 -e USER=git -e GITEA_CUSTOM=/data/gitea \
  -v /mnt/cache/appdata/forgejo/data:/data \
  codeberg.org/forgejo/forgejo:latest
```

Keep the old container until rung 2 answers again: `docker rename forgejo-fuse-bak forgejo` followed
by `docker start forgejo` is the entire rollback.

Two things quietly undo this, so check both afterwards:

- **a container template or compose file that still says `/mnt/user/...`** - re-creating from it puts
  the FUSE path back: `grep -rl 'mnt/user/appdata/forgejo' /boot/config /root /opt /srv`;
- **somebody else's `docker compose up`** on the host, for exactly the same reason.

### The general rule

**SQLite must live on a real local filesystem.** Not a FUSE path, not a network share, not a sync
folder - the locking those filesystems provide does not survive the assumptions SQLite makes, and
the failure mode is a hang rather than an error, which is why it reads as "the forge keeps
crashing". If the database has to be shared or hosted off-box, that is the moment to move to
PostgreSQL, not to move the file.

## While it is down

The temptation is to keep retrying or to work around it destructively. Both are
wrong, and one of them loses work:

- **Do not force-push, delete branches, or re-create the repository** to get a push
  through. None of that addresses a locked backend, and a force-push during an
  incident destroys the only record of what was in flight.
- **Do not rewrite history to "resync".** A fetch that fails leaves your refs
  exactly as they were; the repository is not damaged by the outage.
- **Do** keep working locally on a branch, run the suite, and commit. A commit that
  cannot be pushed is finished work; the push is the last step, not the first.
- **Do** write down what you attempted (`curl` codes, timestamps, the exact error
  string). `Internal Server Connection Error` and `Could not read from remote
  repository` are different failures and the distinction is the whole diagnosis.
- **When it comes back**, push the branch and then re-read `main` before opening
  the pull request: an outage hides merges that landed from elsewhere.

## The forge is up, git works, and the API answers `403`

Symptom, seen exactly like this:

```
$ curl -s -o /dev/null -w '%{http_code}' -u "$USER:$TOKEN" https://git.jayw.uk/api/v1/repos/jaylouisw/packetforge
403
$ curl -s -u "$USER:$TOKEN" https://git.jayw.uk/api/v1/user
{"message":"You must change your password. Change it at: https://git.jayw.uk//user/change_password"}
```

Meanwhile `git push` works and the web UI is fine, so the instance looks half-alive and the
temptation is to go looking at the backend again. It is not the backend. Forgejo refuses **every
authenticated API call** — reads included — for an account with `must_change_password` set, and git
over SSH/HTTP does not consult that flag.

Check it against the database rather than guessing:

```sh
ssh root@10.0.10.20 "sqlite3 'file:/mnt/cache/appdata/forgejo/data/gitea/forgejo.db?mode=ro' \
  'select id,lower_name,must_change_password,is_admin from user;'"
# 1|jaylouisw|1|1
```

To clear it without touching the password (stop the container first — SQLite on a live data
directory is the mistake this document exists to prevent):

```sh
docker stop forgejo
sqlite3 /mnt/cache/appdata/forgejo/data/gitea/forgejo.db \
  'update user set must_change_password=0 where id=1;'
docker start forgejo   # ~2 s to serving; nothing else is affected
```

Then re-check with a single API call before assuming the token itself is broken. Do **not** reset the
password to get past this: that is a change to somebody's credential to fix a flag.

The flag was first seen after `MIN_PASSWORD_LENGTH` was raised from the default to 12 in `[service]`
— an existing shorter password is a plausible reason for the account to be asked to change it, though
this was not confirmed against Forgejo's source. If it reappears on the next restart, that is the
first thing to look at.

## The database file you are about to query may not be the database

`app.ini` points at `/data/gitea/forgejo.db`:

```ini
[database]
DB_TYPE = sqlite3
PATH = /data/gitea/forgejo.db
```

The name everybody reaches for is `gitea.db`, and it is not there — but `sqlite3 gitea.db 'select ...
from user'` does not complain about a missing file: it **creates** a 0-byte one and then answers
`Parse error ... no such table: user`, which reads like a corrupted instance and is not. If a stray
`gitea.db` appears in that directory, that is where it came from; `rm` it.

Take the path from `app.ini`, and query read-only while the container is running:

```sh
sqlite3 'file:/mnt/cache/appdata/forgejo/data/gitea/forgejo.db?mode=ro' \
  'select id,lower_name,must_change_password,is_admin from user;'
```

