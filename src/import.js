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
import path from 'path';
import { getOrCreateLogger } from './log-common.js';

export default function up() {
  let executor;
  return {
    set executor(value) {
      executor = value;
    },
    command: 'import',
    description: 'Run the Helix import server',
    builder: (yargs) => {
      yargs
        .option('open', {
          describe: 'Open a browser window at specified path',
          type: 'string',
          default: '/tools/importer/helix-webui-importer/index.html',
        })
        .option('no-open', {
          // negation of the open option (resets open default)
          // see https://github.com/yargs/yargs/blob/master/docs/tricks.md#negating-boolean-arguments
          alias: 'noOpen',
          describe: 'Disable automatic opening of browser window',
          type: 'boolean',
        })
        .option('port', {
          describe: 'Start import server on port',
          type: 'int',
          default: 3001,
        })
        .option('stop-other', {
          alias: 'stopOther',
          describe: 'Stop other Helix CLI running on the above port',
          type: 'boolean',
          default: true,
        })
        .group(['port', 'stop-other'], 'Server options')
        .option('cache', {
          describe: 'Path to local folder to cache the responses',
          type: 'string',
        })
        .group(['open', 'no-open', 'cache'], 'Helix Import Options')

        .help();
    },
    handler: async (argv) => {
      // codecov:ignore:start
      /* c8 ignore start */
      if (!executor) {
        // eslint-disable-next-line global-require
        const ImportCommand = (await import('./import.cmd.js')).default; // lazy load the handler to speed up execution time
        executor = new ImportCommand(getOrCreateLogger(argv));
      }
      // codecov:ignore:end
      /* c8 ignore end */
      await executor
        .withHttpPort(argv.port)
        // only open  browser window when executable is `hlx`
        // this prevents the window to be opened during integration tests
        .withOpen(path.basename(argv.$0) === 'hlx' ? argv.open : false)
        .withKill(argv.stopOther)
        .withCache(argv.cache)
        .run();
    },
  };
}