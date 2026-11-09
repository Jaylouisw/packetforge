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
