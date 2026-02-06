#!/bin/sh

if [ ! -d ./db-data/mongodb ]; then
  mkdir -p ./db-data/mongodb/  
fi
if [ ! -d ./db-data/postgres ]; then
  mkdir -p ./db-data/postgres/  
fi
if [ ! -d ./registry-data ]; then
  mkdir -p ./registry-data   
fi
if [ ! -d ./pgadmin-data ]; then
  mkdir -p ./pgadmin-data   
fi

docker compose up --build --remove-orphans
