create role pipeline_builder with superuser login password 'password'
\connect pipeline_builder

create database pipeline_builder with owner pipeline_builder
create table pipeline_builder(
    id uuid primary key default gen_random_uuid(),
    created_at timestamp not null default current_timestamp,
    updated_at timestamp not null default current_timestamp,
    description text,
    is_active boolean default true
)