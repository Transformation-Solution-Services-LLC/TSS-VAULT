# Vault as a container, for hosts other than Render (Render builds from
# render.yaml with its Node runtime). Needs DATABASE_URL at run time.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY lib ./lib
COPY public ./public
COPY server.js ./
USER node
EXPOSE 8796
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-8796}/api/health || exit 1
CMD ["node", "server.js"]
