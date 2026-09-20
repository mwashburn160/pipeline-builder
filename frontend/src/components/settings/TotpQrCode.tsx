// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useFetch } from '@/hooks/useFetch';

/**
 * The enrolment QR code, drawn as real SVG rectangles.
 *
 * `uqr` is loaded with a dynamic `import()` for two reasons: nothing but this one
 * panel in Settings → Security needs a QR encoder, and the encoder touches no
 * browser API, so keeping it out of the initial bundle costs nothing. It returns
 * the raw module matrix (`boolean[][]`), which is why this renders `<rect>`
 * elements rather than injecting a markup string — no `dangerouslySetInnerHTML`
 * on a screen whose entire job is handling a secret.
 *
 * A failure to encode is NOT fatal: the panel always shows the base32 secret for
 * manual entry, so the caller renders that instead of an error.
 */
export function TotpQrCode({ value, size = 180 }: { value: string; size?: number }) {
  const { data: matrix, error } = useFetch<boolean[][]>(async () => {
    const { encode } = await import('uqr');
    // `M` (~15% recovery) is what authenticator apps are tuned for — higher
    // levels make the modules smaller for no practical gain on a screen.
    // `border` is the quiet zone, and it is part of the returned matrix; two
    // modules plus the element's own white padding is what cameras need to
    // find the symbol's edges.
    return encode(value, { ecc: 'M', border: 2 }).data;
  }, [value]);

  if (error) {
    return (
      <p className="text-xs text-fg-muted" role="status">
        Couldn&apos;t draw the QR code — enter the setup key below by hand instead.
      </p>
    );
  }

  if (!matrix) {
    return <div style={{ width: size, height: size }} className="rounded bg-surface-muted animate-pulse" aria-hidden="true" />;
  }

  const modules = matrix.length;
  return (
    <svg
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      role="img"
      aria-label="Scan this QR code with your authenticator app"
      // White ground regardless of theme: a dark-mode QR with an inverted or
      // transparent background is unreadable to phone cameras.
      className="rounded bg-white p-2"
      shapeRendering="crispEdges"
    >
      {matrix.map((row, y) => row.map((on, x) => (on
        ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000000" />
        : null)))}
    </svg>
  );
}
