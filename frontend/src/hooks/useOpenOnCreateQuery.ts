import { useEffect } from 'react';
import { useRouter } from 'next/router';

/**
 * Opens a create flow when the page is navigated to with `?create=1` (used by
 * the sidebar Quick Actions), then strips the param so it doesn't re-open on
 * back/refresh. `open` runs once when the param is present.
 */
export function useOpenOnCreateQuery(open: () => void) {
  const router = useRouter();
  useEffect(() => {
    if (!router.isReady || !router.query.create) return;
    open();
    const rest = { ...router.query };
    delete rest.create;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    // `open` is intentionally excluded — fires once on the create param.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.create]);
}
