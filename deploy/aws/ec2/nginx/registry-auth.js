// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Rewrites the Docker registry's WWW-Authenticate Bearer realm on the way out
// of the gateway's /v2/ location.
//
// The in-cluster registry advertises its token realm as
//   http://image-registry:3000/token
// which only resolves inside minikube. Out-of-cluster pull clients — notably
// AWS CodeBuild in the VPC — can't reach that, so on the 401 challenge we
// swap the realm host for the PUBLIC gateway URL the client already used
// (the inbound Host header), preserving the service and scope parameters so
// the issued token still carries the right pull scope:
//
//   Bearer realm="http://image-registry:3000/token",service="...",scope="..."
//     ->  Bearer realm="https://<Host>/image-registry/token",service="...",scope="..."
//
// Wired in via `js_header_filter registry_auth.rewrite_realm;` on the gateway's
// /v2/ location. The registry's own REGISTRY_AUTH_TOKEN_REALM stays internal,
// so in-cluster clients (buildkit) are unaffected — they never pass through
// this filter.

// Matches the in-cluster token realm the registry advertises, regardless of
// the internal host form — `image-registry:3000/token` (EC2 minikube) or
// `image-registry.pipeline-builder.local:3000/token` (Fargate Cloud Map).
// Only the realm URL is replaced; service + scope params are preserved.
var REALM_RE = /realm="https?:\/\/[^"]*\/token"/;

function rewrite_realm(r) {
    var header = r.headersOut['WWW-Authenticate'];
    if (!header || !REALM_RE.test(header)) {
        return;
    }
    var host = r.headersIn['Host'];
    if (!host) {
        return;
    }
    r.headersOut['WWW-Authenticate'] = header.replace(
        REALM_RE,
        'realm="https://' + host + '/image-registry/token"',
    );
}

export default { rewrite_realm };
