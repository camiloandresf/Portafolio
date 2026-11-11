FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /lab .
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 lab
WORKDIR /app
COPY --from=build /lab /app/lab
USER lab
ENV PORT=8080 CHROME_BIN=/usr/bin/chromium CHROME_NO_SANDBOX=1
EXPOSE 8080
CMD ["/app/lab"]
