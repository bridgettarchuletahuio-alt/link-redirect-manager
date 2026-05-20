FROM oven/bun:latest

WORKDIR /app

COPY package.json .
COPY index.ts .

RUN bun install

EXPOSE 3000

CMD ["bun", "run", "index.ts"]
