/**
 * @module openapi/routes/message-routes
 * @description OpenAPI route specs for the Message service.
 */

import { addRegistration, registry } from '../registry';

const tags = ['Messages'];
const auth = [{ bearerAuth: [] }];

addRegistration(() => {
  registry.registerPath({
    method: 'get',
    path: '/message',
    summary: 'List inbox messages',
    description: 'List root messages (inbox) with optional filtering by type and pagination.',
    tags,
    security: auth,
    responses: { 200: { description: 'Paginated list of messages' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/message/announcements',
    summary: 'List announcements',
    description: 'List announcement messages only.',
    tags,
    security: auth,
    responses: { 200: { description: 'List of announcements' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/message/conversations',
    summary: 'List conversations',
    description: 'List conversation messages only.',
    tags,
    security: auth,
    responses: { 200: { description: 'List of conversations' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/message/unread/count',
    summary: 'Get unread count',
    description: 'Get the number of unread messages for the current organization.',
    tags,
    security: auth,
    responses: { 200: { description: 'Unread message count' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/message/{id}',
    summary: 'Get message by ID',
    tags,
    security: auth,
    responses: { 200: { description: 'Message details' }, 404: { description: 'Not found' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/message/{id}/thread',
    summary: 'Get message thread',
    description: 'Get all messages in a thread including the root message and replies.',
    tags,
    security: auth,
    responses: { 200: { description: 'Thread messages sorted by date' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/message',
    summary: 'Create a message',
    description: 'Create a new announcement or conversation message.',
    tags,
    security: auth,
    responses: { 201: { description: 'Message created' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/message/{id}/reply',
    summary: 'Reply to a message',
    description: 'Create a reply in an existing message thread.',
    tags,
    security: auth,
    responses: { 201: { description: 'Reply created' }, 404: { description: 'Parent message not found' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/message/{id}/read',
    summary: 'Mark message as read',
    tags,
    security: auth,
    responses: { 200: { description: 'Message marked as read' } },
  });

  registry.registerPath({
    method: 'put',
    path: '/message/{id}/thread/read',
    summary: 'Mark thread as read',
    description: 'Mark all messages in a thread as read.',
    tags,
    security: auth,
    responses: { 200: { description: 'Thread marked as read' } },
  });

  registry.registerPath({
    method: 'delete',
    path: '/message/{id}',
    summary: 'Delete a message',
    description: 'Soft-delete a message.',
    tags,
    security: auth,
    responses: { 200: { description: 'Message deleted' }, 404: { description: 'Not found' } },
  });
});
