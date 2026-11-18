import { useEffect, useEffectEvent } from 'react';
import { useRouter } from 'next/router';

/**
 * Opens a create flow when the page is navigated to with `?create=…` (used by
 * the sidebar Quick Actions), then strips the param so it doesn't re-open on
 * back/refresh. `open` runs once when the param is present, and receives the
 * param's VALUE so a page with more than one create surface can pick which —
 * `?create=upload` opens the plugin upload tab, anything else keeps the previous
 * `?create=1` behaviour. A caller that has only one flow can ignore the argument.
 *
 * `ready` holds the param until the caller can actually decide — in practice,
 * until the user profile (and so its permissions) has loaded. Without it the
 * param was consumed the moment the router was ready: on a full page load
 * `user` is still null, `canWrite` is false, `open` did nothing, and the param
 * was stripped anyway — so the Quick Actions / bookmarked `?create=1` URL never
 * opened the create modal, even for a user with write access. It only worked on
 * client-side navigation, where the profile was already loaded.
 */
export function useOpenOnCreateQuery(open: (value: string) => void, ready = true) {
  const router = useRouter();
  // The consume step is an Effect Event: it reads the newest `open` and router,
  // but neither re-triggers it — it fires on the create param (and readiness)
  // only, so a re-rendered `open` can't re-open the flow.
  const consume = useEffectEvent((raw: string | string[]) => {
    open(Array.isArray(raw) ? (raw[0] ?? '') : raw);
    const rest = { ...router.query };
    delete rest.create;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
  });
  const create = router.query.create;
  useEffect(() => {
    if (!ready || !router.isReady || !create) return;
    consume(create);
  }, [ready, router.isReady, create]);
}
