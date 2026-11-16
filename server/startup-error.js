'use strict';
// What a person sees when the server will not start.
//
// The web UI carries a "Report a bug" button, and it is the only thing this project
// asks anyone to click. It cannot help here, because the failure being reported is
// that the UI never appeared. The one moment the reporting path most needs to exist
// is the moment the button does not - so the message printed to the terminal has to
// carry it instead.
//
// Kept free of side effects and of the rest of the server so it can be tested, and
// so it cannot accidentally depend on the catalogue having loaded.

const REPO = 'https://git.jayw.uk/jaylouisw/packetforge';

const REPORT_TITLE = '[Bug]: Server will not start';
const REPORT_URL = REPO + '/issues/new?title=' + encodeURIComponent(REPORT_TITLE) +
  '&body=' + encodeURIComponent(
    '### What happened\n\nPacketForge would not start. The terminal printed the message below.\n\n' +
    '```\n<paste the whole terminal output here, including the version banner if you saw one>\n```\n\n' +
    '### How you started it\n\n' +
    '<!-- e.g. npm start / docker run / npm run dev, and the operating system -->\n\n'
  );

// Errors worth translating: these are the ones a normal person actually hits, and each has an obvious
// remedy that a stack trace does not mention.
//
// `host` is the address the server was told to bind (PF_HOST, or its loopback default). It is here
// because EADDRNOTAVAIL and ENOTFOUND are about that value and nothing else: a reader who is shown
// only the port goes looking in PORT, which is not where the mistake is (#1527).
function describeListenError(err, port, host) {
  const code = (err && err.code) || '';
  const p = String(port);
  const h = (typeof host === 'string' && host.trim()) ? host.trim() : '';

  if (code === 'EADDRINUSE') {
    return {
      headline: 'Port ' + p + ' is already in use, so PacketForge could not start.',
      lines: [
        'Something else is already listening on port ' + p + '. The usual cause is a',
        'PacketForge that is still running in another terminal or in the background.',
        '',
        'Stop that copy, or start this one on a different port:',
        '',
        '    PORT=8081 npm start          (macOS, Linux, git-bash)',
        '    $env:PORT=8081; npm start    (PowerShell)',
        '    set PORT=8081 && npm start   (cmd.exe)',
        '',
        'Nothing has been lost: topologies are saved as they change.'
      ],
      reportable: true
    };
  }

  if (code === 'EACCES') {
    return {
      headline: 'Not allowed to listen on port ' + p + '.',
      lines: [
        'On most systems, ports below 1024 can only be opened by a privileged user.',
        'Pick a port of 1024 or higher:',
        '',
        '    PORT=8080 npm start'
      ],
      reportable: false
    };
  }

  // The address the server was told to bind does not exist here: either nothing on this machine owns
  // it (EADDRNOTAVAIL) or the name does not resolve at all (ENOTFOUND). Both name the value tried,
  // because "port 8000 is unusable" would be a lie - the port was never the problem.
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const named = h || 'localhost';
    const unresolvable = code === 'ENOTFOUND' || code === 'EAI_AGAIN';
    const lines = [
      'PF_HOST names the address to listen on, and it is set to ' + JSON.stringify(named) + '.',
      unresolvable
        ? 'That name does not resolve on this machine, and an address has to be one this host owns.'
        : 'No interface on this machine has that address.',
      '',
      'Leave PF_HOST unset to listen on 127.0.0.1 only, or name an interface this machine owns:',
      '',
      '    PORT=8080 npm start                   (this machine only - the default)',
      '    PF_HOST=0.0.0.0 PORT=8080 npm start   (every interface)',
      '',
      '    $env:PF_HOST="0.0.0.0"; $env:PORT="8080"; npm start     (PowerShell)'
    ];
    // The mistake this actually catches: a host and a port in one variable, copied from a URL.
    const portInHost = named.indexOf(':') !== -1 && named.indexOf('::') === -1 &&
      named.slice(-(p.length + 1)) === ':' + p;
    if (portInHost) {
      lines.push('', 'An address with a port on the end is the usual cause - the port belongs in PORT.');
    }
    // Appending the port to a value that already carries one would print `[127.0.0.1:8000]:8000`,
    // which names a thing that cannot exist and hides the mistake the reader has to see.
    const label = portInHost ? named : urlAuthority(named, p);
    return {
      headline: 'Cannot listen on ' + label + ': this machine has no such address.',
      lines: lines,
      reportable: false
    };
  }

  const detail = (err && err.message) || String(err);
  return {
    headline: 'PacketForge failed to start: ' + detail,
    lines: [
      'This is not a known failure, so the message above is the useful part.',
      'If you report it, paste the whole terminal output, not just the last line.'
    ],
    reportable: true
  };
}

// `host:port`, with brackets when the host is an IPv6 literal - the form the operator typed and the
// form a message has to name for it to be actionable.
function urlAuthority(host, port) {
  const h = String(host);
  return (h.indexOf(':') !== -1 ? '[' + h + ']' : h) + ':' + String(port);
}

// The block a person actually reads, as an array of lines, so callers decide where
// it goes (stderr, a log, a test) without re-deriving the wording.
function formatStartupError(err, port, host) {
  const d = describeListenError(err, port, host);
  const out = ['', '  ' + d.headline];
  for (const line of d.lines) out.push('  ' + line);
  if (d.reportable) {
    out.push('', '  Report it: ' + REPORT_URL);
  }
  out.push('');
  return out;
}

module.exports = { describeListenError, formatStartupError, REPORT_URL, REPORT_TITLE, REPO };
