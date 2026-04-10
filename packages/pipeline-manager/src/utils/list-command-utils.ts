// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { printInfo, printKeyValue } from './output-utils';
import { formatDuration, validateBoolean, validateNumber, validateSort } from '../config/cli.constants';

/**
 * Common filter parameters shared by all list commands.
 */
export interface CommonFilterParams {
  id?: string | string[];
  isActive?: boolean;
  limit?: number;
  offset?: number;
  sort?: string;
}

/**
 * Extract common filter parameters (id, isActive, limit, offset, sort) from CLI options.
 */
export function buildCommonFilters(options: Record<string, unknown>): CommonFilterParams {
  const params: CommonFilterParams = {};

  if (options.id) {
    const idValue = options.id as string;
    params.id = idValue.includes(',') ? idValue.split(',').map((s: string) => s.trim()) : idValue;
  }

  if (options.isActive !== undefined) {
    params.isActive = validateBoolean(options.isActive as string, 'is-active');
  }

  params.limit = validateNumber(options.limit as string | number, 'limit', 1, 1000);
  params.offset = validateNumber(options.offset as string | number, 'offset', 0);

  const sort = validateSort(options.sort as string | undefined);
  if (sort) params.sort = sort;

  return params;
}

/**
 * Display pagination settings for a list command.
 */
export function displayPaginationInfo(filterParams: CommonFilterParams): void {
  console.log('');
  printInfo('Pagination Settings');
  printKeyValue({
    Limit: (filterParams.limit ?? 50).toString(),
    Offset: (filterParams.offset ?? 0).toString(),
    Sort: filterParams.sort || 'createdAt:desc',
  });
}

/**
 * Display statistics for list results (count and active count).
 */
export function displayListStatistics(items: Array<{ isActive?: boolean }>, entityName: string): void {
  if (items.length === 0) return;

  const activeCount = items.filter(p => p.isActive).length;

  console.log('');
  printInfo('Statistics');
  printKeyValue({
    [`Active ${entityName}`]: `${activeCount}/${items.length}`,
  });
}

/**
 * Display result summary after a list query completes.
 */
export function displayListResults(
  items: unknown[],
  total: number | undefined,
  hasMore: boolean,
  entityName: string,
  duration: number,
  filterParams: CommonFilterParams,
): void {
  printKeyValue({
    [`${entityName} Found`]: items.length.toString(),
    'Total Available': total !== undefined ? total.toString() : 'Unknown',
    'Has More': hasMore ? 'Yes' : 'No',
    'Request Duration': formatDuration(duration),
  });

  if (hasMore) {
    const currentOffset = filterParams.offset || 0;
    const nextOffset = currentOffset + (filterParams.limit || 50);
    console.log('');
    printInfo('More results available', {
      hint: `Use --offset ${nextOffset} to see next page`,
    });
  }
}
