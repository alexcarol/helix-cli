/*
 * Copyright 2018 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import { Socket } from 'net';
import { PassThrough } from 'stream';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// eslint-disable-next-line import/no-unresolved
import { parseCookie } from 'cookie';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { select, selectAll } from 'hast-util-select';
import { toHtml } from 'hast-util-to-html';
import { getFetch } from '../fetch-utils.js';

// Load console interceptor script at startup
// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlParser = unified().use(rehypeParse);
const CONSOLE_INTERCEPTOR = readFileSync(
  path.join(__dirname, '../../packages/browser-injectables/src/console-interceptor.js'),
  'utf-8',
);
const DA_CONTENT_AUTH_SCRIPT = readFileSync(
  path.join(__dirname, '../../packages/browser-injectables/src/da-content-auth.js'),
  'utf-8',
);

/**
 * @param {object} properties hast properties
 * @param {object[]} [children] hast nodes
 * @returns {object} a hast `div` element
 */
function div(properties, children = []) {
  return {
    type: 'element', tagName: 'div', properties, children,
  };
}

function hasClass(node) {
  return !!node.properties?.className?.length;
}

function elementChildren(node) {
  return node.children.filter((n) => n.type === 'element');
}

/**
 * A block is a `div` with a class whose children are class-less row `div`s made of class-less
 * cell `div`s. Any other top-level `div` is a section.
 * @param {object} node hast element
 * @returns {boolean} true if the node is a block
 */
function isBlock(node) {
  return hasClass(node) && elementChildren(node).every(($row) => $row.tagName === 'div'
    && !hasClass($row)
    && elementChildren($row).every(($cell) => $cell.tagName === 'div' && !hasClass($cell)));
}

/**
 * The html pipeline turns a section-metadata block into the section's classes (`style`), `id`
 * and `data-*` attributes, so a .plain.html copied from aem.page has them already applied.
 * html2md only knows the authored form and drops section attributes, so turn them back into a
 * section-metadata block.
 * @param {object} $section hast section `div`
 * @returns {object} the section in its authored form
 */
function toAuthoredSection($section) {
  const { className = [], id, ...properties } = $section.properties;
  const rows = [];
  if (className.length) {
    rows.push(['style', className.join(', ')]);
  }
  if (id) {
    rows.push(['id', String(id)]);
  }
  Object.entries(properties)
    .filter(([name]) => /^data[A-Z0-9]/.test(name))
    .forEach(([name, value]) => rows.push([
      // hast stores `data-foo-bar` as `dataFooBar`
      name.slice(4).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^-/, ''),
      String(value),
    ]));
  if (!rows.length) {
    return $section;
  }
  return div({}, [
    ...$section.children,
    div({ className: ['section-metadata'] }, rows.map(([name, value]) => div({}, [
      div({}, [{ type: 'text', value: name }]),
      div({}, [{ type: 'text', value }]),
    ]))),
  ]);
}

/**
 * Groups top-level content into sections, the only top-level nodes html2md keeps: runs of
 * content outside a section `div` (including blocks without a section) get a section of their
 * own, and sections are brought back to their authored form.
 * @param {object[]} nodes top-level hast nodes
 * @returns {object[]} section `div`s
 */
function toSections(nodes) {
  const sections = [];
  let stray = null;
  nodes.forEach((node) => {
    if (node.type === 'element' && node.tagName === 'div' && !isBlock(node)) {
      stray = null;
      sections.push(toAuthoredSection(node));
    } else if (node.type === 'comment' || (node.type === 'text' && !node.value.trim())) {
      (stray?.children ?? sections).push(node);
    } else {
      if (!stray) {
        stray = div({});
        sections.push(stray);
      }
      stray.children.push(node);
    }
  });
  return sections;
}

const utils = {
  status2level(status, debug3xx) {
    if (status < 300) {
      return 'debug';
    }
    if (status < 400) {
      return debug3xx ? 'debug' : 'info';
    }
    if (status < 500) {
      return 'warn';
    }
    return 'error';
  },

  /**
   * Checks if the file addressed by the given filename exists and is a regular file.
   * @param {String} filename Path to file
   * @returns {Promise} Returns promise that resolves with the filename or rejects if is not a file.
   */
  async isFile(filename) {
    const stats = await fs.stat(filename);
    if (!stats.isFile()) {
      throw Error(`no regular file: ${filename}`);
    }
    return filename;
  },

  /**
   * Fetches content from the given uri
   * @param {String} uri URL to fetch
   * @param {RequestContext} ctx the context
   * @param {object} auth authentication object ({@see https://github.com/request/request#http-authentication})
   * @returns {Buffer} The requested content or NULL if not exists.
   */
  async fetch(ctx, uri, auth) {
    const headers = {
      'X-Request-Id': ctx.requestId,
    };
    if (auth) {
      headers.authorization = `Bearer ${auth}`;
    }
    const res = await getFetch(ctx.config.allowInsecure)(uri, {
      cache: 'no-store',
      headers,
    });
    const body = await res.buffer();
    if (!res.ok) {
      const level = utils.status2level(res.status);
      ctx.log[level](`resource at ${uri} does not exist. got ${res.status} from server`);
      return null;
    }
    return body;
  },

  /**
   * Injects the live-reload script
   * @param {string} body the html body
   * @param {HelixServer} server the proxy server
   * @returns {string} the modified body
   */
  injectLiveReloadScript(body, server) {
    let match = body.match(/<\/head>/i);
    if (!match) {
      match = body.match(/<\/body>/i);
    }
    if (!match) {
      match = body.match(/<\/html>/i);
    }
    // don't inject if no html found at all.
    if (match) {
      const { index } = match;
      // eslint-disable-next-line no-param-reassign
      const nonceMatch = body.match(/nonce="([a-zA-Z0-9+/=]+)"/);
      const nonce = nonceMatch ? ` nonce="${nonceMatch[1]}"` : '';
      let newbody = body.substring(0, index);
      if (process.env.CODESPACES === 'true') {
        newbody += `<script${nonce}>
window.LiveReloadOptions = { 
  host: new URL(location.href).hostname.replace(/-[0-9]+\\.preview\\.app\\.github\\.dev/, '-35729.preview.app.github.dev'), 
  port: 443,
  https: true,
};
</script>`;
      } else {
        newbody += `<script${nonce}>window.LiveReloadOptions={port:${server.port},host:location.hostname,https:${server.scheme === 'https'}};</script>`;
      }
      newbody += `<script${nonce} src="/__internal__/livereload.js"></script>`;

      // Inject console interceptor if browser log forwarding is enabled
      if (server.forwardBrowserLogs) {
        newbody += `<script${nonce}>${CONSOLE_INTERCEPTOR}</script>`;
      }

      newbody += body.substring(index);
      return newbody;
    }
    return body;
  },

  /**
   * Injects meta tags
   * @param {string} body the html body
   * @param {object} props meta properties
   * @returns {string} the modified body
   */
  injectMeta(body, props) {
    const match = body.match(/<\/head>/i);
    if (!match) {
      return body;
    }
    const text = Object.entries(props).map(([property, content]) => {
      const c = content
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
      return `<meta property="${property}" content="${c}">`;
    }).join('\n');

    const { index } = match;
    return `${body.substring(0, index)}${text}${body.substring(index)}`;
  },

  /**
   * Computes a path to store a cache objet from a url
   * @param {string} url the url
   * @param {string} directory a local directory path
   * @returns {string} the computed path
   */
  computePathForCache(url, directory) {
    const u = new URL(url);
    const { pathname, search } = u;
    let fileName = pathname.substring(1);
    if (fileName.endsWith('/') || fileName === '') {
      fileName += 'index.html';
    }
    if (search) {
      let qs = search.substring(1); // remove leading '?'
      if (fileName.length + qs.length > 255) {
        // try with query string as md5
        qs = crypto.createHash('md5').update(qs).digest('hex');
      }
      if (fileName.length + qs.length <= 255) {
        const index = fileName.lastIndexOf('.');
        if (index > -1) {
          // inject qs before extension
          fileName = `${fileName.substring(0, index)}!${qs}${fileName.substring(index)}`;
        } else {
          fileName = `${fileName}!${qs}`;
        }
      } else {
        // still too long, use md5 as filename
        fileName = crypto.createHash('md5').update(`${fileName}${search.substring(1)}`).digest('hex');
      }
    }
    return path.resolve(directory, fileName);
  },

  /**
   * Writes a partial request object to a local file
   * @param {string} url the request url
   * @param {string} directory a local directory path
   * @param {Object} ret the partial request object ({ body, headers, status })
   * @param {Logger} logger a logger
   */
  async writeToCache(url, directory, { body, headers, status }, logger) {
    try {
      const filePath = utils.computePathForCache(url, directory);
      const parent = path.dirname(filePath);
      logger.debug(`Not in cache, saving: ${filePath}`);
      await fs.ensureDir(parent);
      await fs.writeFile(filePath, body);
      await fs.writeJSON(`${filePath}.json`, { headers, status });
    } catch (error) {
      logger.error(error);
    }
  },

  /**
   * Returns a partial request object ({ body, headers, status }) from a local file
   * @param {string} url the request url
   * @param {string} directory a local directory path
   * @param {Logger} logger a logger
   * @returns {Object} the partial request object ({ body, headers, status }). Null if not found.
   */
  async getFromCache(url, directory, logger) {
    try {
      const filePath = utils.computePathForCache(url, directory);
      logger.debug(`Trying from cache first: ${filePath}`);

      if (await fs.pathExists(filePath)) {
        const body = await fs.readFile(filePath);
        const { headers, status } = await fs.readJSON(`${filePath}.json`);
        return { body, headers, status };
      }
    } catch (error) {
      logger.error(error);
    }
    return null;
  },

  /**
   * Fetches the content from the url  and streams it back to the response.
   * @param {RequestContext} ctx Context
   * @param {string} url The url to fetch from
   * @param {Request} req The original express request
   * @param {Response} res The express response
   * @param {object} opts additional request options
   * @return {Promise} A promise that resolves when the stream is done.
   */
  async proxyRequest(ctx, url, req, res, opts = {}) {
    const { id } = ctx;
    ctx.log.debug(`[${id}] Proxy ${req.method} request to ${url}`);

    if (opts.cacheDirectory) {
      const cached = await utils.getFromCache(url, opts.cacheDirectory, ctx.log);
      if (cached) {
        res
          .status(cached.status)
          .set(cached.headers)
          .send(cached.body);
        return;
      }
    }

    let body;
    // GET and HEAD requests can't have a body
    if (!['GET', 'HEAD'].includes(req.method)) {
      body = new PassThrough();
      req.pipe(body);
    }
    const stream = new PassThrough();
    req.pipe(stream);
    const headers = {
      'x-forwarded-host': `localhost:${ctx.config.server.port}`,
      'x-forwarded-scheme': 'http',
      ...req.headers,
      ...(opts.headers || {}),
    };

    // hlx 5 site auth
    if (opts.siteToken) {
      headers.authorization = `token ${opts.siteToken}`;
    }

    if (!opts.cookies) {
      // only pass through hlx-auth-token cookie
      const cookies = parseCookie(headers.cookie || '');
      delete headers.cookie;
      const hlxAuthToken = cookies['hlx-auth-token'];
      if (hlxAuthToken) {
        headers.cookie = new URLSearchParams({
          'hlx-auth-token': hlxAuthToken,
        }).toString();
      }
    }

    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers.host;
    delete headers['if-modified-since'];
    const ret = await getFetch(ctx.config.allowInsecure)(url, {
      method: req.method,
      headers,
      cache: 'no-store',
      body,
      redirect: 'manual',
    });
    const contentType = ret.headers.get('content-type') || 'text/plain';
    const level = utils.status2level(ret.status, true);
    ctx.log[level](`[${id}] Proxy ${req.method} request to ${url}: ${ret.status} (${contentType})`);

    const respHeaders = Object.fromEntries(ret.headers.entries());
    // multiple Set-Cookie headers need special handling
    // https://www.npmjs.com/package/node-fetch#extract-set-cookie-header
    const setCookieValues = ret.headers.raw()['set-cookie'];
    if (setCookieValues?.length) {
      respHeaders['set-cookie'] = setCookieValues;
    }
    delete respHeaders['content-encoding'];
    delete respHeaders['content-length'];
    delete respHeaders['x-frame-options'];
    delete respHeaders['content-security-policy'];
    delete respHeaders.connection;
    respHeaders['access-control-allow-origin'] = '*';
    respHeaders.via = `${ret.httpVersion ?? '1.0'} ${new URL(url).hostname}`;

    if (ret.status === 404 && contentType.indexOf('text/html') === 0 && opts.file404html) {
      ctx.log.debug(`[${id}] serve local 404.html ${opts.file404html}`);
      let textBody = await fs.readFile(opts.file404html, 'utf-8');
      if (opts.injectLiveReload) {
        textBody = utils.injectLiveReloadScript(textBody, ctx.config.server);
      }
      res
        .status(404)
        .set(respHeaders)
        .send(textBody);
      return;
    }

    const isHTML = ret.status === 200 && contentType.indexOf('text/html') === 0;
    const isHTMLWithAuthError = (ret.status === 401 || ret.status === 403) && contentType.indexOf('text/html') === 0;
    const livereload = isHTML && opts.injectLiveReload;
    const replaceHead = isHTML && opts.headHtml;
    const doIndex = isHTML && opts.indexer && url.indexOf('.plain.html') < 0;

    if (ctx.log.level === 'silly') {
      ctx.log.trace(`[${id}] -----------------------------`);
      ctx.log.trace(`[${id}] < http/${ret.httpVersion} ${ret.status} ${ret.statusText}`);
      Object.entries(ret.headers.raw()).forEach(([name, value]) => {
        ctx.log.trace(`[${id}] < ${name}: ${value}`);
      });
    }

    if (isHTML) {
      let textBody = await ret.text();
      if (ctx.log.level === 'silly') {
        ctx.log.trace(textBody);
        ctx.log.trace(`[${id}] <<<--------------------------`);
      }
      if (replaceHead) {
        await opts.headHtml.setCookie(req.headers.cookie);
        textBody = await opts.headHtml.replace(textBody);
      }
      if (livereload) {
        textBody = utils.injectLiveReloadScript(textBody, ctx.config.server);
      }
      textBody = utils.injectMeta(textBody, {
        'hlx:proxyUrl': url,
      });

      if (doIndex) {
        opts.indexer.onData(url, {
          body: textBody,
          headers: respHeaders,
        });
      }

      if (opts.cacheDirectory) {
        await utils.writeToCache(
          url,
          opts.cacheDirectory,
          {
            body: textBody,
            headers: respHeaders,
            status: ret.status,
          },
          ctx.log,
        );
      }

      res
        .set(respHeaders)
        .status(ret.status)
        .send(textBody);
      return;
    }
    if (isHTMLWithAuthError) {
      // Handle HTML responses with 401/403 status - inject meta tag
      let textBody = await ret.text();
      if (ctx.log.level === 'silly') {
        ctx.log.trace(textBody);
        ctx.log.trace(`[${id}] <<<--------------------------`);
      }
      textBody = utils.injectMeta(textBody, {
        'hlx:proxyUrl': url,
      });

      res
        .set(respHeaders)
        .status(ret.status)
        .send(textBody);
      return;
    }

    if (ret.status === 401 || ret.status === 403) {
      const reqHeaders = req.headers;
      if (opts.autoLogin && opts.loginPath
        && reqHeaders?.['sec-fetch-dest'] === 'document'
        && reqHeaders?.['sec-fetch-mode'] === 'navigate'
      ) {
        // try to automatically login
        res.set('location', opts.loginPath).status(302).send();
        return;
      }

      // Transform plain text 401/403 responses into Chrome-compatible HTML
      // This allows the sidekick to recognize the error page and enable login
      const statusText = ret.status === 401 ? '401 Unauthorized' : '403 Forbidden';
      const escapedUrl = url
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');

      const textBody = `<html><head><meta name="color-scheme" content="light dark"><meta property="hlx:proxyUrl" content="${escapedUrl}"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${statusText}</pre></body></html>`;

      respHeaders['content-type'] = 'text/html';
      res
        .set(respHeaders)
        .status(ret.status)
        .send(textBody);
      return;
    }

    if (ctx.log.level === 'silly') {
      ctx.log.trace(`[${id}] <<<--------------------------`);
    }

    if (opts.cacheDirectory) {
      const buffer = await ret.buffer();
      await utils.writeToCache(
        url,
        opts.cacheDirectory,
        {
          body: buffer,
          headers: respHeaders,
          status: ret.status,
        },
        ctx.log,
      );
      res
        .status(ret.status)
        .set(respHeaders)
        .send(buffer);
      return;
    }

    res
      .status(ret.status)
      .set(respHeaders);
    ret.body.pipe(res);
  },

  /**
   * Generates a random string of the given `length` consisting of alpha numerical characters.
   * if `hex` is {@code true}, the string will only consist of hexadecimal digits.
   * @param {number}length length of the string.
   * @param {boolean} hex returns a hex string if {@code true}
   * @returns {String} a random string.
   */
  randomChars(length, hex = false) {
    if (length === 0) {
      return '';
    }
    if (hex) {
      return crypto.randomBytes(Math.round(length / 2)).toString('hex').substring(0, length);
    }
    const str = crypto.randomBytes(length).toString('base64');
    return str.substring(0, length);
  },

  /**
   * Checks if the given port is already in use on any addr. This is used to prevent starting a
   * server on the same port with an existing socket bound to 0.0.0.0 and SO_REUSEADDR.
   * @param port
   @param addr   * @return {Promise} that resolves `true` if the port is in use.
   */
  checkPortInUse(port, addr = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      let socket;

      const cleanUp = () => {
        if (socket) {
          socket.removeAllListeners('connect');
          socket.removeAllListeners('error');
          socket.end();
          socket.destroy();
          socket.unref();
          socket = null;
        }
      };

      socket = new Socket();
      socket.once('error', (err) => {
        if (err.code !== 'ECONNREFUSED') {
          reject(err);
        } else {
          resolve(false);
        }
        cleanUp();
      });

      socket.connect(port, addr, () => {
        resolve(true);
        cleanUp();
      });
    });
  },

  /**
   * Rewrites all absolute urls to the proxy host with relative ones.
   * @param {Buffer} html
   * @param {string} host
   * @returns {Buffer}
   */
  rewriteUrl(html, host) {
    const hostPattern = host.replaceAll('.', '\\.');
    let text = html.toString('utf-8');
    const re = new RegExp(`(src|href)\\s*=\\s*(["'])${hostPattern}(/.*?)?(['"])`, 'gm');
    text = text.replaceAll(re, (match, arg, q1, value, q2) => (`${arg}=${q1}${value || '/'}${q2}`));
    return Buffer.from(text, 'utf-8');
  },

  /**
   * Validates that a file path is within a base directory (security check)
   * @param {string} filePath absolute file path to validate
   * @param {string} baseDirectory base directory path
   * @returns {boolean} true if path is safe, false if it tries to escape base directory
   */
  validatePathSecurity(filePath, baseDirectory) {
    const resolvedBaseDir = path.resolve(baseDirectory);
    const relPath = path.relative(resolvedBaseDir, filePath);
    return !relPath.startsWith('..');
  },

  /**
   * Rewrites da.live content-store image URLs (`https://content.da.live/${org}/${site}/...`)
   * to the site's preview domain, since content.da.live is not publicly reachable
   * for rendering images during local dev.
   * @param {string} html html content
   * @param {string} org da.live org
   * @param {string} site da.live site
   * @returns {string} rewritten html
   */
  rewriteDaContentImageUrls(html, org, site) {
    if (!org || !site) {
      return html;
    }
    const from = `https://content.da.live/${org}/${site}/`;
    const to = `https://main--${site}--${org}.preview.da.live/`;
    return html.split(from).join(to);
  },

  /**
   * Finds one concrete asset path served from `previewOrigin` in the page (e.g. an
   * image src), so the browser can probe *that* to check for a valid auth cookie —
   * the site's root document is often served regardless of auth, only assets are
   * gated, so probing `/` would give a false "already authorized" reading.
   * @param {string} html html content
   * @param {string} previewOrigin e.g. `https://main--site--org.preview.da.live`
   * @returns {string} an absolute path (starting with `/`), defaults to `/` if none found
   */
  findDaPreviewProbePath(html, previewOrigin) {
    const escaped = previewOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = html.match(new RegExp(`${escaped}(/[^"'\\s)]*)`));
    return match ? match[1] : '/';
  },

  /**
   * Injects the IMS-auth bootstrap that forwards an access token to `/gimme_cookie`
   * on the given preview origin, so images served from that origin (after
   * {@link rewriteDaContentImageUrls}) are authorized. Redirects the browser to the
   * IMS login screen if there is no existing session.
   * @param {string} html full HTML document (must contain a `</head>`)
   * @param {{ previewOrigin: string, probePath: string, clientId: string, scope: string }} options
   * @returns {string} html with the auth bootstrap injected, unchanged if no `</head>` found
   */
  injectDaContentAuthScript(html, {
    previewOrigin, probePath, clientId, scope,
  }) {
    const match = html.match(/<\/head>/i);
    if (!match) {
      return html;
    }
    const { index } = match;
    const nonceMatch = html.match(/nonce="([a-zA-Z0-9+/=]+)"/);
    const nonce = nonceMatch ? ` nonce="${nonceMatch[1]}"` : '';
    const config = JSON.stringify({
      previewOrigin, probePath, clientId, scope,
    });
    const script = `<script${nonce}>window.DaContentAuthConfig=${config};</script>`
      + `<script${nonce} src="/__internal__/da-content-auth.js"></script>`;
    return `${html.substring(0, index)}${script}${html.substring(index)}`;
  },

  /**
   * Serves the da-content-auth bootstrap as a static JS file (referenced by
   * {@link injectDaContentAuthScript}).
   * @param {Express.Response} res response
   */
  serveDaContentAuthScript(res) {
    res.set('content-type', 'application/javascript');
    res.send(DA_CONTENT_AUTH_SCRIPT);
  },

  /**
   * Extracts the innerHTML of the <main> element from a full HTML document.
   * Returns the original content unchanged if no <main> is found.
   * @param {string} html full HTML document
   * @returns {string} innerHTML of <main>, or original html if no <main> present
   */
  extractMainContent(html) {
    const ast = htmlParser.parse(html);
    const main = select('main', ast);
    if (!main) {
      return html;
    }
    return main.children.map((child) => toHtml(child)).join('');
  },

  /**
   * Turns .plain.html content into the authored document html2md expects, so it can be rendered
   * by the html pipeline like aem.page renders it: a <main> made only of section `div`s, with
   * section-metadata in its authored form (see `toSections` and `toAuthoredSection`), and media
   * images with their size in the URL, as html2md produces them.
   * @param {string} html .plain.html content (a fragment, or a document with a <main>)
   * @returns {string} html document with a <main>
   */
  plainHtmlToContentDocument(html) {
    const tree = htmlParser.parse(html);
    let $main = select('main', tree);
    if (!$main) {
      const $body = select('body', tree);
      $main = {
        type: 'element', tagName: 'main', properties: {}, children: $body.children,
      };
      $body.children = [$main];
    }
    $main.children = toSections($main.children);
    // aem.page renders the size of media images from their URL: keep it
    selectAll('img[src^="./media_"][width][height]', $main).forEach(($img) => {
      const { src, width, height } = $img.properties;
      Object.assign($img.properties, { src: `${src.split(/[?#]/)[0]}#width=${width}&height=${height}` });
    });
    return toHtml(tree);
  },
};

export default Object.freeze(utils);
