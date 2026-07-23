// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiveStatusIndicator surfaces the "SSE dropped" state on the messages
 * surface. It must render the reconnecting notice ONLY when paused, so it
 * never flashes during the benign initial connect (paused=false).
 */

import { render, screen } from '@testing-library/react';
import { LiveStatusIndicator } from '../src/components/message/LiveStatusIndicator';

describe('LiveStatusIndicator', () => {
  it('renders the reconnecting notice when paused', () => {
    render(<LiveStatusIndicator paused />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    expect(screen.getByText(/live updates paused/i)).toBeInTheDocument();
  });

  it('renders nothing when not paused (no flash during initial connect)', () => {
    const { container } = render(<LiveStatusIndicator paused={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
  });
});
