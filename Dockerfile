FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node server.mjs style.css board.js ./
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3030 HACKFLOW_MODE=review
EXPOSE 3030
CMD ["node", "server.mjs"]

