import { useEffect } from 'react';
import { useRouter } from 'next/router';

/**
 * Opens a create flow when the page is navigated to with `?create=1` (used by
 * the sidebar Quick Actions), then strips the param so it doesn't re-open on
 * back/refresh. `open` runs once when the param is present.
 *
 * `ready` holds the param until the caller can actually decide — in practice,
 * until the user profile (and so its permissions) has loaded. Without it the
 * param was consumed the moment the router was ready: on a full page load
 * `user` is still null, `canWrite` is false, `open` did nothing, and the param
 * was stripped anyway — so the Quick Actions / bookmarked `?create=1` URL never
 * opened the create modal, even for a user with write access. It only worked on
 * client-side navigation, where the profile was already loaded.
 */
export function useOpenOnCreateQuery(open: () => void, ready = true) {
  const router = useRouter();
  useEffect(() => {
    if (!ready || !router.isReady || !router.query.create) return;
    open();
    const rest = { ...router.query };
    delete rest.create;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    // `open` is intentionally excluded — fires once on the create param.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` excluded on purpose: this fires once, on the create param
  }, [ready, router.isReady, router.query.create]);
}
