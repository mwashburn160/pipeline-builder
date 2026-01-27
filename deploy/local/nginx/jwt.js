var crypto = require('crypto');

/**
 * Verify JWT token signature
 * 
 * @param {Object} r - nginx request object
 * @param {string} token - JWT token string
 * @returns {boolean} true if signature is valid
 */
function verify_token(r, token) {
    var rid = r.variables.request_id || 'unknown';
    var parts = token.split('.');
    
    if (parts.length !== 3) {
        r.warn('[' + rid + '] [JWT] Malformed token: expected 3 parts, got ' + parts.length);
        return false;
    }

    var headerB64 = parts[0];
    var payloadB64 = parts[1];
    var signature = parts[2];
    var dataToVerify = headerB64 + '.' + payloadB64;

    // Get JWT secret from environment
    var secret = process.env.JWT_SECRET;
    if (!secret) {
        r.error('[' + rid + '] [JWT] JWT_SECRET environment variable is not set');
        return false;
    }

    r.log('[' + rid + '] [JWT] Secret loaded (length: ' + secret.length + ')');

    try {
        // Parse and validate header
        var header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
        r.log('[' + rid + '] [JWT] Algorithm: ' + header.alg);
        
        if (header.alg !== 'HS256') {
            r.warn('[' + rid + '] [JWT] Unsupported algorithm: ' + header.alg + ' (only HS256 supported)');
            return false;
        }

        // Verify signature
        var hmac = crypto.createHmac('sha256', secret);
        hmac.update(dataToVerify);
        var calcSignature = hmac.digest('base64url');

        if (calcSignature === signature) {
            r.log('[' + rid + '] [JWT] Signature verified successfully');
            return true;
        } else {
            var calcPrefix = calcSignature.substring(0, 12);
            var sigPrefix = signature.substring(0, 12);
            r.warn('[' + rid + '] [JWT] Signature mismatch - expected: ' + calcPrefix + '..., got: ' + sigPrefix + '...');
            return false;
        }
    } catch (e) {
        r.error('[' + rid + '] [JWT] Verification error: ' + e.message);
        return false;
    }
}

/**
 * Validate JWT token timing claims (nbf, exp)
 * 
 * @param {Object} r - nginx request object
 * @param {Object} payload - decoded JWT payload
 * @returns {boolean} true if token is currently valid
 */
function validate_timing(r, payload) {
    var rid = r.variables.request_id || 'unknown';
    var now = Math.floor(Date.now() / 1000);

    // Check "not before" claim
    if (payload.nbf && payload.nbf > now) {
        var diff = payload.nbf - now;
        r.warn('[' + rid + '] [JWT] Token not yet valid (nbf: ' + payload.nbf + ', now: ' + now + ', diff: ' + diff + 's)');
        return false;
    }

    // Check expiration claim
    if (payload.exp && payload.exp < now) {
        var diff = now - payload.exp;
        r.warn('[' + rid + '] [JWT] Token expired (exp: ' + payload.exp + ', now: ' + now + ', diff: ' + diff + 's, sub: ' + (payload.sub || 'unknown') + ')');
        return false;
    }

    // Log token validity period
    if (payload.iat && payload.exp) {
        var lifetime = payload.exp - payload.iat;
        var remaining = payload.exp - now;
        r.log('[' + rid + '] [JWT] Token valid - lifetime: ' + lifetime + 's, remaining: ' + remaining + 's');
    }

    return true;
}

/**
 * Extract organization ID from JWT token
 * 
 * Checks multiple possible claim names:
 * - organizationId (primary)
 * - orgId
 * - org_id
 * - organization
 * 
 * @param {Object} r - nginx request object
 * @returns {string} organization ID or empty string
 */
function get_org_id(r) {
    var rid = r.variables.request_id || 'unknown';
    var auth = r.headersIn['Authorization'];

    // Check for Authorization header
    if (!auth) {
        r.warn('[' + rid + '] [JWT] No Authorization header present');
        return "";
    }

    // Check for Bearer prefix
    if (!auth.startsWith("Bearer ")) {
        r.warn('[' + rid + '] [JWT] Authorization header missing "Bearer " prefix (value: ' + auth.substring(0, 20) + '...)');
        return "";
    }

    // Extract token
    var token = auth.substring(7).trim();
    if (token.length === 0) {
        r.warn('[' + rid + '] [JWT] Empty token after "Bearer " prefix');
        return "";
    }

    r.log('[' + rid + '] [JWT] Processing PLATFORM_TOKEN (prefix: ' + token.substring(0, 15) + '...)');

    // Verify token signature
    if (!verify_token(r, token)) {
        r.warn('[' + rid + '] [JWT] Verification failed - returning empty org_id');
        return "";
    }

    try {
        // Decode payload
        var payloadB64 = token.split('.')[1];
        var decoded = Buffer.from(payloadB64, 'base64url').toString();
        var payload = JSON.parse(decoded);

        // Validate timing
        if (!validate_timing(r, payload)) {
            r.warn('[' + rid + '] [JWT] Timing validation failed - returning empty org_id');
            return "";
        }

        // Log token claims
        r.log('[' + rid + '] [JWT] Token claims - sub: ' + (payload.sub || 'none') + 
              ', iat: ' + (payload.iat || 'none') + 
              ', exp: ' + (payload.exp || 'none'));

        // Extract organization ID (check multiple possible claim names)
        var orgId = payload.organizationId || 
                    payload.orgId || 
                    payload.org_id || 
                    payload.organization || 
                    "";

        if (orgId) {
            r.log('[' + rid + '] [JWT] Organization ID extracted: ' + orgId);
            return orgId.toString();
        } else {
            r.warn('[' + rid + '] [JWT] No organization claim found in token payload (checked: organizationId, orgId, org_id, organization)');
            return "";
        }

    } catch (e) {
        r.error('[' + rid + '] [JWT] Payload decode/parse error: ' + e.message);
        return "";
    }
}

// Export functions for use in nginx config
export default { 
    get_org_id
};