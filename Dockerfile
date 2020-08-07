FROM buildkite/puppeteer

# Install dependencies
COPY package.json yarn.lock /
WORKDIR /
RUN yarn

# Run twins-notification
COPY . /
CMD ["yarn", "start"]
