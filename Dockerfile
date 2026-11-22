# Life Web Cloud: Node 24 has SQLite built in, so the image needs nothing else.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV LIFEWEB_DATA=/data NODE_ENV=production
EXPOSE 3095
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
