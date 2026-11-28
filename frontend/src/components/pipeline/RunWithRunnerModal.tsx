// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from 'react';
import { Play } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { noRunnerToRun, RunnerChoice, type RegisterRunner } from '@/components/deployments/RegisterDeploymentModal';

/**
 * Run pipeline for a REGISTERED pipeline that no runner is linked to: choose
 * the pipeline runner to run it with (the only one is asked about; several are
 * listed, an unreachable one can't be picked). The run probes only that
 * runner, which is linked once it finds the pipeline. When the runners can't
 * be read, Run still works: every runner is asked to find it.
 */
export function RunWithRunnerModal({ pipelineId, pipelineLabel, onRun, onClose, running = false }: {
  pipelineId: string;
  pipelineLabel: string;
  /** Start the run: with the chosen runner's id, or null to let every runner be asked. */
  onRun: (runnerId: string | null) => void;
  onClose: () => void;
  running?: boolean;
}) {
  const uid = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const info = useFetch(
    async (signal) => (await api.getRegisterRunners(pipelineId, { signal })).data ?? null,
    [pipelineId],
  );
  const facts = info.data;
  const loading = info.loading && !facts;
  const runners: RegisterRunner[] = facts?.available ? facts.runners : [];
  const usable = runners.filter((r) => r.health === 'healthy');
  const runner = usable.find((r) => r.id === picked) ?? (usable.length === 1 ? usable[0] : null);
  const needsPick = usable.length > 1 && !runner;
  const nothingToRunWith = noRunnerToRun(facts);
  const error = info.error && !facts ? formatError(info.error, 'Could not load the pipeline runners') : null;

  return (
    <Modal
      title="Run pipeline"
      onClose={() => running ? undefined : onClose()}
      maxWidth="max-w-lg"
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={running}>Cancel</Button>
          <Button
            onClick={() => onRun(runner?.id ?? null)}
            disabled={running || loading || needsPick || nothingToRunWith}
            className="inline-flex items-center gap-2"
          >
            <Play className="w-4 h-4" aria-hidden="true" />
            {runner ? `Run with ${runner.label}` : 'Run'}
          </Button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm" data-testid="run-with-runner">
        <RunnerChoice
          mode="run"
          uid={uid}
          loading={loading}
          error={error}
          onRetry={info.refetch}
          facts={facts}
          runners={runners}
          usable={usable}
          runner={runner}
          pipelineLabel={pipelineLabel}
          onPick={setPicked}
          disabled={running}
        />
      </div>
    </Modal>
  );
}
