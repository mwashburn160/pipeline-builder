var crypto = require('crypto');

/**
 * Extract a named cookie value from the Cookie header.
 */
function parse_cookie(r, name) {
    var cookie = r.headersIn['Cookie'];
    if (!cookie) return null;

    var prefix = name + '=';
    var parts = cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (part.indexOf(prefix) === 0) {
            return part.substring(prefix.length);
        }
    }
    return null;
}

/**
 * Internal Helper: Verifies and decodes the token once.
 * Checks Authorization header first, then falls back to grafana_token cookie.
 */
function get_payload(r) {
    var rid = r.variables.request_id || 'unknown';
    var token = null;

    // 1. Try Authorization header
    var auth = r.headersIn['Authorization'];
    if (auth && auth.startsWith("Bearer ")) {
        token = auth.substring(7).trim();
    }

    // 2. Fall back to grafana_token cookie
    if (!token) {
        token = parse_cookie(r, 'grafana_token');
    }

    if (!token || token.length === 0) return null;

    // 3. Verify Signature
    if (!verify_token(r, token)) return null;

    try {
        // 4. Decode Payload
        var payloadB64 = token.split('.')[1];
        var payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

        // 5. Validate Expiry/Timing
        if (!validate_timing(r, payload)) return null;

        return payload;
    } catch (e) {
        r.error('[' + rid + '] [JWT] Parse error: ' + e.message);
        return null;
    }
}

function verify_token(r, token) {
    var parts = token.split('.');
    if (parts.length !== 3) return false;

    var secret = process.env.JWT_SECRET;
    if (!secret) {
        r.error('[JWT] JWT_SECRET not set in environment');
        return false;
    }

    var dataToVerify = parts[0] + '.' + parts[1];
    var hmac = crypto.createHmac('sha256', secret);
    hmac.update(dataToVerify);

    return hmac.digest('base64url') === parts[2];
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
