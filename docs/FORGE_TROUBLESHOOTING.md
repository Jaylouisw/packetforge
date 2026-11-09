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
```

Then restart the service (`systemctl restart forgejo`, or the container's
`docker restart`), and confirm with rung 1 **and** rung 2 — rung 1 alone will say
`200` while the instance is still unusable.

If the instance is up but slow rather than hung, read [`CI.md`](CI.md) instead:
that is usually the runner queue, not the forge.

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
