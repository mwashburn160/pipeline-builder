/*
 * Gateway identity HINTS for the access log and the x-org-id / x-user-id /
 * x-user-role headers.
 *
 * NO SIGNATURE VERIFICATION — deliberately, and no longer possible here.
 *
 * Every token that speaks for a person is now ES256, signed only by platform
 * and verified against the key set it publishes at /.well-known/jwks.json. njs
 * cannot do that in a `js_set` handler: picking the right key means an HTTP
 * fetch of the JWKS, and ECDSA verification in njs is only available through the
 * async WebCrypto API, while `js_set` variables must resolve synchronously. The
 * old check HMAC'd the token with the shared JWT_SECRET; that secret no longer
 * signs user tokens, so keeping it would have blanked these headers on every
 * request.
 *
 * Nothing is lost that was load-bearing. This was never an access gate — it only
 * populated variables; enforcement has always been each service's `requireAuth`,
 * which verifies the signature and then RE-DERIVES the request's tenant identity
 * from the verified claims (see api-core's auth middleware). The anti-spoof
 * property also survives: nginx OVERWRITES these headers on every proxied
 * request, so a client still cannot inject an x-org-id of its choosing — it can
 * only see the values from the token it actually presented, which the upstream
 * then verifies.
 *
 * Expiry/not-before are still checked, so an obviously dead token doesn't
 * pollute the log with a stale identity.
 */

/**
 * Internal helper: decode the bearer token's payload once.
 * Reads the token from the Authorization header.
 */
function get_payload(r) {
    var rid = r.variables.request_id || 'unknown';
    var token = null;

    // 1. Read the bearer token from the Authorization header
    var auth = r.headersIn['Authorization'];
    if (auth && auth.startsWith("Bearer ")) {
        token = auth.substring(7).trim();
    }

    if (!token || token.length === 0) return null;

    var parts = token.split('.');
    if (parts.length !== 3) return null;

    try {
        // 2. Decode payload (UNVERIFIED — see the note at the top of this file)
        var payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

        // 3. Validate expiry / not-before
        if (!validate_timing(r, payload)) return null;

        return payload;
    } catch (e) {
        r.error('[' + rid + '] [JWT] Parse error: ' + e.message);
        return null;
    }
}

function validate_timing(r, payload) {
    var now = Math.floor(Date.now() / 1000);
    if (payload.nbf && payload.nbf > now) return false;
    if (payload.exp && payload.exp < now) return false;
    return true;
}

/**
 * Exported functions for Nginx variables
 */
function get_org_id(r) {
    var payload = get_payload(r);
    if (!payload) return undefined;
    var orgId = payload.organizationId || payload.orgId || payload.org_id || payload.organization || "";
    return orgId.toString();
}

function get_user_id(r) {
    var payload = get_payload(r);
    if (!payload || !payload.sub) return undefined;
    return payload.sub.toString();
}

function get_role(r) {
    var payload = get_payload(r);
    if (!payload) return undefined;
    return payload.role || "";
}

function get_username(r) {
    var payload = get_payload(r);
    if (!payload) return "";
    return payload.username || payload.email || "";
}

export default { get_org_id, get_user_id, get_role, get_username };
