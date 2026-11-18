/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @noflow
 * @format
 */

const {report} = require('../visual/approve-run');
const {SHA_A, SHA_B} = require('./__fixtures__/visual');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('approve report', () => {
  const prefix = `reports/pull/1/${SHA_A}/2-1`;
  const results = {
    fingerprint: 'f'.repeat(16),
    platforms: [
      {
        platform: 'ios',
        environmentKey: 'ios-x-0123abcd',
        baseline: {sha: SHA_B, distance: 0, imageStore: 'blobs'},
        results: [{id: 'a/b/new', status: 'added', captured: {}}],
        error: null,
      },
    ],
  };
  const savedEnv = process.env;
  let outDir;
  let checkRuns;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-approve-'));
    process.env = {
      ...savedEnv,
      OUT_DIR: outDir,
      VISUAL_PUBLIC_BASE_URL: 'https://cdn.example',
      GITHUB_TOKEN: 'token',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_API_URL: 'https://api.example',
    };
    checkRuns = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (url === `https://api.example/repos/owner/repo/check-runs`) {
        checkRuns.push(JSON.parse(init.body));
        return new Response('{}', {status: 201});
      }
      if (url === `https://cdn.example/${prefix}/results.json`) {
        return new Response(JSON.stringify(results), {status: 200});
      }
      if (
        url === `https://cdn.example/approvals/pull/1/${'f'.repeat(16)}.json`
      ) {
        return new Response(
          JSON.stringify({fingerprint: 'f'.repeat(16), approver: 'alice'}),
          {status: 200},
        );
      }
      return new Response(null, {status: 404});
    });
  });

  afterEach(() => {
    process.env = savedEnv;
    jest.restoreAllMocks();
    fs.rmSync(outDir, {recursive: true, force: true});
  });

  test.each([
    ['passes the platform checks once approved', true, 'success'],
    ['fails them again when the label is removed', false, 'failure'],
  ])('%s', async (_, labelPresent, conclusion) => {
    fs.writeFileSync(
      path.join(outDir, 'state.json'),
      JSON.stringify({
        prNumber: 1,
        headSha: SHA_A,
        fingerprint: 'f'.repeat(16),
        labelPresent,
        reportPrefix: prefix,
      }),
    );
    await report();
    expect(checkRuns.map(run => [run.name, run.conclusion])).toEqual([
      ['Visual regression (ios)', conclusion],
      ['Visual regression approval', conclusion],
    ]);
  });
});
