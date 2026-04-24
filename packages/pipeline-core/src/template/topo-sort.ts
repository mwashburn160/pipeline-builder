// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export interface TopoNode {
  /** Unique key identifying this node (e.g. source field path) */
  key: string;
  /** Dependency keys that must resolve before this node */
  deps: string[];
}

export interface TopoResult {
  ordered: string[];
  cycles: string[][];
}

/**
 * Topologically sort a set of nodes by their declared dependency keys.
 * Returns `ordered` in resolution order, plus any detected cycles.
 * Nodes whose deps reference keys not in the node set are treated as
 * depending on "external" values and ordered first (no cycle risk).
 */
export function topoSort(nodes: TopoNode[]): TopoResult {
  const keys = new Set(nodes.map(n => n.key));
  const graph = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  // Init
  for (const n of nodes) {
    graph.set(n.key, new Set());
    inDegree.set(n.key, 0);
  }

  // Self-loops short-circuit — detected before topo-sort so single-node
  // cycles are reported even when Kahn's would otherwise accept them.
  const selfLoops: string[][] = [];
  for (const n of nodes) {
    if (n.deps.includes(n.key)) selfLoops.push([n.key, n.key]);
  }

  // Edges only between internal nodes (external deps resolve before pass starts)
  for (const n of nodes) {
    for (const dep of n.deps) {
      if (!keys.has(dep)) continue;
      if (dep === n.key) continue; // self-dep → already captured above
      // Edge: dep -> n.key (dep must come first)
      if (!graph.get(dep)!.has(n.key)) {
        graph.get(dep)!.add(n.key);
        inDegree.set(n.key, (inDegree.get(n.key) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const ordered: string[] = [];
  const queue: string[] = [];
  for (const [k, d] of inDegree) if (d === 0) queue.push(k);
  while (queue.length) {
    const k = queue.shift()!;
    ordered.push(k);
    for (const next of graph.get(k) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // Detect cycles: any node not in `ordered` is part of a cycle
  const cycles: string[][] = [...selfLoops];
  if (ordered.length < nodes.length) {
    const remaining = new Set(nodes.map(n => n.key).filter(k => !ordered.includes(k)));
    const visited = new Set<string>();
    for (const start of remaining) {
      if (visited.has(start)) continue;
      const path: string[] = [];
      const cycle = findCycle(start, graph, visited, path, remaining);
      if (cycle) cycles.push(cycle);
    }
  }

  return { ordered, cycles };
}

function findCycle(
  start: string,
  graph: Map<string, Set<string>>,
  visited: Set<string>,
  path: string[],
  remaining: Set<string>,
): string[] | null {
  if (path.includes(start)) {
    const idx = path.indexOf(start);
    return [...path.slice(idx), start];
  }
  if (visited.has(start) || !remaining.has(start)) return null;
  visited.add(start);
  path.push(start);
  for (const next of graph.get(start) ?? []) {
    const cycle = findCycle(next, graph, visited, path, remaining);
    if (cycle) return cycle;
  }
  path.pop();
  return null;
}
