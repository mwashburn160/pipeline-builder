FROM node:24-alpine AS build

WORKDIR /app
COPY . .
RUN npm install projen --global && \
    npm install
RUN projen build

FROM node:24-alpine AS production

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY --from=build /app/lib .

CMD ["node","index.js"]