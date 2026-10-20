FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV BOT_ONLY=1
ENV PYTHONUNBUFFERED=1
ENV PYTHON_BIN=/usr/bin/python3

RUN apt-get update 
&& apt-get install -y --no-install-recommends 
python3 
python3-pip 
ca-certificates 
&& test -x /usr/bin/python3 
&& /usr/bin/python3 --version 
&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 8080

CMD ["node", "scripts/start-bot.mjs"]
