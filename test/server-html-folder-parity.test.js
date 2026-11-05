/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */
/* eslint-disable no-underscore-dangle */

/**
 * Parity check: a `.plain.html` file served by `aem up --html-folder` must render the same way
 * the html pipeline (`html2md` -> `helix-html-pipeline`, i.e. what aem.page runs, and what the
 * CLI already uses for `content/`) renders the authored content at the same path.
 *
 * The rendered pages are compared on three normalized aspects, so a failure shows which part
 * diverges, and the `.plain.html` fragments on a fourth:
 * - page metadata: `<title>`, `<meta name>` (except `twitter:*`) and `article:*` tags;
 * - social metadata: `og:*`, `twitter:*` and the canonical link;
 * - the `<main>` content;
 * - the fragment served for `<name>.plain.html`.
 * Whitespace-only text, comments and attribute order are ignored.
 */
import os from 'os';
import assert from 'assert';
import fs from 'fs/promises';
import fse from 'fs-extra';
import path from 'path';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { select, selectAll } from 'hast-util-select';
import { toHtml } from 'hast-util-to-html';
import { HelixProject } from '../src/server/HelixProject.js';
import { renderContentHtml } from '../src/content/content-html-pipeline.js';
import { Nock, createTestRoot, setupProject } from './utils.js';

const PROXY_URL = 'https://main--foo--bar.aem.page';
const HTML_FOLDER = 'drafts';

const SHEET_ROWS = [
  { URL: `/${HTML_FOLDER}/sheet`, Template: 'from-sheet', Nav: '/nav-from-sheet' },
];

const FIXTURES = {
  // repro from https://github.com/adobe/helix-cli/issues/2823
  'metadata-in-section': `<div><h1>Example post</h1>
<p>First paragraph.</p>
<div class="metadata"><div><div>Title</div><div>Example post title</div></div><div><div>Template</div><div>blog-post</div></div><div><div>Footer Variant</div><div>padded</div></div></div></div>`,

  // the form the current implementation supports: the block alone in its own section
  'metadata-own-section': `<div><h1>Own section</h1><p>Some intro text.</p></div>
<div><div class="metadata"><div><div>Title</div><div>Own section title</div></div><div><div>Description</div><div>A short description.</div></div><div><div>Template</div><div>landing</div></div></div></div>`,

  // value parsing (readBlockConfig): paragraphs, lists, links and an image
  'metadata-values': `<div><h1>Values</h1><p>Body.</p></div>
<div><div class="metadata">
<div><div>Keywords</div><div><p>alpha</p><p>beta</p></div></div>
<div><div>Tags</div><div><ul><li>one</li><li>two</li></ul></div></div>
<div><div>Related</div><div><a href="https://example.com/related">Related page</a></div></div>
<div><div>Image</div><div><img src="/media/social.png" alt="Social"></div></div>
</div></div>`,

  // no metadata block: defaults derived from the content
  defaults: '<div><h1>Defaults only</h1><p>This first paragraph is long enough to become the default page description.</p><p><img src="/media/hero.png" alt="Hero"></p></div>',

  // metadata from the project's metadata.json sheet (see SHEET_ROWS)
  sheet: '<div><h1>Sheet metadata</h1><p>Body.</p></div>',
};

// .plain.html files that differ from the authored content they must render like
const ADAPTED_FIXTURES = {
  // a block without a section around it
  'block-outside-section': {
    plain: `<div class="hero"><div><div><h1>Hero</h1><p>Intro text.</p></div></div></div>
<div><p>Next section.</p></div>`,
    authored: `<div><div class="hero"><div><div><h1>Hero</h1><p>Intro text.</p></div></div></div></div>
<div><p>Next section.</p></div>`,
  },

  // content without any section
  'content-outside-section': {
    plain: '<h1>Loose content</h1><p>No section here.</p>',
    authored: '<div><h1>Loose content</h1><p>No section here.</p></div>',
  },

  // a copy of the .plain.html aem.page serves for the authored content (rendered in `before`),
  // i.e. with section metadata and media images already rendered
  'copied-from-aem-page': {
    authored: `<div><h1>Copied</h1><p><img src="./media_1234.png#width=800&height=600" alt="Media"></p><p>Text.</p>
<div class="section-metadata"><div><div>Style</div><div>highlight, dark</div></div><div><div>Background</div><div>blue</div></div><div><div>Id</div><div>intro</div></div></div></div>
<div><div class="cards"><div><div>a</div><div>b</div></div></div></div>`,
  },
};

const ALL_FIXTURES = {
  ...Object.fromEntries(Object.entries(FIXTURES)
    .map(([name, html]) => [name, { plain: html, authored: html }])),
  ...ADAPTED_FIXTURES,
};

function parse(html) {
  return unified().use(rehypeParse).parse(html);
}

function text(node) {
  if (node.type === 'text') {
    return node.value;
  }
  return (node.children || []).map(text).join('');
}

function pageMetadata(tree) {
  const $title = select('head > title', tree);
  const metas = selectAll('head > meta', tree)
    .map(({ properties: { name, property, content } }) => [name || property, content])
    .filter(([key]) => key && !key.startsWith('twitter:') && !key.startsWith('og:'))
    .map(([key, content]) => `${key}=${content}`)
    .sort();
  return { title: $title ? text($title).trim() : null, metas };
}

function socialMetadata(tree) {
  const metas = selectAll('head > meta', tree)
    .map(({ properties: { name, property, content } }) => [name || property, content])
    .filter(([key]) => key && (key.startsWith('twitter:') || key.startsWith('og:')))
    .map(([key, content]) => `${key}=${content}`);
  const $canonical = select('head > link[rel=canonical]', tree);
  if ($canonical) {
    metas.push(`canonical=${$canonical.properties.href}`);
  }
  return metas.sort();
}

function stripInsignificant(node) {
  if (node.properties) {
    // eslint-disable-next-line no-param-reassign
    node.properties = Object.fromEntries(Object.entries(node.properties).sort());
  }
  if (node.children) {
    // eslint-disable-next-line no-param-reassign
    node.children = node.children
      .filter((n) => n.type !== 'comment' && !(n.type === 'text' && !n.value.trim()))
      .map(stripInsignificant);
  }
  return node;
}

function mainContent(tree) {
  const $main = select('main', tree);
  return $main ? toHtml(stripInsignificant(structuredClone($main))) : null;
}

function fragmentContent(html) {
  return toHtml(stripInsignificant(unified().use(rehypeParse, { fragment: true }).parse(html)));
}

const silentLog = {
  silly() {}, trace() {}, debug() {}, verbose() {}, info() {}, warn() {}, error() {},
};

describe('Helix Server - HTML Folder .plain.html parity with the html pipeline', () => {
  let nock;
  let testRoot;
  let project;
  let headHtml;

  before(async () => {
    nock = new Nock();
    nock.enableNetConnect(/127.0.0.1/);
    testRoot = await createTestRoot();
    const cwd = await setupProject(path.join(__rootdir, 'test', 'fixtures', 'project'), testRoot);
    headHtml = (await fs.readFile(path.join(cwd, 'head.html'), 'utf-8')).trim();

    const copied = ALL_FIXTURES['copied-from-aem-page'];
    copied.plain = await renderContentHtml(`<main>${copied.authored}</main>`, {
      path: `/${HTML_FOLDER}/copied-from-aem-page.plain.html`,
      log: silentLog,
    });
    assert.ok(copied.plain?.includes('<picture>'), 'html pipeline failed to render the copied fixture');

    const folder = path.join(cwd, HTML_FOLDER);
    await fs.mkdir(folder, { recursive: true });
    await Promise.all(Object.entries(ALL_FIXTURES)
      .map(([name, { plain }]) => fs.writeFile(path.join(folder, `${name}.plain.html`), plain)));

    nock(PROXY_URL)
      .get('/head.html')
      .reply(404)
      // only requested by implementations that apply the metadata sheet
      .get('/metadata.json')
      .optionally()
      .reply(200, { data: SHEET_ROWS });

    project = new HelixProject()
      .withCwd(cwd)
      .withHttpPort(0)
      .withProxyUrl(`${PROXY_URL}/`)
      .withHtmlFolder(HTML_FOLDER);
    await project.init();
    await project.start();
  });

  after(async () => {
    await project?.stop();
    if (os.platform() === 'win32') {
      fse.removeSync(testRoot);
    } else {
      await fse.remove(testRoot);
    }
    nock.done();
  });

  Object.entries(ALL_FIXTURES).forEach(([name, { authored }]) => {
    describe(`${name}.plain.html`, () => {
      let actual;
      let expected;
      let actualFragment;
      let expectedFragment;

      before(async () => {
        const host = `127.0.0.1:${project.server.port}`;
        const pathname = `/${HTML_FOLDER}/${name}`;
        const resp = await fetch(`http://${host}${pathname}`);
        assert.strictEqual(resp.status, 200);
        actual = parse(await resp.text());

        const fragmentResp = await fetch(`http://${host}${pathname}.plain.html`);
        assert.strictEqual(fragmentResp.status, 200);
        actualFragment = fragmentContent(await fragmentResp.text());

        // what aem.page renders for the authored content at the same paths
        const options = {
          log: silentLog,
          headHtml,
          metadataSheetRows: SHEET_ROWS,
          headers: { host },
        };
        const rendered = await renderContentHtml(`<body><main>${authored}</main></body>`, {
          ...options,
          path: pathname,
        });
        assert.ok(rendered, 'html pipeline failed to render the fixture');
        expected = parse(rendered);

        const renderedFragment = await renderContentHtml(`<body><main>${authored}</main></body>`, {
          ...options,
          path: `${pathname}.plain.html`,
        });
        assert.ok(renderedFragment, 'html pipeline failed to render the fixture fragment');
        expectedFragment = fragmentContent(renderedFragment);
      });

      it('has the same page metadata (<title>, <meta name>, article:*)', () => {
        assert.deepStrictEqual(pageMetadata(actual), pageMetadata(expected));
      });

      it('has the same social metadata (og:*, twitter:*, canonical)', () => {
        assert.deepStrictEqual(socialMetadata(actual), socialMetadata(expected));
      });

      it('has the same <main> content', () => {
        assert.strictEqual(mainContent(actual), mainContent(expected));
      });

      it('has the same .plain.html fragment', () => {
        assert.strictEqual(actualFragment, expectedFragment);
      });
    });
  });
});
