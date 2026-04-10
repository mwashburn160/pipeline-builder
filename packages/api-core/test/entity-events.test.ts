// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { entityEvents, type EntityEvent, type EntityEventSubscriber } from '../src/services/entity-events';

function makeEvent(overrides: Partial<EntityEvent> = {}): EntityEvent {
  return {
    eventType: 'created',
    target: 'plugin',
    entityId: 'entity-1',
    orgId: 'org-1',
    userId: 'user-1',
    timestamp: new Date(),
    attributes: { name: 'test' },
    ...overrides,
  };
}

describe('entityEvents', () => {
  // Clean up subscribers after each test to avoid leaks
  const subscribers: EntityEventSubscriber[] = [];

  function addSubscriber(onEvent: jest.Mock): EntityEventSubscriber {
    const sub: EntityEventSubscriber = { onEntityEvent: onEvent };
    entityEvents.subscribe(sub);
    subscribers.push(sub);
    return sub;
  }

  afterEach(() => {
    for (const sub of subscribers) {
      entityEvents.unsubscribe(sub);
    }
    subscribers.length = 0;
  });

  it('starts with existing subscriber count (singleton shared across tests)', () => {
    expect(typeof entityEvents.subscriberCount).toBe('number');
  });

  it('subscribe increments subscriber count', () => {
    const before = entityEvents.subscriberCount;
    const onEvent = jest.fn().mockResolvedValue(undefined);
    addSubscriber(onEvent);
    expect(entityEvents.subscriberCount).toBe(before + 1);
  });

  it('unsubscribe decrements subscriber count', () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const sub = addSubscriber(onEvent);
    const after = entityEvents.subscriberCount;
    entityEvents.unsubscribe(sub);
    subscribers.pop(); // remove from cleanup list since already unsubscribed
    expect(entityEvents.subscriberCount).toBe(after - 1);
  });

  it('emit calls subscriber with event', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    addSubscriber(onEvent);

    const event = makeEvent();
    entityEvents.emit(event);

    await new Promise((r) => setTimeout(r, 10));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('emit calls multiple subscribers', async () => {
    const onEvent1 = jest.fn().mockResolvedValue(undefined);
    const onEvent2 = jest.fn().mockResolvedValue(undefined);
    addSubscriber(onEvent1);
    addSubscriber(onEvent2);

    entityEvents.emit(makeEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(onEvent1).toHaveBeenCalledTimes(1);
    expect(onEvent2).toHaveBeenCalledTimes(1);
  });

  it('emit does not throw when subscriber throws', async () => {
    const failingSubscriber = jest.fn().mockRejectedValue(new Error('subscriber error'));
    addSubscriber(failingSubscriber);

    expect(() => entityEvents.emit(makeEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('healthy subscriber still called when another subscriber throws', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('fail'));
    const healthy = jest.fn().mockResolvedValue(undefined);
    addSubscriber(failing);
    addSubscriber(healthy);

    entityEvents.emit(makeEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('unsubscribed subscriber is not called', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const sub = addSubscriber(onEvent);
    entityEvents.unsubscribe(sub);
    subscribers.pop();

    entityEvents.emit(makeEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('emit with no test subscribers does not throw', () => {
    // All test subscribers are cleaned up, only pre-existing ones remain
    expect(() => entityEvents.emit(makeEvent())).not.toThrow();
  });

  it('passes correct event data through', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    addSubscriber(onEvent);

    const event = makeEvent({
      eventType: 'deleted',
      target: 'pipeline',
      entityId: 'pipe-123',
      orgId: 'org-456',
      userId: 'user-789',
      attributes: { project: 'my-app' },
    });

    entityEvents.emit(event);
    await new Promise((r) => setTimeout(r, 10));

    const received = onEvent.mock.calls[0][0];
    expect(received.eventType).toBe('deleted');
    expect(received.target).toBe('pipeline');
    expect(received.entityId).toBe('pipe-123');
    expect(received.orgId).toBe('org-456');
    expect(received.attributes).toEqual({ project: 'my-app' });
  });
});
