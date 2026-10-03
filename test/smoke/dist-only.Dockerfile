# Phase 6 dist-only smoke (phase-6-05): prove the published bundle boots with
# no node_modules and no dev dependencies. The tiny package.json only declares
# the ESM module type for dist/index.js (the distributed Action repository ships
# its own package.json); it installs nothing.
FROM node:24-alpine

WORKDIR /action
COPY dist/index.js dist/index.js
RUN printf '{"type":"module","private":true}\n' > package.json

ENTRYPOINT ["node", "dist/index.js"]
