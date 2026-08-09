# Hero Run Telegram bot : build from the REPO ROOT (needs both go/ and examples/):
#   docker build -f examples/telegram-bot/Dockerfile -t hero-run-bot .
#   docker run -e TELEGRAM_BOT_TOKEN=... -e HERO_RUN_KEY=... hero-run-bot
FROM golang:1.26-alpine AS build
ENV CGO_ENABLED=0
WORKDIR /src
COPY . .
RUN cd go && go build -o /out/hero-run-mcp . \
 && cd /src/examples/telegram-bot && go build -o /out/telegram-bot .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/hero-run-mcp /app/hero-run-mcp
COPY --from=build /out/telegram-bot /app/telegram-bot
ENV MCP_CMD=/app/hero-run-mcp
WORKDIR /app
# Long-poll worker (no ports). Provide TELEGRAM_BOT_TOKEN and HERO_RUN_KEY at run time.
ENTRYPOINT ["/app/telegram-bot"]
