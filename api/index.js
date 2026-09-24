/* Vercel Function entry: every /api/* request is rewritten here (vercel.json)
   and handled by the same router the local server uses. */

'use strict';

module.exports = require('../gpr-annotator/server.js').handler;
