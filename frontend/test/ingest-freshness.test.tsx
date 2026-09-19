// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports freshness indicator.
 *
 * `POST /reports/ingest-health` was written by the events Lambda with no reader
 * at all, so an empty report couldn't be told apart from a dead ingest pipeline.
 * The rules that matter here: a deployment that has NEVER reported is said so
 * plainly (never dressed up as "stale"), dropped events outrank freshness, and
 * staleness is measured against the SERVER's clock.
 */

import { render, screen } from '@testing-library/react';
import {
  IngestFreshness,
  classifyIngestHealth,
  INGEST_STALE_AFTER_MS,
} from '../src/components/reports/IngestFreshness';

const NOW = '2026-09-19T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

describe('classifyIngestHealth', () => {
  it('reports `never` when the deployment has no ingest row', () => {
    expect(classifyIngestHealth({ health: null, now: NOW })).toEqual({ state: 'never', since: null, dropped: 0 });
  });

  it('does not confuse "never reported" with "stale"', () => {
    // The distinction is the whole point: a fresh install has not regressed.
    expect(classifyIngestHealth({ health: null, now: NOW }).state).not.toBe('stale');
  });

  it('reports `flowing` for a recent heartbeat', () => {
    const status = classifyIngestHealth({
      health: { updatedAt: iso(nowMs - 60_000), lastEventAt: iso(nowMs - 90_000), forwarded: 12, dropped: 0 },
      now: NOW,
    });
    expect(status.state).toBe('flowing');
    expect(status.since).toBe(iso(nowMs - 90_000));
  });

  it('reports `stale` once the heartbeat passes the threshold', () => {
    const status = classifyIngestHealth({
      health: { updatedAt: iso(nowMs - INGEST_STALE_AFTER_MS - 1000), lastEventAt: iso(nowMs - INGEST_STALE_AFTER_MS - 1000), forwarded: 12, dropped: 0 },
      now: NOW,
    });
    expect(status.state).toBe('stale');
  });

  it('measures staleness against the SERVER clock, not the browser', () => {
    // Browser time is irrelevant — a server `now` close to the heartbeat means
    // fresh, even if the local clock is days ahead.
    const beat = iso(Date.now() + 5 * INGEST_STALE_AFTER_MS);
    const serverNow = iso(Date.parse(beat) + 1000);
    expect(classifyIngestHealth({
      health: { updatedAt: beat, lastEventAt: beat, forwarded: 1, dropped: 0 },
      now: serverNow,
    }).state).toBe('flowing');
  });

  it('reports `dropping` regardless of how fresh the heartbeat is', () => {
    const status = classifyIngestHealth({
      health: { updatedAt: iso(nowMs - 1000), lastEventAt: iso(nowMs - 1000), forwarded: 100, dropped: 7 },
      now: NOW,
    });
    expect(status.state).toBe('dropping');
    expect(status.dropped).toBe(7);
  });

  it('does not invent staleness from an unparsable timestamp', () => {
    expect(classifyIngestHealth({
      health: { updatedAt: 'not-a-date', lastEventAt: null, forwarded: null, dropped: null },
      now: NOW,
    }).state).toBe('flowing');
  });
});

describe('<IngestFreshness />', () => {
  it('renders nothing while the read is in flight', () => {
    const { container } = render(<IngestFreshness data={undefined} loading />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the read itself failed', () => {
    const { container } = render(<IngestFreshness data={undefined} loading={false} error="boom" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the deployment has never reported rather than calling it stale', () => {
    render(<IngestFreshness data={{ health: null, now: NOW }} loading={false} />);
    const strip = screen.getByTestId('ingest-freshness');
    expect(strip).toHaveAttribute('data-state', 'never');
    expect(strip.textContent).toMatch(/never received pipeline events/i);
  });

  it('tells the user an empty chart is a quiet range when ingestion is healthy', () => {
    render(<IngestFreshness
      data={{ health: { updatedAt: iso(nowMs - 1000), lastEventAt: iso(nowMs - 1000), forwarded: 5, dropped: 0 }, now: NOW }}
      loading={false}
    />);
    const strip = screen.getByTestId('ingest-freshness');
    expect(strip).toHaveAttribute('data-state', 'flowing');
    expect(strip.textContent).toMatch(/no activity in the selected range/i);
  });

  it('names when ingestion was last heard from once stale', () => {
    render(<IngestFreshness
      data={{ health: { updatedAt: iso(nowMs - 3 * INGEST_STALE_AFTER_MS), lastEventAt: iso(nowMs - 3 * INGEST_STALE_AFTER_MS), forwarded: 5, dropped: 0 }, now: NOW }}
      loading={false}
    />);
    const strip = screen.getByTestId('ingest-freshness');
    expect(strip).toHaveAttribute('data-state', 'stale');
    expect(strip.textContent).toMatch(/No events have reached the ingest pipeline since/i);
  });

  it('surfaces dropped events as data loss', () => {
    render(<IngestFreshness
      data={{ health: { updatedAt: iso(nowMs - 1000), lastEventAt: iso(nowMs - 1000), forwarded: 5, dropped: 3 }, now: NOW }}
      loading={false}
    />);
    const strip = screen.getByTestId('ingest-freshness');
    expect(strip).toHaveAttribute('data-state', 'dropping');
    expect(strip.textContent).toMatch(/3 dropped events/i);
  });
});
