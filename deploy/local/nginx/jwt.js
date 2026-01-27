var crypto = require('crypto');

function verify_token(r, token) {
    var rid = r.variables.request_id || 'unknown';
    var parts = token.split('.');
    if (parts.length !== 3) {
        r.warn('[' + rid + '] Malformed JWT: expected 3 parts, got ' + parts.length);
        return false;
    }

    var headerB64 = parts[0];
    var payloadB64 = parts[1];
    var signature = parts[2];

    var dataToVerify = headerB64 + '.' + payloadB64;
    var secret = process.env.JWT_SECRET;

    if (!secret) {
        r.error('[' + rid + '] JWT_SECRET is missing from environment');
        return false;
    }

    r.log('[' + rid + '] JWT_SECRET found (length: ' + secret.length + ')');

    try {
        var header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
        r.log('[' + rid + '] JWT algorithm: ' + header.alg);
        if (header.alg !== 'HS256') {
            r.warn('[' + rid + '] Unsupported JWT algorithm: ' + header.alg);
            return false;
        }

        var hmac = crypto.createHmac('sha256', secret);
        hmac.update(dataToVerify);
        var calcSignature = hmac.digest('base64url');

        if (calcSignature === signature) {
            r.log('[' + rid + '] JWT signature VERIFIED successfully');
            return true;
        } else {
            var calcPrefix = calcSignature.substring(0, 8);
            var sigPrefix = signature.substring(0, 8);
            r.warn('[' + rid + '] JWT signature mismatch - computed: ' + calcPrefix + '..., received: ' + sigPrefix + '...');
            return false;
        }
    } catch (e) {
        r.error('[' + rid + '] JWT crypto/parse error: ' + e.message);
        return false;
    }
}

function get_org_id(r) {
    var rid = r.variables.request_id || 'unknown';
    var auth = r.headersIn['Authorization'];

    if (!auth) {
        r.warn('[' + rid + '] No Authorization header present');
        return "";
    }

    if (!auth.startsWith("Bearer ")) {
        r.warn('[' + rid + '] Authorization header does not start with "Bearer " (value prefix: ' + auth.substring(0, 20) + '...)');
        return "";
    }

    var token = auth.substring(7).trim();
    r.log('[' + rid + '] Processing JWT token (prefix: ' + token.substring(0, 10) + '...)');

    if (!verify_token(r, token)) {
        r.warn('[' + rid + '] JWT verification failed - returning empty org_id');
        return "";
    }

    try {
        var payloadB64 = token.split('.')[1];
        var decoded = Buffer.from(payloadB64, 'base64url').toString();
        var payload = JSON.parse(decoded);

        var now = Math.floor(Date.now() / 1000);

        if (payload.nbf && payload.nbf > now) {
            r.warn('[' + rid + '] JWT not yet valid (nbf: ' + payload.nbf + ' > now: ' + now + ')');
            return "";
        }

        if (payload.exp && payload.exp < now) {
            r.warn('[' + rid + '] JWT expired (exp: ' + payload.exp + ' < now: ' + now + ', sub: ' + (payload.sub || 'unknown') + ')');
            return "";
        }

        r.log('[' + rid + '] JWT valid - sub: ' + (payload.sub || 'none') + ', iat: ' + (payload.iat || 'none') + ', exp: ' + (payload.exp || 'none'));

        var orgId = payload.organizationId || payload.orgId || payload.org_id || payload.organization || "";
        if (orgId) {
            r.log('[' + rid + '] Extracted org_id: ' + orgId);
        } else {
            r.warn('[' + rid + '] No organization claim found in payload');
        }

        return orgId.toString();

    } catch (e) {
        r.error('[' + rid + '] JWT payload decode/parse error: ' + e.message);
        return "";
    }
}

export default { get_org_id };