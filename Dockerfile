FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV BOT_ONLY=1
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["node", "scripts/start-bot.mjs"]
