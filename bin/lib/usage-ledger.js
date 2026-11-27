'use strict';
const fs = require('fs');
const path = require('path');

/** Append one execution receipt to the existing Harness usage ledger. No prompt/tool payloads. */
function appendUsage(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = { appendUsage };
