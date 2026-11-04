/**
 * Stand-in for `undici`, swapped in by build.ts.
 *
 * cheerio only needs undici for `fromURL()`, which this extension never calls (pages are fetched through
 * utils/http). Bundling the real client drags node:net, tls, worker_threads and sqlite into bundle.js, and the
 * native Tatakai host refuses extensions that require those. Anything that does reach undici fails loudly.
 */

const unavailable = (): never => {
  throw new Error('undici is not bundled in this extension: cheerio.fromURL() is unavailable');
};

export class Client {
  constructor() {
    unavailable();
  }
}

export const interceptors = { redirect: unavailable };

export const errors = { ResponseError: class ResponseError extends Error {} };
