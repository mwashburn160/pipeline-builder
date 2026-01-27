db.createUser({
    user: 'admin',
    pwd: 'password',
    roles: [{
        db: 'admin',
        role: 'dbAdminAnyDatabase'
    }]
});
disableTelemetry()