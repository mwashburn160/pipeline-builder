function prometheus_metrics(r) {
    var now = Math.floor(Date.now() / 1000);
    var uptime = now;
    var metrics = [];
    metrics.push('# HELP nginx_up Nginx is up and running');
    metrics.push('# TYPE nginx_up gauge');
    metrics.push('nginx_up 1');
    metrics.push('');
    metrics.push('# HELP nginx_uptime_seconds Nginx uptime in seconds');
    metrics.push('# TYPE nginx_uptime_seconds counter');
    metrics.push('nginx_uptime_seconds ' + uptime);
    metrics.push('');
    metrics.push('# HELP nginx_timestamp_seconds Current timestamp');
    metrics.push('# TYPE nginx_timestamp_seconds gauge');
    metrics.push('nginx_timestamp_seconds ' + now);
    metrics.push('');
    metrics.push('# HELP nginx_http_requests_total Total HTTP requests');
    metrics.push('# TYPE nginx_http_requests_total counter');
    metrics.push('nginx_http_requests_total{server="' + (r.variables.server_name || 'localhost') + '"} ' + (r.variables.connections_requests || 0));
    metrics.push('');
    metrics.push('# HELP nginx_connections_active Active connections');
    metrics.push('# TYPE nginx_connections_active gauge');
    metrics.push('nginx_connections_active ' + (r.variables.connections_active || 0));
    metrics.push('');
    metrics.push('# HELP nginx_connections_reading Connections reading request');
    metrics.push('# TYPE nginx_connections_reading gauge');
    metrics.push('nginx_connections_reading ' + (r.variables.connections_reading || 0));
    metrics.push('');
    metrics.push('# HELP nginx_connections_writing Connections writing response');
    metrics.push('# TYPE nginx_connections_writing gauge');
    metrics.push('nginx_connections_writing ' + (r.variables.connections_writing || 0));
    metrics.push('');
    metrics.push('# HELP nginx_connections_waiting Idle keepalive connections');
    metrics.push('# TYPE nginx_connections_waiting gauge');
    metrics.push('nginx_connections_waiting ' + (r.variables.connections_waiting || 0));
    metrics.push('');
    metrics.push('# HELP nginx_build_info Nginx build information');
    metrics.push('# TYPE nginx_build_info gauge');
    metrics.push('nginx_build_info{version="' + (r.variables.nginx_version || 'unknown') + '"} 1');
    metrics.push('');
    return metrics.join('\n');
}

function json_metrics(r) {
    var now = Math.floor(Date.now() / 1000);
    var metrics = {
        timestamp: now,
        timestamp_iso: new Date().toISOString(),
        nginx: { version: r.variables.nginx_version || 'unknown', up: true },
        connections: {
            active: parseInt(r.variables.connections_active || 0),
            reading: parseInt(r.variables.connections_reading || 0),
            writing: parseInt(r.variables.connections_writing || 0),
            waiting: parseInt(r.variables.connections_waiting || 0)
        },
        requests: {
            total: parseInt(r.variables.connections_requests || 0),
            current: parseInt(r.variables.connections_active || 0)
        },
        server: {
            name: r.variables.server_name || 'localhost',
            port: r.variables.server_port || '8443'
        }
    };
    return JSON.stringify(metrics, null, 2);
}

function get_metrics(r) {
    var format = r.args.format || 'prometheus';
    var contentType = 'text/plain; version=0.0.4';
    var body = '';
    if (format === 'json') {
        contentType = 'application/json';
        body = json_metrics(r);
    } else {
        body = prometheus_metrics(r);
    }
    r.headersOut['Content-Type'] = contentType;
    r.return(200, body);
}

function service_metrics(r) {
    var services = ['platform','pipeline','plugin','quota','billing','frontend','auth','user','users','organizations','organization','invitation','logs'];
    var metrics = [];
    metrics.push('# HELP nginx_service_requests_total Total requests per service');
    metrics.push('# TYPE nginx_service_requests_total counter');
    for (var i = 0; i < services.length; i++) {
        metrics.push('nginx_service_requests_total{service="' + services[i] + '"} 0');
    }
    metrics.push('');
    r.headersOut['Content-Type'] = 'text/plain; version=0.0.4';
    r.return(200, metrics.join('\n'));
}

export default { get_metrics, prometheus_metrics, json_metrics, service_metrics };
