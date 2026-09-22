// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/*
 * Proof-of-work solver for anonymous plugin submissions (plan §4.2, E3), run
 * as a Web Worker by src/lib/plugin-submissions/proof-of-work.ts.
 *
 * Finds the smallest decimal nonce such that SHA-256("<challenge>:<nonce>")
 * starts with at least `difficulty` zero bits — the check api-core's
 * verifyProofOfWork makes. Plain JavaScript served from public/ (same origin,
 * so the CSP allows it; blob workers are not allowed).
 *
 * Messages in:  { challenge, difficulty, batchSize? }
 * Messages out: { type: 'progress', attempts } after each batch,
 *               { type: 'done', nonce, attempts } or { type: 'error', message }.
 */
(function (scope) {
  'use strict';

  function leadingZeroBits(bytes) {
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) { bits += 8; continue; }
      bits += Math.clz32(bytes[i]) - 24;
      break;
    }
    return bits;
  }

  async function solve(challenge, difficulty, batchSize, report) {
    var subtle = scope.crypto && scope.crypto.subtle;
    if (!subtle) throw new Error('crypto.subtle is unavailable');
    var encoder = new TextEncoder();
    var batch = Math.max(1, batchSize || 256);
    var next = 0;
    for (;;) {
      var digests = [];
      for (var i = 0; i < batch; i++) {
        digests.push(subtle.digest('SHA-256', encoder.encode(challenge + ':' + (next + i))));
      }
      var hashes = await Promise.all(digests);
      for (var j = 0; j < hashes.length; j++) {
        if (leadingZeroBits(new Uint8Array(hashes[j])) >= difficulty) {
          return { nonce: String(next + j), attempts: next + j + 1 };
        }
      }
      next += batch;
      if (report) report(next);
    }
  }

  scope.onmessage = function (event) {
    var data = event.data || {};
    solve(String(data.challenge), Number(data.difficulty), data.batchSize, function (attempts) {
      scope.postMessage({ type: 'progress', attempts: attempts });
    }).then(function (result) {
      scope.postMessage({ type: 'done', nonce: result.nonce, attempts: result.attempts });
    }, function (err) {
      scope.postMessage({ type: 'error', message: (err && err.message) || 'Proof of work failed' });
    });
  };

  // Exposed for the frontend test suite, which runs this exact file.
  scope.__pbProofOfWork = { leadingZeroBits: leadingZeroBits, solve: solve };
})(self);
