// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, Response } from 'express';
import { getRouteGates, tagRouteGate, type ConditionalInnerGate } from './route-table.js';

type Gate = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Run `gates` in order, but only for the requests `when` selects; every other
 * request passes straight through.
 *
 * For a route where only SOME requests are sensitive — `PATCH /user/profile`
 * changing the sign-in email, `POST /users` creating a platform super-admin —
 * and the rest must stay as easy as they are. The gates are the real middleware
 * (`requireStepUp`, `requireAssurance`, …), unchanged, so a selected request is
 * refused exactly as it would be on a route that always demands them.
 *
 * A predicate that throws is handed to Express's error handler — the request is
 * refused, never admitted ungated.
 *
 * `description` names the selected requests in words (`'changes the sign-in
 * email'`). The route table records the wrapped gates under `conditionalGates`
 * with it, and NOT in the top-level `stepUp` / `minAssurance`, which state what
 * EVERY request meets. So the contract shows the condition, and dropping the
 * `gateWhen` changes the table.
 *
 * Only gates the table can project may be wrapped — step-up, and an assurance
 * level with no `maxAge` or exemption. Anything else throws at startup rather
 * than run as a gate nobody can see.
 */
export function gateWhen(
  description: string,
  when: (req: Request) => boolean | Promise<boolean>,
  ...gates: Gate[]
): (req: Request, res: Response, next: NextFunction) => void {
  if (description.trim() === '') throw new Error('gateWhen needs a description of the requests it selects');
  if (gates.length === 0) throw new Error(`gateWhen("${description}") wraps no gate`);
  const inner: ConditionalInnerGate[] = gates.flatMap((gate) => {
    const tags = getRouteGates(gate);
    if (tags.length === 0) throw new Error(`gateWhen("${description}"): a wrapped gate carries no route-table tag`);
    return tags.map((t): ConditionalInnerGate => {
      if (t.kind === 'stepUp') return { kind: 'stepUp', ...(t.methods ? { methods: [...t.methods] } : {}) };
      if (t.kind === 'assurance' && t.maxAge === undefined && t.exempt === undefined) {
        return { kind: 'assurance', minAssurance: t.minAssurance };
      }
      throw new Error(`gateWhen("${description}"): cannot wrap a ${JSON.stringify(t)} gate — the route table records only step-up and a plain assurance level conditionally`);
    });
  });
  return tagRouteGate(
    function gateWhenRoute(req: Request, res: Response, next: NextFunction): void {
      const run = (i: number): void => {
        if (i === gates.length) return next();
        void gates[i](req, res, (err?: unknown) => (err ? next(err) : run(i + 1)));
      };
      Promise.resolve()
        .then(() => when(req))
        .then((applies) => (applies ? run(0) : next()), next);
    },
    { kind: 'conditional', when: description, gates: inner },
  );
}
