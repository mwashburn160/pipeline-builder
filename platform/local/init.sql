\connect pipeline_builder
create table if not exists pipeline_builder (
    id uuid primary key default gen_random_uuid(),
    created_by text not null default current_user,
    created_at timestamp not null default current_timestamp,
    updated_by text not null default current_user,
    updated_at timestamp not null default current_timestamp,
    description text,
    is_active boolean default true
)