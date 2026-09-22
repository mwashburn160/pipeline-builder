// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TENANT publisher + publish-request routes (docs/plugin-publishing.md
 * ). Everything here is a REQUEST or a RESTRICTION
 * of the caller's own reach — nothing a tenant route does admits, expands or
 * decides anything in the ecosystem (the governance test enforces that):
 *
 *   GET /plugins/publisher plugins:read
 *   POST /plugins/publisher publishers:manage claim a handle + accept terms
 *   PATCH /plugins/publisher publishers:manage description / homepage
 *   POST /plugins/publisher/terms publishers:manage re-accept the terms
 *   GET /plugins/publisher/listings plugins:read
 *   GET /plugins/publisher/insights plugins:read installs, k-anonymous adoption, health
 *   POST /plugins/publisher/listings/:listingId/pause plugins:publish pause a listing or a version
 *   POST /plugins/publisher/listings/:listingId/deprecate plugins:publish deprecate a listed version (narrows only)
 *   GET /plugins/publisher/advisories publishers:manage own advisories, incl. private drafts
 *   GET /plugins/publisher/incoming-transfers publishers:manage
 *   GET /plugins/publish-requests plugins:read
 *   GET /plugins/publish-requests/draft plugins:publish the request form
 *   POST /plugins/publish-requests plugins:publish | publishers:manage (per kind)
 *   POST /plugins/publish-requests/:id/withdraw plugins:publish | publishers:manage
 *   POST /plugins/publish-requests/:id/transfer-response publishers:manage + step-up
 */

import { audited, requirePermission, requireStepUp, sendSuccess } from '@pipeline-builder/api-core';
import { Router, type RequestHandler } from 'express';

import { bodyOf, ecosystemRoute, param } from './ecosystem-route.js';
import { deprecateOwnListedVersion, publisherAdvisories } from '../services/ecosystem/advisories.js';
import { publisherInsights } from '../services/ecosystem/insights.js';
import {
  acceptTerms, claimPublisher, ownListings, pause, publisherState, updatePublisherProfile,
} from '../services/ecosystem/publishers.js';
import { draft, incomingTransfers, ownRequests, respondToTransfer, submit, withdraw } from '../services/ecosystem/requests.js';

/** Build the tenant publisher router (mounted at `/plugins`, behind the shared auth + org chain). */
export function createPublisherRoutes(): Router {
  const router = Router();

  router.get('/publisher', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, await publisherState(caller));
  }));

  router.post('/publisher', requirePermission('publishers:manage') as RequestHandler, audited('publisher.create', 'publisher.terms.accept') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 201, { publisher: await claimPublisher(caller, bodyOf(req)) });
    }));

  router.patch('/publisher', requirePermission('publishers:manage') as RequestHandler, audited('publisher.update') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { publisher: await updatePublisherProfile(caller, bodyOf(req)) });
    }));

  router.post('/publisher/terms', requirePermission('publishers:manage') as RequestHandler, audited('publisher.terms.accept') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { publisher: await acceptTerms(caller, bodyOf(req).termsVersion) });
    }));

  router.get('/publisher/listings', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, { listings: await ownListings(caller) });
  }));

  router.get('/publisher/insights', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, await publisherInsights(caller));
  }));

  router.post('/publisher/listings/:listingId/pause', requirePermission('plugins:publish') as RequestHandler, audited('plugin.listing.pause', 'plugin.version.pause') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      const version = bodyOf(req).version;
      sendSuccess(res, 200, { listing: await pause(caller, param(req, 'listingId'), typeof version === 'string' && version ? version : undefined) });
    }));

  router.post('/publisher/listings/:listingId/deprecate', requirePermission('plugins:publish') as RequestHandler, audited('plugin.version.deprecate') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { listing: await deprecateOwnListedVersion(caller, param(req, 'listingId'), bodyOf(req)) });
    }));

  // plugins:read: every member may read the advisories on their OWN publisher's listings (the service scopes it).
  router.get('/publisher/advisories', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, { advisories: await publisherAdvisories(caller) });
  }));

  router.get('/publisher/incoming-transfers', requirePermission('publishers:manage') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const page = await incomingTransfers(caller, req.query as Record<string, unknown>);
    sendSuccess(res, 200, { requests: page.requests, nextCursor: page.nextCursor });
  }));

  router.get('/publish-requests', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const page = await ownRequests(caller, req.query as Record<string, unknown>);
    sendSuccess(res, 200, { requests: page.requests, nextCursor: page.nextCursor });
  }));

  router.get('/publish-requests/draft', requirePermission('plugins:publish') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await draft(caller, req.query.pluginId));
  }));

  router.post('/publish-requests', requirePermission('plugins:publish', 'publishers:manage') as RequestHandler,
    audited('plugin.request.submit', 'publisher.verify.request', 'publisher.transfer.request', 'plugin.advisory.create') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 201, await submit(caller, bodyOf(req)));
    }));

  router.post('/publish-requests/:id/withdraw', requirePermission('plugins:publish', 'publishers:manage') as RequestHandler, audited('plugin.request.withdraw') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { request: await withdraw(caller, param(req, 'id')) });
    }));

  router.post('/publish-requests/:id/transfer-response', requirePermission('publishers:manage') as RequestHandler, requireStepUp as RequestHandler,
    audited('publisher.transfer.accept', 'publisher.transfer.decline') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { request: await respondToTransfer(caller, param(req, 'id'), bodyOf(req).accept === true) });
    }));

  return router;
}
