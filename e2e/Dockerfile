# Official image: Node.js, Playwright and all browsers with their OS dependencies.
# Keep the tag in sync with @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN chmod +x scripts/*.sh

ENV CI=true \
    REPORT_DIR=/app/playwright-report \
    REPORT_PORT=9323

EXPOSE 9323
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
