// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `expandNodeDisk` — the EC2/SSM actuator behind NodeDiskFillingUp — with the
 * AWS SDK clients, IMDS and Redis stubbed and everything else real.
 *
 * Pins the safety discipline the module promises: disabled is a no-op; no Redis
 * fails CLOSED; the cooldown is an atomic SET NX; the volume lookup is narrowed
 * to THIS instance + the data-volume tag; the ceiling is measured from the
 * first-seen size (tagged once, then read back so it cannot compound) and the
 * maxGi cap; the SSM call names one fixed document with NO parameters; and the
 * cooldown is released only when the irreversible ModifyVolume did not run — a
 * resize failure after it is the distinct `fs-resize-failed`, holding the lock.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';

type Cmd = { __type: string; input: Record<string, any> };
const ec2Sent: Cmd[] = [];
const ssmSent: Cmd[] = [];
const ec2Clients: Array<Record<string, unknown>> = [];
let ec2Reply: (cmd: Cmd) => unknown = () => ({});
let ssmReply: (cmd: Cmd) => unknown = () => ({ Command: { CommandId: 'cmd-1' } });

const command = (name: string) => class { readonly __type = name; constructor(public input: Record<string, any>) {} };

jest.unstable_mockModule('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    constructor(cfg: Record<string, unknown>) { ec2Clients.push(cfg); }
    async send(cmd: Cmd) { ec2Sent.push(cmd); return ec2Reply(cmd); }
  },
  DescribeVolumesCommand: command('DescribeVolumes'),
  ModifyVolumeCommand: command('ModifyVolume'),
  CreateTagsCommand: command('CreateTags'),
}));
jest.unstable_mockModule('@aws-sdk/client-ssm', () => ({
  SSMClient: class { async send(cmd: Cmd) { ssmSent.push(cmd); return ssmReply(cmd); } },
  SendCommandCommand: command('SendCommand'),
}));

const redis = {
  set: jest.fn<(...a: unknown[]) => Promise<string | null>>(),
  del: jest.fn<(...a: unknown[]) => Promise<number>>(),
};
let redisAvailable = true;
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: async () => (redisAvailable ? redis : null),
}));

const mockIncCounter = jest.fn();
const mockSetGauge = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  setGauge: (...a: unknown[]) => mockSetGauge(...a),
  observe: jest.fn(),
}));

const { expandNodeDisk, nextVolumeGi, ORIGINAL_TAG } = await import('../src/services/node-disk-autoexpand.js');

const CFG = {
  enabled: true,
  resizeDocument: 'PipelineBuilderResizeData',
  region: 'us-east-1',
  stepFactor: 1.5,
  ceilingFactor: 4,
  maxGi: 1000,
  cooldownSeconds: 21600,
};

const realFetch = global.fetch;
const imds = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let instance = 'i-0abc123def';

beforeEach(() => {
  ec2Sent.length = 0;
  ssmSent.length = 0;
  ec2Clients.length = 0;
  redisAvailable = true;
  redis.set.mockReset().mockResolvedValue('OK');
  redis.del.mockReset().mockResolvedValue(1);
  mockIncCounter.mockReset();
  mockSetGauge.mockReset();
  instance = 'i-0abc123def';
  imds.mockReset().mockImplementation(async (url) => new Response(url.endsWith('/api/token') ? 'imds-token' : instance));
  global.fetch = imds as unknown as typeof fetch;
  ec2Reply = (cmd) => (cmd.__type === 'DescribeVolumes'
    ? { Volumes: [{ VolumeId: 'vol-1', Size: 100, Tags: [{ Key: 'pipeline-builder-data-volume', Value: 'stack' }] }] }
    : {});
  ssmReply = () => ({ Command: { CommandId: 'cmd-1' } });
});

afterAll(() => { global.fetch = realFetch; });

const result = () => mockIncCounter.mock.calls.map((c) => (c[1] as { result: string }).result);

describe('nextVolumeGi', () => {
  it('steps by the factor, clamps to the ceiling, and refuses at/over it', () => {
    expect(nextVolumeGi(100, 100, CFG)).toEqual({ toGi: 150 });
    expect(nextVolumeGi(350, 100, CFG)).toEqual({ toGi: 400 });
    expect(nextVolumeGi(400, 100, CFG)).toEqual({ atCeiling: true, ceilingGi: 400 });
    // maxGi binds before ceilingFactor does.
    expect(nextVolumeGi(900, 500, CFG)).toEqual({ toGi: 1000 });
    expect(nextVolumeGi(1000, 500, CFG)).toEqual({ atCeiling: true, ceilingGi: 1000 });
    // A step too small to reach the next whole GiB is no growth at all.
    expect(nextVolumeGi(10, 10, { ...CFG, stepFactor: 1.0 })).toEqual({ atCeiling: true, ceilingGi: 40 });
  });
});

describe('expandNodeDisk — refusals before any AWS call', () => {
  it('disabled: does nothing', async () => {
    expect(await expandNodeDisk({ ...CFG, enabled: false })).toMatchObject({ outcome: 'disabled' });
    expect(redis.set).not.toHaveBeenCalled();
    expect(ec2Sent).toHaveLength(0);
  });

  it('no Redis: fails CLOSED (no cooldown, no lock → no expansion)', async () => {
    redisAvailable = false;
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/Redis unavailable/) });
    expect(ec2Sent).toHaveLength(0);
  });

  it('inside the cooldown: SET NX lost → cooldown, no AWS call', async () => {
    redis.set.mockResolvedValue(null);
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'cooldown' });
    expect(redis.set).toHaveBeenCalledWith('node-disk:autoexpand:data-volume', expect.any(String), 'EX', 21600, 'NX');
    expect(ec2Sent).toHaveLength(0);
  });
});

describe('expandNodeDisk — the happy path', () => {
  it('first expansion: tags the original size, grows the volume, requests the fixed resize document', async () => {
    const out = await expandNodeDisk(CFG);
    expect(out).toEqual({ outcome: 'expanded', volumeId: 'vol-1', fromGi: 100, toGi: 150 });

    // IMDSv2: token first, then the id with the token.
    expect(imds.mock.calls[0][0]).toBe('http://169.254.169.254/latest/api/token');
    expect(imds.mock.calls[0][1]?.method).toBe('PUT');
    expect((imds.mock.calls[1][1]?.headers as Record<string, string>)['x-aws-ec2-metadata-token']).toBe('imds-token');

    expect(ec2Clients[0]).toEqual({ region: 'us-east-1' });
    expect(ec2Sent.map((c) => c.__type)).toEqual(['DescribeVolumes', 'CreateTags', 'ModifyVolume']);
    expect(ec2Sent[0].input.Filters).toEqual([
      { Name: 'attachment.instance-id', Values: [instance] },
      { Name: 'tag-key', Values: ['pipeline-builder-data-volume'] },
    ]);
    expect(ec2Sent[1].input).toEqual({ Resources: ['vol-1'], Tags: [{ Key: ORIGINAL_TAG, Value: '100' }] });
    expect(ec2Sent[2].input).toEqual({ VolumeId: 'vol-1', Size: 150 });

    expect(ssmSent).toHaveLength(1);
    expect(ssmSent[0].input).toMatchObject({ DocumentName: 'PipelineBuilderResizeData', InstanceIds: [instance] });
    expect(ssmSent[0].input).not.toHaveProperty('Parameters');

    expect(result()).toEqual(['expanded']);
    expect(mockSetGauge).toHaveBeenCalledWith('node_disk_autoexpand_fs_pending', { volume_id: 'vol-1' }, 0);
    // The cooldown is HELD after a successful expansion.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('a later expansion reads the ceiling from the original tag and does not re-tag', async () => {
    ec2Reply = (cmd) => (cmd.__type === 'DescribeVolumes'
      ? { Volumes: [{ VolumeId: 'vol-1', Size: 300, Tags: [{ Key: ORIGINAL_TAG, Value: '100' }] }] }
      : {});
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'expanded', fromGi: 300, toGi: 400 });
    expect(ec2Sent.map((c) => c.__type)).toEqual(['DescribeVolumes', 'ModifyVolume']);
  });
});

describe('expandNodeDisk — safety limits and failures', () => {
  it('at the ceiling: refuses, raises the at-ceiling gauge, releases nothing and modifies nothing', async () => {
    ec2Reply = (cmd) => (cmd.__type === 'DescribeVolumes'
      ? { Volumes: [{ VolumeId: 'vol-1', Size: 400, Tags: [{ Key: ORIGINAL_TAG, Value: '100' }] }] }
      : {});
    const out = await expandNodeDisk(CFG);
    expect(out).toMatchObject({ outcome: 'at-ceiling', volumeId: 'vol-1', fromGi: 400 });
    expect(ec2Sent.map((c) => c.__type)).toEqual(['DescribeVolumes']);
    expect(mockSetGauge).toHaveBeenCalledWith('node_disk_autoexpand_at_ceiling', { volume_id: 'vol-1' }, 1);
    expect(ssmSent).toHaveLength(0);
  });

  it.each([
    ['no volume', { Volumes: [] }],
    ['a volume with no size', { Volumes: [{ VolumeId: 'vol-1' }] }],
  ])('%s attached: not-found, and the cooldown is released', async (_name, reply) => {
    ec2Reply = () => reply;
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'not-found', detail: expect.stringContaining(instance) });
    expect(redis.del).toHaveBeenCalledWith('node-disk:autoexpand:data-volume');
  });

  it('an implausible IMDS instance id is an error BEFORE any AWS call, releasing the cooldown', async () => {
    instance = '<html>captive portal</html>';
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/implausible instance id/) });
    expect(ec2Sent).toHaveLength(0);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('IMDS unreachable: error, cooldown released', async () => {
    imds.mockRejectedValue(new Error('connect ETIMEDOUT 169.254.169.254:80'));
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/ETIMEDOUT/) });
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('ModifyVolume refused (EBS 6h modification window): error, cooldown released, no SSM', async () => {
    ec2Reply = (cmd) => {
      if (cmd.__type === 'ModifyVolume') throw new Error('VolumeModificationRateExceeded');
      return cmd.__type === 'DescribeVolumes' ? { Volumes: [{ VolumeId: 'vol-1', Size: 100, Tags: [] }] } : {};
    };
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'error', detail: 'VolumeModificationRateExceeded' });
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(ssmSent).toHaveLength(0);
  });

  it('a cooldown release that itself fails does not mask the outcome', async () => {
    ec2Reply = () => ({ Volumes: [] });
    redis.del.mockRejectedValue(new Error('redis gone'));
    expect(await expandNodeDisk(CFG)).toMatchObject({ outcome: 'not-found' });
  });

  it('volume grown but the SSM resize refused: fs-resize-failed, cooldown HELD, pending gauge raised', async () => {
    ssmReply = () => { throw new Error('AccessDeniedException: not authorized to perform ssm:SendCommand'); };
    const out = await expandNodeDisk(CFG);
    expect(out).toMatchObject({ outcome: 'fs-resize-failed', volumeId: 'vol-1', fromGi: 100, toGi: 150 });
    expect(out.detail).toMatch(/PipelineBuilderResizeData/);
    expect(redis.del).not.toHaveBeenCalled();
    expect(mockSetGauge).toHaveBeenCalledWith('node_disk_autoexpand_fs_pending', { volume_id: 'vol-1' }, 1);
    expect(result()).toEqual(['fs-resize-failed']);
  });
});
