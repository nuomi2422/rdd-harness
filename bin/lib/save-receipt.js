'use strict';
/** The CLI exit code is transport status only. A save must confirm the business receipt. */
function confirmedSave(receipt) {
  if (!receipt || receipt.ok !== true || typeof receipt.out !== 'string') return false;
  try { const data=JSON.parse(receipt.out); return data.success === true && data.data && data.data.ok === true; }
  catch { return false; }
}
module.exports = { confirmedSave };
