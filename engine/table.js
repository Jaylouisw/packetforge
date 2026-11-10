'use strict';
// The one table renderer.
//
// Column widths are measured from the data, never typed in: every cell is padded to the
// widest value in its column plus two spaces, and the last column is not padded, so no
// row carries trailing whitespace. This exists because hand-padded widths kept drifting
// from the values they were meant to hold - a VRRP ready time ("3218.75 ms") is wider
// than an STP one ("30000 ms"), and a 29-character hostname ran straight into the next
// column - and because a second formatter in `nat.js` had its own idea of the layout.
//
// Callers pass cells; nothing here knows what they mean.

function renderTable(header, rows, indent) {
  const pad0 = ' '.repeat(indent || 0);
  const cols = header.length;
  const width = [];
  for (let c = 0; c < cols; c++) width[c] = String(header[c] === undefined ? '' : header[c]).length;
  for (const row of rows) {
    // A row with more cells than the header means the data and the columns disagree, and
    // the old behaviour was to drop the extra cells - silently losing a column. That is
    // worse than failing: `show ip nat translations` lost its `Type` column this way and
    // the layout sweep still passed, because both sides agreed on the truncated table.
    if (row && row.length > cols) {
      throw new Error('renderTable: a row has ' + row.length +
        ' cells but the header has ' + cols + ' columns');
    }
    for (let c = 0; c < cols; c++) {
      width[c] = Math.max(width[c], String(row[c] === undefined ? '' : row[c]).length);
    }
  }
  const fmt = function (cells) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const value = String(cells[c] === undefined ? '' : cells[c]);
      line += (c === cols - 1) ? value : rightPad(value, width[c] + 2);
    }
    return pad0 + line.replace(/\s+$/, '');
  };
  const lines = [fmt(header)];
  for (const row of rows) lines.push(fmt(row));
  return lines;
}

function rightPad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

module.exports = { renderTable, rightPad };
