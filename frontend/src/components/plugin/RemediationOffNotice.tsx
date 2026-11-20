// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Callout } from '@/components/ui/Callout';
import { REMEDIATION_OPERATOR_OFF_MESSAGE, REMEDIATION_OPERATOR_OFF_TITLE } from '@/lib/plugin-remediation';

/**
 * The one notice every remediation surface shows while the deployment knob
 * (`PLUGIN_REMEDIATION_ENABLED=false`) is off: nothing is built, published or
 * rolled out, and settings stay editable.
 */
export function RemediationOffNotice({ className = '' }: { className?: string }) {
  return (
    <Callout variant="neutral" title={REMEDIATION_OPERATOR_OFF_TITLE} className={className}>
      {REMEDIATION_OPERATOR_OFF_MESSAGE}
    </Callout>
  );
}
