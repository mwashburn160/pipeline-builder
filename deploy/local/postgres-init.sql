\connect pipeline_builder

create or replace function update_modified_column()
returns trigger as $$
begin
    new.updated_at = current_timestamp;
    return new;
end;
$$ language 'plpgsql';

create table if not exists plugins (
    id              uuid primary key default gen_random_uuid(),
    org_id          varchar(100) not null default 'system',
    created_by      varchar(100) not null default 'system',
    created_at      timestamptz not null default current_timestamp,
    updated_by      varchar(100) not null default 'system',
    updated_at      timestamptz not null default current_timestamp,
    name            varchar(150) not null,
    description     text,
    keywords        jsonb not null default '{}',
    version         varchar(20) not null default '1.0.0',
    metadata        jsonb not null default '{}',
    plugin_type     varchar(50) not null default 'CodeBuildStep',
    compute_type    varchar(20) not null default 'SMALL',
    privileged      boolean not null default false,
    env             jsonb not null default '{}',
    install_commands varchar(512)[] not null default '{}',
    commands        varchar(512)[] not null default '{}',
    image_tag       varchar(128) not null unique,
    access_modifier varchar(10) not null default 'public' check (access_modifier in ('public', 'private')),
    is_default      boolean not null default false
);

create table if not exists pipelines (
    id              uuid primary key default gen_random_uuid(),
    org_id          varchar(100) not null default 'system',
    created_by      varchar(100) not null default 'system',
    created_at      timestamptz not null default current_timestamp,
    updated_by      varchar(100) not null default 'system',
    updated_at      timestamptz not null default current_timestamp,
    project         varchar(100) not null,
    organization    varchar(100) not null,
    description     text,
    keywords        jsonb not null default '[]',
    props           jsonb not null default '{}',
    access_modifier varchar(10) not null default 'public' check (access_modifier in ('public', 'private')),
    is_default      boolean not null default false
);

create trigger update_plugins_modtime before update on plugins for each row execute procedure update_modified_column();
create trigger update_pipelines_modtime before update on pipelines for each row execute procedure update_modified_column();