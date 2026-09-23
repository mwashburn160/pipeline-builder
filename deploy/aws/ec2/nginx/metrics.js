// Prometheus metrics for the nginx gateway — REAL counters only.
//
// The previous version published numbers that looked like metrics and were
// not: `nginx_http_requests_total` read a variable nginx does not have (so it
// was always 0), `nginx_uptime_seconds` was the current epoch time, and
// /metrics/services printed a hard-coded 0 for every service. Dashboards and
// alerts built on them could only ever be wrong.
//
// What is exported now:
//   nginx_up                                 1 while this worker answers
//   nginx_connections_{active,reading,writing,waiting}
//                                            stub_status counters (built into
//                                            the nginx image; exact, per instance)
//   nginx_http_requests_total{service,status_class}
//   nginx_http_request_duration_seconds_{bucket,sum,count}{service}
//                                            gateway-side request rate, 5xx
//                                            share and latency, per `$service`
//                                            (the bounded per-location label
//                                            every route already sets)
//
// The request counters live in a SHARED dict zone (nginx.conf:
// `js_shared_dict_zone zone=pb_metrics ... type=number`) so all workers add to
// one set of numbers, and are recorded at LOG time by `record` — nginx.conf
// references it from the `pb_metrics` access-log format, which is evaluated
// once per request after the response is sent, when $status and
// $request_time are final. Locations with `access_log off` (health, metrics
// itself) are therefore not counted, by design.

var BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function dict() {
    return (typeof ngx !== 'undefined' && ngx.shared) ? ngx.shared.pb_metrics : undefined;
}

// Bounded label value: `$service` is a literal set per location, but keep it
// to a safe charset regardless.
function svcLabel(r) {
    var s = r.variables.service || 'none';
    return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
}

// js_set handler, referenced ONLY from the pb_metrics log format. Returns ''.
function record(r) {
    var d = dict();
    if (!d) return '';
    var svc = svcLabel(r);
    var status = parseInt(r.variables.status, 10) || 0;
    var cls = status >= 100 && status < 600 ? Math.floor(status / 100) + 'xx' : 'other';
    d.incr('req|' + svc + '|' + cls, 1, 0);

    var t = parseFloat(r.variables.request_time);
    if (!isNaN(t)) {
        for (var i = 0; i < BUCKETS.length; i++) {
            if (t <= BUCKETS[i]) d.incr('lat|' + svc + '|' + BUCKETS[i], 1, 0);
        }
        d.incr('lat|' + svc + '|+Inf', 1, 0);
        // Sum in integer milliseconds (a number dict holds doubles, but an
        // integer sum never accumulates float error across millions of adds).
        d.incr('latms|' + svc, Math.round(t * 1000), 0);
    }
    return '';
}

function prometheus_metrics(r) {
    var v = r.variables;
    var out = [];
    out.push('# HELP nginx_up Nginx is up and running');
    out.push('# TYPE nginx_up gauge');
    out.push('nginx_up 1');
    var conns = ['active', 'reading', 'writing', 'waiting'];
    for (var c = 0; c < conns.length; c++) {
        var val = v['connections_' + conns[c]];
        if (val === undefined || val === '') continue;
        out.push('# HELP nginx_connections_' + conns[c] + ' Client connections (' + conns[c] + ')');
        out.push('# TYPE nginx_connections_' + conns[c] + ' gauge');
        out.push('nginx_connections_' + conns[c] + ' ' + val);
    }

    var d = dict();
    if (d) {
        var keys = d.keys();
        var req = [], svcs = {};
        for (var k = 0; k < keys.length; k++) {
            var parts = keys[k].split('|');
            if (parts[0] === 'req') {
                req.push('nginx_http_requests_total{service="' + parts[1] + '",status_class="' + parts[2] + '"} ' + d.get(keys[k]));
            } else {
                svcs[parts[1]] = true;
            }
        }
        out.push('# HELP nginx_http_requests_total Requests served by the gateway, by route service and status class');
        out.push('# TYPE nginx_http_requests_total counter');
        out = out.concat(req.sort());
        out.push('# HELP nginx_http_request_duration_seconds Gateway request latency ($request_time), by route service');
        out.push('# TYPE nginx_http_request_duration_seconds histogram');
        var names = Object.keys(svcs).sort();
        for (var s = 0; s < names.length; s++) {
            var svc = names[s];
            var les = BUCKETS.map(String).concat(['+Inf']);
            for (var b = 0; b < les.length; b++) {
                out.push('nginx_http_request_duration_seconds_bucket{service="' + svc + '",le="' + les[b] + '"} ' + (d.get('lat|' + svc + '|' + les[b]) || 0));
            }
            out.push('nginx_http_request_duration_seconds_sum{service="' + svc + '"} ' + ((d.get('latms|' + svc) || 0) / 1000));
            out.push('nginx_http_request_duration_seconds_count{service="' + svc + '"} ' + (d.get('lat|' + svc + '|+Inf') || 0));
        }
    }
    out.push('');
    return out.join('\n');
}

function get_metrics(r) {
    r.headersOut['Content-Type'] = 'text/plain; version=0.0.4';
    r.return(200, prometheus_metrics(r));
}

export default { get_metrics, prometheus_metrics, record };
