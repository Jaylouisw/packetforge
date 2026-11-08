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

// Errors worth translating: these are the two a normal person actually hits, and
// both have an obvious remedy that a stack trace does not mention.
function describeListenError(err, port) {
  const code = (err && err.code) || '';
  const p = String(port);

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

  if (code === 'EADDRNOTAVAIL') {
    return {
      headline: 'This machine has no address that can listen on port ' + p + '.',
      lines: [
        'That usually means PORT is set to an address this host does not own.',
        'Leave PORT unset to listen on all interfaces, or set it to a port number only:',
        '',
        '    PORT=8080 npm start'
      ],
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

// The block a person actually reads, as an array of lines, so callers decide where
// it goes (stderr, a log, a test) without re-deriving the wording.
function formatStartupError(err, port) {
  const d = describeListenError(err, port);
  const out = ['', '  ' + d.headline];
  for (const line of d.lines) out.push('  ' + line);
  if (d.reportable) {
    out.push('', '  Report it: ' + REPORT_URL);
  }
  out.push('');
  return out;
}

module.exports = { describeListenError, formatStartupError, REPORT_URL, REPORT_TITLE, REPO };
