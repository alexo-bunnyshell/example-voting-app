FROM node:18-alpine3.17 as dev

ENV NODE_ENV development

# Needed for VS Code Remote Development
RUN apk add musl libgcc libstdc++ git curl wget bash ca-certificates gcompat openssh-client
RUN apk add ffmpeg \
    exiftool \
    gettext

# need pm2
RUN npm install -g nodemon pm2

# App directory
RUN mkdir -p /app
WORKDIR /app

# App dependencies
COPY package*.json ./

# install dependencies
RUN npm i

# Copy app source code
COPY . .

# build
#RUN npm run build

# setup the entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod +x /usr/local/bin/docker-entrypoint

# RUN cp .env.sample .env


#Expose port and begin application
EXPOSE 9000



# Start the app
#CMD [ "npm", "run", "start:watch"]
# ENTRYPOINT [ "/bin/sh", "-c" ]
ENTRYPOINT [ "/usr/local/bin/docker-entrypoint" ]
CMD ["npx", "mocha", "--no-timeouts", "'tests/testVote.js'"]
