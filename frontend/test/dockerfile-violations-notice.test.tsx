// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI plugin builder surfaces the catalog Dockerfile rules a generated
 * Dockerfile breaks (`dockerfileViolations` on the generate response).
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { DockerfileViolationsNotice } from '../src/components/plugin/AIPluginBuilderTab';

describe('DockerfileViolationsNotice', () => {
  it('renders nothing for a compliant Dockerfile', () => {
    const { container } = render(<DockerfileViolationsNotice violations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each broken rule', () => {
    render(<DockerfileViolationsNotice violations={['Final stage runs as root', 'Raw download not via fetch-verified']} />);
    expect(screen.getByText(/breaks 2 catalog rules/)).toBeInTheDocument();
    expect(screen.getByText('Final stage runs as root')).toBeInTheDocument();
    expect(screen.getByText('Raw download not via fetch-verified')).toBeInTheDocument();
  });

  it('uses the singular for one rule', () => {
    render(<DockerfileViolationsNotice violations={['Final stage runs as root']} />);
    expect(screen.getByText(/breaks a catalog rule/)).toBeInTheDocument();
  });
});
